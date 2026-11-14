import connectDB from "./db.ts";
import FeeReminderLog from "../models/FeeReminderLog.ts";
import { AdmissionWelcomeJob } from "../models/AdmissionWelcomeJob.ts";
import MessageCampaign from "../models/MessageCampaign.ts";

export interface LogModelBreakdown {
  successful: number;
  failed: number;
  total: number;
}

export interface LogCleanupBreakdown {
  successful: number;
  failed: number;
  feeReminders?: {
    successful: number;
    failed: number;
    totalEligible: number;
    protected: number;
  };
  admissionWelcome?: {
    successful: number;
    failed: number;
    totalEligible: number;
    protected: number;
  };
  campaigns?: {
    successful: number;
    failed: number;
    totalEligible: number;
    protected: number;
  };
  byModel: {
    feeReminders: LogModelBreakdown;
    admissionJobs: LogModelBreakdown;
    campaigns: LogModelBreakdown;
  };
}

export interface LogCleanupPreviewResult {
  success: boolean;
  eligibleTotal: number;
  successfulCount: number;
  failedCount: number;
  protectedCount: number;
  breakdown: LogCleanupBreakdown;
}

export interface LogCleanupExecuteOptions {
  centerId: string;
  scope?: "all" | "successful" | "failed";
}

export interface LogCleanupExecuteResult {
  success: boolean;
  message: string;
  deletedCount: number;
  breakdown: {
    successful: number;
    failed: number;
    byModel: {
      feeReminders: number;
      admissionJobs: number;
      campaigns: number;
    };
  };
}

// Canonical Allowlisted Terminal Statuses
export const TERMINAL_FEE_SUCCESS_STATUSES = ["delivered", "sent"] as const;
export const TERMINAL_FEE_FAILED_STATUSES = ["failed"] as const;

export const TERMINAL_ADMISSION_SUCCESS_STATUSES = ["sent", "simulated"] as const;
export const TERMINAL_ADMISSION_FAILED_STATUSES = ["failed", "skipped"] as const;

export const TERMINAL_CAMPAIGN_STATUSES = [
  "completed",
  "cancelled",
  "failed_partial",
] as const;

// Protected Active / Unresolved Statuses (NEVER DELETABLE)
export const PROTECTED_FEE_STATUSES = [
  "attempted",
  "provider_accepted",
  "dispatch_uncertain",
] as const;

export const PROTECTED_ADMISSION_STATUSES = [
  "pending",
  "processing",
  "ambiguous",
  "held_for_access",
] as const;

export const PROTECTED_CAMPAIGN_STATUSES = [
  "pending",
  "approved",
  "in_progress",
  "paused",
] as const;

/**
 * Builds safe query for eligible terminal successful FeeReminderLogs
 */
export function buildFeeReminderSuccessQuery(centerId: string, now: Date = new Date()) {
  return {
    centerId,
    status: { $in: [...TERMINAL_FEE_SUCCESS_STATUSES] },
    $or: [
      { retryLockUntil: { $exists: false } },
      { retryLockUntil: null },
      { retryLockUntil: { $lte: now } },
    ],
  };
}

/**
 * Builds safe query for eligible terminal failed FeeReminderLogs
 */
export function buildFeeReminderFailedQuery(centerId: string, now: Date = new Date()) {
  return {
    centerId,
    status: { $in: [...TERMINAL_FEE_FAILED_STATUSES] },
    $or: [
      { retryLockUntil: { $exists: false } },
      { retryLockUntil: null },
      { retryLockUntil: { $lte: now } },
    ],
  };
}

/**
 * Builds safe query for eligible terminal successful AdmissionWelcomeJobs
 */
export function buildAdmissionWelcomeSuccessQuery(centerId: string, now: Date = new Date()) {
  return {
    centerId,
    status: { $in: [...TERMINAL_ADMISSION_SUCCESS_STATUSES] },
    $or: [
      { lockExpiresAt: { $exists: false } },
      { lockExpiresAt: null },
      { lockExpiresAt: { $lte: now } },
    ],
  };
}

/**
 * Builds safe query for eligible terminal failed AdmissionWelcomeJobs
 */
export function buildAdmissionWelcomeFailedQuery(centerId: string, now: Date = new Date()) {
  return {
    centerId,
    status: { $in: [...TERMINAL_ADMISSION_FAILED_STATUSES] },
    $or: [
      { lockExpiresAt: { $exists: false } },
      { lockExpiresAt: null },
      { lockExpiresAt: { $lte: now } },
    ],
  };
}

/**
 * Previews eligible deletable log counts for an authenticated center.
 * Strictly Read-Only: performs zero database mutations.
 */
export async function previewWhatsAppLogCleanup(
  centerId: string
): Promise<LogCleanupPreviewResult> {
  await connectDB();
  const cleanCenterId = String(centerId).trim();
  const now = new Date();

  // 1. Fee Reminder Counts
  const feeSuccessQuery = buildFeeReminderSuccessQuery(cleanCenterId, now);
  const feeFailedQuery = buildFeeReminderFailedQuery(cleanCenterId, now);
  const feeProtectedQuery = {
    centerId: cleanCenterId,
    status: { $in: [...PROTECTED_FEE_STATUSES] },
  };

  const [feeSuccess, feeFailed, feeProtected] = await Promise.all([
    FeeReminderLog.countDocuments(feeSuccessQuery).catch(() => 0),
    FeeReminderLog.countDocuments(feeFailedQuery).catch(() => 0),
    FeeReminderLog.countDocuments(feeProtectedQuery).catch(() => 0),
  ]);

  // 2. Admission Welcome Job Counts
  const admSuccessQuery = buildAdmissionWelcomeSuccessQuery(cleanCenterId, now);
  const admFailedQuery = buildAdmissionWelcomeFailedQuery(cleanCenterId, now);
  const admProtectedQuery = {
    centerId: cleanCenterId,
    status: { $in: [...PROTECTED_ADMISSION_STATUSES] },
  };

  const [admSuccess, admFailed, admProtected] = await Promise.all([
    AdmissionWelcomeJob.countDocuments(admSuccessQuery).catch(() => 0),
    AdmissionWelcomeJob.countDocuments(admFailedQuery).catch(() => 0),
    AdmissionWelcomeJob.countDocuments(admProtectedQuery).catch(() => 0),
  ]);

  // 3. Campaign Counts
  let campSuccess = 0;
  let campFailed = 0;
  let campProtected = 0;

  try {
    const terminalCampaigns: any[] = await (MessageCampaign.find({
      centerId: cleanCenterId,
      status: { $in: [...TERMINAL_CAMPAIGN_STATUSES] },
    }).lean() as any).catch(() => []);

    for (const c of terminalCampaigns || []) {
      const msgs = c.messages || [];
      if (msgs.length === 0) {
        if (c.status === "completed") {
          campSuccess++;
        } else {
          campFailed++;
        }
      } else {
        for (const m of msgs) {
          if (m.status === "sent" || m.status === "simulated") {
            campSuccess++;
          } else if (
            m.status === "failed" ||
            m.status === "skipped" ||
            m.status === "pending"
          ) {
            campFailed++;
          }
        }
      }
    }

    campProtected = await MessageCampaign.countDocuments({
      centerId: cleanCenterId,
      status: { $in: [...PROTECTED_CAMPAIGN_STATUSES] },
    }).catch(() => 0);
  } catch {}

  const successfulCount = feeSuccess + admSuccess + campSuccess;
  const failedCount = feeFailed + admFailed + campFailed;
  const eligibleTotal = successfulCount + failedCount;
  const protectedCount = feeProtected + admProtected + campProtected;

  return {
    success: true,
    eligibleTotal,
    successfulCount,
    failedCount,
    protectedCount,
    breakdown: {
      successful: successfulCount,
      failed: failedCount,
      feeReminders: {
        successful: feeSuccess,
        failed: feeFailed,
        totalEligible: feeSuccess + feeFailed,
        protected: feeProtected,
      },
      admissionWelcome: {
        successful: admSuccess,
        failed: admFailed,
        totalEligible: admSuccess + admFailed,
        protected: admProtected,
      },
      campaigns: {
        successful: campSuccess,
        failed: campFailed,
        totalEligible: campSuccess + campFailed,
        protected: campProtected,
      },
      byModel: {
        feeReminders: {
          successful: feeSuccess,
          failed: feeFailed,
          total: feeSuccess + feeFailed,
        },
        admissionJobs: {
          successful: admSuccess,
          failed: admFailed,
          total: admSuccess + admFailed,
        },
        campaigns: {
          successful: campSuccess,
          failed: campFailed,
          total: campSuccess + campFailed,
        },
      },
    },
  };
}

/**
 * Safely hard-deletes only eligible terminal dispatch records for an authenticated center.
 * Concurrency Safe: Uses status allowlists and lock-expiry filters to protect active transitions.
 */
export async function executeWhatsAppLogCleanup(
  options: LogCleanupExecuteOptions
): Promise<LogCleanupExecuteResult> {
  await connectDB();
  const cleanCenterId = String(options.centerId).trim();
  const scope = options.scope || "all";
  const now = new Date();

  let feeDeleted = 0;
  let admDeleted = 0;
  let campDeleted = 0;
  let successfulDeleted = 0;
  let failedDeleted = 0;

  // 1. Clean Fee Reminder Logs
  if (scope === "all" || scope === "successful") {
    const feeSuccessQuery = buildFeeReminderSuccessQuery(cleanCenterId, now);
    const res = await FeeReminderLog.deleteMany(feeSuccessQuery).catch(() => ({
      deletedCount: 0,
    }));
    const count = res.deletedCount || 0;
    feeDeleted += count;
    successfulDeleted += count;
  }

  if (scope === "all" || scope === "failed") {
    const feeFailedQuery = buildFeeReminderFailedQuery(cleanCenterId, now);
    const res = await FeeReminderLog.deleteMany(feeFailedQuery).catch(() => ({
      deletedCount: 0,
    }));
    const count = res.deletedCount || 0;
    feeDeleted += count;
    failedDeleted += count;
  }

  // 2. Clean Admission Welcome Jobs
  if (scope === "all" || scope === "successful") {
    const admSuccessQuery = buildAdmissionWelcomeSuccessQuery(cleanCenterId, now);
    const res = await AdmissionWelcomeJob.deleteMany(admSuccessQuery).catch(() => ({
      deletedCount: 0,
    }));
    const count = res.deletedCount || 0;
    admDeleted += count;
    successfulDeleted += count;
  }

  if (scope === "all" || scope === "failed") {
    const admFailedQuery = buildAdmissionWelcomeFailedQuery(cleanCenterId, now);
    const res = await AdmissionWelcomeJob.deleteMany(admFailedQuery).catch(() => ({
      deletedCount: 0,
    }));
    const count = res.deletedCount || 0;
    admDeleted += count;
    failedDeleted += count;
  }

  // 3. Clean Message Campaigns (Only terminal campaigns: completed, cancelled, failed_partial)
  let campaignQuery: any = null;
  if (scope === "all") {
    campaignQuery = {
      centerId: cleanCenterId,
      status: { $in: [...TERMINAL_CAMPAIGN_STATUSES] },
    };
  } else if (scope === "successful") {
    campaignQuery = {
      centerId: cleanCenterId,
      status: "completed",
    };
  } else if (scope === "failed") {
    campaignQuery = {
      centerId: cleanCenterId,
      status: { $in: ["failed_partial", "cancelled"] },
    };
  }

  if (campaignQuery) {
    try {
      const terminalCampaigns: any[] = await (MessageCampaign.find(campaignQuery).lean() as any).catch(() => []);
      let campMsgSuccess = 0;
      let campMsgFailed = 0;

      for (const c of terminalCampaigns || []) {
        const msgs = c.messages || [];
        if (msgs.length === 0) {
          if (c.status === "completed") {
            campMsgSuccess++;
          } else {
            campMsgFailed++;
          }
        } else {
          for (const m of msgs) {
            if (m.status === "sent" || m.status === "simulated") {
              campMsgSuccess++;
            } else if (
              m.status === "failed" ||
              m.status === "skipped" ||
              m.status === "pending"
            ) {
              campMsgFailed++;
            }
          }
        }
      }

      const res = await MessageCampaign.deleteMany(campaignQuery).catch(() => ({
        deletedCount: 0,
      }));

      const deletedDocs = res.deletedCount || 0;
      if (deletedDocs > 0) {
        const totalMsgs = campMsgSuccess + campMsgFailed;
        const effectiveCount = totalMsgs > 0 ? totalMsgs : deletedDocs;
        campDeleted = effectiveCount;
        successfulDeleted += campMsgSuccess;
        failedDeleted += campMsgFailed;
        if (totalMsgs === 0) {
          if (scope === "failed") {
            failedDeleted += deletedDocs;
          } else {
            successfulDeleted += deletedDocs;
          }
        }
      }
    } catch {}
  }

  const totalDeleted = feeDeleted + admDeleted + campDeleted;

  return {
    success: true,
    message: `Successfully cleared ${totalDeleted} terminal WhatsApp dispatch record${
      totalDeleted !== 1 ? "s" : ""
    }.`,
    deletedCount: totalDeleted,
    breakdown: {
      successful: successfulDeleted,
      failed: failedDeleted,
      byModel: {
        feeReminders: feeDeleted,
        admissionJobs: admDeleted,
        campaigns: campDeleted,
      },
    },
  };
}
