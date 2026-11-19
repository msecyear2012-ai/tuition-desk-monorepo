import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Student from "../../../../../models/Student.ts";
import Teacher from "../../../../../models/Teacher.ts";
import Fee, { type IFeeDocument } from "../../../../../models/Fee.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";
import {
  getISTDateComponents,
  getEffectiveBillingCycleDay,
} from "../../../../../lib/dateUtils.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function compareISTDates(
  y1: number,
  m1: number,
  d1: number,
  y2: number,
  m2: number,
  d2: number
): number {
  if (y1 !== y2) return y1 - y2;
  if (m1 !== m2) return m1 - m2;
  return d1 - d2;
}

function getFeeBillingMonth(fee: IFeeDocument): string | null {
  if (
    fee.billingMonth &&
    /^\d{4}-\d{2}$/.test(String(fee.billingMonth).trim())
  ) {
    return String(fee.billingMonth).trim();
  }
  if (fee.month && /^\d{4}-\d{2}$/.test(String(fee.month).trim())) {
    return String(fee.month).trim();
  }
  if (fee.dueDate) {
    const d = new Date(fee.dueDate);
    if (!isNaN(d.getTime())) {
      const comp = getISTDateComponents(d);
      return comp.billingMonth;
    }
  }
  if (fee.month && typeof fee.month === "string") {
    const parsed = new Date(fee.month);
    if (!isNaN(parsed.getTime())) {
      const comp = getISTDateComponents(parsed);
      return comp.billingMonth;
    }
  }
  return null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid student ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. Connect to database only after authentication and authorization
    await connectDB();

    // 3. Locate student strictly scoped to centerId
    const student = await Student.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. Role-based scoping: If teacher, verify access to student assignment or batch
    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const isDirectlyAssigned =
        student.assignedTeacherId &&
        String(student.assignedTeacherId) === String(user.teacherId);

      let isBatchAssigned = false;
      if (!isDirectlyAssigned) {
        const teacherDoc = await Teacher.findOne({
          _id: user.teacherId,
          centerId: user.centerId,
        }).select("assignedBatches");

        if (
          teacherDoc?.assignedBatches &&
          student.batch &&
          teacherDoc.assignedBatches.includes(student.batch)
        ) {
          isBatchAssigned = true;
        }
      }

      if (!isDirectlyAssigned && !isBatchAssigned) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Access denied: You do not have permission to view fee summary for this student",
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 5. Parse Query Parameters (year defaults to current year in Asia/Kolkata)
    const searchParams = request.nextUrl.searchParams;
    const yearParam = searchParams.get("year");
    const nowIST = getISTDateComponents(new Date());
    let targetYear = nowIST.year;
    if (yearParam && /^\d{4}$/.test(yearParam.trim())) {
      targetYear = parseInt(yearParam.trim(), 10);
    }

    // 6. Query all fee documents for this student
    const allFees = (await Fee.find({
      studentId: student._id,
      centerId: user.centerId,
    })) as IFeeDocument[];

    // 7. Compute Summary metrics
    const dueDay = Number(student.billingCycleDate) || 5;
    const monthlyFee = Number(student.monthlyFee) || 0;
    const advanceBalance = Number(student.advanceBalance) || 0;
    const rawAdmission = student.joiningDate || student.createdAt;
    const admissionDate = rawAdmission
      ? new Date(rawAdmission).toISOString()
      : null;

    // Total Due: Sum of remaining unpaid amounts across pending/partial fees
    const pendingFees = allFees.filter(
      (f) =>
        ["Pending", "Verification Pending", "Partial Paid"].includes(f.status) ||
        (Number(f.amountDue) > 0 && f.status !== "Paid")
    );
    const totalDue = pendingFees.reduce(
      (sum, f) => sum + (Number(f.amountDue) || 0),
      0
    );

    // Next Billing Date: Next upcoming due date based on student's dueDay in IST
    const currentMonthDueDay = getEffectiveBillingCycleDay(
      dueDay,
      nowIST.year,
      nowIST.month
    );
    let nextYear = nowIST.year;
    let nextMonth = nowIST.month;
    if (nowIST.day > currentMonthDueDay) {
      if (nextMonth === 12) {
        nextYear += 1;
        nextMonth = 1;
      } else {
        nextMonth += 1;
      }
    }
    const nextCycleDay = getEffectiveBillingCycleDay(
      dueDay,
      nextYear,
      nextMonth
    );
    const nextBillingDate = new Date(
      Date.UTC(nextYear, nextMonth - 1, nextCycleDay)
    ).toISOString();

    // 8. Generate 12-Month Calendar Array (Jan to Dec for targetYear)
    const months = [];
    const admComp = rawAdmission
      ? getISTDateComponents(new Date(rawAdmission))
      : null;

    for (let m = 1; m <= 12; m++) {
      const effectiveDay = getEffectiveBillingCycleDay(dueDay, targetYear, m);
      const billingDate = new Date(
        Date.UTC(targetYear, m - 1, effectiveDay)
      ).toISOString();

      // Check pre-admission: Months strictly before admission month
      let isPreAdmission = false;
      if (admComp) {
        if (
          targetYear < admComp.year ||
          (targetYear === admComp.year && m < admComp.month)
        ) {
          isPreAdmission = true;
        }
      }

      // Check if student enrolled after this month's billing day (e.g. joined 19 Nov, billingDay is 12 Nov)
      const joinedAfterDueDate = Boolean(
        admComp &&
          compareISTDates(
            admComp.year,
            admComp.month,
            admComp.day,
            targetYear,
            m,
            effectiveDay
          ) > 0
      );

      // Check if this month's due date is in the future relative to today in IST (e.g. today 19 Nov, billingDay 26 Nov)
      const isDueDateInFuture =
        compareISTDates(
          targetYear,
          m,
          effectiveDay,
          nowIST.year,
          nowIST.month,
          nowIST.day
        ) > 0;

      // Locate fee matching this canonical YYYY-MM
      const targetMonthKey = `${targetYear}-${String(m).padStart(2, "0")}`;
      const matchingFees = allFees.filter(
        (f) => getFeeBillingMonth(f) === targetMonthKey
      );

      // If multiple records, prioritize Paid / Partial / Pending
      let primaryFee: IFeeDocument | null = null;
      if (matchingFees.length > 0) {
        matchingFees.sort((a, b) => {
          const rank = (status: string) => {
            if (status === "Paid") return 3;
            if (status === "Partial Paid") return 2;
            if (status === "Pending" || status === "Verification Pending")
              return 1;
            return 0;
          };
          return rank(b.status) - rank(a.status);
        });
        primaryFee = matchingFees[0];
      }

      // Determine Status
      let status:
        | "paid"
        | "partial"
        | "due"
        | "advance"
        | "upcoming"
        | "pre_admission";

      if (isPreAdmission) {
        status = "pre_admission";
      } else if (primaryFee) {
        const isPaidInFull =
          primaryFee.status === "Paid" ||
          (Number(primaryFee.amountDue) === 0 &&
            Number(primaryFee.paidAmount || 0) > 0);
        const isAdvanceFee = Boolean(
          primaryFee.isAdvance || primaryFee.feeType === "advance"
        );
        const isPartial =
          primaryFee.status === "Partial Paid" ||
          (Number(primaryFee.paidAmount || 0) > 0 &&
            Number(primaryFee.amountDue || 0) > 0);

        if (isPaidInFull) {
          status = isAdvanceFee ? "advance" : "paid";
        } else if (isPartial) {
          status = "partial";
        } else {
          // Unpaid / Pending record in DB
          status = isDueDateInFuture ? "upcoming" : "due";
        }
      } else {
        // No fee record exists in DB
        // Rule 1: today < monthDueDate -> status MUST be 'upcoming' (dueAmount: 0)
        // Rule 2: joiningDate > monthDueDate -> status MUST be 'upcoming' (dueAmount: 0)
        if (isDueDateInFuture || joinedAfterDueDate) {
          status = "upcoming";
        } else {
          // Rule 3: truly due unbilled cycle (joiningDate <= monthDueDate <= today)
          status = "due";
        }
      }

      // Determine Financial Amounts & Identifiers
      let amountInvoiced = 0;
      let amountPaid = 0;
      let amountDue = 0;
      let paidDate: string | null = null;
      let paymentMode: string | null = null;
      let feeId: string | null = null;

      if (primaryFee) {
        feeId = String(primaryFee._id);
        amountPaid = Number(primaryFee.paidAmount) || 0;
        amountDue = Number(primaryFee.amountDue) || 0;
        amountInvoiced =
          Number(primaryFee.originalAmountDue) ||
          amountDue + amountPaid ||
          monthlyFee;

        const rawPaidDate =
          primaryFee.paidDate ||
          primaryFee.paymentDate ||
          primaryFee.paidAt ||
          primaryFee.paymentHistory?.[0]?.paymentDate;
        paidDate = rawPaidDate ? new Date(rawPaidDate).toISOString() : null;

        paymentMode =
          primaryFee.paymentMode ||
          primaryFee.paymentHistory?.[0]?.paymentMode ||
          null;
      } else {
        if (status === "pre_admission") {
          amountInvoiced = 0;
          amountPaid = 0;
          amountDue = 0;
        } else if (status === "upcoming") {
          amountInvoiced = monthlyFee;
          amountPaid = 0;
          amountDue = 0;
        } else {
          // status === "due"
          amountInvoiced = monthlyFee;
          amountPaid = 0;
          amountDue = monthlyFee;
        }
      }

      months.push({
        month: m,
        label: MONTH_LABELS[m - 1],
        billingDate,
        status,
        amountInvoiced,
        amountPaid,
        amountDue,
        paidDate,
        paymentMode,
        feeId,
      });
    }

    // Ensure summary.totalDue is strictly consistent with the sum of all unpaid/due months shown in the calendar
    const calendarDueSum = months
      .filter((m) => m.status === "due" || m.status === "partial")
      .reduce((sum, m) => sum + (Number(m.amountDue) || 0), 0);
    const synchronizedTotalDue = Math.max(totalDue, calendarDueSum);

    return NextResponse.json(
      {
        success: true,
        data: {
          studentId: String(student._id),
          year: targetYear,
          summary: {
            totalDue: synchronizedTotalDue,
            advanceBalance,
            nextBillingDate,
            monthlyFee,
            dueDay,
            admissionDate,
          },
          months,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch student fee summary";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
