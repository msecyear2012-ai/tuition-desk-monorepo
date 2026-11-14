import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Fee from "../../../../models/Fee.ts";
import Student from "../../../../models/Student.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { sanitizePopulatedStudentDoc } from "../../../../lib/privacyUtils.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    await connectDB();

    const body = await request.json().catch(() => ({}));
    const { studentId, centerId, amount, utrNumber } = body;

    // Validate studentId
    if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
      return NextResponse.json(
        { success: false, error: "Valid studentId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate amount
    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Advance amount must be greater than 0" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate or default utrNumber for advance payment
    const trimmedUtr =
      String(utrNumber || "").trim() ||
      `ADV_INIT_${Date.now().toString().slice(-6)}`;

    // 3. Authenticate user from verified JWT
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

    const targetCenterId = user.centerId;
    const studentDoc = await Student.findById(studentId);
    if (!studentDoc) {
      return NextResponse.json(
        { success: false, error: "Student record not found" },
        { status: 404, headers: corsHeaders }
      );
    }
    if (studentDoc.centerId !== targetCenterId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized access to student outside authenticated center" },
        { status: 403, headers: corsHeaders }
      );
    }

    const now = new Date();
    const collectorId = new mongoose.Types.ObjectId(user.userId);
    const collectorRole = user.role;
    const responsibleTeacherId = studentDoc.assignedTeacherId || null;
    const responsibleBatch = studentDoc.batch || "";

    // Create the new Advance Fee record in "Verification Pending" state.
    // DEC-MSEC-01/03: It represents an unverified payment submission, NOT a completed collection.
    // - paidAmount is 0 (funds not yet settled)
    // - paymentDate/paidDate/paidAt are null (settlement has not completed)
    // - recordedBy tracks who submitted the record for audit
    // - receivedBy is null until physical/digital cash custody is confirmed by Owner
    // - assignedTeacherAtPayment is null until payment is confirmed
    const advanceFee = await Fee.create({
      centerId: targetCenterId,
      studentId: new mongoose.Types.ObjectId(studentId),
      month: "Advance Fee Payment",
      title: "Advance Fee Payment",
      amountDue: parsedAmount,
      paidAmount: 0,
      dueDate: now,
      status: "Verification Pending",
      paymentMode: "Online/UPI",
      feeType: "advance",
      isAdvance: true,
      utrNumber: trimmedUtr,
      paymentDate: null,
      paidDate: null,
      paidAt: null,
      // Academic scoping
      assignedTeacherId: responsibleTeacherId,
      assignedTeacherAtPayment: null,
      batchAtPayment: responsibleBatch,
      // Software Entry Audit
      recordedBy: collectorId,
      recordedByRole: collectorRole,
      recordedAt: now,
      // Physical / Digital Custody (remains null until verification)
      receivedBy: null,
      receivedByRole: null,
    });

    const populatedFee = await Fee.findById(advanceFee._id).populate("studentId");

    const sanitizedFee = sanitizePopulatedStudentDoc(
      populatedFee?.toObject ? populatedFee.toObject() : populatedFee,
      "studentId",
      user.role
    );

    return NextResponse.json(
      {
        success: true,
        message: "Advance fee submitted successfully for verification",
        data: sanitizedFee,
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: number }).code === 11000
    ) {
      const errObj = error as any;
      const isUtrConflict = Boolean(
        (errObj.keyPattern && "utrNumber" in errObj.keyPattern) ||
        (errObj.keyValue && "utrNumber" in errObj.keyValue) ||
        (typeof errObj.message === "string" &&
          (/utr/i.test(errObj.message) ||
            errObj.message.includes("centerId_1_utrNumber_1")))
      );

      if (isUtrConflict) {
        return NextResponse.json(
          {
            success: false,
            code: "DUPLICATE_UTR",
            error:
              "A payment record with this transaction reference (UTR) already exists in this institute. Duplicate UPI/UPI-gateway references are blocked.",
          },
          { status: 409, headers: corsHeaders }
        );
      }
    }

    const errorMsg =
      error instanceof Error ? error.message : "Failed to record advance fee payment";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
