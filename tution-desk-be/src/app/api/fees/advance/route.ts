import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Fee from "../../../../models/Fee.ts";
import Student from "../../../../models/Student.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { sanitizePopulatedStudentDoc } from "../../../../lib/privacyUtils.ts";
import {
  resolvePortalToken,
  validateParentSession,
} from "../../../../lib/parentAccessService.ts";

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

    // 3. Resolve Authentication: Parent Portal or Staff (Owner / Teacher)
    let authCenterId: string | null = null;
    let parentAccessRecord: any = null;
    let isParent = false;

    // A. Check Parent Portal Session Token (Cookie or Authorization: Bearer header) or raw token
    const sessionCookie = request.cookies.get("parent_portal_session")?.value;
    const authHeader = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const sessionToken = sessionCookie || authHeader;

    const rawToken =
      (request.nextUrl ? request.nextUrl.searchParams.get("token") : null) ||
      request.headers.get("x-portal-token") ||
      (typeof body.token === "string" ? body.token.trim() : null);

    if (sessionToken) {
      if (sessionToken.startsWith("pt_")) {
        const tokenResult = await resolvePortalToken(sessionToken.trim());
        if (tokenResult.valid && tokenResult.parentAccess) {
          parentAccessRecord = tokenResult.parentAccess;
          authCenterId = tokenResult.parentAccess.centerId;
          isParent = true;
        }
      } else {
        const sessionResult = await validateParentSession(sessionToken);
        if (sessionResult.valid && sessionResult.parentAccess) {
          parentAccessRecord = sessionResult.parentAccess;
          authCenterId = sessionResult.parentAccess.centerId;
          isParent = true;
        }
      }
    }

    if (!parentAccessRecord && rawToken) {
      const tokenResult = await resolvePortalToken(String(rawToken).trim());
      if (tokenResult.valid && tokenResult.parentAccess) {
        parentAccessRecord = tokenResult.parentAccess;
        authCenterId = tokenResult.parentAccess.centerId;
        isParent = true;
      }
    }

    // B. Check Staff Authentication (Owner or Teacher) if not resolved as parent
    let staffUser: any = null;
    if (!parentAccessRecord) {
      staffUser = await getAuthenticatedUser(request);
      if (staffUser) {
        if (staffUser.role === "owner" || staffUser.role === "teacher") {
          authCenterId = staffUser.centerId;
        } else {
          return NextResponse.json(
            { success: false, error: "Access denied: Unauthorized role" },
            { status: 403, headers: corsHeaders }
          );
        }
      }
    }

    // Fail closed: Reject unauthenticated callers immediately before database lookups
    if (!authCenterId) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const targetCenterId = authCenterId;
    const studentDoc = await Student.findById(studentId);
    if (!studentDoc) {
      return NextResponse.json(
        { success: false, error: "Student record not found" },
        { status: 404, headers: corsHeaders }
      );
    }
    if (String(studentDoc.centerId).trim() !== String(targetCenterId).trim()) {
      return NextResponse.json(
        { success: false, error: "Unauthorized access to student outside authenticated center" },
        { status: 403, headers: corsHeaders }
      );
    }

    // 4. Verify Authorization for this Specific Student
    if (isParent && parentAccessRecord) {
      const linkedStudentIds = (parentAccessRecord.linkedStudentIds || []).map(
        (id: any) => String(id)
      );
      if (!linkedStudentIds.includes(String(studentId))) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Parent is not authorized for this student",
          },
          { status: 403, headers: corsHeaders }
        );
      }
    } else if (staffUser && staffUser.role === "teacher") {
      const teacherId = staffUser.teacherId || staffUser.userId;
      if (
        !studentDoc.assignedTeacherId ||
        String(studentDoc.assignedTeacherId) !== String(teacherId)
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Teacher not assigned to this student",
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    const now = new Date();
    const collectorId = isParent && parentAccessRecord
      ? (parentAccessRecord._id instanceof mongoose.Types.ObjectId
          ? parentAccessRecord._id
          : new mongoose.Types.ObjectId(String(parentAccessRecord._id)))
      : new mongoose.Types.ObjectId(staffUser.userId);
    const collectorRole = isParent ? "system" : staffUser.role;
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
      isParent ? "parent" : staffUser.role
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
