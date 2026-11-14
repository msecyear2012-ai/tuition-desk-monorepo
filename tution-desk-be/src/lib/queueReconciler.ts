import { Types } from "mongoose";
import connectDB from "./db.ts";
import FeeReminderLog, {
  type ReminderDispatchStatus,
} from "../models/FeeReminderLog.ts";
import { AdmissionWelcomeJob } from "../models/AdmissionWelcomeJob.ts";
import MessageCampaign from "../models/MessageCampaign.ts";

export interface ReconciliationOptions {
  centerId?: string;
  staleThresholdMs?: number; // Default 15 minutes to prevent race with live socket delivery
}

export interface ReconciliationSummary {
  processed: number;
  promotedSent: number;
  markedFailed: number;
  markedUncertain: number;
  errors: string[];
}

/**
 * Concurrency-safe, atomic-guard reconciliation worker for in-flight WhatsApp messages.
 * 
 * Rules:
 * 1. Strictly correlates campaigns by exact `messages.sourceId === String(log._id)`.
 *    Never matches broad studentId or recipient phone across arbitrary campaigns.
 * 2. Never marks an in-flight message failed merely because time elapsed.
 *    If an attempt times out without definitive campaign or provider outcome,
 *    it is preserved in a non-terminal uncertain state (`dispatch_uncertain` or `ambiguous`).
 * 3. Uses atomic `findOneAndUpdate` with status preconditions to prevent race conditions
 *    with active socket dispatch workers.
 * 4. Preserves already reconciled records (e.g. `status: "sent"`).
 */
export async function reconcileStaleInFlightRecords(
  options: ReconciliationOptions = {}
): Promise<ReconciliationSummary> {
  await connectDB();

  const summary: ReconciliationSummary = {
    processed: 0,
    promotedSent: 0,
    markedFailed: 0,
    markedUncertain: 0,
    errors: [],
  };

  const staleThresholdMs = options.staleThresholdMs ?? 15 * 60 * 1000; // 15 minutes safe window
  const staleCutoff = new Date(Date.now() - staleThresholdMs);

  const cleanCenterId = options.centerId ? String(options.centerId).trim() : null;

  try {
    // 1. Reconcile stale FeeReminderLog records in 'attempted' status
    const feeFilter: Record<string, unknown> = {
      status: "attempted",
      attemptedAt: { $lt: staleCutoff },
    };
    if (cleanCenterId) {
      feeFilter.centerId = cleanCenterId;
    }

    const feeFind = FeeReminderLog.find(feeFilter);
    const staleFeeLogs =
      feeFind && typeof (feeFind as any).then === "function"
        ? await feeFind
        : [];

    if (Array.isArray(staleFeeLogs)) {
      for (const log of staleFeeLogs) {
        summary.processed++;
        const logIdStr = String(log._id);

        // Strict correlation: Only match campaigns containing this EXACT sourceId
        const findOneQuery = MessageCampaign.findOne({
          centerId: log.centerId,
          "messages.sourceId": logIdStr,
        });

        const matchingCampaign =
          findOneQuery && typeof (findOneQuery as any).then === "function"
            ? await findOneQuery.sort({ updatedAt: -1, createdAt: -1 })
            : null;

        let targetStatus: ReminderDispatchStatus | null = null;
        let reason: string | null = null;
        let providerMsgId: string | undefined = undefined;

        if (matchingCampaign) {
          const matchingMsg = (matchingCampaign.messages || []).find(
            (m: any) => String(m.sourceId) === logIdStr
          );

          if (matchingMsg) {
            if (matchingMsg.status === "sent") {
              targetStatus = "sent";
              reason = null;
              providerMsgId = matchingMsg.messageId || undefined;
            } else if (matchingMsg.status === "simulated") {
              targetStatus = "sent";
              reason = null;
            } else if (matchingMsg.status === "failed") {
              targetStatus = "failed";
              reason = matchingMsg.error || "Retry campaign dispatch failed";
            }
          }
        }

        // If no matching campaign message outcome was found after the safe timeout window,
        // preserve the record in 'dispatch_uncertain' instead of prematurely marking it failed.
        if (!targetStatus) {
          targetStatus = "dispatch_uncertain";
          reason =
            "Dispatch outcome uncertain: attempt timed out without definitive delivery acknowledgment";
        }

        // Concurrency-safe atomic transition: ONLY update if record is STILL in 'attempted' status
        const updatePayload: Record<string, unknown> = {
          status: targetStatus,
          failureReason: reason,
        };
        if (providerMsgId) {
          updatePayload.providerMessageId = providerMsgId;
        }

        const updated = await FeeReminderLog.findOneAndUpdate(
          {
            _id: log._id,
            status: "attempted", // Atomic precondition guard
          },
          {
            $set: updatePayload,
          },
          { new: true }
        ).catch((err) => {
          summary.errors.push(`FeeReminderLog ${logIdStr}: ${err?.message || err}`);
          return null;
        });

        if (updated) {
          if (targetStatus === "sent") summary.promotedSent++;
          else if (targetStatus === "failed") summary.markedFailed++;
          else if (targetStatus === "dispatch_uncertain") summary.markedUncertain++;
        }
      }
    }

    // 2. Reconcile stale AdmissionWelcomeJob records in 'processing' status
    const admFilter: Record<string, unknown> = {
      status: "processing",
      $or: [
        { lockExpiresAt: { $lt: new Date() } },
        { lockedAt: { $lt: staleCutoff } },
        { lastAttemptedAt: { $lt: staleCutoff } },
      ],
    };
    if (cleanCenterId) {
      admFilter.centerId = cleanCenterId;
    }

    const admFind = AdmissionWelcomeJob.find(admFilter);
    const staleAdmissionJobs =
      admFind && typeof (admFind as any).then === "function"
        ? await admFind
        : [];

    if (Array.isArray(staleAdmissionJobs)) {
      for (const job of staleAdmissionJobs) {
        summary.processed++;
        const jobIdStr = String(job._id);

        // Strict correlation by exact sourceId
        const findOneQuery = MessageCampaign.findOne({
          centerId: job.centerId,
          "messages.sourceId": jobIdStr,
        });

        const matchingCampaign =
          findOneQuery && typeof (findOneQuery as any).then === "function"
            ? await findOneQuery.sort({ updatedAt: -1, createdAt: -1 })
            : null;

        // Requirement 3: Expired jobs must NOT be reset while their associated campaign is still actively processing
        const campUpdated = matchingCampaign?.updatedAt
          ? new Date(matchingCampaign.updatedAt).getTime()
          : null;
        const isCampActive =
          matchingCampaign &&
          (matchingCampaign.status === "in_progress" || matchingCampaign.status === "approved") &&
          (campUpdated !== null ? campUpdated >= staleCutoff.getTime() : true);

        if (isCampActive) {
          // Campaign is actively processing; do not mark ambiguous or disrupt active dispatch
          continue;
        }

        let targetStatus: "sent" | "simulated" | "failed" | "ambiguous" | "pending" = "ambiguous";
        let reason = "Admission welcome dispatch outcome uncertain";

        if (matchingCampaign) {
          const matchingMsg = (matchingCampaign.messages || []).find(
            (m: any) => String(m.sourceId) === jobIdStr
          );

          if (matchingMsg) {
            if (matchingMsg.status === "sent") {
              targetStatus = "sent";
              reason = "";
            } else if (matchingMsg.status === "simulated") {
              targetStatus = "simulated";
              reason = "";
            } else if (matchingMsg.status === "failed") {
              targetStatus = "failed";
              reason = matchingMsg.error || "Retry campaign dispatch failed";
            } else if (matchingMsg.status === "pending") {
              // Interrupted campaign: defuse campaign message to prevent duplicate delivery and recover job
              targetStatus = "pending";
              reason = "Recovered from interrupted campaign: lease expired";
              await MessageCampaign.updateOne(
                {
                  _id: matchingCampaign._id,
                  "messages._id": matchingMsg._id,
                  "messages.status": "pending",
                },
                {
                  $set: {
                    "messages.$.status": "failed",
                    "messages.$.error": "Campaign interrupted: message recovered by queue worker",
                  },
                  $inc: {
                    "stats.failed": 1,
                    "stats.pending": -1,
                  },
                }
              ).catch(() => {});
            }
          }
        }

        const updateSet: Record<string, unknown> = {
          status: targetStatus,
          failureReason: reason ? (job.failureReason ? `${job.failureReason} | ${reason}` : reason) : null,
          lockedAt: null,
          lockExpiresAt: null,
        };
        if (targetStatus === "pending") {
          updateSet.nextRetryAt = new Date();
        }

        // Concurrency-safe atomic transition with status precondition
        const updated = await AdmissionWelcomeJob.findOneAndUpdate(
          {
            _id: job._id,
            status: "processing", // Atomic precondition guard
          },
          {
            $set: updateSet,
          },
          { new: true }
        ).catch((err) => {
          summary.errors.push(`AdmissionWelcomeJob ${jobIdStr}: ${err?.message || err}`);
          return null;
        });

        if (updated) {
          if (targetStatus === "sent" || targetStatus === "simulated") {
            summary.promotedSent++;
          } else if (targetStatus === "failed") {
            summary.markedFailed++;
          } else if (targetStatus === "ambiguous") {
            summary.markedUncertain++;
          }
        }
      }
    }
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
  }

  return summary;
}
