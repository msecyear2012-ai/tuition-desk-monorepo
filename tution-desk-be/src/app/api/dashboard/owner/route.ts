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

    // Today's date boundary
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // 3. Run concurrent MongoDB queries using Promise.all
    const [
      totalStudents,
      totalBatches,
      pendingFeeAgg,
      overdueCount,
      todayAttendance,
      todayPresentCount,
      collectedFeeAgg,
      pendingTestsCount,
      batchesList,
      recentFees,
      recentStudents,
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

      // Sum of amountDue from Fee model where status is 'Pending' (scoped)
      Fee.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            centerId: trimmedCenterId,
            status: "Pending",
            ...feeMatchCondition,
          },
        },
        { $group: { _id: null, total: { $sum: "$amountDue" } } },
      ]),

      // Count of 'Pending' fee records (scoped)
      Fee.countDocuments({
        centerId: trimmedCenterId,
        status: "Pending",
        ...feeMatchCondition,
      }),

      // Count of attendance records marked for today (scoped)
      Attendance.countDocuments({
        centerId: trimmedCenterId,
        date: { $gte: startOfDay, $lte: endOfDay },
        ...attendanceMatchCondition,
      }),

      // Count of present attendance records today (scoped)
      Attendance.countDocuments({
        centerId: trimmedCenterId,
        date: { $gte: startOfDay, $lte: endOfDay },
        status: "Present",
        ...attendanceMatchCondition,
      }),

      // Sum of collected fees (scoped)
      Fee.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            centerId: trimmedCenterId,
            status: { $in: ["Paid", "Partial Paid"] },
            ...feeMatchCondition,
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [
                  { $gt: ["$paidAmount", 0] },
                  "$paidAmount",
                  "$amountDue",
                ],
              },
            },
          },
        },
      ]),

      // Total tests in center (scoped)
      Test.countDocuments({
        centerId: trimmedCenterId,
        ...testMatchCondition,
      }),

      // Active batches list for schedule (scoped)
      Batch.find({
        centerId: trimmedCenterId,
        isActive: { $ne: false },
        ...batchMatchCondition,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),

      // Recent fees for activity timeline (scoped)
      Fee.find({
        centerId: trimmedCenterId,
        ...feeMatchCondition,
      })
        .sort({ createdAt: -1 })
        .limit(6)
        .populate("studentId", "name batch")
        .lean(),

      // Recent students for activity timeline (scoped)
      Student.find({
        centerId: trimmedCenterId,
        ...studentMatchCondition,
      })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),
    ]);

    const pendingFeesTotal = pendingFeeAgg[0]?.total || 0;
    const collectedFeesTotal = collectedFeeAgg[0]?.total || 0;
    const attendanceTodayPercentage =
      todayAttendance > 0
        ? Math.round((todayPresentCount / todayAttendance) * 100)
        : 100;

    // Student counts per batch (scoped)
    const studentBatchCounts = await Student.aggregate<{
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
    ]);

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

    // Format recent activities
    const feeActivities = recentFees.map((f: any) => ({
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

    const studentActivities = recentStudents.map((s: any) => ({
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
