import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import StudentBatchRequest from "../../../../../models/StudentBatchRequest.ts";
import Student from "../../../../../models/Student.ts";
import Batch from "../../../../../models/Batch.ts";
import Center from "../../../../../models/Center.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";
import { notifyBatchRequestEvents } from "../../../../../lib/notificationService.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "PUT, OPTIONS");
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    // REQ-01: Only Institute Owners are authorized to approve batch requests
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error:
            "Access denied: Only Institute Owners are authorized to approve batch requests.",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid request ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const centerId = user.centerId;

    // 1. Verify existence, status and center isolation
    const existing = await StudentBatchRequest.findOne({
      _id: id,
      centerId,
    });

    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Batch request not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (existing.status !== "pending") {
      return NextResponse.json(
        {
          success: false,
          error: `Request has already been processed with status '${existing.status}'`,
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 2. Resolve reviewer name
    const centerDoc = await Center.findOne({ centerId }).select(
      "ownerName name"
    );
    const reviewerName =
      centerDoc?.ownerName || centerDoc?.name || "Institute Owner";
    const reviewerObjectId = new mongoose.Types.ObjectId(user.userId);

    // =========================================================================
    // 3. STALE REQUEST REVALIDATION
    // At approval time, revalidate student existence, center custody, active status,
    // and target batch availability. Safely reject stale requests without mutating assignment.
    // =========================================================================

    // 3A. Revalidate student
    const student = await Student.findOne({
      _id: existing.studentId,
      centerId,
    });

    if (!student) {
      await StudentBatchRequest.updateOne(
        { _id: id, centerId, status: "pending" },
        {
          $set: {
            status: "rejected",
            rejectionReason:
              "Stale request: Student record no longer exists in this tuition center",
            reviewedBy: reviewerObjectId,
            reviewedByName: reviewerName,
            reviewedAt: new Date(),
          },
        }
      );
      return NextResponse.json(
        {
          success: false,
          error:
            "Cannot approve request: Student record no longer exists in this tuition center.",
          code: "STALE_REQUEST_STUDENT_NOT_FOUND",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    if (student.isActive === false) {
      await StudentBatchRequest.updateOne(
        { _id: id, centerId, status: "pending" },
        {
          $set: {
            status: "rejected",
            rejectionReason: "Stale request: Student is currently inactive",
            reviewedBy: reviewerObjectId,
            reviewedByName: reviewerName,
            reviewedAt: new Date(),
          },
        }
      );
      return NextResponse.json(
        {
          success: false,
          error: "Cannot approve request: Student is currently inactive.",
          code: "STALE_REQUEST_STUDENT_INACTIVE",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    if (
      student.batch &&
      student.batch.toLowerCase().trim() === existing.batchName.toLowerCase().trim()
    ) {
      await StudentBatchRequest.updateOne(
        { _id: id, centerId, status: "pending" },
        {
          $set: {
            status: "rejected",
            rejectionReason: `Stale request: Student is already assigned to batch '${student.batch}'`,
            reviewedBy: reviewerObjectId,
            reviewedByName: reviewerName,
            reviewedAt: new Date(),
          },
        }
      );
      return NextResponse.json(
        {
          success: false,
          error: `Cannot approve request: Student is already assigned to batch '${student.batch}'.`,
          code: "STALE_REQUEST_ALREADY_ASSIGNED",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 3B. Revalidate target batch existence and active status
    const targetBatch = await Batch.findOne({
      centerId,
      name: existing.batchName,
      isActive: { $ne: false },
    });

    if (!targetBatch) {
      await StudentBatchRequest.updateOne(
        { _id: id, centerId, status: "pending" },
        {
          $set: {
            status: "rejected",
            rejectionReason: `Stale request: Target batch '${existing.batchName}' is inactive or no longer exists in this tuition center`,
            reviewedBy: reviewerObjectId,
            reviewedByName: reviewerName,
            reviewedAt: new Date(),
          },
        }
      );
      return NextResponse.json(
        {
          success: false,
          error: `Cannot approve request: Target batch '${existing.batchName}' is inactive or no longer exists in this tuition center.`,
          code: "STALE_REQUEST_BATCH_UNAVAILABLE",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // =========================================================================
    // 4. ATOMIC APPROVAL CONSISTENCY & TRANSACTION COORDINATION
    // Prefer multi-document ACID transaction when replica-set is available.
    // When standalone, fail safely so request is never marked approved before
    // student assignment succeeds.
    // =========================================================================
    let session: mongoose.ClientSession | null = null;
    let inTx = false;

    try {
      if (typeof mongoose.startSession === "function") {
        session = await mongoose.startSession();
        if (session && typeof session.startTransaction === "function") {
          session.startTransaction();
          inTx = true;
        }
      }
    } catch {
      session = null;
      inTx = false;
    }

    let approvedRequest: any = null;
    let updatedStudent: any = null;

    if (session && inTx) {
      try {
        const reqUpdate = await StudentBatchRequest.findOneAndUpdate(
          {
            _id: id,
            centerId,
            status: "pending",
          },
          {
            $set: {
              status: "approved",
              reviewedBy: reviewerObjectId,
              reviewedByName: reviewerName,
              reviewedAt: new Date(),
            },
          },
          { returnDocument: "after", session }
        );

        if (!reqUpdate) {
          throw new Error("CONCURRENT_MODIFICATION");
        }

        const studUpdate = await Student.findOneAndUpdate(
          {
            _id: reqUpdate.studentId,
            centerId,
          },
          {
            $set: {
              batch: targetBatch.name,
            },
          },
          { returnDocument: "after", session }
        );

        if (!studUpdate) {
          throw new Error("STUDENT_ASSIGNMENT_FAILED");
        }

        await session.commitTransaction();
        approvedRequest = reqUpdate;
        updatedStudent = studUpdate;
      } catch (txErr) {
        await session.abortTransaction();
        if (
          txErr instanceof Error &&
          txErr.message === "CONCURRENT_MODIFICATION"
        ) {
          return NextResponse.json(
            {
              success: false,
              error:
                "Concurrent modification: Request was already processed by another session.",
            },
            { status: 409, headers: corsHeaders }
          );
        }
        throw txErr;
      } finally {
        await session.endSession();
      }
    } else {
      // Non-transactional fallback (Standalone MongoDB / unit test environment)
      // Step A: Perform student batch assignment FIRST to ensure student update succeeds
      const studUpdate = await Student.findOneAndUpdate(
        {
          _id: existing.studentId,
          centerId,
        },
        {
          $set: {
            batch: targetBatch.name,
          },
        },
        { returnDocument: "after" }
      );

      if (!studUpdate) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Failed to update student batch assignment. Request remains pending.",
          },
          { status: 500, headers: corsHeaders }
        );
      }

      // Step B: Atomically transition request status to approved
      const reqUpdate = await StudentBatchRequest.findOneAndUpdate(
        {
          _id: id,
          centerId,
          status: "pending",
        },
        {
          $set: {
            status: "approved",
            reviewedBy: reviewerObjectId,
            reviewedByName: reviewerName,
            reviewedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      if (!reqUpdate) {
        // Compensating rollback: Revert student assignment to previous batch
        await Student.updateOne(
          {
            _id: existing.studentId,
            centerId,
          },
          {
            $set: {
              batch: student.batch,
            },
          }
        );

        return NextResponse.json(
          {
            success: false,
            error:
              "Concurrent modification: Request was already processed by another session.",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      approvedRequest = reqUpdate;
      updatedStudent = studUpdate;
    }

    // Event Notification Dispatch
    try {
      await notifyBatchRequestEvents({
        centerId,
        requestId: String(approvedRequest._id),
        studentId: String(updatedStudent._id),
        studentName: updatedStudent.name || "Student",
        batchName: approvedRequest.batchName,
        currentBatch: existing.currentBatch,
        requesterId: String(existing.requesterId),
        requesterName: existing.requesterName || "Teacher",
        action: "approved",
      });
    } catch (notifErr) {
      console.warn("[BATCH REQUEST APPROVAL] Notification dispatch error:", notifErr);
    }

    return NextResponse.json(
      {
        success: true,
        message: `Student successfully assigned to batch '${approvedRequest.batchName}'`,
        data: {
          request: approvedRequest,
          student: updatedStudent,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to approve batch request";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
