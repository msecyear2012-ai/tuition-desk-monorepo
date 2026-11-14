import { NextRequest, NextResponse } from "next/server.js";
import connectDB from "../../../../../lib/db.ts";
import {
  getCorsHeaders,
  handleCorsPreflight,
  validateRequestOrigin,
} from "../../../../../lib/cors.ts";
import {
  validateParentSession,
  resolvePortalToken,
  portalSecurityHeaders,
} from "../../../../../lib/parentAccessService.ts";
import type { IParentAccessDocument } from "../../../../../models/ParentAccess.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

/**
 * POST /api/parent/push/subscribe
 * Registers or removes Web Push subscriptions (browser/PWA) for the authenticated parent.
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    // 1. Strict Origin Validation
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
    const rawToken = typeof body.token === "string" ? body.token.trim() : "";

    // 2. Resolve Authenticated Parent
    let parentAccess: IParentAccessDocument | null = null;

    const sessionCookie = request.cookies.get("parent_portal_session")?.value;
    const authHeader = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const sessionToken = sessionCookie || authHeader;

    if (sessionToken) {
      const sessionResult = await validateParentSession(sessionToken);
      if (sessionResult.valid && sessionResult.parentAccess) {
        parentAccess = sessionResult.parentAccess;
      }
    } else if (rawToken) {
      const tokenResult = await resolvePortalToken(rawToken);
      if (tokenResult.valid && tokenResult.parentAccess) {
        parentAccess = tokenResult.parentAccess;
      }
    }

    if (!parentAccess) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Valid parent portal session or token needed",
        },
        { status: 401, headers: responseHeaders }
      );
    }

    // 3. Validate PushSubscription Payload
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

    const keys = subscription.keys;
    if (
      !keys ||
      typeof keys.p256dh !== "string" ||
      typeof keys.auth !== "string"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid push subscription keys: p256dh and auth are required",
        },
        { status: 400, headers: responseHeaders }
      );
    }

    const action = String(body.action || "subscribe").toLowerCase();
    const userAgent = request.headers.get("user-agent") || "";

    if (!parentAccess.pushSubscriptions) {
      parentAccess.pushSubscriptions = [];
    }

    // 4. Handle Unsubscribe
    if (action === "unsubscribe") {
      parentAccess.pushSubscriptions = parentAccess.pushSubscriptions.filter(
        (s) => s.endpoint !== subscription.endpoint
      );
      await parentAccess.save();

      return NextResponse.json(
        {
          success: true,
          message: "Push subscription successfully removed",
        },
        { status: 200, headers: responseHeaders }
      );
    }

    // 5. Handle Subscribe / Upsert
    const existingIndex = parentAccess.pushSubscriptions.findIndex(
      (s) => s.endpoint === subscription.endpoint
    );

    if (existingIndex >= 0) {
      // Update existing subscription credentials & refresh timestamp
      parentAccess.pushSubscriptions[existingIndex].keys = {
        p256dh: keys.p256dh,
        auth: keys.auth,
      };
      parentAccess.pushSubscriptions[existingIndex].userAgent = userAgent;
      parentAccess.pushSubscriptions[existingIndex].subscribedAt = new Date();
    } else {
      // Limit to 10 active devices per parent to prevent unbounded document growth
      if (parentAccess.pushSubscriptions.length >= 10) {
        parentAccess.pushSubscriptions.shift();
      }

      parentAccess.pushSubscriptions.push({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
        userAgent,
        subscribedAt: new Date(),
        lastUsedAt: null,
      });
    }

    await parentAccess.save();

    return NextResponse.json(
      {
        success: true,
        message: "Push subscription registered successfully",
        deviceCount: parentAccess.pushSubscriptions.length,
      },
      { status: 200, headers: responseHeaders }
    );
  } catch (err: any) {
    console.error("[PUSH SUBSCRIBE ERROR]", err);
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error registering push notification subscription",
      },
      { status: 500, headers: responseHeaders }
    );
  }
}
