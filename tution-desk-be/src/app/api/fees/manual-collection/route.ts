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
import Student from "../../../../models/Student.ts";
import StaffNotification from "../../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { getISTDateComponents } from "../../../../lib/dateUtils.ts";
import { sendPaymentReceipt } from "../../../../lib/whatsappService.ts";
import { creditAdvanceToStudentWallet } from "../../../../lib/walletService.ts";
import { sanitizePopulatedStudentDoc } from "../../../../lib/privacyUtils.ts";

function formatFeeResponse(fee: unknown, role: string) {
  if (!fee) return fee;
  return sanitizePopulatedStudentDoc(
    typeof (fee as { toObject?: () => Record<string, unknown> }).toObject === "function"
      ? (fee as { toObject: () => Record<string, unknown> }).toObject()
      : (fee as Record<string, unknown>),
    "studentId",
    role
  );
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

// In-flight idempotency key lock set (process-local concurrency guard)
const inFlightIdempotencyKeys = new Set<string>();

interface IdempotentReplayVerificationParams {
  existingFee: IFeeDocument;
  matchingEntry: IPaymentEntry;
  incomingCenterId: string;
  incomingStudentId: string;
  incomingAmount: number;
  incomingFeeId?: string | null;
  incomingBillingMonth?: string | null;
  incomingFeeType: string;
  incomingPaymentMode: string;
  incomingUtrNumber?: string | null;
}

function verifyIdempotentPayloadMatch(params: IdempotentReplayVerificationParams): {
  isMatch: boolean;
  mismatchReason?: string;
} {
  // 1. Center isolation check
  if (params.existingFee.centerId !== params.incomingCenterId) {
    return { isMatch: false, mismatchReason: "centerId mismatch" };
  }

  // 2. Student ID check
  const existingStudentId = String(
    (params.existingFee.studentId as unknown as { _id?: unknown })?._id ||
      params.existingFee.studentId
  );
  if (existingStudentId !== String(params.incomingStudentId)) {
    return { isMatch: false, mismatchReason: "studentId mismatch" };
  }

  // 3. Amount check (within 0.001)
  const entryAmount = Number(params.matchingEntry.amount);
  if (Math.abs(entryAmount - params.incomingAmount) >= 0.001) {
    return { isMatch: false, mismatchReason: "amount mismatch" };
  }

  // 4. Targeted Fee ID check (if client specified a specific feeId)
  if (params.incomingFeeId) {
    const existingFeeId = String(params.existingFee._id);
    if (existingFeeId !== String(params.incomingFeeId)) {
      return { isMatch: false, mismatchReason: "feeId mismatch" };
    }
  }

  // 5. Fee Type check
  const existingFeeType =
    params.existingFee.feeType ||
    (params.existingFee.isAdvance ? "advance" : "monthly_recurring");
  if (existingFeeType !== params.incomingFeeType) {
    return { isMatch: false, mismatchReason: "feeType mismatch" };
  }

  // 6. Billing Month check (for recurring fees or when specified)
  if (params.incomingFeeType === "monthly_recurring") {
    const existingMonth =
      params.existingFee.billingMonth || params.existingFee.month;
    if (
      params.incomingBillingMonth &&
      existingMonth &&
      existingMonth !== params.incomingBillingMonth
    ) {
      return { isMatch: false, mismatchReason: "billingMonth mismatch" };
    }
  }

  // 7. Payment Mode check (case-insensitive)
  const existingMode = String(params.matchingEntry.paymentMode || "").trim().toLowerCase();
  const incomingMode = String(params.incomingPaymentMode || "").trim().toLowerCase();
  if (existingMode && incomingMode && existingMode !== incomingMode) {
    return { isMatch: false, mismatchReason: "paymentMode mismatch" };
  }

  // 8. Applicable UTR / Reference check
  const existingUtr = String(params.existingFee.utrNumber || "").trim();
  const incomingUtr = String(params.incomingUtrNumber || "").trim();
  if (existingUtr !== incomingUtr) {
    return { isMatch: false, mismatchReason: "UTR / reference number mismatch" };
  }

  return { isMatch: true };
}

const FORBIDDEN_FIELDS = [
  "recordedBy",
  "recordedByRole",
  "receivedBy",
  "receivedByRole",
  "paymentHistory",
  "allocations",
  "custodyStatus",
  "isProvisional",
  "originalAmountDue",
];

function generateReceiptNumber(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let random = "";
  for (let i = 0; i < 6; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RCPT-${random}`;
}

function resolveCustody(feeDoc: unknown) {
  try {
    if (!feeDoc) return null;
    return calculateFeeCustody(feeDoc as IFee);
  } catch {
    return null;
  }
}

async function createCollectionNotifications({
  centerId,
  amount,
  studentId,
  studentName,
  collectorId,
  collectorName,
  collectorRole,
  feeId,
  paymentId,
  receiptNumber,
  idempotencyKey,
  session,
}: {
  centerId: string;
  amount: number;
  studentId?: string;
  studentName: string;
  collectorId: string;
  collectorName: string;
  collectorRole: "owner" | "teacher";
  feeId: string;
  paymentId: string;
  receiptNumber: string;
  idempotencyKey?: string;
  session?: mongoose.ClientSession;
}) {
  try {
    if (mongoose.connection?.readyState !== 1) {
      return;
    }
    const formattedAmount = `₹${amount.toLocaleString("en-IN")}`;
    const baseKey = idempotencyKey || `${feeId}_${paymentId}`;

    if (collectorRole === "teacher") {
      // 1. Owner Notification
      const ownerKey = `notif_owner_${baseKey}`;
      const existingOwner = await StaffNotification.findOne({ idempotencyKey: ownerKey });
      if (!existingOwner) {
        const ownerNotif = new StaffNotification({
          centerId,
          recipientId: centerId,
          recipientRole: "owner",
          type: "cash_collection",
          title: "New Cash Collection",
          message: `${collectorName} collected ${formattedAmount} from ${studentName}. Status: Teacher In-Hand.`,
          amount,
          statusLabel: "Teacher In-Hand",
          feeId,
          paymentId,
          studentName,
          collectorId,
          collectorName,
          link: `/fees?tab=payments&sub=paid&feeId=${feeId}`,
          isRead: false,
          idempotencyKey: ownerKey,
          metadata: { receiptNumber, paymentId, feeId, collectorRole },
        });
        if (session) {
          await ownerNotif.save({ session });
        } else {
          await ownerNotif.save();
        }
      }

      // 2. Teacher Notification
      const teacherKey = `notif_teacher_${baseKey}`;
      const existingTeacher = await StaffNotification.findOne({ idempotencyKey: teacherKey });
      if (!existingTeacher) {
        const teacherNotif = new StaffNotification({
          centerId,
          recipientId: String(collectorId),
          recipientRole: "teacher",
          type: "cash_collection",
          title: "Payment Recorded",
          message: `${formattedAmount} collected from ${studentName}. Status: In Your Custody.`,
          amount,
          statusLabel: "In Your Custody",
          feeId,
          paymentId,
          studentName,
          collectorId,
          collectorName,
          link: `/fees?tab=payments&sub=paid&feeId=${feeId}`,
          isRead: false,
          idempotencyKey: teacherKey,
          metadata: { receiptNumber, paymentId, feeId, collectorRole },
        });
        if (session) {
          await teacherNotif.save({ session });
        } else {
          await teacherNotif.save();
        }
      }
    } else {
      // Owner direct collection
      const ownerDirectKey = `notif_owner_${baseKey}`;
      const existing = await StaffNotification.findOne({ idempotencyKey: ownerDirectKey });
      if (!existing) {
        const ownerNotif = new StaffNotification({
          centerId,
          recipientId: centerId,
          recipientRole: "owner",
          type: "cash_collection",
          title: "Payment Recorded",
          message: `${formattedAmount} collected from ${studentName}. Status: In Owner Safe Custody.`,
          amount,
          statusLabel: "In Owner Safe Custody",
          feeId,
          paymentId,
          studentName,
          collectorId,
          collectorName,
          link: `/fees?tab=payments&sub=paid&feeId=${feeId}`,
          isRead: false,
          idempotencyKey: ownerDirectKey,
          metadata: { receiptNumber, paymentId, feeId, collectorRole },
        });
        if (session) {
          await ownerNotif.save({ session });
        } else {
          await ownerNotif.save();
        }
      }
    }

    // 3. Parent Receipt Notification
    if (studentId) {
      const parentKey = `notif_parent_${baseKey}`;
      const existingParent = await StaffNotification.findOne({ idempotencyKey: parentKey });
      if (!existingParent) {
        const parentNotif = new StaffNotification({
          centerId,
          recipientId: String(studentId),
          recipientRole: "parent",
          category: "fee",
          type: "cash_collection",
          title: "Fee Payment Received",
          message: `Payment of ${formattedAmount} received for ${studentName}. Receipt #${receiptNumber}.`,
          amount,
          statusLabel: "Paid",
          feeId,
          paymentId,
          studentId: String(studentId),
          studentName,
          entityType: "Fee",
          entityId: feeId,
          link: "/portal",
          deepLink: "/portal",
          isRead: false,
          idempotencyKey: parentKey,
          metadata: { receiptNumber, paymentId, feeId },
        });
        if (session) {
          await parentNotif.save({ session });
        } else {
          await parentNotif.save();
        }
      }
    }
  } catch (err: unknown) {
    console.warn(
      "[MANUAL COLLECTION] Notification dispatch warning:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  let inFlightLockKey: string | null = null;

  try {
    await connectDB();

    const body = await request.json().catch(() => ({}));

    // -------------------------------------------------------------------------
    // 0. API Perimeter Defense: Reject Client-Supplied Attribution / Ledger Fields
    // -------------------------------------------------------------------------
    const hasForbiddenField = FORBIDDEN_FIELDS.some(
      (field) => body[field] !== undefined
    );
    if (hasForbiddenField) {
      return NextResponse.json(
        {
          success: false,
          code: "IMMUTABLE_FIELD_TAMPERING",
          error:
            "Client-supplied attribution, custody, allocation, or paymentHistory fields are strictly forbidden.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const {
      studentId,
      amount,
      type,
      notes,
      paymentMode,
      paymentDate,
      utrNumber,
    } = body;

    // -------------------------------------------------------------------------
    // 1. Idempotency Key Extraction
    // -------------------------------------------------------------------------
    const rawIdempotencyKey =
      request.headers.get("idempotency-key") ||
      request.headers.get("x-idempotency-key") ||
      body.idempotencyKey;
    const clientKey =
      rawIdempotencyKey && String(rawIdempotencyKey).trim()
        ? String(rawIdempotencyKey).trim()
        : null;

    const cleanUtrNumber =
      utrNumber && String(utrNumber).trim()
        ? String(utrNumber).trim()
        : undefined;
    const resolvedPaymentMode =
      paymentMode && String(paymentMode).trim()
        ? String(paymentMode).trim()
        : "Cash";

    // -------------------------------------------------------------------------
    // 2. Validate studentId
    // -------------------------------------------------------------------------
    if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
      return NextResponse.json(
        { success: false, error: "A valid studentId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // -------------------------------------------------------------------------
    // 3. Validate amount
    // -------------------------------------------------------------------------
    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Payment amount must be greater than 0" },
        { status: 400, headers: corsHeaders }
      );
    }

    // -------------------------------------------------------------------------
    // 4. Authenticate caller strictly from verified JWT claims
    // -------------------------------------------------------------------------
    const authUser = await getAuthenticatedUser(request);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }
    if (authUser.role !== "owner" && authUser.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    const targetCenterId = authUser.centerId;

    // -------------------------------------------------------------------------
    // 5. Look up student record & verify tenant scoping
    // -------------------------------------------------------------------------
    const studentDoc = await Student.findById(studentId);
    if (!studentDoc) {
      return NextResponse.json(
        { success: false, error: "Student record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (studentDoc.centerId !== targetCenterId) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized access to student outside authenticated center",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // -------------------------------------------------------------------------
    // 6. Resolve Transaction Context & Financial Parameters
    // -------------------------------------------------------------------------
    const collectorId = new mongoose.Types.ObjectId(authUser.userId);
    const collectorRole = authUser.role;
    const collectorName =
      authUser.name || (collectorRole === "owner" ? "Institute Owner" : "Teacher");

    const responsibleTeacherId = studentDoc.assignedTeacherId ?? null;
    const responsibleBatch = studentDoc.batch ?? "";

    const now = new Date();
    const resolvedPaymentDate =
      paymentDate && !isNaN(new Date(paymentDate).getTime())
        ? new Date(paymentDate)
        : now;
    const dateComp = getISTDateComponents(now);

    const isAdvance =
      String(type || "").toLowerCase().includes("advance") ||
      String(notes || "").toLowerCase().includes("advance") ||
      body.isAdvance === true ||
      body.feeType === "advance";

    const resolvedFeeType = isAdvance
      ? "advance"
      : body.feeType === "adhoc" || String(type || "").toLowerCase().includes("adhoc")
      ? "adhoc"
      : body.feeType === "registration" ||
        String(type || "").toLowerCase().includes("registration")
      ? "registration"
      : "monthly_recurring";

    let targetBillingMonth = body.billingMonth;
    if (
      !targetBillingMonth &&
      body.month &&
      /^\d{4}-\d{2}$/.test(String(body.month).trim())
    ) {
      targetBillingMonth = String(body.month).trim();
    }
    if (!targetBillingMonth && resolvedFeeType === "monthly_recurring") {
      targetBillingMonth = dateComp.billingMonth;
    }

    if (
      !body.feeId &&
      resolvedFeeType === "monthly_recurring" &&
      (!targetBillingMonth || !/^\d{4}-\d{2}$/.test(targetBillingMonth))
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid billingMonth format: "${targetBillingMonth}". Expected YYYY-MM.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const incomingFeeId =
      body.feeId && String(body.feeId).trim() ? String(body.feeId).trim() : null;

    let targetedFeeDoc: IFeeDocument | null = null;
    if (incomingFeeId) {
      if (!mongoose.Types.ObjectId.isValid(incomingFeeId)) {
        return NextResponse.json(
          {
            success: false,
            code: "INVALID_FEE_ID",
            error: `Invalid fee ID format: "${incomingFeeId}".`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
      targetedFeeDoc = (await Fee.findOne({
        _id: new mongoose.Types.ObjectId(incomingFeeId),
        centerId: targetCenterId,
        studentId: new mongoose.Types.ObjectId(studentId),
      })) as unknown as IFeeDocument | null;

      if (!targetedFeeDoc) {
        return NextResponse.json(
          {
            success: false,
            code: "FEE_NOT_FOUND",
            error: `Target fee document "${incomingFeeId}" could not be found for this student.`,
          },
          { status: 404, headers: corsHeaders }
        );
      }
    }

    const receiptNumber = generateReceiptNumber();
    const noteText = notes ? String(notes).trim() : "";

    // -------------------------------------------------------------------------
    // 7. Idempotency Check & In-Flight Concurrency Guard
    // -------------------------------------------------------------------------
    if (clientKey) {
      inFlightLockKey = `${targetCenterId}:${clientKey}`;

      // 7.1 Check process-level in-flight guard
      if (inFlightIdempotencyKeys.has(inFlightLockKey)) {
        return NextResponse.json(
          {
            success: false,
            code: "IDEMPOTENCY_IN_FLIGHT",
            error:
              "A payment with this idempotency key is currently being processed. Please retry shortly.",
          },
          {
            status: 409,
            headers: {
              ...corsHeaders,
              "Retry-After": "1",
            },
          }
        );
      }

      // Mark this key as in-flight BEFORE performing any async DB queries
      inFlightIdempotencyKeys.add(inFlightLockKey);

      // 7.2 Check durable database for completed idempotent payment
      const findKeyQuery = Fee.findOne({
        centerId: targetCenterId,
        "paymentHistory.idempotencyKey": clientKey,
      });
      const existingFeeWithKey = (
        typeof (findKeyQuery as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
          ? await (findKeyQuery as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
          : await findKeyQuery
      ) as unknown as IFeeDocument | null;

      if (existingFeeWithKey) {
        const matchingEntry = (
          (existingFeeWithKey.paymentHistory as unknown as Array<IPaymentEntry>) || []
        ).find(
          (p) =>
            (p.idempotencyKey ||
              (p as unknown as { get?: (k: string) => unknown }).get?.("idempotencyKey")) ===
            clientKey
        );

        if (matchingEntry) {
          const verifyRes = verifyIdempotentPayloadMatch({
            existingFee: existingFeeWithKey,
            matchingEntry,
            incomingCenterId: targetCenterId,
            incomingStudentId: String(studentId),
            incomingAmount: parsedAmount,
            incomingFeeId,
            incomingBillingMonth: targetBillingMonth,
            incomingFeeType: resolvedFeeType,
            incomingPaymentMode: resolvedPaymentMode,
            incomingUtrNumber: cleanUtrNumber,
          });

          if (verifyRes.isMatch) {
            // Idempotent replay: return exact existing transaction without duplicate mutations or WhatsApp
            const custodyBreakdown = resolveCustody(existingFeeWithKey);
            return NextResponse.json(
              {
                success: true,
                settledExisting: true,
                idempotentReplay: true,
                message: `Payment was already successfully recorded (Idempotent replay). Receipt: ${matchingEntry.receiptNumber}`,
                data: formatFeeResponse(existingFeeWithKey, collectorRole),
                ...(custodyBreakdown ? { custodyBreakdown } : {}),
              },
              { status: 200, headers: corsHeaders }
            );
          } else {
            return NextResponse.json(
              {
                success: false,
                code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
                error: `Idempotency key has already been used with a different payment payload (${verifyRes.mismatchReason || "payload parameter mismatch"}).`,
              },
              { status: 409, headers: corsHeaders }
            );
          }
        }
      }
    }

    const paymentEntryId = new mongoose.Types.ObjectId();
    const newPaymentEntry: IPaymentEntry = {
      _id: paymentEntryId,
      paymentId: paymentEntryId,
      amount: parsedAmount,
      paymentDate: resolvedPaymentDate,
      paymentMode: resolvedPaymentMode,
      receiptNumber: receiptNumber,
      isProvisional: collectorRole === "teacher",
      receivedBy: collectorId,
      receivedByRole: collectorRole,
      recordedBy: collectorId,
      recordedByRole: collectorRole,
      recordedAt: now,
      assignedTeacherAtPayment: responsibleTeacherId,
      batchAtPayment: responsibleBatch,
      custodyStatus:
        collectorRole === "teacher" ? "teacher_custody" : "owner_custody",
      allocations: [],
      notes: noteText,
      ...(clientKey ? { idempotencyKey: clientKey } : {}),
    } as IPaymentEntry;

    // -------------------------------------------------------------------------
    // Branch A: Non-Recurring Fees (advance, registration, adhoc)
    // Only applies if NOT targeting an existing fee document!
    // -------------------------------------------------------------------------
    if (!targetedFeeDoc && resolvedFeeType !== "monthly_recurring") {
      const currentMonthName = now.toLocaleString("en-IN", {
        month: "long",
        year: "numeric",
      });

      const feeTitle = isAdvance
        ? noteText || "Advance Fee Payment"
        : noteText ||
          `${
            resolvedFeeType === "registration"
              ? "Registration Fee"
              : "Ad-hoc Fee"
          } (${currentMonthName})`;

      const monthString = isAdvance
        ? `Advance - ${currentMonthName}`
        : currentMonthName;

      let manualNonRecurringFee: IFeeDocument;
      try {
        manualNonRecurringFee = (await Fee.create({
          centerId: targetCenterId,
          studentId: new mongoose.Types.ObjectId(studentId),
          month: monthString,
          title: feeTitle,
          originalAmountDue: parsedAmount,
          amountDue: parsedAmount,
          paidAmount: parsedAmount,
          dueDate: now,
          status: "Paid",
          paymentMode: resolvedPaymentMode,
          feeType: resolvedFeeType,
          isAdvance: isAdvance,
          notes: noteText,
          receiptNumber: receiptNumber,
          paidDate: resolvedPaymentDate,
          paidAt: now,
          paymentDate: resolvedPaymentDate,
          ...(cleanUtrNumber ? { utrNumber: cleanUtrNumber } : {}),
          assignedTeacherId: responsibleTeacherId,
          assignedTeacherAtPayment: responsibleTeacherId,
          batchAtPayment: responsibleBatch,
          recordedBy: collectorId,
          recordedByRole: collectorRole,
          receivedBy: collectorId,
          receivedByRole: collectorRole,
          recordedAt: now,
          paymentHistory: [newPaymentEntry],
        })) as unknown as IFeeDocument;

        if (isAdvance && parsedAmount > 0) {
          try {
            await creditAdvanceToStudentWallet({
              centerId: targetCenterId,
              studentId: String(studentId),
              amount: parsedAmount,
              feeId: String(manualNonRecurringFee._id),
            });
            manualNonRecurringFee.walletRechargeCredited = true;
          } catch (walletErr) {
            console.error("[MANUAL COLLECTION] Error crediting advance wallet:", walletErr);
          }
        }
      } catch (createErr: unknown) {
        if (
          clientKey &&
          (createErr as { code?: number })?.code === 11000
        ) {
          const replayQuery = Fee.findOne({
            centerId: targetCenterId,
            "paymentHistory.idempotencyKey": clientKey,
          });
          const replayFee = (
            typeof (replayQuery as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
              ? await (replayQuery as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
              : await replayQuery
          ) as unknown as IFeeDocument | null;

          if (replayFee) {
            const matching = (
              (replayFee.paymentHistory as unknown as Array<IPaymentEntry>) || []
            ).find(
              (p) =>
                (p.idempotencyKey ||
                  (p as unknown as { get?: (k: string) => unknown }).get?.("idempotencyKey")) ===
                clientKey
            );
            if (matching) {
              const verifyRes = verifyIdempotentPayloadMatch({
                existingFee: replayFee,
                matchingEntry: matching,
                incomingCenterId: targetCenterId,
                incomingStudentId: String(studentId),
                incomingAmount: parsedAmount,
                incomingFeeId,
                incomingBillingMonth: targetBillingMonth,
                incomingFeeType: resolvedFeeType,
                incomingPaymentMode: resolvedPaymentMode,
                incomingUtrNumber: cleanUtrNumber,
              });

              if (verifyRes.isMatch) {
                const custodyBreakdown = resolveCustody(replayFee);
                return NextResponse.json(
                  {
                    success: true,
                    settledExisting: false,
                    idempotentReplay: true,
                    message: `Payment was already successfully recorded (Idempotent replay). Receipt: ${matching.receiptNumber}`,
                    data: formatFeeResponse(replayFee, collectorRole),
                    ...(custodyBreakdown ? { custodyBreakdown } : {}),
                  },
                  { status: 200, headers: corsHeaders }
                );
              } else {
                return NextResponse.json(
                  {
                    success: false,
                    code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
                    error: `Idempotency key has already been used with a different payment payload (${verifyRes.mismatchReason || "payload parameter mismatch"}).`,
                  },
                  { status: 409, headers: corsHeaders }
                );
              }
            }
          }
        }
        throw createErr;
      }

      const findCreated = Fee.findById(manualNonRecurringFee._id);
      const populatedFee = (
        typeof (findCreated as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
          ? await (findCreated as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
          : await findCreated
      ) as unknown as IFeeDocument | null;

      if (
        populatedFee?.studentId &&
        (populatedFee.studentId as unknown as { parentWhatsApp?: string }).parentWhatsApp
      ) {
        const sDoc = populatedFee.studentId as unknown as {
          parentWhatsApp?: string;
          name?: string;
          _id?: unknown;
        };
        sendPaymentReceipt(
          targetCenterId,
          sDoc.parentWhatsApp!,
          sDoc.name || "Student",
          parsedAmount,
          receiptNumber,
          sDoc._id?.toString()
        ).catch((dispatchErr) => {
          console.warn(
            "[MANUAL COLLECTION] WhatsApp receipt dispatch warning:",
            dispatchErr.message
          );
        });
      }

      const custodyBreakdown = resolveCustody(populatedFee);

      const allocationBreakdown = {
        totalReceived: parsedAmount,
        clearedDuesAmount: isAdvance ? 0 : parsedAmount,
        advanceSavedAmount: isAdvance ? parsedAmount : 0,
        clearedFeeIds: isAdvance ? [] : [String(manualNonRecurringFee._id)],
        summaryText: isAdvance
          ? `₹${parsedAmount.toLocaleString("en-IN")} saved as advance`
          : `₹${parsedAmount.toLocaleString("en-IN")} due cleared`,
      };

      await createCollectionNotifications({
        centerId: targetCenterId,
        amount: parsedAmount,
        studentId: String(studentDoc._id),
        studentName: (populatedFee?.studentId as { name?: string })?.name || studentDoc.name || "Student",
        collectorId: String(collectorId),
        collectorName,
        collectorRole,
        feeId: String(manualNonRecurringFee._id),
        paymentId: String(newPaymentEntry.paymentId || (manualNonRecurringFee.paymentHistory?.[0] as unknown as { _id?: unknown })?._id || ""),
        receiptNumber,
        idempotencyKey: clientKey || undefined,
      });

      return NextResponse.json(
        {
          success: true,
          settledExisting: false,
          idempotentReplay: false,
          message: allocationBreakdown.summaryText,
          data: formatFeeResponse(populatedFee, collectorRole),
          allocationBreakdown,
          ...(custodyBreakdown ? { custodyBreakdown } : {}),
        },
        { status: 201, headers: corsHeaders }
      );
    }

    // -------------------------------------------------------------------------
    // Branch B: Fee Deduplication & Settlement
    // -------------------------------------------------------------------------
    let eligibleCandidates: IFeeDocument[] = [];

    if (targetedFeeDoc) {
      eligibleCandidates = [targetedFeeDoc];
    } else {
      const candidateQuery: Record<string, unknown> = {
        centerId: targetCenterId,
        studentId: new mongoose.Types.ObjectId(studentId),
        feeType: { $ne: "advance" },
        isAdvance: { $ne: true },
        $or: [
          { billingMonth: targetBillingMonth },
          {
            month: {
              $in: [
                targetBillingMonth,
                dateComp.monthLabel,
                dateComp.shortMonthLabel,
              ],
            },
          },
        ],
      };

      const candidates = (await Fee.find(
        candidateQuery
      )) as unknown as IFeeDocument[];

      eligibleCandidates = candidates.filter(
        (c) =>
          c.feeType !== "advance" &&
          c.feeType !== "adhoc" &&
          c.feeType !== "registration" &&
          !c.isAdvance
      );
    }

    // Conflict Rule 1: Multiple candidates
    if (eligibleCandidates.length > 1) {
      const statuses = eligibleCandidates.map((c) => c.status).join(", ");
      return NextResponse.json(
        {
          success: false,
          code: "MULTIPLE_CANDIDATE_FEES",
          error: `Multiple candidate fee records (${eligibleCandidates.length}) exist for billing cycle ${targetBillingMonth} (${statuses}). Safe reconciliation is required before collecting payment.`,
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // Conflict Rule 2: Online Verification Pending
    if (
      eligibleCandidates.length === 1 &&
      eligibleCandidates[0].status === "Verification Pending"
    ) {
      const candidate = eligibleCandidates[0];
      return NextResponse.json(
        {
          success: false,
          code: "VERIFICATION_PENDING_CONFLICT",
          error: `An online payment verification is currently pending for billing cycle ${targetBillingMonth} (Fee ID: ${candidate._id}, UTR: ${candidate.utrNumber || "N/A"}). Please verify or reject the online payment before collecting cash.`,
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // Conflict Rule 3: Already Paid in Full
    if (
      eligibleCandidates.length === 1 &&
      (eligibleCandidates[0].status === "Paid" || (Number(eligibleCandidates[0].amountDue) <= 0 && Number(eligibleCandidates[0].paidAmount) > 0))
    ) {
      const candidate = eligibleCandidates[0];
      return NextResponse.json(
        {
          success: false,
          code: "FEE_ALREADY_PAID",
          error: `Monthly fee for billing cycle ${targetBillingMonth} is already Paid in full (Fee ID: ${candidate._id}, Receipt: ${candidate.receiptNumber || "N/A"}). Duplicate collection is blocked.`,
          data: formatFeeResponse(candidate, authUser.role),
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // Eligible Candidate Exists with Status 'Pending' or 'Partial Paid' -> Settle / Update
    if (eligibleCandidates.length === 1) {
      const candidate = eligibleCandidates[0];

      const currentRemainingDue = Number(candidate.amountDue);
      const priorPaidAmount = Number(candidate.paidAmount) || 0;

      // -----------------------------------------------------------------------
      // 9. Legacy Financial Inconsistency Guard (Reject; Never Silently Repair)
      // -----------------------------------------------------------------------
      const isNegativeAmountDue = currentRemainingDue < 0;
      const isNegativePaidAmount = priorPaidAmount < 0;
      const isPaidWithActiveDebt =
        candidate.status === "Paid" && currentRemainingDue > 0;
      const isPendingZeroZero =
        candidate.status === "Pending" &&
        currentRemainingDue === 0 &&
        priorPaidAmount === 0;

      if (
        isNegativeAmountDue ||
        isNegativePaidAmount ||
        isPaidWithActiveDebt ||
        isPendingZeroZero
      ) {
        return NextResponse.json(
          {
            success: false,
            code: "LEGACY_FINANCIAL_INCONSISTENCY",
            error:
              "Cannot record payment on corrupted fee ledger record. Administrative reconciliation is required.",
            details: {
              feeId: candidate._id,
              amountDue: candidate.amountDue,
              paidAmount: candidate.paidAmount,
              status: candidate.status,
            },
            reconciliationRequired: true,
          },
          { status: 422, headers: corsHeaders }
        );
      }

      // -----------------------------------------------------------------------
      // FIFO Auto-Allocation & Surplus Advance
      // -----------------------------------------------------------------------
      const amountToApply = Math.min(parsedAmount, currentRemainingDue);
      const isFullPayment = amountToApply === currentRemainingDue;
      const totalPaidSoFar = priorPaidAmount + amountToApply;
      const newRemainingDue = isFullPayment ? 0 : currentRemainingDue - amountToApply;
      const baselineOriginalAmount =
        candidate.originalAmountDue || (currentRemainingDue + priorPaidAmount);

      const auditEntry = `[${now.toISOString()}] Cash collected: ₹${amountToApply} (Receipt: ${receiptNumber})${
        noteText ? ` - ${noteText}` : ""
      }`;
      const updatedNotes = candidate.notes
        ? `${candidate.notes}\n${auditEntry}`
        : auditEntry;

      const attributionSet: Record<string, unknown> = {};
      const hasPriorPayment =
        candidate.status === "Partial Paid" ||
        Boolean(candidate.paymentDate) ||
        Boolean(candidate.paidDate);

      if (!hasPriorPayment) {
        attributionSet.assignedTeacherAtPayment = responsibleTeacherId;
        attributionSet.batchAtPayment = responsibleBatch;
      }
      if (!candidate.recordedBy) {
        attributionSet.recordedBy = collectorId;
        attributionSet.recordedByRole = collectorRole;
      }
      if (!candidate.receivedBy) {
        attributionSet.receivedBy = collectorId;
        attributionSet.receivedByRole = collectorRole;
      }
      if (!candidate.recordedAt) {
        attributionSet.recordedAt = now;
      }

      // Update payment entry amount for candidate
      newPaymentEntry.amount = amountToApply;

      // -----------------------------------------------------------------------
      // One Conditional Atomic Update on Fee Document (Single-Document Atomicity)
      // -----------------------------------------------------------------------
      const updateQuery: Record<string, unknown> = {
        _id: candidate._id,
        centerId: targetCenterId,
        status: { $in: ["Pending", "Partial Paid"] },
        amountDue: candidate.amountDue, // Exact optimistic balance guard against concurrent races
      };

      if (clientKey) {
        updateQuery["paymentHistory.idempotencyKey"] = { $ne: clientKey };
      }

      const updateOp = Fee.findOneAndUpdate(
        updateQuery,
        {
          $set: {
            status: isFullPayment ? "Paid" : "Partial Paid",
            amountDue: newRemainingDue,
            paidAmount: totalPaidSoFar,
            originalAmountDue: baselineOriginalAmount,
            receiptNumber: receiptNumber,
            paymentMode: resolvedPaymentMode,
            paidDate: resolvedPaymentDate,
            paidAt: now,
            paymentDate: resolvedPaymentDate,
            feeType: candidate.feeType || resolvedFeeType || "monthly_recurring",
            ...(candidate.billingMonth
              ? { billingMonth: candidate.billingMonth }
              : targetBillingMonth
              ? { billingMonth: targetBillingMonth }
              : {}),
            rejectionReason: null,
            notes: updatedNotes,
            ...(cleanUtrNumber ? { utrNumber: cleanUtrNumber } : {}),
            ...attributionSet,
          },
          $push: {
            paymentHistory: newPaymentEntry,
          },
        },
        { new: true }
      );

      const updatedFee = (
        typeof (updateOp as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
          ? await (updateOp as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
          : await updateOp
      ) as unknown as IFeeDocument | null;

      if (!updatedFee) {
        // Check if failure was caused by duplicate idempotencyKey submitted concurrently
        if (clientKey) {
          const replayQuery = Fee.findOne({
            centerId: targetCenterId,
            "paymentHistory.idempotencyKey": clientKey,
          });
          const replayFee = (
            typeof (replayQuery as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
              ? await (replayQuery as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
              : await replayQuery
          ) as unknown as IFeeDocument | null;

          if (replayFee) {
            const matching = (
              (replayFee.paymentHistory as unknown as Array<IPaymentEntry>) || []
            ).find(
              (p) =>
                (p.idempotencyKey ||
                  (p as unknown as { get?: (k: string) => unknown }).get?.("idempotencyKey")) ===
                clientKey
            );

            if (matching) {
              const verifyRes = verifyIdempotentPayloadMatch({
                existingFee: replayFee,
                matchingEntry: matching,
                incomingCenterId: targetCenterId,
                incomingStudentId: String(studentId),
                incomingAmount: parsedAmount,
                incomingFeeId,
                incomingBillingMonth: targetBillingMonth,
                incomingFeeType: resolvedFeeType,
                incomingPaymentMode: resolvedPaymentMode,
                incomingUtrNumber: cleanUtrNumber,
              });

              if (verifyRes.isMatch) {
                const custodyBreakdown = resolveCustody(replayFee);
                return NextResponse.json(
                  {
                    success: true,
                    settledExisting: true,
                    idempotentReplay: true,
                    message: `Payment was already successfully recorded (Idempotent replay). Receipt: ${matching.receiptNumber}`,
                    data: formatFeeResponse(replayFee, collectorRole),
                    ...(custodyBreakdown ? { custodyBreakdown } : {}),
                  },
                  { status: 200, headers: corsHeaders }
                );
              } else {
                return NextResponse.json(
                  {
                    success: false,
                    code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
                    error: `Idempotency key has already been used with a different payment payload (${verifyRes.mismatchReason || "payload parameter mismatch"}).`,
                  },
                  { status: 409, headers: corsHeaders }
                );
              }
            }
          }
        }

        return NextResponse.json(
          {
            success: false,
            code: "CONCURRENT_MODIFICATION_CONFLICT",
            error:
              "Concurrent payment conflict: Fee record was already updated or settled by another transaction.",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      // WhatsApp receipt dispatch on successful new payment
      if (
        isFullPayment &&
        updatedFee?.studentId &&
        (updatedFee.studentId as unknown as { parentWhatsApp?: string }).parentWhatsApp
      ) {
        const sDoc = updatedFee.studentId as unknown as {
          parentWhatsApp?: string;
          name?: string;
          _id?: unknown;
        };
        sendPaymentReceipt(
          targetCenterId,
          sDoc.parentWhatsApp!,
          sDoc.name || "Student",
          parsedAmount,
          receiptNumber,
          sDoc._id?.toString()
        ).catch((dispatchErr) => {
          console.warn(
            "[MANUAL COLLECTION] WhatsApp receipt dispatch warning:",
            dispatchErr.message
          );
        });
      }

      const custodyBreakdown = resolveCustody(updatedFee);

      let clearedDuesAmount = amountToApply;
      let advanceSavedAmount = 0;
      const clearedFeeIds: string[] = isFullPayment ? [String(candidate._id)] : [];
      let remainingToAllocate = parsedAmount - amountToApply;

      // Smart Advance Wallet: If targeted fee was already an advance fee, credit the student's wallet
      if (
        updatedFee &&
        (updatedFee.isAdvance || updatedFee.feeType === "advance") &&
        !updatedFee.walletRechargeCredited
      ) {
        try {
          await creditAdvanceToStudentWallet({
            centerId: targetCenterId,
            studentId: String(studentDoc._id || studentId),
            amount: amountToApply,
            feeId: String(updatedFee._id),
          });
          updatedFee.walletRechargeCredited = true;
          advanceSavedAmount = amountToApply;
          clearedDuesAmount = 0;
        } catch (walletErr) {
          console.error("[MANUAL COLLECTION] Error crediting advance wallet on targeted fee:", walletErr);
        }
      }

      // FIFO Allocation across other pending fees if surplus remains
      if (remainingToAllocate > 0) {
        const otherPendingQuery = Fee.find({
          centerId: targetCenterId,
          studentId: new mongoose.Types.ObjectId(studentId),
          _id: { $ne: candidate._id },
          status: { $in: ["Pending", "Partial Paid"] },
          feeType: { $ne: "advance" },
          isAdvance: { $ne: true },
        });
        const otherPendingFees = (
          typeof (otherPendingQuery as unknown as { sort?: (s: unknown) => Promise<unknown> })?.sort === "function"
            ? await (otherPendingQuery as unknown as { sort: (s: unknown) => Promise<unknown> }).sort({ dueDate: 1, createdAt: 1 })
            : await otherPendingQuery
        ) as unknown as IFeeDocument[];

        for (const otherFee of otherPendingFees) {
          if (remainingToAllocate <= 0) break;
          const otherDue = Number(otherFee.amountDue) || 0;
          const otherPriorPaid = Number(otherFee.paidAmount) || 0;
          if (otherDue <= 0) continue;

          const otherApply = Math.min(remainingToAllocate, otherDue);
          const otherFull = otherApply === otherDue;
          const otherNewDue = otherFull ? 0 : otherDue - otherApply;
          const otherTotalPaid = otherPriorPaid + otherApply;
          const otherBaseline = otherFee.originalAmountDue || (otherDue + otherPriorPaid);

          const otherPaymentEntryId = new mongoose.Types.ObjectId();
          const otherPaymentEntry: IPaymentEntry = {
            _id: otherPaymentEntryId,
            paymentId: otherPaymentEntryId,
            amount: otherApply,
            paymentDate: resolvedPaymentDate,
            paymentMode: resolvedPaymentMode,
            receiptNumber: receiptNumber,
            isProvisional: collectorRole === "teacher",
            receivedBy: collectorId,
            receivedByRole: collectorRole,
            recordedBy: collectorId,
            recordedByRole: collectorRole,
            recordedAt: now,
            assignedTeacherAtPayment: responsibleTeacherId,
            batchAtPayment: responsibleBatch,
            custodyStatus: collectorRole === "teacher" ? "teacher_custody" : "owner_custody",
            allocations: [],
            notes: noteText ? `${noteText} (FIFO Auto-Allocation)` : "FIFO Auto-Allocation",
          } as IPaymentEntry;

          const otherAudit = `[${now.toISOString()}] Cash collected: ₹${otherApply} (Receipt: ${receiptNumber}) - FIFO auto-allocation`;
          const otherNotes = otherFee.notes ? `${otherFee.notes}\n${otherAudit}` : otherAudit;

          await Fee.findOneAndUpdate(
            {
              _id: otherFee._id,
              centerId: targetCenterId,
              status: { $in: ["Pending", "Partial Paid"] },
            },
            {
              $set: {
                status: otherFull ? "Paid" : "Partial Paid",
                amountDue: otherNewDue,
                paidAmount: otherTotalPaid,
                originalAmountDue: otherBaseline,
                notes: otherNotes,
                paidDate: resolvedPaymentDate,
                paidAt: now,
                paymentDate: resolvedPaymentDate,
              },
              $push: {
                paymentHistory: otherPaymentEntry,
              },
            }
          );

          clearedDuesAmount += otherApply;
          remainingToAllocate -= otherApply;
          if (otherFull) {
            clearedFeeIds.push(String(otherFee._id));
          }
        }
      }

      // Auto-Save Surplus as Advance if any balance remains after all pending dues
      if (remainingToAllocate > 0) {
        advanceSavedAmount += remainingToAllocate;
        const advancePaymentEntryId = new mongoose.Types.ObjectId();
        const advancePaymentEntry: IPaymentEntry = {
          _id: advancePaymentEntryId,
          paymentId: advancePaymentEntryId,
          amount: remainingToAllocate,
          paymentDate: resolvedPaymentDate,
          paymentMode: resolvedPaymentMode,
          receiptNumber: receiptNumber,
          isProvisional: collectorRole === "teacher",
          receivedBy: collectorId,
          receivedByRole: collectorRole,
          recordedBy: collectorId,
          recordedByRole: collectorRole,
          recordedAt: now,
          assignedTeacherAtPayment: responsibleTeacherId,
          batchAtPayment: responsibleBatch,
          custodyStatus: collectorRole === "teacher" ? "teacher_custody" : "owner_custody",
          allocations: [],
          notes: noteText ? `${noteText} (Surplus Advance)` : "Surplus payment saved as advance",
        } as IPaymentEntry;

        const currentMonthName = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
        const advanceFeeDoc = (await Fee.create({
          centerId: targetCenterId,
          studentId: new mongoose.Types.ObjectId(studentId),
          month: `Advance - ${currentMonthName}`,
          title: "Advance Fee Payment",
          originalAmountDue: remainingToAllocate,
          amountDue: remainingToAllocate,
          paidAmount: remainingToAllocate,
          dueDate: now,
          status: "Paid",
          paymentMode: resolvedPaymentMode,
          feeType: "advance",
          isAdvance: true,
          walletRechargeCredited: false,
          notes: noteText ? `${noteText} (Surplus)` : "Surplus payment saved as advance",
          receiptNumber: receiptNumber,
          paidDate: resolvedPaymentDate,
          paidAt: now,
          paymentDate: resolvedPaymentDate,
          ...(cleanUtrNumber ? { utrNumber: cleanUtrNumber } : {}),
          assignedTeacherId: responsibleTeacherId,
          assignedTeacherAtPayment: responsibleTeacherId,
          batchAtPayment: responsibleBatch,
          recordedBy: collectorId,
          recordedByRole: collectorRole,
          receivedBy: collectorId,
          receivedByRole: collectorRole,
          recordedAt: now,
          paymentHistory: [advancePaymentEntry],
        })) as unknown as IFeeDocument;

        try {
          await creditAdvanceToStudentWallet({
            centerId: targetCenterId,
            studentId: String(studentId),
            amount: remainingToAllocate,
            feeId: String(advanceFeeDoc._id),
          });
          advanceFeeDoc.walletRechargeCredited = true;
        } catch (walletErr) {
          console.error("[MANUAL COLLECTION] Error crediting advance wallet:", walletErr);
        }
      }

      let summaryText = "";
      if (clearedDuesAmount > 0 && advanceSavedAmount > 0) {
        summaryText = `₹${clearedDuesAmount.toLocaleString("en-IN")} due cleared, ₹${advanceSavedAmount.toLocaleString("en-IN")} saved as advance`;
      } else if (clearedDuesAmount > 0 && advanceSavedAmount === 0) {
        if (clearedFeeIds.length > 0) {
          summaryText = `₹${clearedDuesAmount.toLocaleString("en-IN")} due cleared`;
        } else {
          summaryText = `₹${clearedDuesAmount.toLocaleString("en-IN")} applied to pending dues`;
        }
      } else if (advanceSavedAmount > 0) {
        summaryText = `₹${advanceSavedAmount.toLocaleString("en-IN")} saved as advance`;
      } else {
        summaryText = `₹${parsedAmount.toLocaleString("en-IN")} payment recorded`;
      }

      const allocationBreakdown = {
        totalReceived: parsedAmount,
        clearedDuesAmount,
        advanceSavedAmount,
        clearedFeeIds,
        summaryText,
      };

      await createCollectionNotifications({
        centerId: targetCenterId,
        amount: parsedAmount,
        studentId: String(studentDoc._id),
        studentName: (updatedFee?.studentId as { name?: string })?.name || studentDoc.name || "Student",
        collectorId: String(collectorId),
        collectorName,
        collectorRole,
        feeId: String(updatedFee?._id || candidate._id),
        paymentId: String(newPaymentEntry.paymentId || (newPaymentEntry as unknown as { _id?: unknown })._id || ""),
        receiptNumber,
        idempotencyKey: clientKey || undefined,
      });

      return NextResponse.json(
        {
          success: true,
          settledExisting: true,
          idempotentReplay: false,
          message: summaryText,
          data: formatFeeResponse(updatedFee, collectorRole),
          allocationBreakdown,
          ...(custodyBreakdown ? { custodyBreakdown } : {}),
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // -------------------------------------------------------------------------
    // Fallback: No candidate fee exists -> Create new Fee record set to 'Paid'
    // -------------------------------------------------------------------------
    const feeTitle =
      noteText || `Regular Monthly Fee (${dateComp.monthLabel})`;

    let newFee: IFeeDocument;
    try {
      newFee = (await Fee.create({
        centerId: targetCenterId,
        studentId: new mongoose.Types.ObjectId(studentId),
        billingMonth: targetBillingMonth,
        month: dateComp.monthLabel,
        title: feeTitle,
        originalAmountDue: parsedAmount,
        amountDue: parsedAmount,
        paidAmount: parsedAmount,
        dueDate: now,
        status: "Paid",
        paymentMode: resolvedPaymentMode,
        feeType: "monthly_recurring",
        isAdvance: false,
        notes: noteText,
        receiptNumber: receiptNumber,
        paidDate: resolvedPaymentDate,
        paidAt: now,
        paymentDate: resolvedPaymentDate,
        ...(cleanUtrNumber ? { utrNumber: cleanUtrNumber } : {}),
        assignedTeacherId: responsibleTeacherId,
        assignedTeacherAtPayment: responsibleTeacherId,
        batchAtPayment: responsibleBatch,
        recordedBy: collectorId,
        recordedByRole: collectorRole,
        receivedBy: collectorId,
        receivedByRole: collectorRole,
        recordedAt: now,
        paymentHistory: [newPaymentEntry],
      })) as unknown as IFeeDocument;
    } catch (createErr: unknown) {
      if (
        clientKey &&
        (createErr as { code?: number })?.code === 11000
      ) {
        const replayQuery = Fee.findOne({
          centerId: targetCenterId,
          "paymentHistory.idempotencyKey": clientKey,
        });
        const replayFee = (
          typeof (replayQuery as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
            ? await (replayQuery as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
            : await replayQuery
        ) as unknown as IFeeDocument | null;

        if (replayFee) {
          const matching = (
            (replayFee.paymentHistory as unknown as Array<IPaymentEntry>) || []
          ).find(
            (p) =>
              (p.idempotencyKey ||
                (p as unknown as { get?: (k: string) => unknown }).get?.("idempotencyKey")) ===
              clientKey
          );
          if (matching) {
            const verifyRes = verifyIdempotentPayloadMatch({
              existingFee: replayFee,
              matchingEntry: matching,
              incomingCenterId: targetCenterId,
              incomingStudentId: String(studentId),
              incomingAmount: parsedAmount,
              incomingFeeId,
              incomingBillingMonth: targetBillingMonth,
              incomingFeeType: resolvedFeeType,
              incomingPaymentMode: resolvedPaymentMode,
              incomingUtrNumber: cleanUtrNumber,
            });

            if (verifyRes.isMatch) {
              const custodyBreakdown = resolveCustody(replayFee);
              return NextResponse.json(
                {
                  success: true,
                  settledExisting: false,
                  idempotentReplay: true,
                  message: `Payment was already successfully recorded (Idempotent replay). Receipt: ${matching.receiptNumber}`,
                  data: formatFeeResponse(replayFee, collectorRole),
                  ...(custodyBreakdown ? { custodyBreakdown } : {}),
                },
                { status: 200, headers: corsHeaders }
              );
            } else {
              return NextResponse.json(
                {
                  success: false,
                  code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
                  error: `Idempotency key has already been used with a different payment payload (${verifyRes.mismatchReason || "payload parameter mismatch"}).`,
                },
                { status: 409, headers: corsHeaders }
              );
            }
          }
        }
      }
      throw createErr;
    }

    const findFallback = Fee.findById(newFee._id);
    const populatedFee = (
      typeof (findFallback as unknown as { populate?: (path: string) => Promise<unknown> })?.populate === "function"
        ? await (findFallback as unknown as { populate: (path: string) => Promise<unknown> }).populate("studentId")
        : await findFallback
    ) as unknown as IFeeDocument | null;

    if (
      populatedFee?.studentId &&
      (populatedFee.studentId as unknown as { parentWhatsApp?: string }).parentWhatsApp
    ) {
      const sDoc = populatedFee.studentId as unknown as {
        parentWhatsApp?: string;
        name?: string;
        _id?: unknown;
      };
      sendPaymentReceipt(
        targetCenterId,
        sDoc.parentWhatsApp!,
        sDoc.name || "Student",
        parsedAmount,
        receiptNumber,
        sDoc._id?.toString()
      ).catch((dispatchErr) => {
        console.warn(
          "[MANUAL COLLECTION] WhatsApp receipt dispatch warning:",
          dispatchErr.message
        );
      });
    }

    const custodyBreakdown = resolveCustody(populatedFee);

    await createCollectionNotifications({
      centerId: targetCenterId,
      amount: parsedAmount,
      studentId: String(studentDoc._id),
      studentName:
        (populatedFee?.studentId as { name?: string })?.name ||
        studentDoc.name ||
        "Student",
      collectorId: String(collectorId),
      collectorName,
      collectorRole,
      feeId: String(newFee._id),
      paymentId: String(
        newPaymentEntry.paymentId ||
          (newFee.paymentHistory?.[0] as unknown as { _id?: unknown })?._id ||
          ""
      ),
      receiptNumber,
      idempotencyKey: clientKey || undefined,
    });

    const allocationBreakdown = {
      totalReceived: parsedAmount,
      clearedDuesAmount: parsedAmount,
      advanceSavedAmount: 0,
      clearedFeeIds: [String(newFee._id)],
      summaryText: `₹${parsedAmount.toLocaleString("en-IN")} due cleared`,
    };

    return NextResponse.json(
      {
        success: true,
        settledExisting: false,
        idempotentReplay: false,
        message: allocationBreakdown.summaryText,
        data: formatFeeResponse(populatedFee, collectorRole),
        allocationBreakdown,
        ...(custodyBreakdown ? { custodyBreakdown } : {}),
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
      const errObj = error as {
        keyPattern?: Record<string, unknown>;
        keyValue?: Record<string, unknown>;
        message?: unknown;
      };
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
      throw error;
    }

    const errorMsg =
      error instanceof Error
        ? error.message
        : "Failed to record manual cash payment";

    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  } finally {
    if (inFlightLockKey) {
      inFlightIdempotencyKeys.delete(inFlightLockKey);
    }
  }
}
