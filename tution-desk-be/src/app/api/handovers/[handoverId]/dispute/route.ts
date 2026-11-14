import { NextRequest, NextResponse } from "next/server.js";
import mongoose, { Types } from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Fee, {
  type IFeeDocument,
  matchPaymentEntry,
  matchPaymentAllocation,
} from "../../../../../models/Fee.ts";
import CashHandover, {
  type ICashHandoverDocument,
  type IHandoverDisputeEntry,
} from "../../../../../models/CashHandover.ts";
import StaffNotification from "../../../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, PUT, OPTIONS");
}

async function handleDispute(
  request: NextRequest,
  context: { params: Promise<{ handoverId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const { handoverId } = await context.params;

    if (!handoverId || !handoverId.trim()) {
      return NextResponse.json(
        { success: false, error: "Handover ID is required", code: "HANDOVER_ID_REQUIRED" },
        { status: 400, headers: corsHeaders }
      );
    }

    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    // Role check: Only Owner and Teacher can initiate a dispute
    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only Institute Owners and Teachers can participate in cash dispute workflows",
          code: "UNAUTHORIZED_ROLE",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const notes =
      typeof body.notes === "string"
        ? body.notes.trim()
        : typeof body.reason === "string"
        ? body.reason.trim()
        : "";

    if (!notes) {
      return NextResponse.json(
        {
          success: false,
          error: "A meaningful dispute reason or explanatory notes are required",
          code: "DISPUTE_REASON_REQUIRED",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Multi-document ACID transaction
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
            "Multi-document transactions are required for cash dispute initiation but are currently unavailable on this MongoDB deployment.",
          code: "TRANSACTIONS_UNAVAILABLE",
        },
        { status: 503, headers: corsHeaders }
      );
    }

    try {
      // Step 1: Find CashHandover document inside transaction
      const handoverFilter: Record<string, unknown> = {};
      if (mongoose.Types.ObjectId.isValid(handoverId)) {
        handoverFilter.$or = [
          { _id: new Types.ObjectId(handoverId) },
          { handoverNumber: handoverId },
        ];
      } else {
        handoverFilter.handoverNumber = handoverId;
      }

      const handover = (await CashHandover.findOne(handoverFilter).session(
        session
      )) as ICashHandoverDocument | null;

      if (!handover) {
        throw new CustomDisputeError(
          404,
          "HANDOVER_NOT_FOUND",
          `Cash handover not found with identifier: ${handoverId}`
        );
      }

      // Step 2: Center isolation check
      if (handover.centerId !== user.centerId) {
        throw new CustomDisputeError(
          403,
          "CROSS_CENTER_ACCESS_FORBIDDEN",
          `Handover ${handoverId} does not belong to authenticated center ${user.centerId}`
        );
      }

      // Step 3: Teacher ownership check (Teachers can only dispute their own handovers)
      if (user.role === "teacher") {
        const callerTeacherId = user.teacherId || user.userId;
        if (String(handover.teacherId) !== String(callerTeacherId)) {
          throw new CustomDisputeError(
            403,
            "UNAUTHORIZED_TEACHER_DISPUTE",
            "Teachers may only initiate disputes on handovers they submitted"
          );
        }
      }

      // Step 4: Eligibility & Discrepancy checks
      if (handover.discrepancyStatus === "resolved") {
        throw new CustomDisputeError(
          409,
          "DISCREPANCY_ALREADY_RESOLVED",
          "Cannot dispute a handover where the discrepancy has already been resolved"
        );
      }

      if (
        handover.status === "approved" &&
        (!handover.discrepancyAmount || Number(handover.discrepancyAmount) === 0)
      ) {
        throw new CustomDisputeError(
          400,
          "NO_DISCREPANCY_TO_DISPUTE",
          "Handover is fully approved with zero discrepancy; no dispute can be initiated"
        );
      }

      // Step 5: Duplicate active dispute prevention for the same unresolved discrepancy
      if (handover.disputes && handover.disputes.length > 0) {
        const lastDispute = handover.disputes[handover.disputes.length - 1];
        if (
          String(lastDispute.initiatedBy) === String(user.userId) &&
          handover.discrepancyStatus === "disputed"
        ) {
          throw new CustomDisputeError(
            409,
            "DUPLICATE_ACTIVE_DISPUTE",
            "An active dispute has already been submitted by this user for the current unresolved discrepancy"
          );
        }
      }

      // Step 6: Create dispute entry
      const now = new Date();
      const disputeEntry: IHandoverDisputeEntry = {
        _id: new Types.ObjectId(),
        initiatedBy: new Types.ObjectId(user.userId),
        initiatedByRole: user.role as "owner" | "teacher",
        notes,
        evidenceUrl:
          typeof body.evidenceUrl === "string" ? body.evidenceUrl.trim() : undefined,
        timestamp: now,
      };

      if (!handover.disputes) {
        handover.disputes = [];
      }
      handover.disputes.push(disputeEntry);
      handover.discrepancyStatus = "disputed";

      // Step 7: Update Fee document allocations to link dispute
      const uniqueFeeIds = Array.from(
        new Set(handover.items.map((it) => String(it.feeId)))
      );

      const feeDocs = (await Fee.find({
        _id: { $in: uniqueFeeIds },
        centerId: user.centerId,
      }).session(session)) as IFeeDocument[];

      const feeMap = new Map<string, IFeeDocument>();
      feeDocs.forEach((f) => feeMap.set(String(f._id), f));

      for (const item of handover.items) {
        const feeDoc = feeMap.get(String(item.feeId));
        if (!feeDoc) continue;

        const entry = (feeDoc.paymentHistory || []).find((p) =>
          matchPaymentEntry(p, item.paymentId)
        );
        if (!entry) continue;

        const alloc = (entry.allocations || []).find((a) =>
          matchPaymentAllocation(a, item.allocationId, handover._id)
        );
        if (!alloc) continue;

        alloc.status = "disputed";
        alloc.disputeId = disputeEntry._id;
        alloc.notes = notes;
      }

      for (const feeDoc of feeDocs) {
        await feeDoc.save({ session });
      }

      // Step 8: Save CashHandover
      await handover.save({ session });

      // Notify counterparty of dispute
      if (mongoose.connection?.readyState === 1 || StaffNotification.find !== mongoose.Model.find) {
        try {
          const disputeNotifKey = `notif_handover_dispute_${handover._id}_${now.getTime()}`;
          const recipientRole = user.role === "teacher" ? "owner" : "teacher";
          const recipientId = user.role === "teacher" ? user.centerId : String(handover.teacherId);
          const disputeNotif = new StaffNotification({
            centerId: user.centerId,
            recipientId,
            recipientRole,
            type: "dispute_raised",
            title: "Handover Disputed",
            message: `Dispute logged on handover ${handover.handoverNumber} by ${user.role === "teacher" ? "Faculty" : "Owner"}: "${notes}".`,
            amount: Number(handover.discrepancyAmount) || 0,
            statusLabel: "Disputed",
            link: "/fees?tab=handovers",
            isRead: false,
            idempotencyKey: disputeNotifKey,
            metadata: {
              handoverId: String(handover._id),
              handoverNumber: handover.handoverNumber,
              disputeReason: notes,
            },
          });
          await disputeNotif.save({ session });
        } catch (notifErr) {
          console.warn("[DISPUTE] Non-fatal notification error:", notifErr);
        }
      }

      // Step 9: Commit transaction
      await session.commitTransaction();

      return NextResponse.json(
        {
          success: true,
          data: handover,
          disputeId: disputeEntry._id,
          message: `Dispute logged successfully for handover ${handover.handoverNumber}`,
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (txErr: unknown) {
      await session.abortTransaction().catch(() => {});

      if (txErr instanceof CustomDisputeError) {
        return NextResponse.json(
          { success: false, error: txErr.message, code: txErr.code },
          { status: txErr.status, headers: corsHeaders }
        );
      }

      if (txErr instanceof Error && txErr.name === "ValidationError") {
        return NextResponse.json(
          { success: false, error: txErr.message, code: "VALIDATION_ERROR" },
          { status: 400, headers: corsHeaders }
        );
      }

      const errMsg = txErr instanceof Error ? txErr.message : "Failed to record dispute";
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

export { handleDispute as POST, handleDispute as PUT };

class CustomDisputeError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CustomDisputeError";
    this.status = status;
    this.code = code;
  }
}
