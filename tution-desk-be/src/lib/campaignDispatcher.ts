import mongoose, { Types } from "mongoose";
import connectDB from "./db.ts";
import MessageCampaign from "../models/MessageCampaign.ts";
import FeeReminderLog from "../models/FeeReminderLog.ts";
import { AdmissionWelcomeJob } from "../models/AdmissionWelcomeJob.ts";
import type {
  IMessageCampaignDocument,
  ICampaignMessage,
} from "../models/MessageCampaign.ts";
import {
  sendCustomWhatsAppMessage,
  sendAdmissionWelcomeDirect,
} from "./whatsappService.ts";

export interface DispatchSummary {
  campaignId: string;
  status: string;
  total: number;
  processed: number;
  sent: number;
  simulated: number;
  failed: number;
  haltedByKillSwitch: boolean;
  error?: string;
}

/**
 * Dispatches a specific campaign's pending messages to WhatsApp.
 * Implements strict per-message Kill Switch checks and duplicate prevention.
 */
export async function dispatchCampaign(
  campaignId: string | Types.ObjectId,
  centerId: string
): Promise<DispatchSummary> {
  await connectDB();

  const cleanCenterId = String(centerId).trim();
  const cId =
    typeof campaignId === "string" ? new Types.ObjectId(campaignId) : campaignId;

  // 1. Fetch campaign scoped strictly to this centerId (tenant boundary)
  const campaign = await MessageCampaign.findOne({
    _id: cId,
    centerId: cleanCenterId,
  });

  if (!campaign) {
    throw new Error("Message campaign not found in this tuition center");
  }

  // Only approved or previously interrupted in_progress campaigns can be dispatched
  if (campaign.status !== "approved" && campaign.status !== "in_progress") {
    return {
      campaignId: String(campaign._id),
      status: campaign.status,
      total: campaign.stats?.total || 0,
      processed: 0,
      sent: campaign.stats?.sent || 0,
      simulated: campaign.stats?.simulated || 0,
      failed: campaign.stats?.failed || 0,
      haltedByKillSwitch: false,
      error: `Cannot dispatch campaign in status '${campaign.status}'`,
    };
  }

  // Transition to in_progress if not already
  if (campaign.status === "approved") {
    campaign.status = "in_progress";
    await MessageCampaign.updateOne(
      { _id: campaign._id },
      { $set: { status: "in_progress" } }
    );
  }

  let processedCount = 0;
  let sentCount = 0;
  let simulatedCount = 0;
  let failedCount = 0;
  let haltedByKillSwitch = false;

  // Iterate messages sequentially
  for (let i = 0; i < campaign.messages.length; i++) {
    const msg = campaign.messages[i];

    // Duplicate prevention: skip already sent or simulated messages
    if (msg.status === "sent" || msg.status === "simulated") {
      continue;
    }

    // 2. EMERGENCY KILL SWITCH CHECK:
    // Re-query the live campaign status in MongoDB before dispatching each individual message!
    const liveDoc = await MessageCampaign.findById(campaign._id, "status");
    if (!liveDoc || liveDoc.status === "paused" || liveDoc.status === "cancelled") {
      console.log(
        `[SMART ENGINE] [Center: ${cleanCenterId}] Emergency Kill Switch triggered! Halting dispatch. Live status: ${liveDoc?.status}`
      );
      haltedByKillSwitch = true;
      break;
    }

    // Anti-Ban Sequential Pacing: Enforce randomized delay (3-7s) after the first message
    const isTestEnvironment =
      process.env.NODE_ENV === "test" ||
      Boolean((globalThis as any).mongooseCache) ||
      process.env.DISABLE_DISPATCH_PACING === "true";
    if (processedCount > 0 && !isTestEnvironment) {
      const antiBanDelayMs =
        Math.floor(Math.random() * (7000 - 3000 + 1)) + 3000;
      await new Promise((res) => setTimeout(res, antiBanDelayMs));
    }

    processedCount++;

    try {
      // 3. Dispatch via WhatsApp service (routes through WhatsAppMessageQueue in microservice)
      const isAdmissionWelcome =
        campaign.campaignType === "admission_welcome" ||
        msg.sourceType === "admission_welcome";
      const dispatchResult = isAdmissionWelcome
        ? await sendAdmissionWelcomeDirect(
            cleanCenterId,
            msg.phone,
            msg.message
          )
        : await sendCustomWhatsAppMessage(
            cleanCenterId,
            msg.phone,
            msg.message
          );

      const now = new Date();
      let newMsgStatus: "sent" | "simulated" | "failed" = "failed";
      let errorText = dispatchResult.error || "";

      if (dispatchResult.success) {
        newMsgStatus = "sent";
        sentCount++;
      } else if (dispatchResult.simulated) {
        newMsgStatus = "simulated";
        simulatedCount++;
      } else {
        newMsgStatus = "failed";
        failedCount++;
      }

      // 4. Update the individual message status inside the array
      await MessageCampaign.updateOne(
        { _id: campaign._id, "messages._id": msg._id },
        {
          $set: {
            "messages.$.status": newMsgStatus,
            "messages.$.messageId": dispatchResult.messageId || "",
            "messages.$.dispatchedAt": now,
            "messages.$.error": errorText,
          },
          $inc: {
            "stats.sent": newMsgStatus === "sent" ? 1 : 0,
            "stats.simulated": newMsgStatus === "simulated" ? 1 : 0,
            "stats.failed": newMsgStatus === "failed" ? 1 : 0,
            "stats.pending": -1,
          },
        }
      );

      // 4b. Atomically update original documents in MongoDB (FeeReminderLog, AdmissionWelcomeJob, or MessageCampaign)
      const isSuccessOrSim =
        newMsgStatus === "sent" || newMsgStatus === "simulated";
      const feeStatus = isSuccessOrSim ? "sent" : "failed";
      const admStatus =
        newMsgStatus === "sent"
          ? "sent"
          : newMsgStatus === "simulated"
          ? "simulated"
          : "failed";

      const sourceIdStr = msg.sourceId ? String(msg.sourceId).trim() : "";
      const isValidSourceId =
        sourceIdStr !== "" &&
        sourceIdStr !== "undefined" &&
        Types.ObjectId.isValid(sourceIdStr);

      if (msg.sourceType === "fee_reminder" && isValidSourceId) {
        const feeObjId = new Types.ObjectId(sourceIdStr);
        await FeeReminderLog.updateOne(
          { _id: feeObjId },
          {
            $set: {
              status: feeStatus,
              attemptedAt: now,
              failureReason: isSuccessOrSim
                ? null
                : errorText || "WhatsApp dispatch rejected",
            },
          }
        ).catch((err) => {
          console.warn(
            "[campaignDispatcher] FeeReminderLog update error:",
            err?.message || err
          );
        });
      } else if (
        campaign.campaignType === "fee_reminder" ||
        campaign.campaignType === "fail_safe_retry"
      ) {
        if (msg.studentId) {
          await FeeReminderLog.updateMany(
            {
              centerId: cleanCenterId,
              studentId: msg.studentId,
              status: { $in: ["attempted", "failed", "dispatch_uncertain"] },
            },
            {
              $set: {
                status: feeStatus,
                attemptedAt: now,
                failureReason: isSuccessOrSim
                  ? null
                  : errorText || "WhatsApp dispatch rejected",
              },
            }
          ).catch(() => {});
        }
      }

      if (msg.sourceType === "admission_welcome" && isValidSourceId) {
        const admObjId = new Types.ObjectId(sourceIdStr);
        await AdmissionWelcomeJob.updateOne(
          { _id: admObjId },
          {
            $set: {
              status: admStatus,
              lastAttemptedAt: now,
              failureReason: isSuccessOrSim
                ? null
                : errorText || "WhatsApp dispatch rejected",
              ...(dispatchResult.messageId
                ? { messageId: dispatchResult.messageId }
                : {}),
              ...(isSuccessOrSim ? { dispatchedAt: now } : {}),
            },
            $inc: { attempts: 1 },
          }
        ).catch((err) => {
          console.warn(
            "[campaignDispatcher] AdmissionWelcomeJob update error:",
            err?.message || err
          );
        });
      } else if (
        campaign.campaignType === "admission_welcome" ||
        campaign.campaignType === "fail_safe_retry"
      ) {
        if (msg.studentId) {
          await AdmissionWelcomeJob.updateMany(
            {
              centerId: cleanCenterId,
              studentId: msg.studentId,
              status: {
                $in: ["processing", "failed", "pending", "ambiguous"],
              },
            },
            {
              $set: {
                status: admStatus,
                lastAttemptedAt: now,
                failureReason: isSuccessOrSim
                  ? null
                  : errorText || "WhatsApp dispatch rejected",
                ...(dispatchResult.messageId
                  ? { messageId: dispatchResult.messageId }
                  : {}),
                ...(isSuccessOrSim ? { dispatchedAt: now } : {}),
              },
              $inc: { attempts: 1 },
            }
          ).catch(() => {});
        }
      }

      if (msg.sourceType === "campaign" && msg.sourceId) {
        const [origCampId, origMsgId] = String(msg.sourceId).split(":");
        if (origCampId && origMsgId) {
          const campObjId = Types.ObjectId.isValid(origCampId)
            ? new Types.ObjectId(origCampId)
            : origCampId;
          const msgObjId = Types.ObjectId.isValid(origMsgId)
            ? new Types.ObjectId(origMsgId)
            : origMsgId;
          await MessageCampaign.updateOne(
            {
              _id: campObjId,
              centerId: cleanCenterId,
              "messages._id": msgObjId,
            },
            {
              $set: {
                "messages.$.status": newMsgStatus,
                "messages.$.dispatchedAt": now,
                "messages.$.error": errorText || "",
                "messages.$.messageId": dispatchResult.messageId || "",
              },
            }
          ).catch(() => {});
        }
      }
    } catch (sendErr: unknown) {
      failedCount++;
      const errMsg =
        sendErr instanceof Error ? sendErr.message : "Dispatch error";
      const nowErr = new Date();
      await MessageCampaign.updateOne(
        { _id: campaign._id, "messages._id": msg._id },
        {
          $set: {
            "messages.$.status": "failed",
            "messages.$.dispatchedAt": nowErr,
            "messages.$.error": errMsg,
          },
          $inc: {
            "stats.failed": 1,
            "stats.pending": -1,
          },
        }
      );

      const sourceIdStr = msg.sourceId ? String(msg.sourceId).trim() : "";
      const isValidSourceId =
        sourceIdStr !== "" &&
        sourceIdStr !== "undefined" &&
        Types.ObjectId.isValid(sourceIdStr);

      // Atomically update original documents to failed
      if (msg.sourceType === "fee_reminder" && isValidSourceId) {
        const feeObjId = new Types.ObjectId(sourceIdStr);
        await FeeReminderLog.updateOne(
          { _id: feeObjId },
          {
            $set: {
              status: "failed",
              attemptedAt: nowErr,
              failureReason: errMsg,
            },
          }
        ).catch((err) => {
          console.warn(
            "[campaignDispatcher] FeeReminderLog catch update error:",
            err?.message || err
          );
        });
      } else if (
        msg.studentId &&
        (campaign.campaignType === "fee_reminder" ||
          campaign.campaignType === "fail_safe_retry")
      ) {
        await FeeReminderLog.updateMany(
          {
            centerId: cleanCenterId,
            studentId: msg.studentId,
            status: { $in: ["attempted", "dispatch_uncertain", "failed"] },
          },
          {
            $set: {
              status: "failed",
              attemptedAt: nowErr,
              failureReason: errMsg,
            },
          }
        ).catch(() => {});
      }

      if (msg.sourceType === "admission_welcome" && isValidSourceId) {
        const admObjId = new Types.ObjectId(sourceIdStr);
        await AdmissionWelcomeJob.updateOne(
          { _id: admObjId },
          {
            $set: {
              status: "failed",
              lastAttemptedAt: nowErr,
              failureReason: errMsg,
            },
          }
        ).catch((err) => {
          console.warn(
            "[campaignDispatcher] AdmissionWelcomeJob catch update error:",
            err?.message || err
          );
        });
      } else if (
        msg.studentId &&
        (campaign.campaignType === "admission_welcome" ||
          campaign.campaignType === "fail_safe_retry")
      ) {
        await AdmissionWelcomeJob.updateMany(
          {
            centerId: cleanCenterId,
            studentId: msg.studentId,
            status: {
              $in: ["processing", "pending", "ambiguous", "failed"],
            },
          },
          {
            $set: {
              status: "failed",
              lastAttemptedAt: nowErr,
              failureReason: errMsg,
            },
          }
        ).catch(() => {});
      }
    }
  }

  // 5. Finalize campaign status if all messages have been processed
  const finalDoc = await MessageCampaign.findById(campaign._id);
  if (finalDoc) {
    if (!haltedByKillSwitch && finalDoc.status === "in_progress") {
      const remainingPending = finalDoc.messages.filter(
        (m) => m.status === "pending"
      ).length;

      if (remainingPending === 0) {
        const hasFailures =
          (finalDoc.stats?.failed || 0) > 0 ||
          finalDoc.messages.some((m) => m.status === "failed");
        finalDoc.status = hasFailures ? "failed_partial" : "completed";
        finalDoc.completedAt = new Date();
        await finalDoc.save();
      }
    }
  }

  return {
    campaignId: String(campaign._id),
    status: finalDoc ? finalDoc.status : campaign.status,
    total: campaign.messages.length,
    processed: processedCount,
    sent: sentCount,
    simulated: simulatedCount,
    failed: failedCount,
    haltedByKillSwitch,
  };
}

/**
 * Sweeps and processes all approved campaigns across one or all centers.
 * Ideal for periodic cron execution or background worker triggers.
 */
export async function processApprovedCampaigns(
  centerId?: string
): Promise<DispatchSummary[]> {
  await connectDB();

  const filter: Record<string, unknown> = {
    status: "approved",
  };
  if (centerId) {
    filter.centerId = String(centerId).trim();
  }

  const approvedCampaigns = await MessageCampaign.find(filter).sort({
    createdAt: 1,
  });
  const results: DispatchSummary[] = [];

  for (const campaign of approvedCampaigns) {
    try {
      const summary = await dispatchCampaign(campaign._id, campaign.centerId);
      results.push(summary);
    } catch (err: unknown) {
      console.error(
        `[SMART ENGINE] Failed to process campaign ${campaign._id}:`,
        err
      );
    }
  }

  return results;
}
