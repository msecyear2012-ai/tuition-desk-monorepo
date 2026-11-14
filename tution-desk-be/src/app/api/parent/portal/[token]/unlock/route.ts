import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/db";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import {
  resolvePortalToken,
  verifyParentPassword,
  portalSecurityHeaders,
} from "@/lib/parentAccessService";
import { signToken } from "@/lib/auth";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    await connectDB();

    const { token: rawToken } = await context.params;

    if (!rawToken || !rawToken.trim()) {
      return NextResponse.json(
        { success: false, error: "Portal access token is required" },
        { status: 400, headers: responseHeaders }
      );
    }

    const tokenResult = await resolvePortalToken(rawToken.trim());

    if (!tokenResult.valid) {
      if (tokenResult.reason === "locked") {
        return NextResponse.json(
          {
            success: false,
            locked: true,
            lockoutUntil: tokenResult.lockoutUntil,
            error:
              "Portal access temporarily locked due to excessive failed password attempts.",
          },
          { status: 429, headers: responseHeaders }
        );
      }
      return NextResponse.json(
        { success: false, error: "Invalid or revoked portal access link." },
        { status: 404, headers: responseHeaders }
      );
    }

    const parentAccess = tokenResult.parentAccess!;

    if (!parentAccess.isPasswordProtected) {
      return NextResponse.json(
        { success: true, message: "Portal is not password protected" },
        { status: 200, headers: responseHeaders }
      );
    }

    const body = await request.json().catch(() => ({}));
    const password = String(body.password || "").trim();

    if (!password) {
      return NextResponse.json(
        { success: false, error: "Password is required" },
        { status: 400, headers: responseHeaders }
      );
    }

    const verifyResult = await verifyParentPassword(parentAccess, password);

    if (!verifyResult.valid) {
      if (verifyResult.locked) {
        return NextResponse.json(
          {
            success: false,
            locked: true,
            lockoutUntil: verifyResult.lockoutUntil,
            error:
              "Too many incorrect password attempts. Portal locked for 15 minutes.",
          },
          { status: 429, headers: responseHeaders }
        );
      }

      return NextResponse.json(
        {
          success: false,
          error: "Incorrect password.",
          remainingAttempts: verifyResult.remainingAttempts,
        },
        { status: 401, headers: responseHeaders }
      );
    }

    // Success: sign session token bound to the current tokenPrefix credential version
    const sessionToken = await signToken({
      parentAccessId: String(parentAccess._id),
      centerId: parentAccess.centerId,
      tokenPrefix: parentAccess.tokenPrefix,
      role: "parent",
      linkedStudentIds: parentAccess.linkedStudentIds.map(String),
    });

    const response = NextResponse.json(
      {
        success: true,
        message: "Portal unlocked successfully",
        sessionToken,
      },
      { status: 200, headers: responseHeaders }
    );

    response.cookies.set({
      name: "parent_portal_session",
      value: sessionToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60, // 24 hours
    });

    return response;
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to unlock portal";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: responseHeaders }
    );
  }
}
