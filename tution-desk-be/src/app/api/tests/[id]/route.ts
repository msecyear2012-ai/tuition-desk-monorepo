import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Test from "@/models/Test";
import Student from "@/models/Student";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { notifyTestEvents } from "@/lib/notificationService";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, PUT, DELETE, OPTIONS");
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access test" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    const resolvedParams = await params;
    const { id } = resolvedParams;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid test ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    // 2. Eliminate IDOR: Query strictly scoped to caller's centerId
    const test = await Test.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!test) {
      return NextResponse.json(
        { success: false, error: "Test not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. For Teachers, restrict strictly to their own assigned tests
    if (user.role === "teacher") {
      if (
        !test.assignedTeacherId ||
        test.assignedTeacherId.toString() !== String(user.teacherId)
      ) {
        // Return 404 to avoid ID enumeration/leakage across teachers
        return NextResponse.json(
          { success: false, error: "Test not found" },
          { status: 404, headers: corsHeaders }
        );
      }
    }

    return NextResponse.json(
      { success: true, data: test },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch test";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to update test" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    const resolvedParams = await params;
    const { id } = resolvedParams;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid test ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    // 2. Eliminate IDOR: Verify test exists and belongs to caller's center
    const existingTest = await Test.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!existingTest) {
      return NextResponse.json(
        { success: false, error: "Test not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. For Teachers, restrict strictly to tests assigned to them
    if (user.role === "teacher") {
      if (
        !existingTest.assignedTeacherId ||
        existingTest.assignedTeacherId.toString() !== String(user.teacherId)
      ) {
        return NextResponse.json(
          { success: false, error: "Test not found" },
          { status: 404, headers: corsHeaders }
        );
      }
    }

    const body = await request.json().catch(() => ({}));

    // 4. Whitelist protection: Block any attempt to tamper with centerId or assignedTeacherId
    if (body.centerId !== undefined || body.assignedTeacherId !== undefined) {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot modify test ownership or center attribution",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const updateData: Record<string, unknown> = {};

    if (body.title !== undefined) {
      const trimmedTitle = String(body.title).trim();
      if (!trimmedTitle) {
        return NextResponse.json(
          { success: false, error: "Test title cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      updateData.title = trimmedTitle;
    }

    if (body.batch !== undefined) {
      const trimmedBatch = String(body.batch).trim();
      if (!trimmedBatch) {
        return NextResponse.json(
          { success: false, error: "Batch cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      updateData.batch = trimmedBatch;
    }

    if (body.date !== undefined) {
      const parsedDate = new Date(body.date);
      if (isNaN(parsedDate.getTime())) {
        return NextResponse.json(
          { success: false, error: "Invalid test date" },
          { status: 400, headers: corsHeaders }
        );
      }
      updateData.date = parsedDate;
    }

    if (body.maxMarks !== undefined) {
      const parsedMaxMarks = Number(body.maxMarks);
      if (isNaN(parsedMaxMarks) || parsedMaxMarks < 1) {
        return NextResponse.json(
          {
            success: false,
            error: "maxMarks must be a positive number greater than 0",
          },
          { status: 400, headers: corsHeaders }
        );
      }
      updateData.maxMarks = parsedMaxMarks;
    }

    // 5. If results are updated, strictly validate all student IDs
    if (body.results !== undefined) {
      if (!Array.isArray(body.results)) {
        return NextResponse.json(
          { success: false, error: "results must be an array" },
          { status: 400, headers: corsHeaders }
        );
      }

      const resultsList = body.results;
      const studentIds = (resultsList as Array<{ studentId?: unknown }>)
        .map((r) => (r.studentId ? String(r.studentId) : null))
        .filter((sId: string | null): sId is string => Boolean(sId) && mongoose.Types.ObjectId.isValid(sId!));

      if (studentIds.length > 0) {
        const studentQuery: Record<string, unknown> = {
          _id: { $in: studentIds },
          centerId: user.centerId,
        };

        if (user.role === "teacher") {
          studentQuery.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
        }

        const validStudents = await Student.find(studentQuery).select("_id");
        const validStudentIdSet = new Set(validStudents.map((s) => String(s._id)));

        const hasForeignStudent = studentIds.some((sId: string) => !validStudentIdSet.has(sId));
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

      updateData.results = resultsList;
    }

    const updatedTest = await Test.findOneAndUpdate(
      { _id: id, centerId: user.centerId },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    // Event Notification Dispatch (Parents published results alert)
    if (body.results && Array.isArray(body.results) && body.results.length > 0 && updatedTest) {
      try {
        const studentIds = body.results.map((r: any) => r.studentId);
        const studentDocs = await Student.find({
          _id: { $in: studentIds.map((sid: string) => new mongoose.Types.ObjectId(sid)) },
          centerId: user.centerId,
        }).select("_id name");
        const studentMap = new Map(studentDocs.map((s) => [String(s._id), s.name]));

        const resultsPayload = body.results.map((r: any) => ({
          studentId: String(r.studentId),
          studentName: studentMap.get(String(r.studentId)) || "Student",
          marksObtained: Number(r.marksObtained) || 0,
        }));

        await notifyTestEvents({
          centerId: user.centerId,
          testId: String(updatedTest._id),
          testTitle: updatedTest.title,
          batch: updatedTest.batch,
          maxMarks: updatedTest.maxMarks,
          assignedTeacherId: updatedTest.assignedTeacherId ? String(updatedTest.assignedTeacherId) : undefined,
          eventType: "test_result",
          results: resultsPayload,
        });
      } catch (notifErr) {
        console.warn("[TEST RESULTS] Notification dispatch error:", notifErr);
      }
    }

    return NextResponse.json(
      { success: true, data: updatedTest },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to update test";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to delete test" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    const resolvedParams = await params;
    const { id } = resolvedParams;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid test ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    // 2. Eliminate IDOR: Verify test exists and belongs to caller's center
    const existingTest = await Test.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!existingTest) {
      return NextResponse.json(
        { success: false, error: "Test not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. For Teachers, restrict strictly to tests assigned to them
    if (user.role === "teacher") {
      if (
        !existingTest.assignedTeacherId ||
        existingTest.assignedTeacherId.toString() !== String(user.teacherId)
      ) {
        return NextResponse.json(
          { success: false, error: "Test not found" },
          { status: 404, headers: corsHeaders }
        );
      }
    }

    await Test.findOneAndDelete({
      _id: id,
      centerId: user.centerId,
    });

    return NextResponse.json(
      { success: true, message: "Test deleted successfully" },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to delete test";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}