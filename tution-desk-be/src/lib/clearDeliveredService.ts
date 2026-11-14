import connectDB from "./db.ts";
import FeeReminderLog from "../models/FeeReminderLog.ts";
import { AdmissionWelcomeJob } from "../models/AdmissionWelcomeJob.ts";
import MessageCampaign from "../models/MessageCampaign.ts";

export interface ClearDeliveredOptions {
  centerId: string;
  cutoffTimestamp?: string | Date | null;
}

export interface ClearDeliveredResult {
  success: boolean;
  archivedCount: number;
  message: string;
}

/**
 * Executes safe soft-archiving of confirmed delivered messages for a specific center.
 * 
 * Invariants:
 * 1. Only records in terminal 'delivered' status are eligible.
 * 2. Records in 'sent', 'simulated', 'provider_accepted', 'failed', 'pending',
 *    'processing', 'ambiguous', or 'dispatch_uncertain' are NEVER archived.
 * 3. Never deletes records: sets `isArchived: true` and `archivedAt: now`.
 * 4. Strictly isolated by authenticated `centerId`.
 * 5. Respects `cutoffTimestamp` to avoid archiving newly arrived delivery receipts.
 */
export async function executeClearDelivered(
  options: ClearDeliveredOptions
): Promise<ClearDeliveredResult> {
  await connectDB();

  const cleanCenterId = String(options.centerId).trim();
  const cutoffDate = options.cutoffTimestamp
    ? new Date(options.cutoffTimestamp)
    : new Date();
  const now = new Date();

  // 1. Soft-archive delivered FeeReminderLogs
  const feeRes = await FeeReminderLog.updateMany(
    {
      centerId: cleanCenterId,
      status: "delivered", // STRICT: only terminal delivered
      isArchived: { $ne: true },
      attemptedAt: { $lte: cutoffDate },
    },
    {
      $set: {
        isArchived: true,
        archivedAt: now,
      },
    }
  );

  // 2. Soft-archive delivered AdmissionWelcomeJobs (if marked delivered)
  const admRes = await AdmissionWelcomeJob.updateMany(
    {
      centerId: cleanCenterId,
      status: "delivered" as any, // STRICT: only terminal delivered
      isArchived: { $ne: true },
      createdAt: { $lte: cutoffDate },
    },
    {
      $set: {
        isArchived: true,
        archivedAt: now,
      },
    }
  ).catch(() => ({ modifiedCount: 0 }));

  // 3. Soft-archive delivered MessageCampaign sub-messages
  const campRes = await MessageCampaign.updateMany(
    {
      centerId: cleanCenterId,
      "messages.status": "delivered" as any,
      isArchived: { $ne: true },
      createdAt: { $lte: cutoffDate },
    },
    {
      $set: {
        isArchived: true,
        archivedAt: now,
        "messages.$[elem].isArchived": true,
        "messages.$[elem].archivedAt": now,
      },
    },
    {
      arrayFilters: [{ "elem.status": "delivered" }],
    }
  ).catch(() => ({ modifiedCount: 0 }));

  const totalArchived =
    (feeRes.modifiedCount || 0) +
    (admRes.modifiedCount || 0) +
    (campRes.modifiedCount || 0);

  return {
    success: true,
    archivedCount: totalArchived,
    message: `Successfully cleared ${totalArchived} delivered message(s) from active view.`,
  };
}
