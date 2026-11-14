import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Teacher from "@/models/Teacher";
import Center from "@/models/Center";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import bcrypt from "bcryptjs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, PUT, OPTIONS");
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

    // 2. Authorize: Only Institute Owner may view teacher details
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner privileges required" },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid teacher ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Connect to database only after authentication and authorization
    await connectDB();

    // 4. Query strictly scoped to the authenticated centerId
    const teacher = await Teacher.findOne({
      _id: id,
      centerId: user.centerId,
    }).select("-password");

    if (!teacher) {
      return NextResponse.json(
        { success: false, error: "Teacher not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: true, data: teacher },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Failed to fetch teacher";
    return NextResponse.json(
      { success: false, error: errorMsg },
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

    // 2. Authorize: Only Institute Owner may update teachers
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner privileges required" },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await context.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Valid teacher ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Connect to database only after authentication and authorization
    await connectDB();

    // 4. Locate teacher strictly within the authenticated institute
    const teacher = await Teacher.findOne({
      _id: id,
      centerId: user.centerId,
    });

    if (!teacher) {
      return NextResponse.json(
        { success: false, error: "Teacher not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => ({}));

    // 4. Update permitted mutable fields with strict validation
    if (body.name !== undefined) {
      const cleanName = String(body.name).trim();
      if (!cleanName) {
        return NextResponse.json(
          { success: false, error: "Teacher name cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }
      teacher.name = cleanName;
    }

    // 4. Update permitted mutable fields with strict validation & cross-field collision prevention
    let candidateLoginId = teacher.loginId;
    let candidatePhone = teacher.phone;
    let loginIdChanged = false;
    let phoneChanged = false;

    if (body.loginId !== undefined) {
      const cleanLoginId = String(body.loginId).trim();
      if (!cleanLoginId) {
        return NextResponse.json(
          { success: false, error: "Login ID cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (cleanLoginId !== teacher.loginId) {
        candidateLoginId = cleanLoginId;
        loginIdChanged = true;
      }
    }

    if (body.phone !== undefined) {
      const cleanPhone = String(body.phone).trim();
      if (!cleanPhone) {
        return NextResponse.json(
          { success: false, error: "Phone number cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (cleanPhone !== teacher.phone) {
        candidatePhone = cleanPhone;
        phoneChanged = true;
      }
    }

    if (loginIdChanged || phoneChanged) {
      const conflictOrConditions: Array<Record<string, unknown>> = [];
      if (loginIdChanged) {
        conflictOrConditions.push(
          { loginId: candidateLoginId },
          { phone: candidateLoginId }
        );
      }
      if (phoneChanged) {
        conflictOrConditions.push(
          { phone: candidatePhone },
          { loginId: candidatePhone }
        );
      }

      const dupConflict = await Teacher.findOne({
        centerId: user.centerId,
        _id: { $ne: id },
        $or: conflictOrConditions,
      });

      if (dupConflict) {
        return NextResponse.json(
          {
            success: false,
            error: "Phone number or login ID conflicts with another teacher in this institute",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      // Check collision with Owner phone
      const centerDoc = await Center.findOne({ centerId: user.centerId });
      if (
        centerDoc &&
        ((phoneChanged && String(centerDoc.phone).trim() === candidatePhone) ||
          (loginIdChanged && String(centerDoc.phone).trim() === candidateLoginId))
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Phone number or login ID conflicts with the Institute Owner's registered phone",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      if (loginIdChanged) teacher.loginId = candidateLoginId;
      if (phoneChanged) teacher.phone = candidatePhone;
    }

    if (body.email !== undefined) {
      teacher.email = String(body.email).trim().toLowerCase();
    }

    if (body.subjects !== undefined) {
      teacher.subjects = Array.isArray(body.subjects)
        ? body.subjects.map((s: unknown) => String(s).trim()).filter(Boolean)
        : [];
    }

    if (body.assignedBatches !== undefined) {
      teacher.assignedBatches = Array.isArray(body.assignedBatches)
        ? body.assignedBatches.map((b: unknown) => String(b).trim()).filter(Boolean)
        : [];
    }

    if (body.isActive !== undefined) {
      // Soft toggle for deactivation; preserves all historical student & fee records
      teacher.isActive = Boolean(body.isActive);
    }

    if (body.password !== undefined && String(body.password).trim()) {
      if (String(body.password).length < 6) {
        return NextResponse.json(
          { success: false, error: "Password must be at least 6 characters" },
          { status: 400, headers: corsHeaders }
        );
      }
      const salt = await bcrypt.genSalt(10);
      teacher.password = await bcrypt.hash(String(body.password), salt);
    }

    // Protected identity fields (_id, centerId, role) are strictly preserved
    await teacher.save();

    // 5. Sanitize output (never expose password hash)
    const sanitized = teacher.toObject() as unknown as Record<string, unknown>;
    delete sanitized.password;

    return NextResponse.json(
      {
        success: true,
        message: "Teacher updated successfully",
        data: sanitized,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Failed to update teacher";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
