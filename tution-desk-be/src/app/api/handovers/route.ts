import { NextRequest, NextResponse } from "next/server.js";
import mongoose, { Types } from "mongoose";
import crypto from "crypto";
import connectDB from "../../../lib/db.ts";
import Fee, {
  type IFeeDocument,
  type IPaymentAllocation,
  getLockedAllocationAmount,
  calculatePaymentCustody,
  matchPaymentEntry,
} from "../../../models/Fee.ts";
import CashHandover, {
  type IHandoverItemAllocation,
  type ICashHandoverDocument,
} from "../../../models/CashHandover.ts";
import Teacher from "../../../models/Teacher.ts";
import StaffNotification from "../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

function generateHandoverNumber(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `HO-${dateStr}-${randomSuffix}`;
}

interface IncomingHandoverItem {
  feeId: string;
  paymentId: string;
  amount: number;
  studentId?: string;
  studentName?: string;
  receiptNumber?: string;
}

export async function POST(request: NextRequest) {
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

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const rawItems: IncomingHandoverItem[] = body.items;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Handover items array is required and must contain at least one allocation",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Determine target teacher identity for CashHandover
    let handoverTeacherId = user.userId;
    if (user.role === "teacher" && user.teacherId) {
      handoverTeacherId = String(user.teacherId);
    } else if (user.role === "owner" && body.teacherId) {
      if (!mongoose.Types.ObjectId.isValid(String(body.teacherId))) {
        return NextResponse.json(
          { success: false, error: "Invalid teacherId provided" },
          { status: 400, headers: corsHeaders }
        );
      }
      handoverTeacherId = String(body.teacherId);
    }

    // 4. Atomicity and concurrency: inspect session / transaction capability
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

    if (!session || !inTx) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Multi-document transactions are required for cash handover coordination but are currently unavailable on this MongoDB deployment.",
          code: "TRANSACTIONS_UNAVAILABLE",
        },
        { status: 503, headers: corsHeaders }
      );
    }

    try {
      // Step A: Deduplicate and aggregate item allocations by paymentId to prevent intra-request over-allocation
      const paymentItemMap = new Map<string, { feeId: string; paymentId: string; totalAmount: number; studentName?: string }>();

      for (const item of rawItems) {
        if (!item.feeId || !item.paymentId || item.amount === undefined || item.amount === null) {
          throw new CustomHandoverError(
            400,
            "INVALID_ITEM_PAYLOAD",
            "Each item must specify valid feeId, paymentId, and amount"
          );
        }

        const parsedAmount = Number(item.amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
          throw new CustomHandoverError(
            400,
            "INVALID_ALLOCATION_AMOUNT",
            "Item allocation amount must be a finite number greater than zero"
          );
        }

        const key = `${item.feeId}:${item.paymentId}`;
        const existing = paymentItemMap.get(key);
        if (existing) {
          existing.totalAmount += parsedAmount;
        } else {
          paymentItemMap.set(key, {
            feeId: String(item.feeId),
            paymentId: String(item.paymentId),
            totalAmount: parsedAmount,
            studentName: item.studentName,
          });
        }
      }

      // Step B: Load all referenced Fee documents in the transaction
      const uniqueFeeIds = Array.from(new Set(Array.from(paymentItemMap.values()).map((p) => p.feeId)));
      const feeDocs = (await Fee.find({
        _id: { $in: uniqueFeeIds },
      }).session(session)) as IFeeDocument[];

      const feeMap = new Map<string, IFeeDocument>();
      feeDocs.forEach((f) => feeMap.set(String(f._id), f));

      // Check existence and center isolation
      for (const feeId of uniqueFeeIds) {
        const feeDoc = feeMap.get(feeId);
        if (!feeDoc) {
          throw new CustomHandoverError(404, "FEE_NOT_FOUND", `Fee not found with ID: ${feeId}`);
        }
        if (feeDoc.centerId !== user.centerId) {
          throw new CustomHandoverError(
            403,
            "CROSS_CENTER_ACCESS_FORBIDDEN",
            `Fee ${feeId} does not belong to authenticated center ${user.centerId}`
          );
        }
      }

      // Step C: Validate payment entries and lock balances
      const handoverDocId = new Types.ObjectId();
      const handoverNumber = generateHandoverNumber();
      const handoverItems: IHandoverItemAllocation[] = [];
      const now = new Date();

      for (const reqItem of paymentItemMap.values()) {
        const feeDoc = feeMap.get(reqItem.feeId)!;
        const entry = (feeDoc.paymentHistory || []).find((p) =>
          matchPaymentEntry(p, reqItem.paymentId)
        );

        if (!entry) {
          throw new CustomHandoverError(
            404,
            "PAYMENT_ENTRY_NOT_FOUND",
            `Payment entry ${reqItem.paymentId} not found in Fee ${reqItem.feeId}`
          );
        }

        // Collector attribution check
        const entryReceiverId = String(
          entry.receivedBy ||
          (entry as unknown as { recordedBy?: unknown }).recordedBy ||
          feeDoc.receivedBy ||
          ""
        );
        if (user.role === "teacher") {
          const teacherIdentities = [String(user.userId)];
          if (user.teacherId) teacherIdentities.push(String(user.teacherId));

          if (!teacherIdentities.includes(entryReceiverId)) {
            throw new CustomHandoverError(
              403,
              "UNAUTHORIZED_COLLECTOR_ALLOCATION",
              `Teacher cannot hand over payment ${reqItem.paymentId} collected by ${entryReceiverId}`
            );
          }
        } else if (user.role === "owner" && body.teacherId) {
          // If Owner submits on behalf of teacher, entry must match that teacher
          if (entryReceiverId !== String(body.teacherId) && entryReceiverId !== String(user.userId)) {
            throw new CustomHandoverError(
              403,
              "UNAUTHORIZED_COLLECTOR_ALLOCATION",
              `Payment ${reqItem.paymentId} was not collected by specified teacher ${body.teacherId}`
            );
          }
        }

        // Available balance check
        const activeAllocated = (entry.allocations || []).reduce((sum, a) => {
          return sum + getLockedAllocationAmount(a);
        }, 0);

        const availableAmount = Math.max(0, Number(entry.amount) - activeAllocated);

        if (reqItem.totalAmount > availableAmount + 0.001) {
          throw new CustomHandoverError(
            400,
            "INSUFFICIENT_AVAILABLE_FUNDS",
            `Requested allocation of ₹${reqItem.totalAmount} exceeds available unlocked amount of ₹${availableAmount} on payment ${reqItem.paymentId}`
          );
        }

        // Generate allocation ID and construct new allocation
        const allocationId = new Types.ObjectId();
        const newAllocation: IPaymentAllocation = {
          _id: allocationId,
          allocationId,
          handoverId: handoverDocId,
          handoverNumber,
          allocatedAmount: reqItem.totalAmount,
          allocatedAt: now,
          allocatedBy: new Types.ObjectId(user.userId),
          status: "pending_verification",
        };

        entry.allocations = entry.allocations || [];
        entry.allocations.push(newAllocation);

        // Update entry custody status label
        const custodyBreakdown = calculatePaymentCustody(entry);
        entry.custodyStatus = custodyBreakdown.custodyLabel;

        // Construct handover line item
        handoverItems.push({
          allocationId,
          paymentId: new Types.ObjectId(reqItem.paymentId),
          feeId: new Types.ObjectId(reqItem.feeId),
          studentId: feeDoc.studentId,
          studentName: reqItem.studentName || "",
          amount: reqItem.totalAmount,
          receiptNumber: entry.receiptNumber || "RCPT",
        });
      }

      // Step D: Save all modified Fee documents within transaction
      for (const feeDoc of feeDocs) {
        // Mongoose pre-validate hook on FeeSchema runs here, asserting allocation invariants
        await feeDoc.save({ session });
      }

      // Step E: Create and save CashHandover document within transaction
      const totalSubmittedAmount = handoverItems.reduce((s, it) => s + it.amount, 0);

      const newHandover = new CashHandover({
        _id: handoverDocId,
        centerId: user.centerId,
        handoverNumber,
        teacherId: new Types.ObjectId(handoverTeacherId),
        submittedAmount: totalSubmittedAmount,
        approvedAmount: 0,
        discrepancyAmount: 0,
        status: "pending_approval",
        discrepancyStatus: "none",
        items: handoverItems,
        submittedAt: now,
        submissionNotes: typeof body.submissionNotes === "string" ? body.submissionNotes.trim() : "",
      });

      await newHandover.save({ session });

      // Create persistent StaffNotifications for Owner & Teacher
      if (mongoose.connection?.readyState === 1 || StaffNotification.find !== mongoose.Model.find) {
        try {
          const ownerNotifKey = `notif_handover_sub_owner_${handoverDocId}`;
          const existingOwnerNotif = await StaffNotification.findOne({ idempotencyKey: ownerNotifKey });
          if (!existingOwnerNotif) {
            const ownerNotif = new StaffNotification({
              centerId: user.centerId,
              recipientId: user.centerId,
              recipientRole: "owner",
              type: "handover_submitted",
              title: "New Handover Submitted",
              message: `Handover envelope ${handoverNumber} submitted for ₹${totalSubmittedAmount.toLocaleString("en-IN")}. Awaiting physical count.`,
              amount: totalSubmittedAmount,
              statusLabel: "Pending Physical Count",
              link: "/fees?tab=handovers",
              isRead: false,
              idempotencyKey: ownerNotifKey,
              metadata: { handoverId: String(handoverDocId), handoverNumber, teacherId: String(handoverTeacherId) },
            });
            await ownerNotif.save({ session });
          }

          const teacherNotifKey = `notif_handover_sub_teacher_${handoverDocId}`;
          const existingTeacherNotif = await StaffNotification.findOne({ idempotencyKey: teacherNotifKey });
          if (!existingTeacherNotif) {
            const teacherNotif = new StaffNotification({
              centerId: user.centerId,
              recipientId: String(handoverTeacherId),
              recipientRole: "teacher",
              type: "handover_submitted",
              title: "Handover Envelope Submitted",
              message: `Handover ${handoverNumber} submitted for ₹${totalSubmittedAmount.toLocaleString("en-IN")}. Status: Awaiting Owner Verification.`,
              amount: totalSubmittedAmount,
              statusLabel: "Awaiting Owner Count",
              link: "/fees?tab=handovers",
              isRead: false,
              idempotencyKey: teacherNotifKey,
              metadata: { handoverId: String(handoverDocId), handoverNumber },
            });
            await teacherNotif.save({ session });
          }
        } catch (notifErr) {
          console.warn("[HANDOVER] Non-fatal notification error on submission:", notifErr);
        }
      }

      // Step F: Commit transaction
      await session.commitTransaction();

      return NextResponse.json(
        {
          success: true,
          data: newHandover,
          message: `Cash handover ${handoverNumber} submitted successfully for ₹${totalSubmittedAmount}`,
        },
        { status: 201, headers: corsHeaders }
      );
    } catch (txErr: unknown) {
      await session.abortTransaction().catch(() => {});

      if (txErr instanceof CustomHandoverError) {
        return NextResponse.json(
          { success: false, error: txErr.message, code: txErr.code },
          { status: txErr.status, headers: corsHeaders }
        );
      }

      // Mongoose ValidationError
      if (txErr instanceof Error && txErr.name === "ValidationError") {
        return NextResponse.json(
          { success: false, error: txErr.message, code: "VALIDATION_ERROR" },
          { status: 400, headers: corsHeaders }
        );
      }

      // MongoDB duplicate key error (code 11000)
      if (
        txErr &&
        typeof txErr === "object" &&
        "code" in txErr &&
        (txErr as { code: number }).code === 11000
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Concurrent handover allocation conflict. Please retry.",
            code: "CONCURRENT_ALLOCATION_CONFLICT",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      const errMsg = txErr instanceof Error ? txErr.message : "Failed to process cash handover";
      return NextResponse.json(
        { success: false, error: errMsg },
        { status: 500, headers: corsHeaders }
      );
    } finally {
      await session.endSession().catch(() => {});
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function GET(request: NextRequest) {
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

    await connectDB();

    const { searchParams } = request.nextUrl;
    const filter: Record<string, unknown> = {
      centerId: user.centerId,
    };

    // Role-based scoping
    if (user.role === "teacher") {
      // Teachers can ONLY view their own submitted handovers
      const teacherObjectId = new Types.ObjectId(user.teacherId || user.userId);
      filter.teacherId = teacherObjectId;
    } else {
      // Owner can view all handovers across institute or filter by teacherId
      const targetTeacherParam = searchParams.get("teacherId");
      if (targetTeacherParam) {
        if (!mongoose.Types.ObjectId.isValid(targetTeacherParam)) {
          return NextResponse.json(
            { success: false, error: "Invalid teacherId query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
        filter.teacherId = new Types.ObjectId(targetTeacherParam);
      }
    }

    // Status filter
    const statusParam = searchParams.get("status");
    if (statusParam) {
      if (statusParam.includes(",")) {
        filter.status = { $in: statusParam.split(",").map((s) => s.trim()) };
      } else {
        filter.status = statusParam.trim();
      }
    }

    // Date range filter
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");
    if (startDateParam || endDateParam) {
      const dateQuery: Record<string, Date> = {};
      if (startDateParam) {
        const start = new Date(startDateParam);
        if (!isNaN(start.getTime())) {
          dateQuery.$gte = start;
        }
      }
      if (endDateParam) {
        const end = new Date(endDateParam);
        if (!isNaN(end.getTime())) {
          dateQuery.$lte = end;
        }
      }
      if (Object.keys(dateQuery).length > 0) {
        filter.submittedAt = dateQuery;
      }
    }

    const handovers = (await CashHandover.find(filter)
      .sort({ submittedAt: -1 })
      .lean()) as ICashHandoverDocument[];

    // Enrich with teacher names if available
    const teacherIds = Array.from(
      new Set(handovers.map((h) => String(h.teacherId)).filter((id) => mongoose.Types.ObjectId.isValid(id)))
    );

    const teachers = await Teacher.find({
      centerId: user.centerId,
      _id: { $in: teacherIds },
    }).select("_id name phone loginId");

    const teacherMap = new Map<string, string>();
    teachers.forEach((t) => teacherMap.set(String(t._id), t.name));

    const enrichedHandovers = handovers.map((h) => ({
      ...h,
      teacherName: teacherMap.get(String(h.teacherId)) || "Institute Faculty",
    }));

    return NextResponse.json(
      {
        success: true,
        count: enrichedHandovers.length,
        data: enrichedHandovers,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Failed to fetch cash handovers";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}

class CustomHandoverError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CustomHandoverError";
    this.status = status;
    this.code = code;
  }
}
