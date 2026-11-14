import { NextRequest, NextResponse } from "next/server.js";
import mongoose, { Types } from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Fee, {
  type IFeeDocument,
  calculatePaymentCustody,
  matchPaymentEntry,
  matchPaymentAllocation,
} from "../../../../../models/Fee.ts";
import CashHandover, {
  type ICashHandoverDocument,
} from "../../../../../models/CashHandover.ts";
import StaffNotification from "../../../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "PUT, OPTIONS");
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ handoverId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const { handoverId } = await context.params;

    if (!handoverId || !handoverId.trim()) {
      return NextResponse.json(
        { success: false, error: "Handover ID is required" },
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

    // A. Authorization: Only authenticated Owner can reject handovers
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only Institute Owners are authorized to reject physical cash handovers",
          code: "UNAUTHORIZED_ROLE",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const rejectionReason =
      typeof body.rejectionReason === "string" ? body.rejectionReason.trim() : "";

    if (!rejectionReason) {
      return NextResponse.json(
        {
          success: false,
          error: "Rejection reason is mandatory when rejecting a cash handover",
          code: "REJECTION_REASON_REQUIRED",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Start multi-document ACID transaction
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
            "Multi-document transactions are required for cash handover rejection but are currently unavailable on this MongoDB deployment.",
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
        throw new CustomRejectError(
          404,
          "HANDOVER_NOT_FOUND",
          `Cash handover not found with identifier: ${handoverId}`
        );
      }

      // Center isolation check
      if (handover.centerId !== user.centerId) {
        throw new CustomRejectError(
          403,
          "CROSS_CENTER_ACCESS_FORBIDDEN",
          `Handover ${handoverId} does not belong to authenticated center ${user.centerId}`
        );
      }

      // Concurrency / state guard: handover must be pending_approval
      if (handover.status !== "pending_approval") {
        throw new CustomRejectError(
          409,
          "HANDOVER_ALREADY_RESOLVED",
          `Handover ${handover.handoverNumber} is already in '${handover.status}' state and cannot be rejected`
        );
      }

      const now = new Date();

      // Step 2: Load and update Fee documents
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
        if (!feeDoc) {
          throw new CustomRejectError(
            404,
            "FEE_NOT_FOUND",
            `Fee not found with ID: ${item.feeId}`
          );
        }

        // Find payment entry
        const entry = (feeDoc.paymentHistory || []).find((p) =>
          matchPaymentEntry(p, item.paymentId)
        );

        if (!entry) {
          throw new CustomRejectError(
            404,
            "PAYMENT_ENTRY_NOT_FOUND",
            `Payment entry ${item.paymentId} not found in Fee ${item.feeId}`
          );
        }

        // Find allocation
        const alloc = (entry.allocations || []).find((a) =>
          matchPaymentAllocation(a, item.allocationId, handover._id)
        );

        if (!alloc) {
          throw new CustomRejectError(
            404,
            "ALLOCATION_NOT_FOUND",
            `Allocation ${item.allocationId} not found in payment history`
          );
        }

        // Update allocation: status = "rejected", preserve history, set rejectionReason
        alloc.status = "rejected";
        alloc.rejectionReason = rejectionReason;
        alloc.verifiedAmount = 0;
        alloc.verifiedAt = null;
        alloc.verifiedBy = null;

        // Re-derive payment entry custody status
        // getLockedAllocationAmount(alloc) evaluates to 0 for rejected allocations,
        // so unallocated funds are restored to teacher_in_hand
        const custody = calculatePaymentCustody(entry);
        entry.custodyStatus = custody.custodyLabel;
      }

      // Step 3: Save all Fee documents within transaction
      for (const feeDoc of feeDocs) {
        await feeDoc.save({ session });
      }

      // Step 4: Update CashHandover state
      handover.status = "rejected";
      handover.rejectionReason = rejectionReason;
      handover.rejectedAt = now;
      handover.approvedAmount = 0;
      handover.discrepancyAmount = 0;
      handover.discrepancyStatus = "none";

      // Save CashHandover document (validates Invariant 2 in CashHandoverSchema)
      await handover.save({ session });

      // Notify Teacher of rejection
      if (mongoose.connection?.readyState === 1 || StaffNotification.find !== mongoose.Model.find) {
        try {
          const rejectNotifKey = `notif_handover_reject_${handover._id}_${now.getTime()}`;
          const teacherNotif = new StaffNotification({
            centerId: user.centerId,
            recipientId: String(handover.teacherId),
            recipientRole: "teacher",
            category: "handover",
            type: "handover_rejected",
            title: "Handover Envelope Rejected",
            message: `Owner rejected handover ${handover.handoverNumber}: "${rejectionReason}". Cash returned to your custody.`,
            amount: Number(handover.submittedAmount) || 0,
            statusLabel: "Rejected",
            entityType: "CashHandover",
            entityId: String(handover._id),
            link: "/fees?tab=handovers",
            deepLink: "/fees?tab=handovers",
            isRead: false,
            idempotencyKey: rejectNotifKey,
            metadata: {
              handoverId: String(handover._id),
              handoverNumber: handover.handoverNumber,
              rejectionReason,
            },
          });
          await teacherNotif.save({ session });
        } catch (notifErr) {
          console.warn("[REJECT] Non-fatal notification error:", notifErr);
        }
      }

      // Step 5: Commit transaction
      await session.commitTransaction();

      return NextResponse.json(
        {
          success: true,
          data: handover,
          message: `Handover ${handover.handoverNumber} rejected: ${rejectionReason}`,
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (txErr: unknown) {
      await session.abortTransaction().catch(() => {});

      if (txErr instanceof CustomRejectError) {
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

      const errMsg = txErr instanceof Error ? txErr.message : "Failed to reject cash handover";
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

class CustomRejectError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CustomRejectError";
    this.status = status;
    this.code = code;
  }
}
