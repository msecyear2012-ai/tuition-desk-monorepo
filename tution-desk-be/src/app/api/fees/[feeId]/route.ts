import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Fee, {
  type IFee,
  type IFeeDocument,
  type IPaymentEntry,
  calculateFeeCustody,
  getFeePaymentEntries,
} from "../../../../models/Fee.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import {
  validateParentSession,
  resolvePortalToken,
} from "../../../../lib/parentAccessService.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { sendPaymentReceipt } from "../../../../lib/whatsappService.ts";
import {
  maskContactNumber,
  sanitizeStudentForRole,
  sanitizePopulatedStudentDoc,
} from "../../../../lib/privacyUtils.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "PUT, GET, DELETE, OPTIONS");
}

const FORBIDDEN_FIELDS = [
  "paymentHistory",
  "allocations",
  "originalAmountDue",
  "recordedBy",
  "recordedByRole",
  "receivedBy",
  "receivedByRole",
  "custodyStatus",
  "isProvisional",
];

function generateReceiptNumber(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let random = "";
  for (let i = 0; i < 6; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RCPT-${random}`;
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ feeId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    await connectDB();

    const { feeId } = await context.params;

    if (!feeId || !mongoose.Types.ObjectId.isValid(feeId)) {
      return NextResponse.json(
        { success: false, error: "Invalid fee ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    const user = await getAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));

    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to update fee record" },
        { status: 401, headers: corsHeaders }
      );
    }
    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    // 1. API Perimeter Defense: Reject tampering with server-controlled ledger fields
    const hasForbiddenField = FORBIDDEN_FIELDS.some(
      (field) => body[field] !== undefined
    );
    if (hasForbiddenField) {
      return NextResponse.json(
        {
          success: false,
          code: "IMMUTABLE_FIELD_TAMPERING",
          error:
            "Modification of server-controlled financial ledger fields (paymentHistory, allocations, originalAmountDue, attribution, custody) is strictly forbidden.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Strictly derive centerId from verified JWT; never trust client-supplied centerId
    const targetCenterId = user.centerId;

    // Find the fee record
    const existingFee = await Fee.findOne({
      _id: feeId,
      centerId: String(targetCenterId).trim(),
    });

    if (!existingFee) {
      // Check if fee belongs to another center
      const crossCenterFee = await Fee.findById(feeId).select("centerId").lean();
      if (crossCenterFee && crossCenterFee.centerId !== targetCenterId) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Cross-center fee modification is strictly forbidden",
          },
          { status: 403, headers: corsHeaders }
        );
      }
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Teacher Authorization & Bypass Prevention
    if (user.role === "teacher") {
      const teacherId = user.teacherId || user.userId;
      if (!teacherId || !mongoose.Types.ObjectId.isValid(teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const teacherObjectId = String(teacherId);
      const isAssigned =
        existingFee.assignedTeacherId &&
        String(existingFee.assignedTeacherId) === teacherObjectId;

      if (!isAssigned) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Fee record is not assigned to your account",
          },
          { status: 403, headers: corsHeaders }
        );
      }

      // Teachers cannot change student assignment on any fee record
      if (body.assignedTeacherId !== undefined) {
        return NextResponse.json(
          { success: false, error: "Teachers cannot change student assignment" },
          { status: 403, headers: corsHeaders }
        );
      }

      // Teachers must NEVER bypass the manual collection API to record payments or alter balances
      const attemptsFinancialUpdate =
        body.status === "Paid" ||
        body.status === "Partial Paid" ||
        body.paidAmount !== undefined ||
        body.amountDue !== undefined;

      if (attemptsFinancialUpdate) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Teachers cannot record payments or alter financial balances via PUT. Please use the manual collection API (POST /api/fees/manual-collection).",
          },
          { status: 403, headers: corsHeaders }
        );
      }

      // Teachers may update non-financial fields such as notes
      if (body.notes !== undefined) {
        existingFee.notes = String(body.notes);
      }

      await existingFee.save();
      const populatedFee = (
        typeof (existingFee as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
          ? await (existingFee as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
          : existingFee
      ) as IFeeDocument;

      const custodyBreakdown = calculateFeeCustody(populatedFee);
      return NextResponse.json(
        {
          success: true,
          message: "Fee record updated successfully",
          data: populatedFee,
          ...(custodyBreakdown ? { custodyBreakdown } : {}),
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // 3. Owner Legitimate Updates
    const now = new Date();
    const isPaidRecord =
      existingFee.status === "Paid" || existingFee.status === "Partial Paid";

    if (body.notes !== undefined) {
      existingFee.notes = String(body.notes);
    }
    if (body.title !== undefined) {
      existingFee.title = String(body.title);
    }
    if (body.dueDate !== undefined && !isNaN(new Date(body.dueDate).getTime())) {
      existingFee.dueDate = new Date(body.dueDate);
    }
    if (body.assignedTeacherId !== undefined) {
      existingFee.assignedTeacherId =
        body.assignedTeacherId && mongoose.Types.ObjectId.isValid(body.assignedTeacherId)
          ? new mongoose.Types.ObjectId(body.assignedTeacherId)
          : null;
    }

    // Handle payment marking / approval by Owner (e.g. Online/UPI approval or Cash mark)
    if (body.status === "Paid" || body.paymentMode) {
      const paymentMode = body.paymentMode || existingFee.paymentMode || "Cash";
      const receiptNumber =
        existingFee.receiptNumber ||
        body.receiptNumber ||
        generateReceiptNumber();

      const settledAmount =
        body.paidAmount !== undefined
          ? Number(body.paidAmount)
          : Number(existingFee.amountDue) || Number(existingFee.paidAmount) || 0;

      existingFee.status = (typeof body.status === "string" ? body.status : "Paid") as IFee["status"];
      existingFee.paymentMode = paymentMode;
      existingFee.paidDate = now;
      existingFee.paidAt = now;
      existingFee.paymentDate = now;
      existingFee.receiptNumber = receiptNumber;
      existingFee.amountDue = 0;
      existingFee.paidAmount =
        (Number(existingFee.paidAmount) || 0) + (existingFee.status === "Paid" ? Number(existingFee.amountDue || 0) : 0);
      if (body.paidAmount !== undefined) {
        existingFee.paidAmount = Number(body.paidAmount);
      }

      // Do not silently overwrite financial history: append structured payment entry for Owner settlement
      if (!isPaidRecord && settledAmount > 0) {
        const ownerCollectorId = new mongoose.Types.ObjectId(user.userId);
        const ownerPaymentId = new mongoose.Types.ObjectId();
        const ownerPaymentEntry: IPaymentEntry = {
          _id: ownerPaymentId,
          paymentId: ownerPaymentId,
          amount: settledAmount,
          paymentDate: now,
          paymentMode,
          receiptNumber,
          isProvisional: false,
          receivedBy: ownerCollectorId,
          receivedByRole: "owner",
          recordedBy: ownerCollectorId,
          recordedByRole: "owner",
          recordedAt: now,
          assignedTeacherAtPayment: existingFee.assignedTeacherId ?? null,
          batchAtPayment: existingFee.batchAtPayment || "",
          custodyStatus: "owner_custody",
          allocations: [],
          notes: body.notes ? String(body.notes).trim() : "Settled by Owner via Fee Update API",
        };

        if (!existingFee.paymentHistory) {
          existingFee.paymentHistory = [];
        }
        existingFee.paymentHistory.push(ownerPaymentEntry);
      }

      // Top-level attribution
      if (!existingFee.recordedBy) {
        existingFee.recordedBy = new mongoose.Types.ObjectId(user.userId);
        existingFee.recordedByRole = "owner";
      }
      if (!existingFee.receivedBy) {
        existingFee.receivedBy = new mongoose.Types.ObjectId(user.userId);
        existingFee.receivedByRole = "owner";
      }
      if (!existingFee.recordedAt) {
        existingFee.recordedAt = now;
      }
    }

    await existingFee.save();
    const populatedFee = (
      typeof (existingFee as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
        ? await (existingFee as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
        : existingFee
    ) as IFeeDocument;

    // Dispatch receipt in background if Paid
    if (
      existingFee.status === "Paid" &&
      populatedFee.studentId &&
      (populatedFee.studentId as unknown as { parentWhatsApp?: string }).parentWhatsApp
    ) {
      const sDoc = populatedFee.studentId as unknown as {
        parentWhatsApp?: string;
        name?: string;
        _id?: unknown;
      };
      sendPaymentReceipt(
        existingFee.centerId || targetCenterId || "",
        sDoc.parentWhatsApp!,
        sDoc.name || "Student",
        existingFee.paidAmount || existingFee.amountDue,
        existingFee.receiptNumber || "",
        sDoc._id?.toString()
      ).catch((dispatchErr) => {
        console.warn("[FEES UPDATE] WhatsApp receipt dispatch warning:", dispatchErr.message);
      });
    }

    const custodyBreakdown = calculateFeeCustody(populatedFee);

    const sanitizedPopulatedFee = sanitizePopulatedStudentDoc(
      populatedFee.toObject ? populatedFee.toObject() : { ...populatedFee },
      "studentId",
      user.role
    );

    return NextResponse.json(
      {
        success: true,
        message: "Fee record updated successfully",
        data: sanitizedPopulatedFee,
        ...(custodyBreakdown ? { custodyBreakdown } : {}),
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to update fee record";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ feeId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    await connectDB();

    const { feeId } = await context.params;

    if (!feeId || !mongoose.Types.ObjectId.isValid(feeId)) {
      return NextResponse.json(
        { success: false, error: "Invalid fee ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1. Resolve Authentication: Parent Portal or Staff (Owner / Teacher)
    let authCenterId: string | null = null;
    let parentAccessRecord: any = null;
    let staffUser: any = null;

    // A. Check Parent Portal Session Token (Cookie or Authorization: Bearer header)
    const sessionCookie = request.cookies.get("parent_portal_session")?.value;
    const authHeader = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const sessionToken = sessionCookie || authHeader;

    const rawToken =
      (request.nextUrl ? request.nextUrl.searchParams.get("token") : null) ||
      request.headers.get("x-portal-token");

    if (sessionToken) {
      const sessionResult = await validateParentSession(sessionToken);
      if (sessionResult.valid && sessionResult.parentAccess) {
        parentAccessRecord = sessionResult.parentAccess;
        authCenterId = sessionResult.parentAccess.centerId;
      }
    } else if (rawToken) {
      const tokenResult = await resolvePortalToken(String(rawToken).trim());
      if (tokenResult.valid && tokenResult.parentAccess) {
        parentAccessRecord = tokenResult.parentAccess;
        authCenterId = tokenResult.parentAccess.centerId;
      }
    }

    // B. Check Staff Authentication (Owner or Teacher) if not resolved as parent
    if (!parentAccessRecord) {
      staffUser = await getAuthenticatedUser(request);
      if (staffUser) {
        if (staffUser.role === "owner" || staffUser.role === "teacher") {
          authCenterId = String(staffUser.centerId);
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
        { success: false, error: "Authentication required to view fee record" },
        { status: 401, headers: corsHeaders }
      );
    }

    const targetCenterId = authCenterId;

    // Retrieve fee record with populated student
    const findQuery = Fee.findOne({
      _id: feeId,
      centerId: String(targetCenterId).trim(),
    });
    const feeDoc = (
      typeof (findQuery as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
        ? await (findQuery as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
        : await findQuery
    ) as unknown as IFeeDocument | null;

    if (!feeDoc) {
      // Check if fee belongs to another center
      const crossCenterFee = await Fee.findById(feeId).select("centerId").lean();
      if (crossCenterFee && String(crossCenterFee.centerId).trim() !== String(targetCenterId).trim()) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Cross-center fee access is strictly forbidden",
          },
          { status: 403, headers: corsHeaders }
        );
      }
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Parent Authorization Check & Clean Data Response
    if (parentAccessRecord) {
      const targetStudentId =
        feeDoc.studentId && typeof feeDoc.studentId === "object" && "_id" in feeDoc.studentId
          ? String((feeDoc.studentId as any)._id)
          : String(feeDoc.studentId);

      const linked = (parentAccessRecord.linkedStudentIds || []).map((id: any) =>
        String(id)
      );

      if (!linked.includes(targetStudentId)) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: You are not authorized to view fee records for this student",
          },
          { status: 403, headers: corsHeaders }
        );
      }

      // Safe parent-facing payload: Exclude internal ledger accounting data,
      // teacher assignments, recordedBy/receivedBy, and custody breakdowns.
      const feeObj = feeDoc.toObject ? feeDoc.toObject() : { ...feeDoc };

      let sanitizedStudent = feeObj.studentId;
      if (sanitizedStudent && typeof sanitizedStudent === "object") {
        const s = sanitizedStudent as Record<string, unknown>;
        sanitizedStudent = {
          _id: s._id,
          name: s.name,
          rollNumber: s.rollNumber,
          standard: s.standard,
          batchId: s.batchId,
        };
      }

      return NextResponse.json(
        {
          success: true,
          data: {
            _id: feeObj._id,
            centerId: feeObj.centerId,
            studentId: sanitizedStudent,
            month: feeObj.month,
            billingMonth: feeObj.billingMonth,
            feeType: feeObj.feeType,
            title: feeObj.title,
            amountDue: Number(feeObj.amountDue) || 0,
            paidAmount: Number(feeObj.paidAmount) || 0,
            dueDate: feeObj.dueDate,
            paidDate: feeObj.paidDate,
            status: feeObj.status,
            utrNumber: feeObj.utrNumber,
            receiptNumber: feeObj.receiptNumber,
            isAdvance: feeObj.isAdvance,
            paymentMode: feeObj.paymentMode,
            createdAt: feeObj.createdAt,
            updatedAt: feeObj.updatedAt,
          },
        },
        { status: 200, headers: corsHeaders }
      );
    }

    const user = staffUser;

    // Teacher authorization check
    if (user.role === "teacher") {
      const teacherId = user.teacherId || user.userId;
      if (!teacherId || !mongoose.Types.ObjectId.isValid(teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const teacherObjectId = String(teacherId);
      const feeAssignedTeacher = feeDoc.assignedTeacherId ? String(feeDoc.assignedTeacherId) : null;
      const feeAssignedAtPayment = feeDoc.assignedTeacherAtPayment ? String(feeDoc.assignedTeacherAtPayment) : null;

      const studentDoc = feeDoc.studentId as unknown as { assignedTeacherId?: unknown } | null;
      const studentAssignedTeacher = studentDoc?.assignedTeacherId ? String(studentDoc.assignedTeacherId) : null;

      const isAssigned =
        feeAssignedTeacher === teacherObjectId ||
        feeAssignedAtPayment === teacherObjectId ||
        studentAssignedTeacher === teacherObjectId;

      const hasCollectedPayment =
        (feeDoc.paymentHistory || []).some((p) => {
          const recId = p.receivedBy ? String(p.receivedBy) : "";
          const recRole = p.recordedBy ? String(p.recordedBy) : "";
          return (
            recId === teacherObjectId ||
            recId === String(user.userId) ||
            recRole === teacherObjectId ||
            recRole === String(user.userId)
          );
        }) ||
        String(feeDoc.receivedBy || "") === teacherObjectId ||
        String(feeDoc.recordedBy || "") === teacherObjectId;

      if (!isAssigned && !hasCollectedPayment) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Fee record is not assigned to your account",
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    const feeObj = feeDoc.toObject ? feeDoc.toObject() : { ...feeDoc };

    // Student privacy defense: Teachers must never see raw student/parent contact numbers
    if (user.role === "teacher" && feeObj.studentId && typeof feeObj.studentId === "object") {
      const student = feeObj.studentId as Record<string, unknown>;
      if (student.parentWhatsApp) {
        student.parentWhatsApp = maskContactNumber(String(student.parentWhatsApp));
      }
      if (student.phone) {
        student.phone = maskContactNumber(String(student.phone));
      }
      if (student.parentPhone) {
        student.parentPhone = maskContactNumber(String(student.parentPhone));
      }
    }

    // Structured payment history & legacy backward compatibility
    const paymentHistory = getFeePaymentEntries(feeDoc as IFee);

    const currentDue = Number(feeDoc.amountDue) || 0;
    const currentPaid = Number(feeDoc.paidAmount) || 0;
    const originalAmountDue =
      feeDoc.originalAmountDue ?? (currentDue + currentPaid);

    // Live custody breakdown derived from payment allocations
    const custodyBreakdown = calculateFeeCustody(feeDoc as IFee);

    return NextResponse.json(
      {
        success: true,
        data: {
          ...feeObj,
          originalAmountDue,
          paymentHistory,
          ...(custodyBreakdown ? { custodyBreakdown } : {}),
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch fee details";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ feeId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    await connectDB();

    const { feeId } = await context.params;

    if (!feeId || !mongoose.Types.ObjectId.isValid(feeId)) {
      return NextResponse.json(
        { success: false, error: "Invalid fee ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    const user = await getAuthenticatedUser(request);

    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to delete fee record" },
        { status: 401, headers: corsHeaders }
      );
    }
    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    // Strictly derive centerId from verified JWT; never trust client-supplied centerId
    const targetCenterId = user.centerId;

    if (user.role === "teacher") {
      const teacherId = user.teacherId || user.userId;
      if (!teacherId || !mongoose.Types.ObjectId.isValid(teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      // Check existence and authorization first:
      const existingFee = await Fee.findOne({
        _id: feeId,
        centerId: String(targetCenterId).trim(),
      });

      if (!existingFee) {
        return NextResponse.json(
          { success: false, error: "Fee record not found" },
          { status: 404, headers: corsHeaders }
        );
      }

      // Teacher resource authorization: records with assignedTeacherId === null (Owner-assigned)
      // or assigned to another teacher are strictly forbidden (return 404 to preserve privacy)
      if (
        !existingFee.assignedTeacherId ||
        String(existingFee.assignedTeacherId) !== String(teacherId)
      ) {
        return NextResponse.json(
          { success: false, error: "Fee record not found" },
          { status: 404, headers: corsHeaders }
        );
      }

      // Ledger Immutability (DEC-MSEC-01/02): teachers cannot delete paid or partially paid financial records
      if (
        existingFee.status === "Paid" ||
        existingFee.status === "Partial Paid"
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Teachers cannot delete paid or partially paid fee records",
          },
          { status: 403, headers: corsHeaders }
        );
      }

      // Atomic deletion guard (DEC-MSEC-01/02): prevent concurrent payment
      // settlement from racing with this delete.
      const deleteConditions: Record<string, unknown> = {
        _id: feeId,
        centerId: String(targetCenterId).trim(),
        assignedTeacherId: new mongoose.Types.ObjectId(String(teacherId)),
        status: { $nin: ["Paid", "Partial Paid"] },
      };

      const deletedFeeResult = await Fee.findOneAndDelete(deleteConditions);

      if (!deletedFeeResult) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Concurrent modification conflict: fee record was already settled or deleted by another transaction.",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      return NextResponse.json(
        {
          success: true,
          message: "Fee record deleted successfully",
          data: { feeId: deletedFeeResult._id },
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // Owner role deletion:
    const deletedFeeResult = await Fee.findOneAndDelete({
      _id: feeId,
      centerId: String(targetCenterId).trim(),
    });

    if (!deletedFeeResult) {
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: "Fee record deleted successfully",
        data: { feeId: deletedFeeResult._id },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to delete fee record";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

