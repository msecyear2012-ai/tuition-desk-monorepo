import { NextRequest, NextResponse } from "next/server.js";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
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

    // 2. Policy Enforcement: Unthrottled direct bulk fee reminders are disabled.
    // Bulk fee reminder campaigns must be submitted and approved via the Smart Messaging Engine (/api/campaigns)
    // with Owner review, emergency kill-switch, and WhatsApp operational queue pacing.
    return NextResponse.json(
      {
        success: false,
        error:
          "Direct unthrottled bulk fee reminders are disabled. Bulk fee reminders must be created and approved via the Smart Messaging Campaign Engine (/api/campaigns) with operational rate pacing.",
        code: "BULK_REMINDERS_CAMPAIGN_REQUIRED",
      },
      { status: 403, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to process bulk reminder request";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
