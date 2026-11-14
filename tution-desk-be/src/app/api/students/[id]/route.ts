import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Student from "../../../../models/Student.ts";
import Teacher from "../../../../models/Teacher.ts";
import Fee from "../../../../models/Fee.ts";
import Attendance from "../../../../models/Attendance.ts";
import Test from "../../../../models/Test.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { sanitizeStudentForRole } from "../../../../lib/privacyUtils.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, PUT, DELETE, OPTIONS");
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

    // 3. Query strictly scoped to centerId and role
    const query: Record<string, unknown> = {
      _id: id,
      centerId: user.centerId,
    };

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      query.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    const student = await Student.findOne(query);

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const sanitizedStudent = sanitizeStudentForRole(
      student.toObject ? student.toObject() : { ...student },
      user.role
    );

    return NextResponse.json(
      { success: true, data: sanitizedStudent },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch student";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function PUT(
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

    // 3. Locate student strictly scoped to centerId and role
    const query: Record<string, unknown> = {
      _id: id,
      centerId: user.centerId,
    };

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      query.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    const student = await Student.findOne(query);

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => ({}));

    // 4. Validate assignment changes
    if (user.role === "teacher") {
      // Teachers CANNOT change student assignment
      if (
        body.assignedTeacherId !== undefined &&
        String(body.assignedTeacherId) !== String(user.teacherId)
      ) {
        return NextResponse.json(
          { success: false, error: "Teachers cannot change student assignment" },
          { status: 403, headers: corsHeaders }
        );
      }
    } else {
      // Owner can reassign student to Owner (null) or an active Teacher in the same center
      if (body.assignedTeacherId !== undefined) {
        if (
          body.assignedTeacherId === null ||
          body.assignedTeacherId === "owner" ||
          body.assignedTeacherId === ""
        ) {
          student.assignedTeacherId = null;
        } else {
          if (!mongoose.Types.ObjectId.isValid(String(body.assignedTeacherId))) {
            return NextResponse.json(
              { success: false, error: "Invalid Teacher ID format" },
              { status: 400, headers: corsHeaders }
            );
          }

          const targetTeacher = await Teacher.findOne({
            _id: body.assignedTeacherId,
            centerId: user.centerId,
          });

          if (!targetTeacher) {
            return NextResponse.json(
              { success: false, error: "Teacher not found in this institute" },
              { status: 400, headers: corsHeaders }
            );
          }

          if (!targetTeacher.isActive) {
            return NextResponse.json(
              { success: false, error: "Cannot assign student to an inactive teacher" },
              { status: 400, headers: corsHeaders }
            );
          }

          student.assignedTeacherId = targetTeacher._id as mongoose.Types.ObjectId;
        }
      }
    }

    // 5. Update permitted mutable fields with strict validation (protect _id, centerId)
    if (body.name !== undefined) {
      const cleanName = String(body.name).trim();
      if (!cleanName) {
        return NextResponse.json(
          { success: false, error: "Student name cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      student.name = cleanName;
    }

    if (body.batch !== undefined) {
      const cleanBatch = String(body.batch).trim();
      if (!cleanBatch) {
        return NextResponse.json(
          { success: false, error: "Batch cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      // REQ-01: Teachers cannot directly reassign student batches; must go through Owner approval workflow
      if (user.role === "teacher" && cleanBatch !== student.batch) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Access denied: Teachers cannot directly reassign student batches. Submit a batch assignment request for Owner approval.",
          },
          { status: 403, headers: corsHeaders }
        );
      }
      student.batch = cleanBatch;
    }

    if (body.parentWhatsApp !== undefined) {
      if (user.role === "teacher") {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Teachers cannot update student contact numbers",
          },
          { status: 403, headers: corsHeaders }
        );
      }
      const cleanPhone = String(body.parentWhatsApp).replace(/\D/g, "");
      if (cleanPhone.length < 10 || cleanPhone.length > 15) {
        return NextResponse.json(
          {
            success: false,
            error: "parentWhatsApp must be a valid 10 to 15 digit phone number",
          },
          { status: 400, headers: corsHeaders }
        );
      }
      student.parentWhatsApp = cleanPhone;
    }

    if (body.isActive !== undefined) {
      student.isActive = Boolean(body.isActive);
    }

    if (body.joiningDate !== undefined) {
      student.joiningDate = new Date(body.joiningDate);
    }

    if (body.monthlyFee !== undefined) {
      const feeNum = Number(body.monthlyFee);
      if (isNaN(feeNum) || feeNum < 0) {
        return NextResponse.json(
          { success: false, error: "Monthly fee must be a non-negative number" },
          { status: 400, headers: corsHeaders }
        );
      }
      student.monthlyFee = feeNum;
    }

    if (body.billingCycleDate !== undefined) {
      const cycleNum = Number(body.billingCycleDate);
      if (isNaN(cycleNum) || cycleNum < 1 || cycleNum > 31) {
        return NextResponse.json(
          { success: false, error: "Billing cycle date must be between 1 and 31" },
          { status: 400, headers: corsHeaders }
        );
      }
      student.billingCycleDate = cycleNum;
    }

    await student.save();

    const sanitizedStudent = sanitizeStudentForRole(
      student.toObject ? student.toObject() : { ...student },
      user.role
    );

    return NextResponse.json(
      { success: true, data: sanitizedStudent },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to update student";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(
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

    // 3. Locate student strictly scoped to centerId and role
    const query: Record<string, unknown> = {
      _id: id,
      centerId: user.centerId,
    };

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      query.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    const student = await Student.findOne(query);

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. Guard against removing students with unresolved Pending, Verification Pending, or Partial Paid dues
    const unresolvedDuesCount = await Fee.countDocuments({
      studentId: student._id,
      centerId: user.centerId,
      status: { $in: ["Pending", "Verification Pending", "Partial Paid"] },
    });

    if (unresolvedDuesCount > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot remove student: ${unresolvedDuesCount} active fee obligation(s) exist. Settle or cancel pending dues before removing.`,
          code: "UNRESOLVED_FEES_EXIST",
          unresolvedCount: unresolvedDuesCount,
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 5. Check if historical fee, attendance, or test records exist
    const [hasFees, hasAttendance, hasTests] = await Promise.all([
      Fee.exists({ studentId: student._id, centerId: user.centerId }),
      Attendance.exists({ studentId: student._id, centerId: user.centerId }),
      Test.exists({ centerId: user.centerId, "results.studentId": student._id }),
    ]);

    const hasHistoricalRecords = Boolean(hasFees || hasAttendance || hasTests);

    if (hasHistoricalRecords) {
      // Soft-deactivate student to preserve receipts, attendance, and academic history
      student.isActive = false;
      await student.save();

      return NextResponse.json(
        {
          success: true,
          action: "deactivated",
          message:
            "Student deactivated and archived. Historical fee receipts, attendance, and test records preserved.",
          data: student,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // 6. Clean hard-delete if zero historical dependencies exist
    await Student.findOneAndDelete({ _id: student._id, centerId: user.centerId });

    return NextResponse.json(
      {
        success: true,
        action: "deleted",
        message: "Student deleted successfully",
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to delete student";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
