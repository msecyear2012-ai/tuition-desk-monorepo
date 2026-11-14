import { Types } from "mongoose";
import connectDB from "./db.ts";
import Fee, { type IFeeDocument } from "../models/Fee.ts";
import Student, { type IStudentDocument } from "../models/Student.ts";
import FeeReminderLog from "../models/FeeReminderLog.ts";
import {
  checkReminderEligibility,
  dispatchFeeReminder,
  type DispatchReminderResult,
} from "./reminderService.ts";
import { isEligibleForFollowupReminder, getISTDayRange } from "./dateUtils.ts";

export const QA_CLOCK_SIMULATION_TARGET = {
  centerId: "msce-8267",
  studentId: "6af1f73ab1bcf9141efc36ad",
  feeId: "6af2be59960e044faeca1749",
};

/**
 * Strict QA-only Clock Simulation Guard:
 * - Disabled by default.
 * - Allowed ONLY when qaClockSimulation === true AND exact target matches msce-8267,
 *   QA student 6af1f73ab1bcf9141efc36ad, and QA fee 6af2be59960e044faeca1749.
 * - Missing flag, invalid date, or mismatched IDs fail closed to real system time (returns null).
 */
export function validateQaClockSimulation(options: {
  qaClockSimulation?: boolean;
  centerId?: string;
  studentId?: string;
  feeId?: string;
  referenceDate?: Date | string;
}): Date | null {
  if (!options.qaClockSimulation) return null;
  const cleanCenterId = String(options.centerId || "").trim();
  const cleanStudentId = String(options.studentId || "").trim();
  const cleanFeeId = String(options.feeId || "").trim();

  if (
    cleanCenterId !== QA_CLOCK_SIMULATION_TARGET.centerId ||
    cleanStudentId !== QA_CLOCK_SIMULATION_TARGET.studentId ||
    cleanFeeId !== QA_CLOCK_SIMULATION_TARGET.feeId
  ) {
    console.warn(
      `[QA CLOCK SIMULATION GUARD] Rejected: clock simulation requested with unauthorized targets (center: ${cleanCenterId}, student: ${cleanStudentId}, fee: ${cleanFeeId}). Failing closed to actual system time.`
    );
    return null;
  }

  if (!options.referenceDate) return null;
  const parsed = new Date(options.referenceDate);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

export interface ScheduledReminderOptions {
  centerId?: string;
  studentId?: string;
  feeId?: string;
  limit?: number;
  referenceDate?: Date;
  qaClockSimulation?: boolean;
  pacingDelayMs?: number;
  models?: {
    Fee?: any;
    Student?: any;
    FeeReminderLog?: any;
  };
  sendFn?: (
    centerId: string,
    phone: string,
    studentName: string,
    amount: number | string,
    dueDate: string,
    magicLink?: string
  ) => Promise<any>;
}

export interface ScheduledReminderItemDetail {
  feeId: string;
  studentId: string;
  studentName: string;
  phone?: string;
  amountDue: number;
  dueDate?: Date;
  status: string;
  reason?: string;
  providerMessageId?: string;
}

export interface ScheduledReminderSummary {
  success: boolean;
  timestamp: string;
  totalPendingDiscovered: number;
  eligibleCount: number;
  dispatchedCount: number;
  simulatedCount: number;
  skippedCount: number;
  failedCount: number;
  uncertainCount: number;
  details: ScheduledReminderItemDetail[];
  error?: string;
}

/**
 * Scheduled Fee Reminder Processing Engine
 * 
 * Automatically discovers pending tuition fees that have reached their payment due date,
 * evaluates strict multi-tenant eligibility and automated cooldowns, and dispatches reminders
 * sequentially with randomized anti-ban pacing (3-7s jitter).
 * 
 * Rules:
 * 1. Independent Job: Runs separately from monthly recurring fee generation.
 * 2. Due Date Respect: Only pending fees with dueDate <= referenceDate are eligible.
 *    Newly generated fees with future due dates are NEVER reminded prematurely.
 * 3. Exclusion Rules: Paid, Verification Pending, Paused, Inactive Students, and
 *    records within the 7-day automated follow-up cooldown are strictly excluded.
 * 4. Concurrency Safety: Atomic claim leases on MongoDB prevent duplicate queueing
 *    under concurrent scheduler triggers.
 * 5. Outcome Integrity: Never marks accepted as delivered.
 */
export async function processScheduledFeeReminders(
  options: ScheduledReminderOptions = {}
): Promise<ScheduledReminderSummary> {
  const FeeModel = options.models?.Fee || Fee;
  const StudentModel = options.models?.Student || Student;
  const FeeReminderLogModel = options.models?.FeeReminderLog || FeeReminderLog;

  if (!options.models) {
    await connectDB();
  }

  const isTestEnvironment =
    process.env.NODE_ENV === "test" ||
    Boolean((globalThis as any).mongooseCache) ||
    process.env.DISABLE_DISPATCH_PACING === "true";

  let now = new Date();
  if (isTestEnvironment && options.referenceDate) {
    now = new Date(options.referenceDate);
  } else if (options.qaClockSimulation) {
    const validatedQaDate = validateQaClockSimulation(options);
    if (validatedQaDate) {
      now = validatedQaDate;
    }
  }

  // Safe serverless batch limit: 8 reminders with 3-7s jitter (average ~5s) + network roundtrip
  // completes in ~40-48s, well within Vercel's 60s maxDuration limit.
  const limit = Math.min(Math.max(Number(options.limit) || 8, 1), 100);

  const summary: ScheduledReminderSummary = {
    success: true,
    timestamp: now.toISOString(),
    totalPendingDiscovered: 0,
    eligibleCount: 0,
    dispatchedCount: 0,
    simulatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    details: [],
  };

  // In India Standard Time, a fee due on a calendar date is due on that calendar day.
  // We clamp the query threshold to the end of the reference day in IST to ensure fees due
  // on referenceDate are eligible regardless of original generation millisecond.
  const { endOfDay: dueThreshold } = getISTDayRange(now);

  // 1. Build discovery query for pending/partial-paid fees due on or before reference date
  const feeFilter: Record<string, unknown> = {
    status: { $in: ["Pending", "Partial Paid"] },
    reminderPaused: { $ne: true },
    dueDate: { $lte: options.qaClockSimulation ? dueThreshold : now },
    $or: [
      { reminderLockUntil: { $exists: false } },
      { reminderLockUntil: null },
      { reminderLockUntil: { $lte: now } },
    ],
  };

  if (options.centerId) {
    feeFilter.centerId = String(options.centerId).trim();
  }

  if (options.studentId && options.studentId.trim()) {
    feeFilter.studentId = String(options.studentId).trim();
  }

  if (options.feeId && options.feeId.trim()) {
    feeFilter._id = String(options.feeId).trim();
  }

  // Find candidate fees ordered by earliest due date first
  const pendingFees = (await FeeModel.find(feeFilter)
    .sort({ dueDate: 1, createdAt: 1 })
    .limit(limit)
    .populate("studentId")) as IFeeDocument[];

  summary.totalPendingDiscovered = pendingFees.length;

  let processedCount = 0;

  for (const fee of pendingFees) {
    const student = fee.studentId as any;
    const studentIdStr = student?._id ? String(student._id) : String(fee.studentId || "");
    const studentName = student?.name || "Student";
    const parentPhone = student?.parentWhatsApp || "";
    const amountDue = fee.amountDue || 0;

    // Determine automated trigger type based on previous reminder count
    const triggerType =
      fee.reminderCount && fee.reminderCount > 0
        ? "auto_followup"
        : "auto_due_date";

    // 2. Strict eligibility evaluation
    const eligibility = checkReminderEligibility(fee, student, triggerType, now);

    if (!eligibility.eligible) {
      summary.skippedCount++;
      summary.details.push({
        feeId: String(fee._id),
        studentId: studentIdStr,
        studentName,
        phone: parentPhone,
        amountDue,
        dueDate: fee.dueDate,
        status: "skipped",
        reason: eligibility.message || eligibility.reason || "Ineligible for reminder",
      });
      continue;
    }

    // 3. Automated 7-day follow-up cooldown check
    if (!isEligibleForFollowupReminder(fee.lastReminderSentAt, now)) {
      summary.skippedCount++;
      summary.details.push({
        feeId: String(fee._id),
        studentId: studentIdStr,
        studentName,
        phone: parentPhone,
        amountDue,
        dueDate: fee.dueDate,
        status: "skipped",
        reason: "Follow-up reminder not due yet (7-day cooldown active)",
      });
      continue;
    }

    summary.eligibleCount++;

    // 4. Enforce randomized anti-ban pacing delay between consecutive outbound sends
    if (processedCount > 0 && !isTestEnvironment) {
      const pacingDelay =
        options.pacingDelayMs !== undefined
          ? options.pacingDelayMs
          : Math.floor(Math.random() * (7000 - 3000 + 1)) + 3000;
      await new Promise((res) => setTimeout(res, pacingDelay));
    }

    processedCount++;

    // 5. Execute atomic claim and reminder dispatch
    try {
      const dispatchResult: DispatchReminderResult = await dispatchFeeReminder({
        feeId: fee._id,
        centerId: fee.centerId,
        triggerType,
        referenceDate: now,
        models: {
          Fee: FeeModel,
          Student: StudentModel,
          FeeReminderLog: FeeReminderLogModel,
        },
        sendFn: options.sendFn,
      });

      if (dispatchResult.status === "provider_accepted") {
        summary.dispatchedCount++;
        summary.details.push({
          feeId: String(fee._id),
          studentId: studentIdStr,
          studentName,
          phone: parentPhone,
          amountDue,
          dueDate: fee.dueDate,
          status: "provider_accepted",
          providerMessageId: dispatchResult.providerMessageId,
        });
      } else if (dispatchResult.simulated || dispatchResult.status === "attempted") {
        summary.simulatedCount++;
        summary.details.push({
          feeId: String(fee._id),
          studentId: studentIdStr,
          studentName,
          phone: parentPhone,
          amountDue,
          dueDate: fee.dueDate,
          status: "simulated",
          reason: "Simulation mode active (zero live frames sent)",
        });
      } else if (dispatchResult.status === "dispatch_uncertain") {
        summary.uncertainCount++;
        summary.details.push({
          feeId: String(fee._id),
          studentId: studentIdStr,
          studentName,
          phone: parentPhone,
          amountDue,
          dueDate: fee.dueDate,
          status: "dispatch_uncertain",
          reason: dispatchResult.message || "Timeout after dispatch; 60m lock retained",
        });
      } else {
        summary.failedCount++;
        summary.details.push({
          feeId: String(fee._id),
          studentId: studentIdStr,
          studentName,
          phone: parentPhone,
          amountDue,
          dueDate: fee.dueDate,
          status: "failed",
          reason: dispatchResult.message || "Reminder dispatch failed",
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Dispatch error";
      summary.failedCount++;
      summary.details.push({
        feeId: String(fee._id),
        studentId: studentIdStr,
        studentName,
        phone: parentPhone,
        amountDue,
        dueDate: fee.dueDate,
        status: "failed",
        reason: errMsg,
      });
    }
  }

  return summary;
}

export default processScheduledFeeReminders;
