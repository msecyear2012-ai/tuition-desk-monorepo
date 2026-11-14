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
  type IHandoverItemAllocation,
} from "../../../../../models/CashHandover.ts";
import StaffNotification from "../../../../../models/StaffNotification.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "PUT, OPTIONS");
}

interface ItemVerificationInput {
  allocationId?: string;
  paymentId?: string;
  verifiedAmount: number;
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

    // A. Authorization: Only authenticated Owner can verify handovers
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only Institute Owners are authorized to verify physical cash handovers",
          code: "UNAUTHORIZED_ROLE",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));

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
            "Multi-document transactions are required for cash handover verification but are currently unavailable on this MongoDB deployment.",
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
        throw new CustomVerifyError(
          404,
          "HANDOVER_NOT_FOUND",
          `Cash handover not found with identifier: ${handoverId}`
        );
      }

      // Center isolation check
      if (handover.centerId !== user.centerId) {
        throw new CustomVerifyError(
          403,
          "CROSS_CENTER_ACCESS_FORBIDDEN",
          `Handover ${handoverId} does not belong to authenticated center ${user.centerId}`
        );
      }

      // Concurrency / state guard: handover must be pending_approval
      if (handover.status !== "pending_approval") {
        throw new CustomVerifyError(
          409,
          "HANDOVER_ALREADY_RESOLVED",
          `Handover ${handover.handoverNumber} is already in '${handover.status}' state and cannot be verified`
        );
      }

      // Step 2: Determine item-level verification amounts
      const inputItems: ItemVerificationInput[] | undefined = Array.isArray(body.items)
        ? body.items
        : undefined;

      const itemVerificationMap = new Map<string, number>();

      if (inputItems && inputItems.length > 0) {
        for (const item of inputItems) {
          const key = item.allocationId ? String(item.allocationId) : item.paymentId ? String(item.paymentId) : "";
          if (!key) continue;

          const verifiedAmount = Number(item.verifiedAmount);
          if (isNaN(verifiedAmount) || verifiedAmount < 0) {
            throw new CustomVerifyError(
              400,
              "INVALID_VERIFICATION_AMOUNT",
              "Item verified amount must be a finite non-negative number"
            );
          }
          itemVerificationMap.set(key, verifiedAmount);
        }
      } else if (body.verifiedAmount !== undefined && body.verifiedAmount !== null) {
        const overallVerified = Number(body.verifiedAmount);
        if (isNaN(overallVerified) || overallVerified < 0) {
          throw new CustomVerifyError(
            400,
            "INVALID_VERIFICATION_AMOUNT",
            "Verified amount must be a finite non-negative number"
          );
        }

        if (handover.items.length === 1) {
          itemVerificationMap.set(String(handover.items[0].allocationId), overallVerified);
        } else if (overallVerified === handover.submittedAmount) {
          // Full verification of multi-item handover
          for (const it of handover.items) {
            itemVerificationMap.set(String(it.allocationId), it.amount);
          }
        } else {
          throw new CustomVerifyError(
            400,
            "ITEMS_REQUIRED_FOR_PARTIAL_VERIFICATION",
            "Please specify item-level verification amounts when partially verifying a multi-item handover"
          );
        }
      } else {
        // Default: Full verification of all items
        for (const it of handover.items) {
          itemVerificationMap.set(String(it.allocationId), it.amount);
        }
      }

      // Step 3: Validate and resolve verification amounts per item
      let calculatedTotalApproved = 0;
      const verifiedItemDetails: Array<{
        allocation: IHandoverItemAllocation;
        verifiedAmount: number;
      }> = [];

      for (const item of handover.items) {
        const keyByAlloc = String(item.allocationId);
        const keyByPay = String(item.paymentId);
        let verifiedAmount = itemVerificationMap.get(keyByAlloc);
        if (verifiedAmount === undefined) {
          verifiedAmount = itemVerificationMap.get(keyByPay);
        }
        if (verifiedAmount === undefined) {
          // Default to full allocation amount if not explicitly specified
          verifiedAmount = item.amount;
        }

        if (verifiedAmount > item.amount + 0.001) {
          throw new CustomVerifyError(
            400,
            "INVALID_VERIFICATION_AMOUNT",
            `Verified amount (₹${verifiedAmount}) cannot exceed submitted allocation amount (₹${item.amount}) on item ${item.allocationId}`
          );
        }

        calculatedTotalApproved += verifiedAmount;
        verifiedItemDetails.push({ allocation: item, verifiedAmount });
      }

      const calculatedDiscrepancy = Math.max(0, handover.submittedAmount - calculatedTotalApproved);
      const now = new Date();

      // Step 4: Load and update Fee documents
      const uniqueFeeIds = Array.from(
        new Set(handover.items.map((it) => String(it.feeId)))
      );

      const feeDocs = (await Fee.find({
        _id: { $in: uniqueFeeIds },
        centerId: user.centerId,
      }).session(session)) as IFeeDocument[];

      const feeMap = new Map<string, IFeeDocument>();
      feeDocs.forEach((f) => feeMap.set(String(f._id), f));

      for (const detail of verifiedItemDetails) {
        const feeDoc = feeMap.get(String(detail.allocation.feeId));
        if (!feeDoc) {
          throw new CustomVerifyError(
            404,
            "FEE_NOT_FOUND",
            `Fee not found with ID: ${detail.allocation.feeId}`
          );
        }

        // Find payment entry
        const entry = (feeDoc.paymentHistory || []).find((p) =>
          matchPaymentEntry(p, detail.allocation.paymentId)
        );

        if (!entry) {
          throw new CustomVerifyError(
            404,
            "PAYMENT_ENTRY_NOT_FOUND",
            `Payment entry ${detail.allocation.paymentId} not found in Fee ${detail.allocation.feeId}`
          );
        }

        // Find allocation
        const alloc = (entry.allocations || []).find((a) =>
          matchPaymentAllocation(a, detail.allocation.allocationId, handover._id)
        );

        if (!alloc) {
          throw new CustomVerifyError(
            404,
            "ALLOCATION_NOT_FOUND",
            `Allocation ${detail.allocation.allocationId} not found in payment history`
          );
        }

        // Update allocation verification fields
        alloc.verifiedAmount = detail.verifiedAmount;
        alloc.verifiedAt = now;
        alloc.verifiedBy = new Types.ObjectId(user.userId);

        if (Math.abs(detail.verifiedAmount - alloc.allocatedAmount) < 0.001) {
          alloc.status = "verified";
        } else {
          // Partial approval: record disputed shortage
          alloc.status = "disputed";
          alloc.notes = typeof body.notes === "string" ? body.notes.trim() : "Partial approval discrepancy";
        }

        // Re-derive payment entry custody status
        const custody = calculatePaymentCustody(entry);
        entry.custodyStatus = custody.custodyLabel;

        // If fully verified and zero in-hand remainder, update isProvisional to false
        if (custody.custodyLabel === "owner_verified" && custody.teacherInHandAmount === 0) {
          entry.isProvisional = false;
        }
      }

      // Step 5: Save all Fee documents within transaction
      for (const feeDoc of feeDocs) {
        // Enforces FeeSchema.pre("validate") invariant bounds
        await feeDoc.save({ session });
      }

      // Step 6: Update CashHandover state
      handover.approvedAmount = calculatedTotalApproved;
      handover.discrepancyAmount = calculatedDiscrepancy;
      handover.approvedBy = new Types.ObjectId(user.userId);
      handover.approvedAt = now;

      if (calculatedDiscrepancy === 0) {
        handover.status = "approved";
        handover.discrepancyStatus = "none";
      } else {
        handover.status = "partially_approved";
        handover.discrepancyStatus = "disputed";
      }

      // Save CashHandover document (validates Invariant 2 in CashHandoverSchema)
      await handover.save({ session });

      // Notify Teacher of verification outcome
      if (mongoose.connection?.readyState === 1 || StaffNotification.find !== mongoose.Model.find) {
        try {
          const verifyNotifKey = `notif_handover_verify_${handover._id}_${now.getTime()}`;
          const teacherNotif = new StaffNotification({
            centerId: user.centerId,
            recipientId: String(handover.teacherId),
            recipientRole: "teacher",
            category: "handover",
            type: "handover_verified",
            title: calculatedDiscrepancy === 0 ? "Handover Fully Verified" : "Handover Partially Verified",
            message: calculatedDiscrepancy === 0
              ? `Owner verified handover ${handover.handoverNumber} for ₹${calculatedTotalApproved.toLocaleString("en-IN")}. Physical cash cleared to Institute safe.`
              : `Owner verified ₹${calculatedTotalApproved.toLocaleString("en-IN")} on handover ${handover.handoverNumber}. Discrepancy shortage: ₹${calculatedDiscrepancy.toLocaleString("en-IN")}.`,
            amount: calculatedTotalApproved,
            statusLabel: calculatedDiscrepancy === 0 ? "Fully Verified" : "Partially Verified",
            entityType: "CashHandover",
            entityId: String(handover._id),
            link: "/fees?tab=handovers",
            deepLink: "/fees?tab=handovers",
            isRead: false,
            idempotencyKey: verifyNotifKey,
            metadata: {
              handoverId: String(handover._id),
              handoverNumber: handover.handoverNumber,
              approvedAmount: calculatedTotalApproved,
              discrepancyAmount: calculatedDiscrepancy,
            },
          });
          await teacherNotif.save({ session });
        } catch (notifErr) {
          console.warn("[VERIFY] Non-fatal notification error:", notifErr);
        }
      }

      // Step 7: Commit transaction
      await session.commitTransaction();

      return NextResponse.json(
        {
          success: true,
          data: handover,
          message:
            handover.status === "approved"
              ? `Handover ${handover.handoverNumber} fully approved for ₹${calculatedTotalApproved}`
              : `Handover ${handover.handoverNumber} partially approved for ₹${calculatedTotalApproved} (₹${calculatedDiscrepancy} discrepancy recorded)`,
        },
        { status: 200, headers: corsHeaders }
      );
    } catch (txErr: unknown) {
      await session.abortTransaction().catch(() => {});

      if (txErr instanceof CustomVerifyError) {
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

      const errMsg = txErr instanceof Error ? txErr.message : "Failed to verify cash handover";
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

class CustomVerifyError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CustomVerifyError";
    this.status = status;
    this.code = code;
  }
}
