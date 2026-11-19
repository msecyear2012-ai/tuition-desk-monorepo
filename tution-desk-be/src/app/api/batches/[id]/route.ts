import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Batch from "../../../../models/Batch.ts";
import Student from "../../../../models/Student.ts";
import Fee from "../../../../models/Fee.ts";
import FeeCreationLock from "../../../../models/FeeCreationLock.ts";
import FeeReminderLog from "../../../../models/FeeReminderLog.ts";
import PaymentProof from "../../../../models/PaymentProof.ts";
import Attendance from "../../../../models/Attendance.ts";
import AdmissionWelcomeJob from "../../../../models/AdmissionWelcomeJob.ts";
import MessageCampaign from "../../../../models/MessageCampaign.ts";
import ParentAccess from "../../../../models/ParentAccess.ts";
import ParentAccessLock from "../../../../models/ParentAccessLock.ts";
import StudentBatchRequest from "../../../../models/StudentBatchRequest.ts";
import Test from "../../../../models/Test.ts";
import Teacher from "../../../../models/Teacher.ts";
import StaffNotification from "../../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, DELETE, OPTIONS");
}

export async function GET(
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

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid Batch ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const batch = await Batch.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!batch) {
      return NextResponse.json(
        { success: false, error: "Batch not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);
      const [teacherStudents, teacherDoc] = await Promise.all([
        Student.find({
          centerId: user.centerId,
          assignedTeacherId: teacherObjectId,
          isActive: { $ne: false },
        }).select("batch"),
        Teacher.findOne({
          _id: teacherObjectId,
          centerId: user.centerId,
        }).select("assignedBatches"),
      ]);

      const allowedBatchNames = new Set([
        ...(teacherDoc?.assignedBatches || []),
        ...teacherStudents.map((s) => s.batch).filter(Boolean),
      ]);

      if (!allowedBatchNames.has(batch.name)) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: You are not assigned to this batch",
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    return NextResponse.json(
      { success: true, data: batch },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch batch";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(
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

    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error:
            "Access denied: Only Institute Owners are authorized to delete batches.",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid Batch ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const centerId = user.centerId;
    const batch = await Batch.findOne({ _id: id, centerId });

    if (!batch) {
      return NextResponse.json(
        { success: false, error: "Batch not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 1. Identify all students associated with this batch
    const batchStudents = await Student.find({
      centerId,
      $or: [{ batch: batch.name }, { batch: String(batch._id) }],
    }).select("_id");

    const studentIds = batchStudents.map((s) => s._id);
    const studentIdStrings = studentIds.map((sId) => String(sId));

    // 2. Coordinate atomic cascade deletion
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

    try {
      const sessionOpts = session && inTx ? { session } : {};

      // 3. Cascade delete all student-dependent collections sequentially
      if (studentIds.length > 0) {
        await Fee.deleteMany(
          { centerId, studentId: { $in: studentIds } },
          sessionOpts
        );
        await FeeCreationLock.deleteMany(
          { centerId, studentId: { $in: studentIdStrings } },
          sessionOpts
        );
        await FeeReminderLog.deleteMany(
          { centerId, studentId: { $in: studentIds } },
          sessionOpts
        );
        await PaymentProof.deleteMany(
          { centerId, studentId: { $in: studentIds } },
          sessionOpts
        );
        await ParentAccessLock.deleteMany(
          { centerId, studentId: { $in: studentIdStrings } },
          sessionOpts
        );

        await ParentAccess.updateMany(
          { centerId, linkedStudentIds: { $in: studentIds } },
          { $pull: { linkedStudentIds: { $in: studentIds } } },
          sessionOpts
        );

        await ParentAccess.deleteMany(
          { centerId, linkedStudentIds: { $size: 0 } },
          sessionOpts
        );

        await MessageCampaign.updateMany(
          { centerId, "messages.studentId": { $in: studentIds } },
          { $pull: { messages: { studentId: { $in: studentIds } } } },
          sessionOpts
        );

        await MessageCampaign.updateMany(
          {
            centerId,
            status: { $in: ["pending", "approved", "in_progress", "paused"] },
            messages: { $size: 0 },
          },
          { $set: { status: "cancelled" } },
          sessionOpts
        );

        await Student.deleteMany(
          { centerId, _id: { $in: studentIds } },
          sessionOpts
        );
      }

      // 4. Cascade delete batch-level and related operational collections sequentially
      await Attendance.deleteMany(
        {
          centerId,
          $or: [
            { batch: batch.name },
            ...(studentIds.length > 0
              ? [{ studentId: { $in: studentIds } }]
              : []),
          ],
        },
        sessionOpts
      );
      await AdmissionWelcomeJob.deleteMany(
        {
          centerId,
          $or: [
            { batchName: batch.name },
            ...(studentIds.length > 0
              ? [{ studentId: { $in: studentIds } }]
              : []),
          ],
        },
        sessionOpts
      );
      await StudentBatchRequest.deleteMany(
        {
          centerId,
          $or: [
            { batchName: batch.name },
            { batchId: batch._id },
            ...(studentIds.length > 0
              ? [{ studentId: { $in: studentIds } }]
              : []),
          ],
        },
        sessionOpts
      );
      await Test.deleteMany({ centerId, batch: batch.name }, sessionOpts);
      await Teacher.updateMany(
        { centerId, assignedBatches: batch.name },
        { $pull: { assignedBatches: batch.name } },
        sessionOpts
      );
      await StaffNotification.deleteMany(
        {
          centerId,
          $or: [
            { entityId: String(batch._id) },
            ...(studentIdStrings.length > 0
              ? [{ studentId: { $in: studentIdStrings } }]
              : []),
          ],
        },
        sessionOpts
      );

      // 5. Finally, delete the Batch itself
      await Batch.deleteOne({ _id: batch._id, centerId }, sessionOpts);

      if (session && inTx) {
        await session.commitTransaction();
      }

      return NextResponse.json(
        {
          success: true,
          message: "Batch and all associated student records deleted successfully",
          data: {
            deletedBatchId: id,
            deletedBatchName: batch.name,
            deletedStudentsCount: studentIds.length,
          },
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (txError) {
      if (session && inTx) {
        await session.abortTransaction().catch(() => {});
      }
      throw txError;
    } finally {
      if (session) {
        await session.endSession().catch(() => {});
      }
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to delete batch";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
