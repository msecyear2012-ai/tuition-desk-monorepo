import { NextRequest, NextResponse } from "next/server.js";
import connectDB from "../../../../../lib/db.ts";
import {
  getCorsHeaders,
  handleCorsPreflight,
  validateRequestOrigin,
} from "../../../../../lib/cors.ts";
import {
  resolvePortalToken,
  setParentPassword,
  removeParentPassword,
  validateParentSession,
  portalSecurityHeaders,
} from "../../../../../lib/parentAccessService.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

/**
 * POST /api/parent/portal/password
 * Configures or removes parent password protection without exposing tokens in the URL.
 * Authenticated via HttpOnly parent_portal_session cookie or body token.
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    // 0. Strict Origin Validation Preflight (Defense-in-depth against unauthorized cross-origin POSTs)
    const originCheck = validateRequestOrigin(request);
    if (!originCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Cross-origin request forbidden: Origin is not authorized",
        },
        { status: 403, headers: responseHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").toLowerCase();
    const rawToken = typeof body.token === "string" ? body.token.trim() : "";

    let parentAccess: any = null;

    if (rawToken) {
      const tokenResult = await resolvePortalToken(rawToken);
      if (!tokenResult.valid) {
        return NextResponse.json(
          { success: false, error: "Invalid or revoked portal access link." },
          { status: 404, headers: responseHeaders }
        );
      }
      parentAccess = tokenResult.parentAccess!;
    } else {
      const sessionCookie = request.cookies.get("parent_portal_session")?.value;
      const authHeader = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "");
      const sessionToken = sessionCookie || authHeader;

      if (!sessionToken) {
        return NextResponse.json(
          { success: false, error: "Authentication required" },
          { status: 401, headers: responseHeaders }
        );
      }

      const sessionResult = await validateParentSession(sessionToken);
      if (!sessionResult.valid) {
        return NextResponse.json(
          {
            success: false,
            error: sessionResult.error || "Session invalidated or expired",
          },
          { status: sessionResult.statusCode || 401, headers: responseHeaders }
        );
      }

      parentAccess = sessionResult.parentAccess!;
    }

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
