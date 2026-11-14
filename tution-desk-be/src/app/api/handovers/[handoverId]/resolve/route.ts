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
  type IHandoverResolutionEntry,
  type IHandoverIncrementalSettlement,
  type DisputeResolutionType,
} from "../../../../../models/CashHandover.ts";
import StaffNotification from "../../../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, PUT, OPTIONS");
}

export async function handleDisputeResolution(
  request: NextRequest,
  context: { params: Promise<{ handoverId: string }> },
  overrideBody?: Record<string, unknown>
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

    // Role check: Only Owner can resolve disputes
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only Institute Owners are authorized to resolve cash disputes and authorize settlements",
          code: "UNAUTHORIZED_ROLE",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const body = overrideBody ?? (await request.json().catch(() => ({})));
    const rawType = body.resolutionType || body.type;
    const resolutionType = String(rawType || "").toLowerCase() as DisputeResolutionType;

    const validTypes: DisputeResolutionType[] = [
      "cash_received",
      "accounting_adjustment",
      "shortage_confirmed",
    ];

    if (!validTypes.includes(resolutionType)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid resolution type '${rawType}'. Must be one of: ${validTypes.join(", ")}`,
          code: "INVALID_RESOLUTION_TYPE",
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
            "Multi-document transactions are required for cash dispute resolution but are currently unavailable on this MongoDB deployment.",
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
        throw new CustomResolveError(
          404,
          "HANDOVER_NOT_FOUND",
          `Cash handover not found with identifier: ${handoverId}`
        );
      }

      // Step 2: Center isolation check
      if (handover.centerId !== user.centerId) {
        throw new CustomResolveError(
          403,
          "CROSS_CENTER_ACCESS_FORBIDDEN",
          `Handover ${handoverId} does not belong to authenticated center ${user.centerId}`
        );
      }

      // Step 3: Check that discrepancy exists
      const baseDiscrepancy = Number(handover.discrepancyAmount) || 0;
      if (baseDiscrepancy <= 0) {
        throw new CustomResolveError(
          400,
          "NO_DISCREPANCY_TO_RESOLVE",
          "Handover has zero recorded discrepancy to resolve"
        );
      }

      // Calculate current cumulative settlements and remaining unresolved balance
      const cumulativeSettled = (handover.incrementalSettlements || []).reduce(
        (sum, s) => sum + (Number(s.amountReceived) || 0),
        0
      );
      const unresolvedDiscrepancy = Math.max(0, baseDiscrepancy - cumulativeSettled);

      if (handover.discrepancyStatus === "resolved" || unresolvedDiscrepancy <= 0.001) {
        throw new CustomResolveError(
          409,
          "DISCREPANCY_ALREADY_RESOLVED",
          `The discrepancy on handover ${handover.handoverNumber} has already been fully resolved`
        );
      }

      const now = new Date();
      let resolutionEntry: IHandoverResolutionEntry;

      if (resolutionType === "cash_received") {
        // Outcome A: Physical cash recovery (Incremental or Full)
        const amount = Number(body.amount ?? body.amountReceived);
        if (isNaN(amount) || amount <= 0) {
          throw new CustomResolveError(
            400,
            "INVALID_RESOLUTION_AMOUNT",
            "Cash received amount must be a finite positive number"
          );
        }

        if (amount > unresolvedDiscrepancy + 0.001) {
          throw new CustomResolveError(
            400,
            "EXCEEDS_UNRESOLVED_DISCREPANCY",
            `Settlement amount (₹${amount}) cannot exceed remaining unresolved discrepancy (₹${unresolvedDiscrepancy})`
          );
        }

        const newRemainingDiscrepancy = Math.max(0, unresolvedDiscrepancy - amount);

        // Record incremental physical settlement
        const settlementEntry: IHandoverIncrementalSettlement = {
          _id: new Types.ObjectId(),
          amountReceived: amount,
          receivedAt: now,
          receivedBy: new Types.ObjectId(user.userId),
          remainingDiscrepancy: newRemainingDiscrepancy,
          notes:
            typeof body.notes === "string"
              ? body.notes.trim()
              : typeof body.reason === "string"
              ? body.reason.trim()
              : "Physical cash recovered",
        };

        if (!handover.incrementalSettlements) {
          handover.incrementalSettlements = [];
        }
        handover.incrementalSettlements.push(settlementEntry);

        // Record resolution entry
        const auditRef =
          typeof body.auditReference === "string" && body.auditReference.trim()
            ? body.auditReference.trim()
            : `AUD-CASH-REC-${Date.now()}`;

        resolutionEntry = {
          _id: new Types.ObjectId(),
          resolutionType: "cash_received",
          amount,
          resolvedBy: new Types.ObjectId(user.userId),
          resolvedAt: now,
          reason:
            typeof body.reason === "string" && body.reason.trim()
              ? body.reason.trim()
              : "Physical currency received from teacher",
          auditReference: auditRef,
          notes: typeof body.notes === "string" ? body.notes.trim() : "",
        };

        if (!handover.resolutions) {
          handover.resolutions = [];
        }
        handover.resolutions.push(resolutionEntry);

        // Update discrepancy status
        if (newRemainingDiscrepancy <= 0.001) {
          handover.discrepancyStatus = "resolved";
        } else {
          handover.discrepancyStatus = "disputed";
        }

        // Update Fee documents: Distribute recovered physical cash into allocations
        const uniqueFeeIds = Array.from(
          new Set(handover.items.map((it) => String(it.feeId)))
        );

        const feeDocs = (await Fee.find({
          _id: { $in: uniqueFeeIds },
          centerId: user.centerId,
        }).session(session)) as IFeeDocument[];

        const feeMap = new Map<string, IFeeDocument>();
        feeDocs.forEach((f) => feeMap.set(String(f._id), f));

        let amountToDistribute = amount;

        for (const item of handover.items) {
          if (amountToDistribute <= 0) break;

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

          // Increase verified amount up to allocatedAmount
          const currentVerified = Number(alloc.verifiedAmount) || 0;
          const needed = Math.max(0, alloc.allocatedAmount - currentVerified);
          const add = Math.min(amountToDistribute, needed);

          if (add > 0) {
            alloc.verifiedAmount = currentVerified + add;
            amountToDistribute -= add;
            alloc.verifiedAt = now;
            alloc.verifiedBy = new Types.ObjectId(user.userId);

            if (Math.abs(alloc.verifiedAmount - alloc.allocatedAmount) < 0.001) {
              alloc.status = "verified";
            }

            // Re-derive custody breakdown
            const custody = calculatePaymentCustody(entry);
            entry.custodyStatus = custody.custodyLabel;

            if (
              custody.custodyLabel === "owner_verified" &&
              custody.teacherInHandAmount === 0
            ) {
              entry.isProvisional = false;
            }
          }
        }

        for (const feeDoc of feeDocs) {
          await feeDoc.save({ session });
        }
      } else if (resolutionType === "accounting_adjustment") {
        // Outcome B: Accounting adjustment (Mandatory reason and audit ref; zero cash added)
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) {
          throw new CustomResolveError(
            400,
            "MANDATORY_REASON_REQUIRED",
            "A documented justification reason is mandatory for an authorized accounting adjustment"
          );
        }

        const amount =
          body.amount !== undefined ? Number(body.amount) : unresolvedDiscrepancy;
        if (isNaN(amount) || amount <= 0) {
          throw new CustomResolveError(
            400,
            "INVALID_RESOLUTION_AMOUNT",
            "Adjustment amount must be a finite positive number"
          );
        }

        if (amount > unresolvedDiscrepancy + 0.001) {
          throw new CustomResolveError(
            400,
            "EXCEEDS_UNRESOLVED_DISCREPANCY",
            `Adjustment amount (₹${amount}) cannot exceed remaining unresolved discrepancy (₹${unresolvedDiscrepancy})`
          );
        }

        const auditRef =
          typeof body.auditReference === "string" && body.auditReference.trim()
            ? body.auditReference.trim()
            : `AUD-ADJ-${Date.now()}`;

        resolutionEntry = {
          _id: new Types.ObjectId(),
          resolutionType: "accounting_adjustment",
          amount,
          resolvedBy: new Types.ObjectId(user.userId),
          resolvedAt: now,
          reason,
          auditReference: auditRef,
          notes: typeof body.notes === "string" ? body.notes.trim() : "",
        };

        if (!handover.resolutions) {
          handover.resolutions = [];
        }
        handover.resolutions.push(resolutionEntry);

        // Closes discrepancy without adding physical cash to vault
        handover.discrepancyStatus = "resolved";

        // Audit log in Fee document allocations
        const uniqueFeeIds = Array.from(
          new Set(handover.items.map((it) => String(it.feeId)))
        );
        const feeDocs = (await Fee.find({
          _id: { $in: uniqueFeeIds },
          centerId: user.centerId,
        }).session(session)) as IFeeDocument[];

        for (const feeDoc of feeDocs) {
          for (const item of handover.items) {
            const entry = (feeDoc.paymentHistory || []).find((p) =>
              matchPaymentEntry(p, item.paymentId)
            );
            if (!entry) continue;
            const alloc = (entry.allocations || []).find((a) =>
              matchPaymentAllocation(a, item.allocationId, handover._id)
            );
            if (!alloc) continue;

            alloc.notes = `Authorized adjustment: ${reason} (Ref: ${auditRef})`;
          }
          await feeDoc.save({ session });
        }
      } else {
        // Outcome C: shortage_confirmed
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) {
          throw new CustomResolveError(
            400,
            "MANDATORY_REASON_REQUIRED",
            "A documented reason is mandatory when confirming a teacher cash drawer shortage"
          );
        }

        const amount =
          body.amount !== undefined ? Number(body.amount) : unresolvedDiscrepancy;
        if (isNaN(amount) || amount <= 0) {
          throw new CustomResolveError(
            400,
            "INVALID_RESOLUTION_AMOUNT",
            "Shortage amount must be a finite positive number"
          );
        }

        if (amount > unresolvedDiscrepancy + 0.001) {
          throw new CustomResolveError(
            400,
            "EXCEEDS_UNRESOLVED_DISCREPANCY",
            `Confirmed shortage amount (₹${amount}) cannot exceed remaining unresolved discrepancy (₹${unresolvedDiscrepancy})`
          );
        }

        const auditRef =
          typeof body.auditReference === "string" && body.auditReference.trim()
            ? body.auditReference.trim()
            : `AUD-SHORTAGE-${Date.now()}`;

        resolutionEntry = {
          _id: new Types.ObjectId(),
          resolutionType: "shortage_confirmed",
          amount,
          resolvedBy: new Types.ObjectId(user.userId),
          resolvedAt: now,
          reason,
          auditReference: auditRef,
          notes: typeof body.notes === "string" ? body.notes.trim() : "",
        };

        if (!handover.resolutions) {
          handover.resolutions = [];
        }
        handover.resolutions.push(resolutionEntry);

        // Sets discrepancyStatus to shortage_confirmed
        handover.discrepancyStatus = "shortage_confirmed";

        // Update Fee document allocations: status = "shortage_confirmed"
        const uniqueFeeIds = Array.from(
          new Set(handover.items.map((it) => String(it.feeId)))
        );
        const feeDocs = (await Fee.find({
          _id: { $in: uniqueFeeIds },
          centerId: user.centerId,
        }).session(session)) as IFeeDocument[];

        for (const feeDoc of feeDocs) {
          for (const item of handover.items) {
            const entry = (feeDoc.paymentHistory || []).find((p) =>
              matchPaymentEntry(p, item.paymentId)
            );
            if (!entry) continue;
            const alloc = (entry.allocations || []).find((a) =>
              matchPaymentAllocation(a, item.allocationId, handover._id)
            );
            if (!alloc) continue;

            alloc.status = "shortage_confirmed";
            alloc.notes = `Confirmed shortage deficit: ${reason} (Ref: ${auditRef})`;

            const custody = calculatePaymentCustody(entry);
            entry.custodyStatus = custody.custodyLabel;
          }
          await feeDoc.save({ session });
        }
      }

      // Save CashHandover
      await handover.save({ session });

      // Notify Teacher of dispute resolution
      if (mongoose.connection?.readyState === 1 || StaffNotification.find !== mongoose.Model.find) {
        try {
          const resolveNotifKey = `notif_handover_resolve_${handover._id}_${now.getTime()}`;
          const teacherNotif = new StaffNotification({
            centerId: user.centerId,
            recipientId: String(handover.teacherId),
            recipientRole: "teacher",
            type: "handover_verified",
            title: "Dispute Resolved",
            message: `Discrepancy on handover ${handover.handoverNumber} was resolved via '${resolutionType}'. Reason: "${resolutionEntry.reason || ""}".`,
            amount: Number(resolutionEntry.amount) || 0,
            statusLabel: "Resolved",
            link: "/fees?tab=handovers",
            isRead: false,
            idempotencyKey: resolveNotifKey,
            metadata: {
              handoverId: String(handover._id),
              handoverNumber: handover.handoverNumber,
              resolutionType,
              reason: resolutionEntry.reason,
            },
          });
          await teacherNotif.save({ session });
        } catch (notifErr) {
          console.warn("[RESOLVE] Non-fatal notification error:", notifErr);
        }
      }

      // Commit transaction
      await session.commitTransaction();

      return NextResponse.json(
        {
          success: true,
          data: handover,
          resolution: resolutionEntry,
          message: `Dispute resolved successfully as '${resolutionType}' for handover ${handover.handoverNumber}`,
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (txErr: unknown) {
      await session.abortTransaction().catch(() => {});

      if (txErr instanceof CustomResolveError) {
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

      const errMsg = txErr instanceof Error ? txErr.message : "Failed to resolve dispute";
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

export { handleDisputeResolution as POST, handleDisputeResolution as PUT };

class CustomResolveError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CustomResolveError";
    this.status = status;
    this.code = code;
  }
}
