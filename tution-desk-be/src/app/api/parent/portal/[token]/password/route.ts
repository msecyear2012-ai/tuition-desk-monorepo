import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/db";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import {
  resolvePortalToken,
  setParentPassword,
  removeParentPassword,
  validateParentSession,
  portalSecurityHeaders,
} from "@/lib/parentAccessService";

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
      return NextResponse.json(
        { success: false, error: "Invalid or revoked portal access link." },
        { status: 404, headers: responseHeaders }
      );
    }

    const parentAccess = tokenResult.parentAccess!;

    // Verify caller has authorization: either direct token access or valid session
    if (parentAccess.isPasswordProtected) {
      const sessionCookie = request.cookies.get("parent_portal_session")?.value;
      const authHeader = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const sessionToken = sessionCookie || authHeader;

      let isAuthorized = false;
      if (sessionToken) {
        const sessionResult = await validateParentSession(sessionToken);
        if (
          sessionResult.valid &&
          String(sessionResult.parentAccess?._id) === String(parentAccess._id)
        ) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        return NextResponse.json(
          { success: false, error: "Authentication required to modify password" },
          { status: 401, headers: responseHeaders }
        );
      }
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").toLowerCase();

    if (action === "set") {
      const newPassword = String(body.newPassword || body.password || "").trim();
      if (!newPassword || newPassword.length < 4) {
        return NextResponse.json(
          { success: false, error: "Password must be at least 4 characters long" },
          { status: 400, headers: responseHeaders }
        );
      }
      await setParentPassword(parentAccess, newPassword);
      return NextResponse.json(
        {
          success: true,
          message: "Password protection enabled successfully",
          isPasswordProtected: true,
        },
        { status: 200, headers: responseHeaders }
      );
    } else if (action === "remove") {
      const currentPassword = String(body.currentPassword || "").trim();
      if (!currentPassword) {
        return NextResponse.json(
          { success: false, error: "Current password is required to disable protection" },
          { status: 400, headers: responseHeaders }
        );
      }
      await removeParentPassword(parentAccess, currentPassword);
      return NextResponse.json(
        {
          success: true,
          message: "Password protection disabled successfully",
          isPasswordProtected: false,
        },
        { status: 200, headers: responseHeaders }
      );
    } else {
      return NextResponse.json(
        { success: false, error: "Invalid action. Must be 'set' or 'remove'." },
        { status: 400, headers: responseHeaders }
      );
    }
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to update password settings";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 400, headers: responseHeaders }
    );
  }
}
