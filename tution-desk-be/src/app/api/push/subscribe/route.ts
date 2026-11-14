import { NextRequest, NextResponse } from "next/server.js";
import connectDB from "../../../../lib/db.ts";
import {
  getCorsHeaders,
  handleCorsPreflight,
  validateRequestOrigin,
} from "../../../../lib/cors.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import {
  validateParentSession,
  resolvePortalToken,
  portalSecurityHeaders,
} from "../../../../lib/parentAccessService.ts";
import UserPushSubscription from "../../../../models/UserPushSubscription.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

/**
 * POST /api/push/subscribe
 * Unified Web Push registration for Owners, Teachers, and Parents.
 * Supports multiple devices per user and ensures server-side ownership verification.
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
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
    const action = body.action || "subscribe";

    let centerId: string | null = null;
    let userId: string | null = null;
    let userRole: "owner" | "teacher" | "parent" | null = null;

    // 1. Check for staff (Owner / Teacher) JWT authentication
    const authStaff = await getAuthenticatedUser(request);
    if (authStaff && (authStaff.role === "owner" || authStaff.role === "teacher")) {
      centerId = String(authStaff.centerId).trim();
      userId = String(authStaff.teacherId || authStaff.userId).trim();
      userRole = authStaff.role;
    } else {
      // 2. Check for Parent portal session or token
      const sessionCookie = request.cookies.get("parent_portal_session")?.value;
      const authHeader = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "");
      const sessionToken = sessionCookie || authHeader;
      const rawToken = typeof body.token === "string" ? body.token.trim() : "";

      if (sessionToken) {
        const sessionResult = await validateParentSession(sessionToken);
        if (sessionResult.valid && sessionResult.parentAccess) {
          centerId = String(sessionResult.parentAccess.centerId).trim();
          userId = String(sessionResult.parentAccess._id).trim();
          userRole = "parent";
        }
      } else if (rawToken) {
        const tokenResult = await resolvePortalToken(rawToken);
        if (tokenResult.valid && tokenResult.parentAccess) {
          centerId = String(tokenResult.parentAccess.centerId).trim();
          userId = String(tokenResult.parentAccess._id).trim();
          userRole = "parent";
        }
      }
    }

    if (!centerId || !userId || !userRole) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Valid staff session or parent portal session required",
        },
        { status: 401, headers: responseHeaders }
      );
    }

    const subscription = body.subscription;
    if (
      !subscription ||
      typeof subscription !== "object" ||
      typeof subscription.endpoint !== "string" ||
      !subscription.endpoint.startsWith("https://")
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid push subscription object: https endpoint is required",
        },
        { status: 400, headers: responseHeaders }
      );
    }

    if (action === "unsubscribe") {
      await UserPushSubscription.deleteOne({
        endpoint: subscription.endpoint,
        centerId,
        userId,
      });

      return NextResponse.json(
        { success: true, message: "Push subscription successfully unregistered" },
        { status: 200, headers: responseHeaders }
      );
    }

    // Subscribe Action
    const keys = subscription.keys;
    if (
      !keys ||
      typeof keys.p256dh !== "string" ||
      typeof keys.auth !== "string"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid subscription keys: p256dh and auth are required",
        },
        { status: 400, headers: responseHeaders }
      );
    }

    const userAgent = request.headers.get("user-agent") || undefined;

    await UserPushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        $set: {
          centerId,
          userId,
          userRole,
          keys: {
            p256dh: keys.p256dh.trim(),
            auth: keys.auth.trim(),
          },
          userAgent,
          subscribedAt: new Date(),
          lastUsedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return NextResponse.json(
      {
        success: true,
        message: "Push subscription registered successfully",
        role: userRole,
      },
      { status: 200, headers: responseHeaders }
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to process push subscription";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: responseHeaders }
    );
  }
}
