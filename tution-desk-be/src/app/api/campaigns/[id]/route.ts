import { NextRequest, NextResponse } from "next/server.js";
import { runBackgroundTask } from "../../../../lib/serverlessTask.ts";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import MessageCampaign from "../../../../models/MessageCampaign.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import { dispatchCampaign } from "../../../../lib/campaignDispatcher.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, PATCH, OPTIONS");
}

/**
 * GET /api/campaigns/[id]
 * Fetches campaign details scoped strictly to the authenticated center.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const { id } = await params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid campaign ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const campaign = await MessageCampaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      centerId: user.centerId,
    }).lean();

    if (!campaign) {
      return NextResponse.json(
        { success: false, error: "Message campaign not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: true, campaign },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    console.error("[CAMPAIGNS API] GET [id] error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch campaign",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * PATCH /api/campaigns/[id]
 * Specifically restricted to Institute Owner:
 * Approves, pauses, or cancels a message campaign.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    // STRICT OWNER-ONLY AUTHORIZATION (SEC-OWNER-CONTROL)
    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only Institute Owner can approve, pause, or cancel campaigns",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const { id } = await params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid campaign ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Invalid JSON request body" },
        { status: 400, headers: corsHeaders }
      );
    }

    const requestedStatus = String(body.status || "").trim().toLowerCase();
    const autoDispatch = body.autoDispatch !== false; // defaults to true on approval

    const validActions = ["approved", "paused", "cancelled"];
    if (!validActions.includes(requestedStatus)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid status update. Allowed values: 'approved', 'paused', 'cancelled'",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const campaign = await MessageCampaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      centerId: user.centerId,
    });

    if (!campaign) {
      return NextResponse.json(
        { success: false, error: "Message campaign not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (campaign.status === "completed") {
      return NextResponse.json(
        { success: false, error: "Cannot modify an already completed campaign" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Apply state transitions
    if (requestedStatus === "approved") {
      campaign.status = "approved";
      campaign.approvedBy = user.userId;
      campaign.approvedAt = new Date();
      await campaign.save();

      // Trigger asynchronous background dispatch if autoDispatch is requested
      if (autoDispatch) {
        // Safe serverless decoupled execution via Next.js after() with unit test fallback
        runBackgroundTask(async () => {
          await dispatchCampaign(campaign._id, user.centerId);
        });
      }

      return NextResponse.json(
        {
          success: true,
          message: "Campaign approved and queued for dispatch",
          campaign,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    if (requestedStatus === "paused") {
      campaign.status = "paused";
      await campaign.save();
      return NextResponse.json(
        {
          success: true,
          message: "Campaign paused. Active dispatches will halt immediately via Kill Switch.",
          campaign,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    if (requestedStatus === "cancelled") {
      campaign.status = "cancelled";
      await campaign.save();
      return NextResponse.json(
        {
          success: true,
          message: "Campaign cancelled. No further messages will be sent.",
          campaign,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: false, error: "Unrecognized transition" },
      { status: 400, headers: corsHeaders }
    );
  } catch (error: unknown) {
    console.error("[CAMPAIGNS API] PATCH [id] error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update campaign status",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
