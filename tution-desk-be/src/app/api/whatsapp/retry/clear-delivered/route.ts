import { NextRequest, NextResponse } from "next/server.js";
import connectDB from "../../../../../lib/db.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";
import { executeClearDelivered } from "../../../../../lib/clearDeliveredService.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

/**
 * POST /api/whatsapp/retry/clear-delivered
 * Restricted to Owner.
 * Soft-archives all successfully delivered messages for this center.
 * Never hard-deletes records. Non-delivered items (pending, processing, failed, etc.) are never touched.
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

    const result = await executeClearDelivered({
      centerId: cleanCenterId,
      cutoffTimestamp: body?.cutoffTimestamp,
    });

    return NextResponse.json(
      result,
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to clear delivered messages";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
