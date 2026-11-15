import { NextRequest, NextResponse } from "next/server";
import mongoose, { PipelineStage } from "mongoose";
import connectDB from "@/lib/db";
import Fee from "@/models/Fee";
import Center from "@/models/Center";
import Teacher from "@/models/Teacher";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { getISTDateComponents } from "@/lib/dateUtils";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

/**
 * Parses daily IST date string (YYYY-MM-DD) into UTC Date boundaries.
 * Start: YYYY-MM-DDT00:00:00.000+05:30
 * End:   YYYY-MM-DDT23:59:59.999+05:30
 */
function parseISTDailyBounds(dateStr: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const start = new Date(`${dateStr}T00:00:00.000+05:30`);
  const end = new Date(`${dateStr}T23:59:59.999+05:30`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return null;
  }
  return { start, end };
}

/**
 * Parses monthly IST components into UTC Date boundaries for that entire month.
 */
function parseISTMonthlyBounds(year: number, month: number): { start: Date; end: Date } | null {
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return null;
  }
  const monthStr = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const lastDayStr = String(lastDay).padStart(2, "0");

  const start = new Date(`${year}-${monthStr}-01T00:00:00.000+05:30`);
  const end = new Date(`${year}-${monthStr}-${lastDayStr}T23:59:59.999+05:30`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return null;
  }
  return { start, end };
}

/**
 * Parses custom date range (startDate, endDate in YYYY-MM-DD) in IST.
 */
function parseISTCustomBounds(
  startDateStr: string,
  endDateStr: string
): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
    return null;
  }
  const start = new Date(`${startDateStr}T00:00:00.000+05:30`);
  const end = new Date(`${endDateStr}T23:59:59.999+05:30`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return null;
  }
  return { start, end };
}

/**
 * GET /api/reports/teacher-collections
 * Multi-Axis Collection Reporting Endpoint (CONFIRMED DEC-MSEC-06)
 *
 * Provides the Institute Owner with daily, monthly, and custom date-range collection
 * reports with dual-axis attribution:
 * 1. Physical/Digital Cash Custody: receivedBy & receivedByRole (who collected the funds)
 * 2. Academic Responsibility: assignedTeacherAtPayment (student's teacher at payment snapshot)
 *
 * Restricted strictly to authenticated Institute Owners (role === "owner").
 */
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access collection reports" },
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Strict Role Authorization (DEC-MSEC-06): Owners only
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Collection reports are restricted strictly to institute owners",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    // 3. Strictly derive centerId from verified session; never trust client parameters
    const targetCenterId = user.centerId;
    const { searchParams } = request.nextUrl;

    const requestedType = searchParams.get("type");
    const dateParam = searchParams.get("date");
    const monthParam = searchParams.get("month");
    const yearParam = searchParams.get("year");
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    let resolvedType: "daily" | "monthly" | "custom" = "daily";
    let dateBounds: { start: Date; end: Date } | null = null;

    // Determine query type and bounds
    if (requestedType === "custom" || (startDateParam && endDateParam && !requestedType)) {
      resolvedType = "custom";
      if (!startDateParam || !endDateParam) {
        return NextResponse.json(
          {
            success: false,
            error: "startDate and endDate parameters are required for custom range reports (YYYY-MM-DD)",
          },
          { status: 400, headers: corsHeaders }
        );
      }
      dateBounds = parseISTCustomBounds(startDateParam, endDateParam);
      if (!dateBounds) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Invalid date range. Expected startDate and endDate in YYYY-MM-DD format with startDate <= endDate",
          },
          { status: 400, headers: corsHeaders }
        );
      }
    } else if (
      requestedType === "monthly" ||
      (monthParam && !requestedType) ||
      (yearParam && !requestedType)
    ) {
      resolvedType = "monthly";
      let y = parseInt(yearParam || "", 10);
      let m = parseInt(monthParam || "", 10);

      // Support canonical "YYYY-MM" format in month param (e.g. month=2026-11)
      if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
        const [yStr, mStr] = monthParam.split("-");
        y = parseInt(yStr, 10);
        m = parseInt(mStr, 10);
      }

      dateBounds = parseISTMonthlyBounds(y, m);
      if (!dateBounds) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Invalid year or month format. Expected year (YYYY) and month (1-12) or month=YYYY-MM",
          },
          { status: 400, headers: corsHeaders }
        );
      }
    } else {
      // Default to daily report
      resolvedType = "daily";
      let targetDateStr = dateParam;

      if (!targetDateStr) {
        // Default to today in IST
        const istComponents = getISTDateComponents(new Date());
        targetDateStr = `${istComponents.year}-${String(istComponents.month).padStart(2, "0")}-${String(istComponents.day).padStart(2, "0")}`;
      }

      dateBounds = parseISTDailyBounds(targetDateStr);
      if (!dateBounds) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid date format. Expected date in YYYY-MM-DD format",
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    const { start, end } = dateBounds;

    // 4. Aggregation Pipeline
    // Matches settled payments within the date boundaries under the authenticated center.
    // Notice: Verification Pending payments (paidAmount: 0, paymentDate: null) are strictly excluded.
    const matchStage: Record<string, unknown> = {
      centerId: targetCenterId,
      status: { $in: ["Paid", "Partial Paid"] },
      isVoided: { $ne: true },
      paidAmount: { $gt: 0 },
      $or: [
        { paymentDate: { $gte: start, $lte: end } },
        { paymentDate: null, paidDate: { $gte: start, $lte: end } },
        { paymentDate: { $exists: false }, paidDate: { $gte: start, $lte: end } },
      ],
    };

    const aggregationPipeline: PipelineStage[] = [
      { $match: matchStage as Record<string, any> },
      {
        $facet: {
          consolidated: [
            {
              $group: {
                _id: null,
                totalAmount: { $sum: "$paidAmount" },
                transactionCount: { $sum: 1 },
              },
            },
          ],
          byPaymentReceiver: [
            {
              $group: {
                _id: {
                  receivedBy: "$receivedBy",
                  receivedByRole: "$receivedByRole",
                },
                totalAmount: { $sum: "$paidAmount" },
                transactionCount: { $sum: 1 },
              },
            },
            { $sort: { totalAmount: -1 } },
          ],
          byAcademicTeacher: [
            {
              $group: {
                _id: "$assignedTeacherAtPayment",
                totalAmount: { $sum: "$paidAmount" },
                transactionCount: { $sum: 1 },
              },
            },
            { $sort: { totalAmount: -1 } },
          ],
        },
      },
    ];

    const [aggregationResult] = await Fee.aggregate(aggregationPipeline);

    // 5. Resolve Center & Teacher Entities for human-readable labels
    const centerDoc = await Center.findOne({ centerId: targetCenterId }).select(
      "_id name ownerName phone"
    );
    const ownerDisplayName = centerDoc?.ownerName || centerDoc?.name || "Institute Owner";
    const ownerCenterIdString = centerDoc?._id?.toString();

    const teacherDocs = await Teacher.find({ centerId: targetCenterId }).select(
      "_id name phone loginId isActive"
    );
    const teacherMap = new Map<string, { name: string; phone: string; isActive: boolean }>();
    teacherDocs.forEach((t) => {
      teacherMap.set(t._id.toString(), {
        name: t.name,
        phone: t.phone,
        isActive: Boolean(t.isActive),
      });
    });

    // 6. Format Consolidated Summary
    const consolidatedRaw = aggregationResult?.consolidated?.[0];
    const summary = {
      totalAmount: Number(consolidatedRaw?.totalAmount) || 0,
      transactionCount: Number(consolidatedRaw?.transactionCount) || 0,
    };

    // 7. Format byPaymentReceiver (Cash Custody Breakdown)
    interface ReceiverBucket {
      _id: { receivedBy?: mongoose.Types.ObjectId; receivedByRole?: string };
      totalAmount: number;
      transactionCount: number;
    }

    const byPaymentReceiver = (
      (aggregationResult?.byPaymentReceiver as ReceiverBucket[]) || []
    ).map((bucket) => {
      const rawReceiverId = bucket._id?.receivedBy ? String(bucket._id.receivedBy) : null;
      let role = bucket._id?.receivedByRole || "owner";

      // If receiverId matches center._id, role is owner
      if (rawReceiverId && ownerCenterIdString && rawReceiverId === ownerCenterIdString) {
        role = "owner";
      }

      let name = ownerDisplayName;
      let phone = centerDoc?.phone || "";

      if (role === "teacher" && rawReceiverId) {
        const teacherInfo = teacherMap.get(rawReceiverId);
        if (teacherInfo) {
          name = teacherInfo.name;
          phone = teacherInfo.phone;
        } else {
          name = "Teacher (Unknown/Inactive)";
        }
      } else {
        role = "owner";
        name = `${ownerDisplayName} (Owner)`;
      }

      return {
        receiverId: rawReceiverId,
        receiverRole: role as "owner" | "teacher",
        name,
        phone,
        totalAmount: Number(bucket.totalAmount) || 0,
        transactionCount: Number(bucket.transactionCount) || 0,
      };
    });

    // 8. Format byAcademicTeacher (Academic Responsibility Breakdown)
    interface AcademicTeacherBucket {
      _id?: mongoose.Types.ObjectId | null;
      totalAmount: number;
      transactionCount: number;
    }

    const byAcademicTeacher = (
      (aggregationResult?.byAcademicTeacher as AcademicTeacherBucket[]) || []
    ).map((bucket) => {
      const teacherId = bucket._id ? String(bucket._id) : null;
      const isOwner = !teacherId;

      let name = `${ownerDisplayName} (Owner)`;
      let phone = centerDoc?.phone || "";

      if (teacherId) {
        const teacherInfo = teacherMap.get(teacherId);
        if (teacherInfo) {
          name = teacherInfo.name;
          phone = teacherInfo.phone;
        } else {
          name = "Teacher (Unknown/Inactive)";
        }
      }

      return {
        teacherId,
        isOwner,
        name,
        phone,
        totalAmount: Number(bucket.totalAmount) || 0,
        transactionCount: Number(bucket.transactionCount) || 0,
      };
    });

    return NextResponse.json(
      {
        success: true,
        period: {
          type: resolvedType,
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          timezone: "Asia/Kolkata",
        },
        summary,
        byPaymentReceiver,
        byAcademicTeacher,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Failed to generate collection report";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
