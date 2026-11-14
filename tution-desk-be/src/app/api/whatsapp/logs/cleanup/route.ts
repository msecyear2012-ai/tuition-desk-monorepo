import { NextRequest, NextResponse } from "next/server.js";
import connectDB from "../../../../../lib/db.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";
import {
  previewWhatsAppLogCleanup,
  executeWhatsAppLogCleanup,
} from "../../../../../lib/whatsappLogCleanupService.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

/**
 * GET /api/whatsapp/logs/cleanup
 * Restricted strictly to Owner.
 * Returns preview counts of eligible deletable terminal records vs protected active records.
 * Pure Read-Only: performs zero database mutations.
 */
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner role required" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();
    const cleanCenterId = String(user.centerId).trim();

    const preview = await previewWhatsAppLogCleanup(cleanCenterId);

    return NextResponse.json(preview, { status: 200, headers: corsHeaders });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to preview log cleanup";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * POST /api/whatsapp/logs/cleanup
 * Restricted strictly to Owner.
 * Hard-deletes only eligible terminal dispatch records for this center.
 * Active, queued, processing, retry-scheduled, and provider-accepted records are NEVER touched.
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner role required" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();
    const cleanCenterId = String(user.centerId).trim();

    const body = await request.json().catch(() => ({}));
    if (body?.confirm !== true) {
      return NextResponse.json(
        {
          success: false,
          error: "Explicit confirmation required: 'confirm: true' must be supplied",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const scope =
      body?.scope === "successful" || body?.scope === "failed" ? body.scope : "all";

    const result = await executeWhatsAppLogCleanup({
      centerId: cleanCenterId,
      scope,
    });

    return NextResponse.json(result, { status: 200, headers: corsHeaders });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to execute log cleanup";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
