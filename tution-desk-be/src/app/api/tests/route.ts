import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Test from "@/models/Test";
import Student from "@/models/Student";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { notifyTestEvents } from "@/lib/notificationService";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access tests" },
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

    const { searchParams } = request.nextUrl;

    // 2. Center isolation derived strictly from verified JWT
    const filter: Record<string, unknown> = { centerId: user.centerId };

    // 3. Role-based scoping for tests
    if (user.role === "teacher") {
      // Teachers can ONLY view tests assigned to their own teacherId
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      filter.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    } else {
      // Owner can view all tests in institute, or filter by teacher
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          filter.$or = [
            { assignedTeacherId: null },
            { assignedTeacherId: { $exists: false } },
          ];
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          filter.assignedTeacherId = new mongoose.Types.ObjectId(assignedTeacherParam);
        } else {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacher query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
      }
    }

    // Optional batch filter
    const batch = searchParams.get("batch");
    if (batch && batch.trim()) {
      filter.batch = batch.trim();
    }

    const tests = await Test.find(filter).sort({ date: -1, createdAt: -1 });

    return NextResponse.json(
      { success: true, count: tests.length, data: tests },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch tests";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to create tests" },
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

    const body = await request.json().catch(() => ({}));
    const { title, batch, date, maxMarks, results } = body;

    // 2. Validate input parameters
    if (!title || !String(title).trim()) {
      return NextResponse.json(
        { success: false, error: "Test title is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!batch || !String(batch).trim()) {
      return NextResponse.json(
        { success: false, error: "Batch is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const parsedMaxMarks = Number(maxMarks);
    if (isNaN(parsedMaxMarks) || parsedMaxMarks < 1) {
      return NextResponse.json(
        { success: false, error: "maxMarks must be a positive number greater than 0" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Derive centerId and teacher attribution exclusively from verified JWT
    // Client-supplied centerId and assignedTeacherId are strictly ignored
    const targetCenterId = user.centerId;
    let assignedTeacherId: mongoose.Types.ObjectId | null = null;

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    // 4. If initial results are submitted, validate student IDs
    const resultsList = Array.isArray(results) ? results : [];
    if (resultsList.length > 0) {
      const studentIds = resultsList
        .map((r: { studentId?: string | mongoose.Types.ObjectId }) =>
          r.studentId ? String(r.studentId) : null
        )
        .filter((id: string | null): id is string => Boolean(id) && mongoose.Types.ObjectId.isValid(id!));

      if (studentIds.length > 0) {
        const studentQuery: Record<string, unknown> = {
          _id: { $in: studentIds },
          centerId: targetCenterId,
        };

        if (user.role === "teacher") {
          studentQuery.assignedTeacherId = assignedTeacherId;
        }

        const validStudents = await Student.find(studentQuery).select("_id");
        const validStudentIdSet = new Set(validStudents.map((s) => String(s._id)));

        const hasForeignStudent = studentIds.some((id) => !validStudentIdSet.has(id));
        if (hasForeignStudent) {
          return NextResponse.json(
            {
              success: false,
              error:
                user.role === "teacher"
                  ? "Access denied: Cannot submit test results for students not assigned to your account"
                  : "One or more student records do not exist in this institute",
            },
            { status: 403, headers: corsHeaders }
          );
        }
      }
    }

    const testDate = date && !isNaN(new Date(date).getTime()) ? new Date(date) : new Date();

    const newTest = await Test.create({
      centerId: targetCenterId,
      assignedTeacherId,
      title: String(title).trim(),
      batch: String(batch).trim(),
      date: testDate,
      maxMarks: parsedMaxMarks,
      results: resultsList,
    });

    // Event Notification Dispatch (Assigned Teacher alert)
    try {
      await notifyTestEvents({
        centerId: targetCenterId,
        testId: String(newTest._id),
        testTitle: newTest.title,
        batch: newTest.batch,
        maxMarks: newTest.maxMarks,
        assignedTeacherId: assignedTeacherId ? String(assignedTeacherId) : undefined,
        eventType: "test_scheduled",
      });
    } catch (notifErr) {
      console.warn("[TEST SCHEDULED] Notification dispatch error:", notifErr);
    }

    return NextResponse.json(
      { success: true, data: newTest },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create test";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
