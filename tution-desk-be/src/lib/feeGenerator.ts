import connectDB from "./db.ts";
import Student from "../models/Student.ts";
import type { IStudentDocument } from "../models/Student.ts";
import type { IFeeDocument } from "../models/Fee.ts";
import { generateOrGetMonthlyFee } from "./feeService.ts";
import {
  getISTDateComponents,
  getDaysInISTMonth,
  getEligibleBillingCycleDates,
} from "./dateUtils.ts";

export interface FeeGenerationOptions {
  overrideDay?: number;
  centerId?: string;
  studentId?: string;
  studentIds?: string[];
  forceAllStudents?: boolean;
  referenceDate?: Date;
  models?: {
    Student?: unknown;
    Fee?: unknown;
    Center?: unknown;
    FeeCreationLock?: unknown;
  };
}

export interface SkippedFeeRecord {
  studentId: string;
  studentName: string;
  reason: string;
}

export interface FeeGenerationResult {
  success: boolean;
  month: string;
  cycleDay: number | string;
  totalEligibleStudents: number;
  generatedCount: number;
  skippedCount: number;
  generatedFeeRecords: IFeeDocument[];
  skippedRecords: SkippedFeeRecord[];
  timestamp: string;
}

/**
 * Auto-Fee Generator Engine
 * Generates recurring monthly fees for active students based on billingCycleDate
 * or forces generation for all active students when forceAllStudents is true.
 * Uses shared idempotent feeService for canonical YYYY-MM keying, mid-month joiner protection,
 * and center due-date offsets.
 */
export async function generateMonthlyFees(
  options: FeeGenerationOptions = {}
): Promise<FeeGenerationResult> {
  if (!options.models) {
    await connectDB();
  }

  const now = options.referenceDate || new Date();
  const dateComp = getISTDateComponents(now);

  const cycleDay =
    options.overrideDay !== undefined ? options.overrideDay : dateComp.day;

  // Build query for eligible students
  const studentQuery: Record<string, unknown> = {
    isActive: { $ne: false },
  };

  // If not forcing all students, filter by billingCycleDate matching cycleDay,
  // deterministically clamping dates 29, 30, 31 to the final calendar day in shorter months.
  if (!options.forceAllStudents) {
    if (isNaN(cycleDay) || cycleDay < 1 || cycleDay > 31) {
      throw new Error(`Invalid cycle day: ${cycleDay}. Must be between 1 and 31.`);
    }
    const daysInMonth = getDaysInISTMonth(dateComp.year, dateComp.month);
    const eligibleCycleDays = getEligibleBillingCycleDates(cycleDay, daysInMonth);
    if (eligibleCycleDays.length === 1) {
      studentQuery.billingCycleDate = eligibleCycleDays[0];
    } else {
      studentQuery.billingCycleDate = { $in: eligibleCycleDays };
    }
  }

  if (options.centerId) {
    studentQuery.centerId = options.centerId;
  }

  if (options.studentId && options.studentId.trim()) {
    studentQuery._id = options.studentId.trim();
  }

  if (options.studentIds && Array.isArray(options.studentIds) && options.studentIds.length > 0) {
    const cleanIds = options.studentIds.map((id) => String(id).trim()).filter(Boolean);
    if (cleanIds.length === 1) {
      studentQuery._id = cleanIds[0];
    } else if (cleanIds.length > 1) {
      studentQuery._id = { $in: cleanIds };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const StudentModel = (options.models?.Student as any) || Student;
  const eligibleStudents = (await StudentModel.find(studentQuery)) as IStudentDocument[];

  // Build in-memory Map keyed by student ID for O(1) batch lookup
  const studentMap = new Map<string, IStudentDocument>();
  for (const student of eligibleStudents) {
    if (student && student._id) {
      studentMap.set(student._id.toString(), student);
    }
  }

  let generatedCount = 0;
  let skippedCount = 0;
  const generatedFeeRecords: IFeeDocument[] = [];
  const skippedRecords: SkippedFeeRecord[] = [];

  for (const student of eligibleStudents) {
    const studentDoc = studentMap.get(student._id.toString()) || student;
    const res = await generateOrGetMonthlyFee({
      centerId: student.centerId,
      studentId: student._id,
      student: studentDoc,
      studentMap,
      referenceDate: now,
      isManual: false,
      models: options.models,
    });

    if (res.wasCreated && res.fee) {
      generatedFeeRecords.push(res.fee);
      generatedCount++;
    } else {
      skippedCount++;
      const reason =
        res.conflictReason ||
        (res.fee
          ? `Fee already exists for ${dateComp.shortMonthLabel} (Fee ID: ${res.fee._id}, Status: ${res.fee.status})`
          : res.error || "Ineligible for monthly billing");

      skippedRecords.push({
        studentId: student._id.toString(),
        studentName: student.name,
        reason,
      });
    }
  }

  return {
    success: true,
    month: dateComp.shortMonthLabel,
    cycleDay: options.forceAllStudents ? "FORCED_ALL" : cycleDay,
    totalEligibleStudents: eligibleStudents.length,
    generatedCount,
    skippedCount,
    generatedFeeRecords,
    skippedRecords,
    timestamp: now.toISOString(),
  };
}

export default generateMonthlyFees;
