import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/db";
import Teacher from "@/models/Teacher";
import Center from "@/models/Center";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import bcrypt from "bcryptjs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
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

    // 2. Authorize: Only Institute Owner may manage teachers
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner privileges required" },
        { status: 403, headers: corsHeaders }
      );
    }

    // 3. Connect to database only after authentication and authorization
    await connectDB();

    const centerId = user.centerId;
    const { searchParams } = request.nextUrl;
    const isActiveFilter = searchParams.get("isActive");

    // 4. Build strictly scoped tenant query
    const query: Record<string, unknown> = { centerId };
    if (isActiveFilter !== null) {
      query.isActive = isActiveFilter === "true";
    }

    const teachers = await Teacher.find(query)
      .select("-password")
      .sort({ createdAt: -1 });

    return NextResponse.json(
      {
        success: true,
        count: teachers.length,
        data: teachers,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Failed to fetch teachers";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
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

    // 2. Authorize: Only Institute Owner may manage teachers
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner privileges required" },
        { status: 403, headers: corsHeaders }
      );
    }

    // 3. Connect to database only after authentication and authorization
    await connectDB();

    const centerId = user.centerId;
    const body = await request.json().catch(() => ({}));
    const { name, loginId, phone, email, password, subjects, assignedBatches, isActive } = body;

    // 4. Validate required fields
    if (!name || !String(name).trim()) {
      return NextResponse.json(
        { success: false, error: "Teacher name is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!loginId || !String(loginId).trim()) {
      return NextResponse.json(
        { success: false, error: "Login ID is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!phone || !String(phone).trim()) {
      return NextResponse.json(
        { success: false, error: "Phone number is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!password || !String(password).trim() || String(password).length < 6) {
      return NextResponse.json(
        { success: false, error: "Password is required and must be at least 6 characters" },
        { status: 400, headers: corsHeaders }
      );
    }

    const cleanName = String(name).trim();
    const cleanLoginId = String(loginId).trim();
    const cleanPhone = String(phone).trim();
    const cleanEmail = email ? String(email).trim().toLowerCase() : "";

    // 4. Cross-field duplicate prevention within the authenticated institute
    const existingConflict = await Teacher.findOne({
      centerId,
      $or: [
        { phone: cleanPhone },
        { loginId: cleanPhone },
        { phone: cleanLoginId },
        { loginId: cleanLoginId },
      ],
    });

    if (existingConflict) {
      return NextResponse.json(
        {
          success: false,
          error: "Phone number or login ID conflicts with an existing teacher in this institute",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // Guard against registering Owner phone as a Teacher phone or loginId
    const centerDoc = await Center.findOne({ centerId });
    if (
      centerDoc &&
      (String(centerDoc.phone).trim() === cleanPhone ||
        String(centerDoc.phone).trim() === cleanLoginId)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Phone number or login ID conflicts with the Institute Owner's registered phone",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 5. Secure password hashing with bcryptjs
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(String(password), salt);

    // 6. Create teacher document under verified centerId
    const newTeacher = await Teacher.create({
      centerId,
      name: cleanName,
      loginId: cleanLoginId,
      phone: cleanPhone,
      email: cleanEmail,
      password: hashedPassword,
      role: "teacher",
      subjects: Array.isArray(subjects)
        ? subjects.map((s: unknown) => String(s).trim()).filter(Boolean)
        : [],
      assignedBatches: Array.isArray(assignedBatches)
        ? assignedBatches.map((b: unknown) => String(b).trim()).filter(Boolean)
        : [],
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      mustChangePassword: false,
    });

    // 7. Sanitize output (never expose password hash)
    const sanitized = newTeacher.toObject() as unknown as Record<string, unknown>;
    delete sanitized.password;

    return NextResponse.json(
      {
        success: true,
        message: "Teacher created successfully",
        data: sanitized,
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Failed to create teacher";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
