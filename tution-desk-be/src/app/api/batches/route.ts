import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import Batch from "../../../models/Batch.ts";
import Student from "../../../models/Student.ts";
import Teacher from "../../../models/Teacher.ts";
import { getAuthenticatedUser, getAuthenticatedCenterId } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

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

    // REQ-01: Additional teachers are strictly prohibited from creating new batches
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only Institute Owners are authorized to create batches.",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const { name, timing, subject, teacherId, assignedTeacherId } = body;
    const targetCenterId = user.centerId;

    if (!name || !String(name).trim()) {
      return NextResponse.json(
        { success: false, error: "Batch name is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const trimmedName = String(name).trim();

    // Check if batch already exists for this center
    const existing = await Batch.findOne({ centerId: targetCenterId, name: trimmedName });
    if (existing) {
      return NextResponse.json(
        { success: false, error: "A batch with this name already exists" },
        { status: 409, headers: corsHeaders }
      );
    }

    const rawTeacherId =
      assignedTeacherId !== undefined ? assignedTeacherId : teacherId;
    let targetTeacherObjectId: mongoose.Types.ObjectId | null = null;

    if (
      rawTeacherId &&
      rawTeacherId !== "owner" &&
      rawTeacherId !== "null" &&
      rawTeacherId !== "" &&
      mongoose.Types.ObjectId.isValid(rawTeacherId)
    ) {
      const targetTeacher = await Teacher.findOne({
        _id: rawTeacherId,
        centerId: targetCenterId,
        isActive: { $ne: false },
      });
      if (targetTeacher) {
        targetTeacherObjectId = new mongoose.Types.ObjectId(rawTeacherId);
      }
    }

    const newBatch = await Batch.create({
      centerId: targetCenterId,
      name: trimmedName,
      timing: timing ? String(timing).trim() : undefined,
      subject: subject ? String(subject).trim() : undefined,
      assignedTeacherId: targetTeacherObjectId,
      isActive: true,
    });

    if (targetTeacherObjectId) {
      await Teacher.updateOne(
        { _id: targetTeacherObjectId, centerId: targetCenterId },
        { $addToSet: { assignedBatches: trimmedName } }
      );
    }


    return NextResponse.json(
      { success: true, data: newBatch },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create batch";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    const authCenterId = user?.centerId || (await getAuthenticatedCenterId(request));
    const { searchParams } = request.nextUrl;
    const centerId = authCenterId || searchParams.get("centerId");

    if (!centerId) {
      return NextResponse.json(
        { success: false, error: "Authentication or centerId query parameter is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const filter: Record<string, unknown> = {
      centerId,
      isActive: { $ne: false },
    };

    const studentMatch: Record<string, unknown> = {
      centerId,
    };

    // Role-based scoping
    if (user?.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);
      studentMatch.assignedTeacherId = teacherObjectId;

      const [teacherStudents, teacherDoc, teacherBatches] = await Promise.all([
        Student.find({
          centerId,
          assignedTeacherId: teacherObjectId,
          isActive: { $ne: false },
        }).select("batch"),
        Teacher.findOne({
          _id: teacherObjectId,
          centerId,
        }).select("assignedBatches"),
        Batch.find({
          centerId,
          assignedTeacherId: teacherObjectId,
          isActive: { $ne: false },
        }).select("name"),
      ]);

      const allowedBatchNames = Array.from(
        new Set([
          ...(teacherDoc?.assignedBatches || []),
          ...teacherStudents.map((s) => s.batch).filter(Boolean),
          ...teacherBatches.map((b) => b.name).filter(Boolean),
        ])
      );

      filter.name = { $in: allowedBatchNames };
    } else if (user?.role === "owner") {
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          studentMatch.$or = [
            { assignedTeacherId: null },
            { assignedTeacherId: { $exists: false } },
          ];
          const [ownerStudents, ownerBatches] = await Promise.all([
            Student.find({
              centerId,
              $or: [{ assignedTeacherId: null }, { assignedTeacherId: { $exists: false } }],
              isActive: { $ne: false },
            }).select("batch"),
            Batch.find({
              centerId,
              $or: [{ assignedTeacherId: null }, { assignedTeacherId: { $exists: false } }],
              isActive: { $ne: false },
            }).select("name"),
          ]);
          const ownerBatchNames = Array.from(
            new Set([
              ...ownerStudents.map((s) => s.batch).filter(Boolean),
              ...ownerBatches.map((b) => b.name).filter(Boolean),
            ])
          );
          filter.name = { $in: ownerBatchNames };
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          const teacherObjectId = new mongoose.Types.ObjectId(assignedTeacherParam);
          studentMatch.assignedTeacherId = teacherObjectId;
          const [teacherStudents, teacherDoc, teacherBatches] = await Promise.all([
            Student.find({
              centerId,
              assignedTeacherId: teacherObjectId,
              isActive: { $ne: false },
            }).select("batch"),
            Teacher.findOne({
              _id: teacherObjectId,
              centerId,
            }).select("assignedBatches"),
            Batch.find({
              centerId,
              assignedTeacherId: teacherObjectId,
              isActive: { $ne: false },
            }).select("name"),
          ]);
          const allowedBatchNames = Array.from(
            new Set([
              ...(teacherDoc?.assignedBatches || []),
              ...teacherStudents.map((s) => s.batch).filter(Boolean),
              ...teacherBatches.map((b) => b.name).filter(Boolean),
            ])
          );
          filter.name = { $in: allowedBatchNames };
        }
      }
    }

    // Run batch query and Student aggregation in parallel
    const [batches, aggResult] = await Promise.all([
      Batch.find(filter).sort({ createdAt: -1 }),
      typeof Student.aggregate === "function"
        ? Student.aggregate([
            { $match: studentMatch },
            {
              $facet: {
                overall: [
                  {
                    $group: {
                      _id: null,
                      totalStudents: { $sum: 1 },
                      activeStudents: {
                        $sum: { $cond: [{ $ne: ["$isActive", false] }, 1, 0] },
                      },
                      totalMonthlyFee: {
                        $sum: {
                          $cond: [
                            { $ne: ["$isActive", false] },
                            { $ifNull: ["$monthlyFee", 0] },
                            0,
                          ],
                        },
                      },
                    },
                  },
                ],
                byBatch: [
                  {
                    $group: {
                      _id: "$batch",
                      studentCount: { $sum: 1 },
                      activeStudentCount: {
                        $sum: { $cond: [{ $ne: ["$isActive", false] }, 1, 0] },
                      },
                      monthlyFeeSum: {
                        $sum: {
                          $cond: [
                            { $ne: ["$isActive", false] },
                            { $ifNull: ["$monthlyFee", 0] },
                            0,
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ]).catch((err) => {
            console.error("Student.aggregate error in /api/batches:", err);
            return [];
          })
        : Promise.resolve([]),
    ]);

    let overall = { totalStudents: 0, activeStudents: 0, totalMonthlyFee: 0 };
    const batchStatsRecord: Record<
      string,
      { studentCount: number; activeStudentCount: number; monthlyFeeSum: number }
    > = {};

    if (Array.isArray(aggResult) && aggResult[0]) {
      const first = aggResult[0];
      if (Array.isArray(first.overall) && first.overall[0]) {
        overall = {
          totalStudents: Number(first.overall[0].totalStudents) || 0,
          activeStudents: Number(first.overall[0].activeStudents) || 0,
          totalMonthlyFee: Number(first.overall[0].totalMonthlyFee) || 0,
        };
      }
      if (Array.isArray(first.byBatch)) {
        for (const item of first.byBatch) {
          if (item && item._id) {
            batchStatsRecord[String(item._id)] = {
              studentCount: Number(item.studentCount) || 0,
              activeStudentCount: Number(item.activeStudentCount) || 0,
              monthlyFeeSum: Number(item.monthlyFeeSum) || 0,
            };
          }
        }
      }
    }

    const batchesWithStats = batches.map((b: any) => {
      const plain = typeof b.toObject === "function" ? b.toObject() : { ...b };
      const stats = batchStatsRecord[plain.name] || {
        studentCount: 0,
        activeStudentCount: 0,
        monthlyFeeSum: 0,
      };
      return {
        ...plain,
        studentCount: stats.studentCount,
        activeStudentCount: stats.activeStudentCount,
        monthlyFeeSum: stats.monthlyFeeSum,
      };
    });

    return NextResponse.json(
      {
        success: true,
        count: batchesWithStats.length,
        data: batchesWithStats,
        summary: {
          totalStudents: overall.totalStudents,
          activeStudents: overall.activeStudents,
          totalMonthlyFee: overall.totalMonthlyFee,
          byBatch: batchStatsRecord,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch batches";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
