import { NextRequest, NextResponse } from "next/server.js";
import { runBackgroundTask } from "../../../../lib/serverlessTask.ts";
import mongoose, { Types } from "mongoose";
import connectDB from "../../../../lib/db.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { AdmissionWelcomeJob } from "../../../../models/AdmissionWelcomeJob.ts";
import type { AdmissionWelcomeJobStatus } from "../../../../models/AdmissionWelcomeJob.ts";
import FeeReminderLog from "../../../../models/FeeReminderLog.ts";
import type { ReminderDispatchStatus } from "../../../../models/FeeReminderLog.ts";
import MessageCampaign from "../../../../models/MessageCampaign.ts";
import type { MessageDeliveryStatus } from "../../../../models/MessageCampaign.ts";
import Student from "../../../../models/Student.ts";
import Center from "../../../../models/Center.ts";
import { decryptToken } from "../../../../lib/tokenCipher.ts";
import {
  formatAdmissionWelcomeMessage,
  getAppBaseUrl,
  buildMagicLinkForStudent,
} from "../../../../lib/whatsappService.ts";
import { resolvePortalInvitationUrl } from "../../../../lib/parentAccessService.ts";
import { dispatchCampaign } from "../../../../lib/campaignDispatcher.ts";
import { reconcileStaleInFlightRecords } from "../../../../lib/queueReconciler.ts";
import { executeClearDelivered } from "../../../../lib/clearDeliveredService.ts";

export const dynamic = "force-dynamic";

export type LiveQueueStatus =
  | "pending"
  | "processing"
  | "provider_accepted"
  | "delivered"
  | "sent"
  | "simulated"
  | "failed"
  | "ambiguous"
  | "outcome_unknown";

export type DeliveryState =
  | "pending"
  | "processing"
  | "provider_accepted"
  | "delivered"
  | "sent"
  | "simulated"
  | "failed"
  | "outcome_unknown";

export interface FailedQueueItem {
  id: string;
  type: "admission_welcome" | "fee_reminder" | "campaign";
  typeLabel: string;
  recipientPhone: string;
  studentName: string;
  status: LiveQueueStatus;
  statusLabel?: string;
  deliveryState?: DeliveryState;
  error?: string;
  timestamp: string;
  attempts?: number;
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, DELETE, OPTIONS");
}

/**
 * GET /api/whatsapp/retry
 * Restricted to Owner.
 * Pure Read-Only: Returns the count, breakdown, and detailed items of failed or pending WhatsApp messages for this center.
 * Performs strictly zero database writes, mutations, or state modifications.
 */
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

    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner role required" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const cleanCenterId = String(user.centerId).trim();

    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
    const archiveFilter = includeArchived ? {} : { isArchived: { $ne: true } };

    // 1. Pending/failed admission welcome jobs
    const admissionStatuses: AdmissionWelcomeJobStatus[] = [
      "failed",
      "pending",
      "ambiguous",
      "processing",
    ];
    const admissionFilter = {
      centerId: cleanCenterId,
      status: { $in: admissionStatuses },
      ...archiveFilter,
    };
    const pendingAdmissionCount = await AdmissionWelcomeJob.countDocuments(admissionFilter);
    const failedAdmissionJobs = await AdmissionWelcomeJob.find(admissionFilter)
      .sort({ createdAt: -1 })
      .limit(100);

    const admissionItems: FailedQueueItem[] = failedAdmissionJobs.map((j) => {
      const isAmbiguous = j.status === "ambiguous";
      const isFail = j.status === "failed";
      const isProc = j.status === "processing";
      return {
        id: String(j._id),
        type: "admission_welcome" as const,
        typeLabel: "Admission Welcome",
        recipientPhone: String(j.parentPhone || ""),
        studentName: j.studentName || "Student",
        status: (isFail
          ? "failed"
          : isAmbiguous
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : "pending") as LiveQueueStatus,
        statusLabel: isAmbiguous
          ? "Outcome Unknown"
          : isFail
          ? "Failed"
          : isProc
          ? "Processing"
          : "Pending",
        deliveryState: (isFail
          ? "failed"
          : isAmbiguous
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : "pending") as DeliveryState,
        error:
          j.failureReason ||
          (isAmbiguous ? "Dispatch outcome uncertain: awaiting delivery acknowledgment" : undefined),
        timestamp: (j.createdAt || (j as any).updatedAt || new Date()).toISOString(),
        attempts: j.attempts || 0,
      };
    });

    // 2. Pending/failed fee reminder logs
    const feeStatuses: ReminderDispatchStatus[] = ["failed", "attempted", "dispatch_uncertain"];
    const feeFilter = {
      centerId: cleanCenterId,
      status: { $in: feeStatuses },
      ...archiveFilter,
    };
    const pendingFeeReminderCount = await FeeReminderLog.countDocuments(feeFilter);
    const failedFeeLogs = await FeeReminderLog.find(feeFilter)
      .populate("studentId", "name")
      .sort({ attemptedAt: -1 })
      .limit(100);

    const feeItems: FailedQueueItem[] = failedFeeLogs.map((log) => {
      const student = log.studentId as any;
      const studentName = student?.name || "Student";
      const isUncertain = log.status === "dispatch_uncertain";
      const isFail = log.status === "failed";
      const isProc = log.status === "attempted";
      return {
        id: String(log._id),
        type: "fee_reminder" as const,
        typeLabel: "Fee Reminder",
        recipientPhone: String(log.recipientPhone || ""),
        studentName,
        status: (isFail
          ? "failed"
          : isUncertain
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : "pending") as LiveQueueStatus,
        statusLabel: isUncertain
          ? "Outcome Unknown"
          : isFail
          ? "Failed"
          : isProc
          ? "Processing"
          : "Pending",
        deliveryState: (isFail
          ? "failed"
          : isUncertain
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : "pending") as DeliveryState,
        error:
          log.failureReason ||
          (isUncertain ? "Dispatch outcome uncertain: awaiting delivery acknowledgment" : undefined),
        timestamp: (log.attemptedAt || (log as any).createdAt || new Date()).toISOString(),
      };
    });

    // 3. Pending/failed campaign messages
    const campaignStatuses: MessageDeliveryStatus[] = ["failed", "pending"];
    const campaignFilter = {
      centerId: cleanCenterId,
      campaignType: { $ne: "fail_safe_retry" },
      "messages.status": { $in: campaignStatuses },
      ...archiveFilter,
    };
    const failedCampaigns = await (MessageCampaign.find(campaignFilter as any)
      .sort({ createdAt: -1 })
      .limit(25) as any);

    let pendingCampaignCount = 0;
    const campaignItems: FailedQueueItem[] = [];

    for (const c of (failedCampaigns || [])) {
      const messages = c.messages || [];
      for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (
          (m.status === "failed" || m.status === "pending") &&
          (includeArchived || !m.isArchived)
        ) {
          pendingCampaignCount++;
          campaignItems.push({
            id: String(m._id || `${c._id}_${idx}`),
            type: "campaign" as const,
            typeLabel:
              c.campaignType === "attendance_alert"
                ? "Attendance Alert"
                : c.campaignType === "fee_reminder"
                ? "Fee Reminder"
                : "Announcement",
            recipientPhone: String(m.phone || ""),
            studentName: m.studentName || "Student",
            status: m.status === "failed" ? "failed" : "pending",
            error: m.error || undefined,
            timestamp: (m.dispatchedAt || c.createdAt || new Date()).toISOString(),
          });
        }
      }
    }

    const totalCount =
      pendingAdmissionCount + pendingFeeReminderCount + pendingCampaignCount;

    const allItems = [...admissionItems, ...feeItems, ...campaignItems].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // 4. Recent activity across all statuses (AdmissionWelcomeJob, FeeReminderLog, MessageCampaign)
    let recentAdmissionJobs: any[] = [];
    try {
      recentAdmissionJobs = await AdmissionWelcomeJob.find({
        centerId: cleanCenterId,
        ...archiveFilter,
      })
        .sort({ createdAt: -1 })
        .limit(30);
    } catch {}

    const recentAdmissionItems: FailedQueueItem[] = (recentAdmissionJobs || []).map((j) => {
      const isAmbiguous = j.status === "ambiguous";
      const isSent = j.status === "sent";
      const isSim = j.status === "simulated";
      const isProc = j.status === "processing";
      const isFail = j.status === "failed";
      return {
        id: String(j._id),
        type: "admission_welcome" as const,
        typeLabel: "Admission Welcome",
        recipientPhone: String(j.parentPhone || ""),
        studentName: j.studentName || "Student",
        status: (isFail
          ? "failed"
          : isAmbiguous
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : isSent
          ? "sent"
          : isSim
          ? "simulated"
          : "pending") as LiveQueueStatus,
        statusLabel: isAmbiguous
          ? "Outcome Unknown"
          : isSent
          ? "Sent"
          : isSim
          ? "Simulated"
          : isProc
          ? "Processing"
          : isFail
          ? "Failed"
          : "Queued",
        deliveryState: (isFail
          ? "failed"
          : isAmbiguous
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : isSent
          ? "sent"
          : isSim
          ? "simulated"
          : "pending") as DeliveryState,
        error:
          j.failureReason ||
          (isAmbiguous ? "Dispatch outcome uncertain: awaiting delivery acknowledgment" : undefined),
        timestamp: (j.dispatchedAt || j.createdAt || (j as any).updatedAt || new Date()).toISOString(),
        attempts: j.attempts || 0,
      };
    });

    let recentFeeLogs: any[] = [];
    try {
      recentFeeLogs = await FeeReminderLog.find({
        centerId: cleanCenterId,
        ...archiveFilter,
      })
        .populate("studentId", "name")
        .sort({ attemptedAt: -1 })
        .limit(30);
    } catch {}

    const recentFeeItems: FailedQueueItem[] = (recentFeeLogs || []).map((log) => {
      const student = log.studentId as any;
      const studentName = student?.name || "Student";
      const isUncertain = log.status === "dispatch_uncertain";
      const isAccepted = log.status === "provider_accepted";
      const isDelivered = log.status === "delivered";
      const isSent = log.status === "sent";
      const isProc = log.status === "attempted";
      const isFail = log.status === "failed";

      return {
        id: String(log._id),
        type: "fee_reminder" as const,
        typeLabel: "Fee Reminder",
        recipientPhone: String(log.recipientPhone || ""),
        studentName,
        status: (isAccepted
          ? "provider_accepted"
          : isDelivered
          ? "delivered"
          : isSent
          ? "sent"
          : isFail
          ? "failed"
          : isUncertain
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : "pending") as LiveQueueStatus,
        statusLabel: isAccepted
          ? "Accepted by Provider"
          : isDelivered
          ? "Confirmed Delivered"
          : isSent
          ? "Sent"
          : isProc
          ? "Processing"
          : isFail
          ? "Failed"
          : isUncertain
          ? "Outcome Unknown"
          : "Uncertain",
        deliveryState: (isAccepted
          ? "provider_accepted"
          : isDelivered
          ? "delivered"
          : isSent
          ? "sent"
          : isFail
          ? "failed"
          : isUncertain
          ? "outcome_unknown"
          : isProc
          ? "processing"
          : "pending") as DeliveryState,
        error:
          log.failureReason ||
          (isUncertain ? "Dispatch outcome uncertain: awaiting delivery acknowledgment" : undefined),
        timestamp: (log.attemptedAt || (log as any).createdAt || new Date()).toISOString(),
      };
    });

    let recentCampaigns: any[] = [];
    try {
      recentCampaigns = await MessageCampaign.find({
        centerId: cleanCenterId,
        ...archiveFilter,
      })
        .sort({ createdAt: -1 })
        .limit(10);
    } catch {}

    const recentCampaignItems: FailedQueueItem[] = [];
    for (const c of (recentCampaigns || [])) {
      const messages = c.messages || [];
      for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (!includeArchived && m.isArchived) continue;
        const isSent = m.status === "sent";
        const isSim = m.status === "simulated";
        const isFail = m.status === "failed";
        recentCampaignItems.push({
          id: String(m._id || `${c._id}_${idx}`),
          type: "campaign" as const,
          typeLabel:
            c.campaignType === "attendance_alert"
              ? "Attendance Alert"
              : c.campaignType === "fee_reminder"
              ? "Fee Reminder"
              : "Announcement",
          recipientPhone: String(m.phone || ""),
          studentName: m.studentName || "Student",
          status: (isFail ? "failed" : isSent ? "sent" : isSim ? "simulated" : "pending") as LiveQueueStatus,
          statusLabel: isSent ? "Sent" : isSim ? "Simulated" : isFail ? "Failed" : "Queued",
          deliveryState: (isSent ? "sent" : isSim ? "simulated" : isFail ? "failed" : "pending") as DeliveryState,
          error: m.error || undefined,
          timestamp: (m.dispatchedAt || c.createdAt || new Date()).toISOString(),
        });
      }
    }

    const recentActivity = [...recentAdmissionItems, ...recentFeeItems, ...recentCampaignItems]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 50);

    const pendingItems = allItems.filter((i) => i.status === "pending" || i.status === "processing");
    const failedItems = allItems.filter((i) => i.status === "failed");
    const uncertainItems = allItems.filter(
      (i) => i.status === "outcome_unknown" || i.status === "ambiguous"
    );

    // Aggregate summary counts across the center
    let totalArchived = 0;
    try {
      const [archivedAdmissions, archivedFees] = await Promise.all([
        AdmissionWelcomeJob.countDocuments({ centerId: cleanCenterId, isArchived: true }).catch(() => 0),
        FeeReminderLog.countDocuments({ centerId: cleanCenterId, isArchived: true }).catch(() => 0),
      ]);
      let archivedCampaigns = 0;
      if (typeof (MessageCampaign as any).countDocuments === "function" && mongoose.connection?.readyState === 1) {
        archivedCampaigns = await MessageCampaign.countDocuments({ centerId: cleanCenterId, isArchived: true }).catch(() => 0);
      }
      totalArchived = (archivedAdmissions || 0) + (archivedFees || 0) + (archivedCampaigns || 0);
    } catch {}

    const summary = {
      pending: pendingItems.filter((i) => i.status === "pending").length,
      processing: pendingItems.filter((i) => i.status === "processing").length,
      provider_accepted: recentActivity.filter((i) => i.deliveryState === "provider_accepted").length,
      delivered: recentActivity.filter((i) => i.deliveryState === "delivered").length,
      sent: recentActivity.filter((i) => i.deliveryState === "sent").length,
      failed: failedItems.length,
      simulated: recentActivity.filter((i) => i.deliveryState === "simulated").length,
      uncertain: uncertainItems.length,
      archived: totalArchived,
      total: recentActivity.length,
    };

    return NextResponse.json(
      {
        success: true,
        count: totalCount,
        failedCount: failedItems.length,
        inFlightCount: pendingItems.length,
        totalUnresolved: totalCount,
        breakdown: {
          admissionWelcome: pendingAdmissionCount,
          feeReminders: pendingFeeReminderCount,
          campaigns: pendingCampaignCount,
        },
        summary,
        items: allItems,
        pendingItems,
        failedItems,
        recentActivity,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch retry status";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * POST /api/whatsapp/retry
 * Restricted to Owner.
 * 1. Runs safe, concurrency-guarded reconciliation on stale in-flight messages.
 * 2. Collects eligible FAILED messages from AdmissionWelcomeJob, FeeReminderLog, and MessageCampaign.
 *    (Ambiguous, attempted, processing, and uncertain items are strictly excluded from blind retries).
 * 3. Deduplicates them and enqueues into campaignDispatcher for sequential anti-ban 3-7s dispatch.
 */
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

    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner role required" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const cleanCenterId = String(user.centerId).trim();

    // Priority 3: Run concurrency-safe reconciliation on demand before gathering retryable failures
    await reconcileStaleInFlightRecords({ centerId: cleanCenterId });

    const centerDoc = await Center.findOne({ centerId: cleanCenterId }).select(
      "name"
    );
    const instituteName = centerDoc?.name || "Tuition Center";
    const baseUrl = getAppBaseUrl();

    const retryMessages: Array<{
      phone: string;
      message: string;
      studentId?: Types.ObjectId | null;
      studentName?: string;
      status: "pending";
      sourceType?: string;
      sourceId?: string;
    }> = [];

    // 1. Gather failed AdmissionWelcomeJobs (STRICT: only failed; exclude ambiguous/processing/pending)
    const failedAdmissionJobs = await AdmissionWelcomeJob.find({
      centerId: cleanCenterId,
      status: "failed",
    }).limit(100);

    const admissionJobIds: Types.ObjectId[] = [];

    for (const job of failedAdmissionJobs) {
      if (job._id) {
        admissionJobIds.push(job._id as Types.ObjectId);
      }
      let portalUrl: string | null = null;
      let isExistingActivePortal = false;

      if (job.encryptedInvitationToken) {
        try {
          const rawToken = decryptToken(job.encryptedInvitationToken);
          if (rawToken) {
            portalUrl = `${baseUrl}/portal#token=${rawToken}`;
          }
        } catch {
          portalUrl = null;
        }
      }

      if (!portalUrl) {
        // Recover the already-issued token from the ParentAccess record.
        // Never regenerates it, so links the parent already holds stay valid.
        portalUrl = await resolvePortalInvitationUrl(
          job.centerId || cleanCenterId,
          job.studentId,
          { baseUrl, fallbackToPortalEntry: false }
        );
      }

      if (!portalUrl) {
        // No credential can be reconstructed: fall back to the session-based
        // entry page instead of emitting an unauthenticated `/p/{studentId}`.
        isExistingActivePortal = true;
      }

      const msgText = formatAdmissionWelcomeMessage({
        studentName: job.studentName,
        instituteName,
        batchName: job.batchName,
        portalUrl,
        isExistingActivePortal,
        appBaseUrl: baseUrl,
      });

      retryMessages.push({
        phone: String(job.parentPhone).replace(/\D/g, ""),
        message: msgText,
        studentId: job.studentId,
        studentName: job.studentName,
        status: "pending",
        sourceType: "admission_welcome",
        sourceId: job._id ? String(job._id) : undefined,
      });
    }

    // 2. Gather failed FeeReminderLogs (STRICT: only failed; exclude attempted/dispatch_uncertain)
    const failedFeeLogs = await FeeReminderLog.find({
      centerId: cleanCenterId,
      status: "failed",
    })
      .populate("studentId")
      .limit(100);

    const feeLogIds: Types.ObjectId[] = [];

    for (const log of failedFeeLogs) {
      if (log._id) {
        feeLogIds.push(log._id as Types.ObjectId);
      }
      const student = log.studentId as any;
      const studentName = student?.name || "Student";
      const studentIdStr = student?._id
        ? String(student._id)
        : String(log.studentId || "");
      const formattedDate = new Date(log.dueDate).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const magicLink = await buildMagicLinkForStudent(cleanCenterId, studentIdStr);
      const reminderText = `Payment Reminder 🔔\n\nDear Parent, this is a friendly reminder that the tuition fee of ₹${Number(
        log.amountDue
      ).toLocaleString(
        "en-IN"
      )} for ${studentName} is due on ${formattedDate}.\n\n💳 Pay or view fee receipt online directly via your VIP Parent Portal:\n🔗 ${magicLink}\n\nIf you have already paid, please ignore this reminder. Thank you!`;

      retryMessages.push({
        phone: String(log.recipientPhone).replace(/\D/g, ""),
        message: reminderText,
        studentId: log.studentId ? (student?._id || log.studentId) : null,
        studentName,
        status: "pending",
        sourceType: "fee_reminder",
        sourceId: log._id ? String(log._id) : undefined,
      });
    }

    // 3. Gather failed MessageCampaign sub-messages (STRICT: only failed)
    const failedCampaigns = await MessageCampaign.find({
      centerId: cleanCenterId,
      campaignType: { $ne: "fail_safe_retry" },
      "messages.status": "failed",
    }).limit(25);

    for (const camp of failedCampaigns) {
      for (const m of camp.messages || []) {
        if (m.status === "failed") {
          retryMessages.push({
            phone: String(m.phone).replace(/\D/g, ""),
            message: m.message,
            studentId: m.studentId || null,
            studentName: m.studentName || "",
            status: "pending",
            sourceType: "campaign",
            sourceId: `${camp._id}:${m._id}`,
          });
        }
      }
    }

    // 4. Deduplicate messages by (phone + normalized message text)
    const seen = new Set<string>();
    const deduplicatedMessages: typeof retryMessages = [];

    for (const item of retryMessages) {
      if (!item.phone || item.phone.length < 10) continue;
      const key = `${item.phone}:::${item.message.trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicatedMessages.push(item);
      }
    }

    if (deduplicatedMessages.length === 0) {
      return NextResponse.json(
        {
          success: true,
          requeuedCount: 0,
          message: "No failed or pending messages found to retry.",
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // Mark only the deduplicated items actually being enqueued as processing/attempted
    const enqueuedAdmissionIds: Types.ObjectId[] = [];
    const enqueuedFeeIds: Types.ObjectId[] = [];

    for (const item of deduplicatedMessages) {
      if (
        item.sourceType === "admission_welcome" &&
        item.sourceId &&
        Types.ObjectId.isValid(item.sourceId)
      ) {
        enqueuedAdmissionIds.push(new Types.ObjectId(item.sourceId));
      } else if (
        item.sourceType === "fee_reminder" &&
        item.sourceId &&
        Types.ObjectId.isValid(item.sourceId)
      ) {
        enqueuedFeeIds.push(new Types.ObjectId(item.sourceId));
      }
    }

    if (enqueuedAdmissionIds.length > 0) {
      await AdmissionWelcomeJob.updateMany(
        { _id: { $in: enqueuedAdmissionIds } },
        { $set: { status: "processing", lastAttemptedAt: new Date() } }
      ).catch(() => {});
    }

    if (enqueuedFeeIds.length > 0) {
      await FeeReminderLog.updateMany(
        { _id: { $in: enqueuedFeeIds } },
        { $set: { status: "attempted", attemptedAt: new Date() } }
      ).catch(() => {});
    }

    // 5. Create durable fail_safe_retry campaign
    const retryCampaign = await MessageCampaign.create({
      centerId: cleanCenterId,
      title: `Fail-Safe Retry Queue — ${new Date().toLocaleDateString("en-IN")}`,
      campaignType: "fail_safe_retry",
      status: "approved",
      messages: deduplicatedMessages,
      createdBy: user.userId,
      createdRole: user.role,
      approvedBy: user.userId,
      approvedAt: new Date(),
      stats: {
        total: deduplicatedMessages.length,
        sent: 0,
        simulated: 0,
        failed: 0,
        pending: deduplicatedMessages.length,
      },
    });

    // 6. Asynchronously trigger campaignDispatcher decoupled in background (non-blocking for HTTP response)
    runBackgroundTask(async () => {
      await dispatchCampaign(retryCampaign._id, cleanCenterId);
    });

    return NextResponse.json(
      {
        success: true,
        requeued: deduplicatedMessages.length,
        requeuedCount: deduplicatedMessages.length,
        campaignId: String(retryCampaign._id),
        message: `Successfully queued ${deduplicatedMessages.length} message(s) for sequential retry.`,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to retry messages";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * DELETE /api/whatsapp/retry
 * Restricted to Owner.
 * Soft-archives all successfully delivered messages for this center.
 * Delegates to canonical executeClearDelivered service.
 * Never hard-deletes records. Non-delivered items (pending, processing, failed, etc.) are never touched.
 */
export async function DELETE(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner role required" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const cleanCenterId = String(user.centerId).trim();
    const body = await request.json().catch(() => ({}));

    const result = await executeClearDelivered({
      centerId: cleanCenterId,
      cutoffTimestamp: body?.cutoffTimestamp,
    });

    return NextResponse.json(
      result,
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to clear delivered messages";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
