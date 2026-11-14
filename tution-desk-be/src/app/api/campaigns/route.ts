import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import MessageCampaign from "../../../models/MessageCampaign.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

/**
 * GET /api/campaigns
 * Retrieves all message campaigns for the authenticated center.
 */
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to view campaigns" },
        { status: 401, headers: corsHeaders }
      );
    }

    await connectDB();

    const { searchParams } = request.nextUrl;
    const statusParam = searchParams.get("status")?.trim().toLowerCase();
    const typeParam = searchParams.get("campaignType")?.trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10), 1), 100);
    const page = Math.max(parseInt(searchParams.get("page") || "1", 10), 1);
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      centerId: user.centerId,
    };

    if (statusParam) {
      filter.status = statusParam;
    }
    if (typeParam) {
      filter.campaignType = typeParam;
    }

    const [campaigns, totalCount] = await Promise.all([
      MessageCampaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MessageCampaign.countDocuments(filter),
    ]);

    return NextResponse.json(
      {
        success: true,
        campaigns,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    console.error("[CAMPAIGNS API] GET error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch campaigns",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * POST /api/campaigns
 * Creates a new message campaign in "pending" status, awaiting Owner approval.
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to create campaigns" },
        { status: 401, headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Invalid JSON request body" },
        { status: 400, headers: corsHeaders }
      );
    }

    const { title, campaignType, messages, scheduledAt } = body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return NextResponse.json(
        { success: false, error: "Campaign title is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { success: false, error: "Campaign must contain at least one message" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Sanitize and validate recipient items
    const sanitizedMessages = [];
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      if (!item || typeof item !== "object") continue;

      const cleanPhone = String(item.phone || "").replace(/\D/g, "");
      const cleanText = String(item.message || "").trim();

      if (!cleanPhone || cleanPhone.length < 10) {
        return NextResponse.json(
          {
            success: false,
            error: `Message item at index ${i} has invalid phone number`,
          },
          { status: 400, headers: corsHeaders }
        );
      }

      if (!cleanText) {
        return NextResponse.json(
          {
            success: false,
            error: `Message item at index ${i} has empty message body`,
          },
          { status: 400, headers: corsHeaders }
        );
      }

      sanitizedMessages.push({
        phone: cleanPhone,
        message: cleanText,
        studentId:
          item.studentId && mongoose.Types.ObjectId.isValid(item.studentId)
            ? new mongoose.Types.ObjectId(item.studentId)
            : null,
        studentName: String(item.studentName || "").trim(),
        parentName: String(item.parentName || "").trim(),
        status: "pending" as const,
        dispatchedAt: null,
        error: "",
      });
    }

    if (sanitizedMessages.length === 0) {
      return NextResponse.json(
        { success: false, error: "No valid messages found in submission" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const newCampaign = await MessageCampaign.create({
      centerId: user.centerId,
      title: title.trim(),
      campaignType: (campaignType || "custom_announcement").trim(),
      status: "pending",
      messages: sanitizedMessages,
      createdBy: user.userId,
      createdRole: user.role,
      approvedBy: null,
      approvedAt: null,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      completedAt: null,
      stats: {
        total: sanitizedMessages.length,
        sent: 0,
        simulated: 0,
        failed: 0,
        pending: sanitizedMessages.length,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: "Message campaign created and held in 'pending' status awaiting Owner approval",
        campaign: newCampaign,
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    console.error("[CAMPAIGNS API] POST error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create campaign",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
