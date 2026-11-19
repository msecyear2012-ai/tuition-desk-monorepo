import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Student from "../../../../models/Student.ts";
import Teacher from "../../../../models/Teacher.ts";
import Fee, { type IPaymentEntry } from "../../../../models/Fee.ts";
import AdmissionWelcomeJob from "../../../../models/AdmissionWelcomeJob.ts";
import FeeCreationLock from "../../../../models/FeeCreationLock.ts";
import FeeReminderLog from "../../../../models/FeeReminderLog.ts";
import ParentAccess from "../../../../models/ParentAccess.ts";
import ParentAccessLock from "../../../../models/ParentAccessLock.ts";
import MessageCampaign from "../../../../models/MessageCampaign.ts";
import PaymentProof from "../../../../models/PaymentProof.ts";
import StudentBatchRequest from "../../../../models/StudentBatchRequest.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { sanitizeStudentForRole } from "../../../../lib/privacyUtils.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, PUT, DELETE, OPTIONS");
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
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
        { success: false, error: "Valid student ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. Connect to database only after authentication and authorization
    await connectDB();

    // 3. Query strictly scoped to centerId and role
    const query: Record<string, unknown> = {
      _id: id,
      centerId: user.centerId,
    };

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      query.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    const student = await Student.findOne(query);

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const sanitizedStudent = sanitizeStudentForRole(
      student.toObject ? student.toObject() : { ...student },
      user.role
    );

    const checkDues = request.nextUrl.searchParams.get("checkDues") === "true";
    if (checkDues) {
      const pendingFees = await Fee.find({
        studentId: student._id,
        centerId: user.centerId,
        status: { $in: ["Pending", "Verification Pending", "Partial Paid"] },
      });
      const unpaidAmount = pendingFees.reduce(
        (sum, f) => sum + (Number(f.amountDue) || 0),
        0
      );
      return NextResponse.json(
        {
          success: true,
          data: {
            ...sanitizedStudent,
            unpaidAmount,
            pendingFeesCount: pendingFees.length,
          },
        },
        { status: 200, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: true, data: sanitizedStudent },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch student";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
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
        { success: false, error: "Valid student ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. Connect to database only after authentication and authorization
    await connectDB();

    // 3. Locate student strictly scoped to centerId and role
    const query: Record<string, unknown> = {
      _id: id,
      centerId: user.centerId,
    };

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      query.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    const student = await Student.findOne(query);

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => ({}));

    // 4. Validate assignment changes
    if (user.role === "teacher") {
      // Teachers CANNOT change student assignment
      if (
        body.assignedTeacherId !== undefined &&
        String(body.assignedTeacherId) !== String(user.teacherId)
      ) {
        return NextResponse.json(
          { success: false, error: "Teachers cannot change student assignment" },
          { status: 403, headers: corsHeaders }
        );
      }
    } else {
      // Owner can reassign student to Owner (null) or an active Teacher in the same center
      if (body.assignedTeacherId !== undefined) {
        if (
          body.assignedTeacherId === null ||
          body.assignedTeacherId === "owner" ||
          body.assignedTeacherId === ""
        ) {
          student.assignedTeacherId = null;
        } else {
          if (!mongoose.Types.ObjectId.isValid(String(body.assignedTeacherId))) {
            return NextResponse.json(
              { success: false, error: "Invalid Teacher ID format" },
              { status: 400, headers: corsHeaders }
            );
          }

          const targetTeacher = await Teacher.findOne({
            _id: body.assignedTeacherId,
            centerId: user.centerId,
          });

          if (!targetTeacher) {
            return NextResponse.json(
              { success: false, error: "Teacher not found in this institute" },
              { status: 400, headers: corsHeaders }
            );
          }

          if (!targetTeacher.isActive) {
            return NextResponse.json(
              { success: false, error: "Cannot assign student to an inactive teacher" },
              { status: 400, headers: corsHeaders }
            );
          }

          student.assignedTeacherId = targetTeacher._id as mongoose.Types.ObjectId;
        }
      }
    }

    // 5. Update permitted mutable fields with strict validation (protect _id, centerId)
    if (body.name !== undefined) {
      const cleanName = String(body.name).trim();
      if (!cleanName) {
        return NextResponse.json(
          { success: false, error: "Student name cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      student.name = cleanName;
    }

    if (body.batch !== undefined) {
      const cleanBatch = String(body.batch).trim();
      if (!cleanBatch) {
        return NextResponse.json(
          { success: false, error: "Batch cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      // REQ-01: Teachers cannot directly reassign student batches; must go through Owner approval workflow
      if (user.role === "teacher" && cleanBatch !== student.batch) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Access denied: Teachers cannot directly reassign student batches. Submit a batch assignment request for Owner approval.",
          },
          { status: 403, headers: corsHeaders }
        );
      }
      student.batch = cleanBatch;
    }

    if (body.parentWhatsApp !== undefined) {
      if (user.role === "teacher") {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Teachers cannot update student contact numbers",
          },
          { status: 403, headers: corsHeaders }
        );
      }
      const cleanPhone = String(body.parentWhatsApp).replace(/\D/g, "");
      if (cleanPhone.length < 10 || cleanPhone.length > 15) {
        return NextResponse.json(
          {
            success: false,
            error: "parentWhatsApp must be a valid 10 to 15 digit phone number",
          },
          { status: 400, headers: corsHeaders }
        );
      }
      student.parentWhatsApp = cleanPhone;
    }

    if (body.isActive !== undefined) {
      student.isActive = Boolean(body.isActive);
    }

    if (body.joiningDate !== undefined) {
      student.joiningDate = new Date(body.joiningDate);
    }

    if (body.monthlyFee !== undefined) {
      const feeNum = Number(body.monthlyFee);
      if (isNaN(feeNum) || feeNum < 0) {
        return NextResponse.json(
          { success: false, error: "Monthly fee must be a non-negative number" },
          { status: 400, headers: corsHeaders }
        );
      }
      student.monthlyFee = feeNum;
    }

    if (body.billingCycleDate !== undefined) {
      const cycleNum = Number(body.billingCycleDate);
      if (isNaN(cycleNum) || cycleNum < 1 || cycleNum > 31) {
        return NextResponse.json(
          { success: false, error: "Billing cycle date must be between 1 and 31" },
          { status: 400, headers: corsHeaders }
        );
      }
      student.billingCycleDate = cycleNum;
    }

    await student.save();

    const sanitizedStudent = sanitizeStudentForRole(
      student.toObject ? student.toObject() : { ...student },
      user.role
    );

    return NextResponse.json(
      { success: true, data: sanitizedStudent },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to update student";

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
    // 1. Authenticate user from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    // Individual student deletion is strictly restricted to Owner
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Only Owners can delete students" },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid student ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. Connect to database only after authentication and authorization
    await connectDB();

    // 3. Locate student strictly scoped to centerId
    const student = await Student.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. Safely parse incoming settlement action payload if present
    let body: {
      settlementAction?: "mark_paid" | "waive_and_delete";
      amountReceived?: number;
      paymentMode?: string;
    } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    // 5. Calculate student's total unpaid balance across all pending Fee records
    const pendingFees = await Fee.find({
      studentId: student._id,
      centerId: user.centerId,
      status: { $in: ["Pending", "Verification Pending", "Partial Paid"] },
    });

    const unpaidAmount = pendingFees.reduce(
      (sum, f) => sum + (Number(f.amountDue) || 0),
      0
    );
    const pendingFeesCount = pendingFees.length;

    // 6. If student has unpaid dues (> 0) and no valid settlement action is provided, return 409 Conflict
    if (
      unpaidAmount > 0 &&
      (!body.settlementAction ||
        !["mark_paid", "waive_and_delete"].includes(body.settlementAction))
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot remove student: ${pendingFeesCount} active fee obligation(s) totaling ₹${unpaidAmount.toLocaleString(
            "en-IN"
          )} exist. Settle or waive pending dues before deleting.`,
          code: "UNRESOLVED_FEES_EXIST",
          unpaidAmount,
          pendingFeesCount,
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 7. Atomic transaction setup (if supported)
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
      const now = new Date();

      // 8. Handle Settlement Actions if unpaid dues exist
      if (unpaidAmount > 0 && body.settlementAction === "mark_paid") {
        const paymentMode = body.paymentMode || "Cash";
        const totalReceived =
          typeof body.amountReceived === "number" && body.amountReceived > 0
            ? body.amountReceived
            : unpaidAmount;

        let remainingAllocation = totalReceived;

        for (const fee of pendingFees) {
          const currentDue = Number(fee.amountDue) || 0;
          const allocated = Math.min(remainingAllocation, currentDue);
          remainingAllocation = Math.max(0, remainingAllocation - allocated);

          const priorPaid = Number(fee.paidAmount) || 0;
          const finalPaid =
            priorPaid + (allocated > 0 ? allocated : currentDue);
          const receiptNumber = `RCP-${Date.now()}-${Math.floor(
            1000 + Math.random() * 9000
          )}`;

          const paymentEntry: IPaymentEntry = {
            amount: allocated > 0 ? allocated : currentDue,
            paymentDate: now,
            paymentMode,
            receiptNumber,
            receivedBy: new mongoose.Types.ObjectId(user.userId),
            receivedByRole: "owner",
            recordedBy: new mongoose.Types.ObjectId(user.userId),
            recordedByRole: "owner",
            recordedAt: now,
            custodyStatus: "owner_custody",
            notes: "Settled during student deletion",
          };

          fee.status = "Paid";
          fee.amountDue = 0;
          fee.paidAmount = finalPaid;
          fee.paidDate = now;
          fee.paidAt = now;
          fee.paymentDate = now;
          fee.paymentMode = paymentMode;
          fee.receiptNumber = fee.receiptNumber || receiptNumber;
          fee.receivedBy = new mongoose.Types.ObjectId(user.userId);
          fee.receivedByRole = "owner";
          fee.recordedBy = new mongoose.Types.ObjectId(user.userId);
          fee.recordedByRole = "owner";
          fee.recordedAt = now;
          if (!Array.isArray(fee.paymentHistory)) {
            fee.paymentHistory = [];
          }
          fee.paymentHistory.push(paymentEntry);
          fee.notes = fee.notes
            ? `${fee.notes}\nSettled during student deletion`
            : "Settled during student deletion";

          await fee.save(sessionOpts);
        }
      } else if (
        unpaidAmount > 0 &&
        body.settlementAction === "waive_and_delete"
      ) {
        // Clear/delete the unpaid pending fee records so no ghost dues remain
        await Fee.deleteMany(
          {
            centerId: user.centerId,
            studentId: student._id,
            status: { $in: ["Pending", "Verification Pending", "Partial Paid"] },
          },
          sessionOpts
        );
      }

      // 9. Cascade delete student and all operational / pending artifacts
      await Promise.all([
        Student.findOneAndDelete(
          { _id: student._id, centerId: user.centerId },
          sessionOpts
        ),
        AdmissionWelcomeJob.deleteMany(
          { centerId: user.centerId, studentId: student._id },
          sessionOpts
        ),
        FeeReminderLog.deleteMany(
          { centerId: user.centerId, studentId: student._id },
          sessionOpts
        ),
        FeeCreationLock.deleteMany(
          { centerId: user.centerId, studentId: String(student._id) },
          sessionOpts
        ),
        ParentAccessLock.deleteMany(
          { centerId: user.centerId, studentId: String(student._id) },
          sessionOpts
        ),
        PaymentProof.deleteMany(
          { centerId: user.centerId, studentId: student._id },
          sessionOpts
        ),
        StudentBatchRequest.deleteMany(
          { centerId: user.centerId, studentId: student._id },
          sessionOpts
        ),
      ]);

      await ParentAccess.updateMany(
        { centerId: user.centerId, linkedStudentIds: student._id },
        { $pull: { linkedStudentIds: student._id } },
        sessionOpts
      );
      await ParentAccess.deleteMany(
        { centerId: user.centerId, linkedStudentIds: { $size: 0 } },
        sessionOpts
      );

      await MessageCampaign.updateMany(
        { centerId: user.centerId, "messages.studentId": student._id },
        { $pull: { messages: { studentId: student._id } } },
        sessionOpts
      );
      await MessageCampaign.updateMany(
        {
          centerId: user.centerId,
          status: { $in: ["pending", "approved", "in_progress", "paused"] },
          messages: { $size: 0 },
        },
        { $set: { status: "cancelled" } },
        sessionOpts
      );

      if (inTx && session) {
        await session.commitTransaction();
      }

      const actionMessage =
        body.settlementAction === "mark_paid"
          ? "Payment recorded as Paid under Owner custody and student deleted successfully."
          : body.settlementAction === "waive_and_delete"
          ? "Pending fees waived and student deleted successfully."
          : "Student deleted successfully.";

      return NextResponse.json(
        {
          success: true,
          action: body.settlementAction || "deleted",
          message: actionMessage,
          unpaidAmount: 0,
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (innerErr) {
      if (inTx && session) {
        await session.abortTransaction();
      }
      throw innerErr;
    } finally {
      if (session) {
        await session.endSession();
      }
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to delete student";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
