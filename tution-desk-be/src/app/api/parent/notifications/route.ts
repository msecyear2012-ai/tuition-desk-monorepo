import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import MessageCampaign from "../../../../models/MessageCampaign.ts";
import {
  getCorsHeaders,
  handleCorsPreflight,
  validateRequestOrigin,
} from "../../../../lib/cors.ts";
import {
  validateParentSession,
  resolvePortalToken,
  portalSecurityHeaders,
} from "../../../../lib/parentAccessService.ts";
import type { IParentAccessDocument } from "../../../../models/ParentAccess.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

/**
 * GET /api/parent/notifications
 * Retrieves a permanent history of notifications (attendance, fees, announcements)
 * dispatched to the authenticated parent or linked students within the institute.
 */
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    // 1. Strict Origin Validation Preflight
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

    // 2. Resolve Authenticated Parent Access
    let parentAccess: IParentAccessDocument | null = null;

    const sessionCookie = request.cookies.get("parent_portal_session")?.value;
    const authHeader = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const sessionToken = sessionCookie || authHeader;
    const rawToken = request.nextUrl.searchParams.get("token")?.trim();

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

    if (!parentAccess || parentAccess.status !== "active") {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Valid active parent portal session needed",
        },
        { status: 401, headers: responseHeaders }
      );
    }

    // 3. Prepare Multi-Tenant Phone & Student Filters
    const cleanPhone = parentAccess.parentPhone.trim();
    const phoneVariants = Array.from(
      new Set([
        cleanPhone,
        cleanPhone.replace(/^\+91/, ""),
        cleanPhone.replace(/^\+/, ""),
        cleanPhone.startsWith("+") ? cleanPhone : `+91${cleanPhone}`,
      ])
    ).filter(Boolean);

    const linkedStudentIdStrings = (parentAccess.linkedStudentIds || []).map((id) =>
      typeof id === "string" ? id : id.toString()
    );
    const linkedStudentObjectIds = linkedStudentIdStrings
      .map((id) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter((id): id is mongoose.Types.ObjectId => id !== null);

    const studentMatchTargets = [
      ...linkedStudentObjectIds,
      ...linkedStudentIdStrings,
    ];

    // Privacy Invariant:
    // 1. Student-specific notifications must match ONLY explicitly linked studentIds.
    // 2. Phone matching may be used ONLY for genuine institute-wide notifications with missing/null studentId.
    const studentMatchClause = {
      "messages.studentId": { $in: studentMatchTargets },
    };

    const broadcastMatchClause = {
      $and: [
        { "messages.phone": { $in: phoneVariants } },
        {
          $or: [
            { "messages.studentId": { $exists: false } },
            { "messages.studentId": null },
          ],
        },
      ],
    };

    const notificationCriteria = [studentMatchClause, broadcastMatchClause];

    // 4. Aggregate Notifications from MessageCampaign
    const aggregated = await MessageCampaign.aggregate([
      {
        $match: {
          centerId: parentAccess.centerId,
          status: { $in: ["approved", "in_progress", "completed", "paused"] },
          $or: notificationCriteria,
        },
      },
      { $unwind: "$messages" },
      {
        $match: {
          $or: notificationCriteria,
          "messages.status": { $in: ["sent", "simulated", "pending"] },
        },
      },
      {
        $project: {
          id: {
            $toString: { $ifNull: ["$messages._id", "$_id"] },
          },
          campaignId: { $toString: "$_id" },
          title: "$title",
          campaignType: { $ifNull: ["$campaignType", "announcement"] },
          body: "$messages.message",
          status: "$messages.status",
          studentId: {
            $cond: [
              { $ifNull: ["$messages.studentId", false] },
              { $toString: "$messages.studentId" },
              null,
            ],
          },
          studentName: { $ifNull: ["$messages.studentName", ""] },
          parentName: { $ifNull: ["$messages.parentName", ""] },
          dispatchedAt: {
            $ifNull: ["$messages.dispatchedAt", "$createdAt"],
          },
          createdAt: "$createdAt",
        },
      },
      { $sort: { dispatchedAt: -1 } },
      { $limit: 100 },
    ]);

    return NextResponse.json(
      {
        success: true,
        notifications: aggregated || [],
        count: (aggregated || []).length,
      },
      { status: 200, headers: responseHeaders }
    );
  } catch (err: any) {
    console.error("[PARENT NOTIFICATIONS ERROR]", err);
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error fetching parent notification history",
      },
      { status: 500, headers: responseHeaders }
    );
  }
}
