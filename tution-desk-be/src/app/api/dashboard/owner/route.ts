import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import Student from "../../../../models/Student.ts";
import Batch from "../../../../models/Batch.ts";
import Fee from "../../../../models/Fee.ts";
import Attendance from "../../../../models/Attendance.ts";
import Test from "../../../../models/Test.ts";
import Teacher from "../../../../models/Teacher.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { maskContactNumber } from "../../../../lib/privacyUtils.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access dashboard" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const trimmedCenterId = String(user.centerId).trim();
    const { searchParams } = request.nextUrl;

    let studentMatchCondition: Record<string, unknown> = {};
    let feeMatchCondition: Record<string, unknown> = {};
    let attendanceMatchCondition: Record<string, unknown> = {};
    let testMatchCondition: Record<string, unknown> = {};
    let batchMatchCondition: Record<string, unknown> = {};

    // 2. Role-based scoping
    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);

      // Fetch teacher's assigned students to determine batch and student scope
      const teacherStudents = await Student.find({
        centerId: trimmedCenterId,
        assignedTeacherId: teacherObjectId,
        isActive: { $ne: false },
      }).select("_id batch name");

      const scopedStudentIds = teacherStudents.map((s) => s._id);
      const studentBatchNames = [
        ...new Set(teacherStudents.map((s) => s.batch).filter(Boolean)),
      ];

      // Fetch teacher document for explicitly assigned batches
      const teacherDoc = await Teacher.findOne({
        _id: teacherObjectId,
        centerId: trimmedCenterId,
      }).select("assignedBatches");

      const teacherBatches = Array.from(
        new Set([...studentBatchNames, ...(teacherDoc?.assignedBatches || [])])
      );

      studentMatchCondition = {
        assignedTeacherId: teacherObjectId,
      };

      feeMatchCondition = {
        $or: [
          { assignedTeacherId: teacherObjectId },
          ...(scopedStudentIds.length > 0 ? [{ studentId: { $in: scopedStudentIds } }] : []),
        ],
      };

      attendanceMatchCondition = {
        $or: [
          { assignedTeacherId: teacherObjectId },
          ...(scopedStudentIds.length > 0 ? [{ studentId: { $in: scopedStudentIds } }] : []),
        ],
      };

      testMatchCondition = {
        assignedTeacherId: teacherObjectId,
      };

      batchMatchCondition = {
        name: { $in: teacherBatches },
      };
    } else {
      // Owner: Institute-wide by default, or filtered by faculty parameter
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          studentMatchCondition = {
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
            ],
          };

          const ownerStudents = await Student.find({
            centerId: trimmedCenterId,
            ...studentMatchCondition,
            isActive: { $ne: false },
          }).select("_id batch name");

          const ownerStudentIds = ownerStudents.map((s) => s._id);
          const ownerBatches = [
            ...new Set(ownerStudents.map((s) => s.batch).filter(Boolean)),
          ];

          feeMatchCondition = {
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
              ...(ownerStudentIds.length > 0 ? [{ studentId: { $in: ownerStudentIds } }] : []),
            ],
          };

          attendanceMatchCondition = {
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
              ...(ownerStudentIds.length > 0 ? [{ studentId: { $in: ownerStudentIds } }] : []),
            ],
          };

          testMatchCondition = {
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
            ],
          };

          batchMatchCondition = {
            name: { $in: ownerBatches },
          };
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          const targetTeacherId = new mongoose.Types.ObjectId(assignedTeacherParam);

          studentMatchCondition = {
            assignedTeacherId: targetTeacherId,
          };

          const teacherStudents = await Student.find({
            centerId: trimmedCenterId,
            assignedTeacherId: targetTeacherId,
            isActive: { $ne: false },
          }).select("_id batch name");

          const scopedStudentIds = teacherStudents.map((s) => s._id);
          const studentBatchNames = [
            ...new Set(teacherStudents.map((s) => s.batch).filter(Boolean)),
          ];

          const teacherDoc = await Teacher.findOne({
            _id: targetTeacherId,
            centerId: trimmedCenterId,
          }).select("assignedBatches");

          const teacherBatches = Array.from(
            new Set([...studentBatchNames, ...(teacherDoc?.assignedBatches || [])])
          );

          feeMatchCondition = {
            $or: [
              { assignedTeacherId: targetTeacherId },
              ...(scopedStudentIds.length > 0 ? [{ studentId: { $in: scopedStudentIds } }] : []),
            ],
          };

          attendanceMatchCondition = {
            $or: [
              { assignedTeacherId: targetTeacherId },
              ...(scopedStudentIds.length > 0 ? [{ studentId: { $in: scopedStudentIds } }] : []),
            ],
          };

          testMatchCondition = {
            assignedTeacherId: targetTeacherId,
          };

          batchMatchCondition = {
            name: { $in: teacherBatches },
          };
        } else {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacher query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
      }
    }

    // Date boundaries in IST (UTC+5:30)
    const nowUtcMs = Date.now();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(nowUtcMs + (new Date().getTimezoneOffset() * 60000) + istOffsetMs);

    const istYear = istNow.getFullYear();
    const istMonth = String(istNow.getMonth() + 1).padStart(2, "0");
    const istDay = String(istNow.getDate()).padStart(2, "0");
    const lastDayOfMonth = new Date(istYear, istNow.getMonth() + 1, 0).getDate();

    const startOfDay = new Date(`${istYear}-${istMonth}-${istDay}T00:00:00.000+05:30`);
    const endOfDay = new Date(`${istYear}-${istMonth}-${istDay}T23:59:59.999+05:30`);

    const startOfMonth = new Date(`${istYear}-${istMonth}-01T00:00:00.000+05:30`);
    const endOfMonth = new Date(`${istYear}-${istMonth}-${String(lastDayOfMonth).padStart(2, "0")}T23:59:59.999+05:30`);

    // 3. Run concurrent MongoDB queries using Promise.all
    const [
      totalStudents,
      totalBatches,
      pendingFeeAgg,
      attendanceMetrics,
      collectedFeeAgg,
      pendingTestsCount,
      batchesList,
      recentFees,
      recentStudents,
      studentBatchCounts,
    ] = await Promise.all([
      // Count of active students in this center (scoped)
      Student.countDocuments({
        centerId: trimmedCenterId,
        isActive: { $ne: false },
        ...studentMatchCondition,
      }),

      // Count of active batches (scoped)
      Batch.countDocuments({
        centerId: trimmedCenterId,
        isActive: { $ne: false },
        ...batchMatchCondition,
      }),

      // Combined pending fee amount and count in a single aggregation pipeline
      Fee.aggregate<{ _id: null; total: number; count: number }>([
        {
          $match: {
            centerId: trimmedCenterId,
            status: "Pending",
            ...feeMatchCondition,
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amountDue" },
            count: { $sum: 1 },
          },
        },
      ]),

      // Combined attendance metrics for today in a single query
      (async () => {
        if (
          typeof Attendance.aggregate === "function" &&
          (mongoose.connection?.readyState === 1 || Attendance.aggregate !== mongoose.Model.aggregate)
        ) {
          const agg = await Attendance.aggregate<{ _id: null; total: number; present: number }>([
            {
              $match: {
                centerId: trimmedCenterId,
                date: { $gte: startOfDay, $lte: endOfDay },
                ...attendanceMatchCondition,
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                present: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "Present"] }, 1, 0],
                  },
                },
              },
            },
          ]);
          return {
            todayAttendance: agg[0]?.total || 0,
            todayPresentCount: agg[0]?.present || 0,
          };
        }

        // Fallback for mocked test environments without aggregate support
        const [todayAttendance, todayPresentCount] = await Promise.all([
          Attendance.countDocuments({
            centerId: trimmedCenterId,
            date: { $gte: startOfDay, $lte: endOfDay },
            ...attendanceMatchCondition,
          }),
          Attendance.countDocuments({
            centerId: trimmedCenterId,
            date: { $gte: startOfDay, $lte: endOfDay },
            status: "Present",
            ...attendanceMatchCondition,
          }),
        ]);
        return { todayAttendance, todayPresentCount };
      })(),

      // Sum of collected fees strictly within current month in IST (scoped)
      Fee.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            centerId: trimmedCenterId,
            status: { $in: ["Paid", "Partial Paid"] },
            ...feeMatchCondition,
          },
        },
        {
          $project: {
            payments: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$paymentHistory", []] } }, 0] },
                "$paymentHistory",
                [
                  {
                    amount: {
                      $cond: [{ $gt: ["$paidAmount", 0] }, "$paidAmount", "$amountDue"],
                    },
                    paymentDate: {
                      $ifNull: ["$paidDate", { $ifNull: ["$paymentDate", "$paidAt"] }],
                    },
                  },
                ],
              ],
            },
          },
        },
        { $unwind: "$payments" },
        {
          $match: {
            "payments.paymentDate": { $gte: startOfMonth, $lte: endOfMonth },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$payments.amount" },
          },
        },
      ]),

      // Total tests in center (scoped)
      Test.countDocuments({
        centerId: trimmedCenterId,
        ...testMatchCondition,
      }),

      // Active batches list for schedule with lightweight field selection (scoped)
      Batch.find({
        centerId: trimmedCenterId,
        isActive: { $ne: false },
        ...batchMatchCondition,
      })
        .select("_id name timing subject")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),

      // Recent fees for activity timeline with lightweight field selection (scoped)
      Fee.find({
        centerId: trimmedCenterId,
        ...feeMatchCondition,
      })
        .select("_id status month amountDue createdAt studentId")
        .sort({ createdAt: -1 })
        .limit(6)
        .populate("studentId", "name batch")
        .lean(),

      // Recent students for activity timeline with lightweight field selection (scoped)
      Student.find({
        centerId: trimmedCenterId,
        ...studentMatchCondition,
      })
        .select("_id name batch parentWhatsApp createdAt")
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      // Student counts per batch run concurrently in parallel instead of serial waterfall (scoped)
      Student.aggregate<{
        _id: string;
        count: number;
      }>([
        {
          $match: {
            centerId: trimmedCenterId,
            isActive: { $ne: false },
            ...studentMatchCondition,
          },
        },
        {
          $group: {
            _id: "$batch",
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const pendingFeesTotal = pendingFeeAgg[0]?.total || 0;
    const overdueCount =
      pendingFeeAgg.length === 0
        ? 0
        : pendingFeeAgg[0]?.count !== undefined
        ? pendingFeeAgg[0].count
        : typeof Fee.countDocuments === "function"
        ? await Fee.countDocuments({
            centerId: trimmedCenterId,
            status: "Pending",
            ...feeMatchCondition,
          })
        : 0;

    const { todayAttendance, todayPresentCount } = attendanceMetrics;
    const collectedFeesTotal = collectedFeeAgg[0]?.total || 0;
    const attendanceTodayPercentage =
      todayAttendance > 0
        ? Math.round((todayPresentCount / todayAttendance) * 100)
        : 100;

    const batchCountMap = new Map<string, number>();
    studentBatchCounts.forEach((b) => {
      if (b._id) batchCountMap.set(b._id, b.count);
    });

    const formattedBatches = batchesList.map((b, idx) => ({
      id: String(b._id),
      batchName: b.name,
      timing: b.timing || "05:00 PM - 06:15 PM",
      subject: b.subject || "Regular Session",
      totalStudents: batchCountMap.get(b.name) || 0,
      markedStudents: 0,
      status: "pending",
      timelineStatus: idx === 0 ? "ongoing" : "upcoming",
    }));

    interface RecentFeeActivityItem {
      _id: unknown;
      status?: string;
      month?: string;
      amountDue?: number;
      createdAt?: Date | string;
      studentId?: { name?: string; batch?: string };
    }

    interface RecentStudentActivityItem {
      _id: unknown;
      name?: string;
      batch?: string;
      parentWhatsApp?: string;
      createdAt?: Date | string;
    }

    // Format recent activities
    const feeActivities = (recentFees as unknown as RecentFeeActivityItem[]).map((f) => ({
      id: `fee_${f._id}`,
      title:
        f.status === "Paid"
          ? `Fee Received: ${f.studentId?.name || "Student"}`
          : `Fee Due: ${f.studentId?.name || "Student"}`,
      subtitle: `${f.month} • ${f.status}`,
      time: f.createdAt ? new Date(f.createdAt).toISOString() : new Date().toISOString(),
      type: "fee",
      amount: f.amountDue,
    }));

    const studentActivities = (recentStudents as unknown as RecentStudentActivityItem[]).map((s) => ({
      id: `student_${s._id}`,
      title: `Student Enrolled: ${s.name}`,
      subtitle:
        user.role === "teacher"
          ? `${s.batch} • Parent: ${maskContactNumber(s.parentWhatsApp)}`
          : `${s.batch} • Parent: ${s.parentWhatsApp}`,
      time: s.createdAt ? new Date(s.createdAt).toISOString() : new Date().toISOString(),
      type: "enquiry",
    }));

    const recentActivities = [...feeActivities, ...studentActivities]
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 8);

    // 4. Return the aggregated data as JSON
    return NextResponse.json(
      {
        success: true,
        data: {
          totalStudents,
          totalBatches,
          pendingFeesTotal,
          overdueCount,
          todayAttendance,
          todayPresentCount,
          collectedFeesThisMonth: collectedFeesTotal,
          pendingTestsCount,
          attendanceTodayPercentage,
          batches: formattedBatches,
          recentActivities,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to load owner dashboard data";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
