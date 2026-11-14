import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/db";
import Center from "@/models/Center";
import Teacher from "@/models/Teacher";
import { signToken } from "@/lib/jwt";
import bcrypt from "bcryptjs";

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = await request.json();
    const { phone, password } = body;

    if (!phone || !password) {
      return NextResponse.json(
        { success: false, error: "Phone number and password are required." },
        { status: 400 }
      );
    }

    const cleanPhone = String(phone).trim();

    // 1. Primary Check: Authenticate Institute Owner via Center collection
    const center = await Center.findOne({ phone: cleanPhone });

    if (center) {
      if (center.isActive === false) {
        return NextResponse.json(
          {
            success: false,
            error: "Institute account is inactive. Please contact support.",
          },
          { status: 403 }
        );
      }

      // Verify Owner password with bcryptjs
      let isMatch = false;
      if (center.password) {
        isMatch = await bcrypt.compare(String(password), center.password);
      } else {
        // Legacy fallback for previously seeded centers: accept default password & migrate hash
        if (password === "password123" || password === "123456") {
          isMatch = true;
          const salt = await bcrypt.genSalt(10);
          center.password = await bcrypt.hash(password, salt);
          await center.save();
        }
      }

      if (!isMatch) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid phone number or password.",
          },
          { status: 401 }
        );
      }

      // Generate JWT strictly using verified Owner identity & centerId
      const token = await signToken({
        userId: String(center._id),
        centerId: center.centerId,
        role: "owner",
        name: center.ownerName || center.name,
      });

      const response = NextResponse.json(
        {
          success: true,
          role: "owner",
          center: {
            centerId: center.centerId,
            name: center.name,
            ownerName: center.ownerName,
            phone: center.phone,
            themeColor: center.themeColor,
          },
          token,
        },
        { status: 200 }
      );

      // Set HttpOnly cookie
      response.cookies.set({
        name: "auth_token",
        value: token,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });

      return response;
    }

    // 2. Secondary Check: Authenticate Additional Staff via Teacher collection
    const teacher = await Teacher.findOne({
      $or: [{ phone: cleanPhone }, { loginId: cleanPhone }],
    });

    if (teacher) {
      if (teacher.isActive === false) {
        return NextResponse.json(
          {
            success: false,
            error: "Teacher account is inactive. Please contact your institute administrator.",
          },
          { status: 403 }
        );
      }

      // Verify Teacher password
      const isMatch = await bcrypt.compare(String(password), teacher.password);

      if (!isMatch) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid phone number or password.",
          },
          { status: 401 }
        );
      }

      // Verify that the associated Institute Center exists and is active
      const associatedCenter = await Center.findOne({ centerId: teacher.centerId });
      if (!associatedCenter || associatedCenter.isActive === false) {
        return NextResponse.json(
          {
            success: false,
            error: "Associated institute is inactive or not found.",
          },
          { status: 403 }
        );
      }

      // Generate JWT with server-verified Teacher claims
      const token = await signToken({
        userId: String(teacher._id),
        centerId: teacher.centerId,
        role: "teacher",
        teacherId: String(teacher._id),
        name: teacher.name,
        mustChangePassword: Boolean(teacher.mustChangePassword),
      });

      const response = NextResponse.json(
        {
          success: true,
          role: "teacher",
          teacher: {
            id: teacher._id,
            name: teacher.name,
            phone: teacher.phone,
            loginId: teacher.loginId,
            centerId: teacher.centerId,
            subjects: teacher.subjects || [],
            mustChangePassword: Boolean(teacher.mustChangePassword),
          },
          center: {
            centerId: associatedCenter.centerId,
            name: associatedCenter.name,
            ownerName: associatedCenter.ownerName,
            themeColor: associatedCenter.themeColor,
          },
          token,
        },
        { status: 200 }
      );

      // Set HttpOnly cookie
      response.cookies.set({
        name: "auth_token",
        value: token,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });

      return response;
    }

    // Neither Center nor Teacher found with the provided identifier
    return NextResponse.json(
      {
        success: false,
        error: "Invalid phone number or password.",
      },
      { status: 401 }
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Authentication error";

    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    );
  }
}
