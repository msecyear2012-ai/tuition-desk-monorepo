import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Student from "@/models/Student";
import Fee from "@/models/Fee";
import Teacher from "@/models/Teacher";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";

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

    if (user.role === "teacher" && (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId))) {
      return NextResponse.json(
        { success: false, error: "Teacher profile invalid" },
        { status: 403, headers: corsHeaders }
      );
    }

    const { searchParams } = request.nextUrl;
    const q = (
      searchParams.get("q") ||
      searchParams.get("query") ||
      searchParams.get("search") ||
      searchParams.get("name") ||
      searchParams.get("rollNumber") ||
      ""
    ).trim();

    // Input length validation
    if (q.length > 100) {
      return NextResponse.json(
        { success: false, error: "Search query too long (max 100 characters)" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Limit result count (default 20, max 50, min 1)
    const limitParam = searchParams.get("limit");
    const limit = Math.min(Math.max(1, Number(limitParam) || 20), 50);

    // Empty search query returns empty list
    if (q.length === 0) {
      return NextResponse.json(
        { success: true, count: 0, data: [] },
        { status: 200, headers: corsHeaders }
      );
    }

    await connectDB();

    // Escape regex characters to prevent ReDoS
    const escapedQuery = q.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");

    // Strictly scope student query to caller's centerId from verified JWT
    const studentFilter: Record<string, unknown> = {
      centerId: user.centerId,
      $or: [
        { name: { $regex: escapedQuery, $options: "i" } },
        { rollNumber: { $regex: escapedQuery, $options: "i" } },
      ],
    };

    // Project ONLY non-sensitive fields; never fetch phone, parentWhatsApp, address, notes, marks
    const students = await Student.find(studentFilter)
      .select("_id name rollNumber batch assignedTeacherId centerId")
      .limit(limit)
      .lean();

    if (!students || students.length === 0) {
      return NextResponse.json(
        { success: true, count: 0, data: [] },
        { status: 200, headers: corsHeaders }
      );
    }

    // Resolve assigned teacher names within the institute
    const teacherIdStrings = Array.from(
      new Set(
        students
          .map((s) => s.assignedTeacherId)
          .filter((id): id is mongoose.Types.ObjectId => Boolean(id) && mongoose.Types.ObjectId.isValid(String(id)))
          .map((id) => String(id))
      )
    );

    const teacherMap = new Map<string, string>();
    if (teacherIdStrings.length > 0) {
      const teachers = await Teacher.find({
        _id: { $in: teacherIdStrings },
        centerId: user.centerId,
      })
        .select("_id name")
        .lean();

      for (const t of teachers) {
        teacherMap.set(String(t._id), t.name);
      }
    }

    // Join pending fee dues from Fee collection scoped strictly to user.centerId
    const studentIds = students.map((s) => s._id);
    const pendingFees = await Fee.find({
      centerId: user.centerId,
      studentId: { $in: studentIds },
      status: { $in: ["Pending", "Partial Paid"] },
      amountDue: { $gt: 0 },
    })
      .select("studentId amountDue")
      .lean();

    const duesMap = new Map<string, number>();
    for (const fee of pendingFees) {
      const sKey = String(fee.studentId);
      duesMap.set(sKey, (duesMap.get(sKey) || 0) + (Number(fee.amountDue) || 0));
    }

    // Build sanitized student cards strictly adhering to Phase 3A specifications
    const sanitizedData = students.map((student) => {
      let assignedTeacherName = "Institute Owner";
      if (student.assignedTeacherId) {
        const foundName = teacherMap.get(String(student.assignedTeacherId));
        assignedTeacherName = foundName || "Teacher";
      }

      return {
        _id: student._id,
        name: student.name,
        rollNumber: student.rollNumber || "",
        batch: student.batch || "",
        assignedTeacherName,
        pendingDues: duesMap.get(String(student._id)) || 0,
      };
    });

    return NextResponse.json(
      {
        success: true,
        count: sanitizedData.length,
        data: sanitizedData,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to perform student lookup";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
