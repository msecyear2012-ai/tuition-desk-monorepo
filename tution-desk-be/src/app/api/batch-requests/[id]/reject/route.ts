import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import StudentBatchRequest from "../../../../../models/StudentBatchRequest.ts";
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

    // REQ-01: Only Institute Owners are authorized to reject batch requests
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error:
            "Access denied: Only Institute Owners are authorized to reject batch requests.",
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

    const body = await request.json().catch(() => ({}));
    const { rejectionReason } = body;

    // REQ-01: Rejection strictly requires a reason
    if (!rejectionReason || !String(rejectionReason).trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Rejection reason is required to reject a batch assignment request",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const centerId = user.centerId;

    // 1. Verify existence and center isolation
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

    // 3. Atomically update status with race-condition protection
    const rejectedRequest = await StudentBatchRequest.findOneAndUpdate(
      {
        _id: id,
        centerId,
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          rejectionReason: String(rejectionReason).trim(),
          reviewedBy: new mongoose.Types.ObjectId(user.userId),
          reviewedByName: reviewerName,
          reviewedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!rejectedRequest) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Concurrent modification: Request was already processed by another session.",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // Event Notification Dispatch
    try {
      await notifyBatchRequestEvents({
        centerId,
        requestId: String(rejectedRequest._id),
        studentId: String(existing.studentId),
        studentName: "Student",
        batchName: existing.batchName,
        currentBatch: existing.currentBatch,
        requesterId: String(existing.requesterId),
        requesterName: existing.requesterName || "Teacher",
        action: "rejected",
        rejectionReason: String(rejectionReason).trim(),
      });
    } catch (notifErr) {
      console.warn("[BATCH REQUEST REJECTION] Notification dispatch error:", notifErr);
    }

    // REQ-01: Student record is preserved untouched
    return NextResponse.json(
      {
        success: true,
        message: "Batch assignment request rejected",
        data: rejectedRequest,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to reject batch request";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
