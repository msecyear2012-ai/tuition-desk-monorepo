import { NextRequest, NextResponse } from "next/server.js";
import connectDB from "../../../lib/db.ts";
import Center from "../../../models/Center.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

/**
 * GET /api/centers
 * Authenticated & tenant-isolated endpoint to retrieve the caller's center details.
 * Strictly excludes sensitive authentication fields (e.g. password hash).
 */
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user || !user.centerId) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access centers" },
        { status: 401, headers: corsHeaders }
      );
    }

    const authCenterId = String(user.centerId).trim();

    // 2. Strict Tenant Isolation: reject cross-tenant spoofing attempts
    const searchParams = request.nextUrl
      ? request.nextUrl.searchParams
      : new URL(request.url).searchParams;
    const queryCenterId = searchParams.get("centerId");
    const headerCenterId = request.headers.get("x-center-id");

    const requestedCenterId = queryCenterId || headerCenterId;
    if (requestedCenterId && String(requestedCenterId).trim() !== authCenterId) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Cross-tenant center access is strictly forbidden",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    // 3. Retrieve strictly the authenticated center with sensitive fields excluded
    const center = await Center.findOne({ centerId: authCenterId })
      .select("-password -__v")
      .lean();

    if (!center) {
      return NextResponse.json(
        { success: false, error: "Center not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // Explicit runtime defense: ensure password hash is never present in output
    const sanitizedCenter = { ...(center as unknown as Record<string, unknown>) };
    delete sanitizedCenter.password;
    delete sanitizedCenter.__v;

    // 4. Return sanitized array matching legacy response contract: { success: true, data: [...] }
    return NextResponse.json(
      {
        success: true,
        data: [sanitizedCenter],
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch centers";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * POST /api/centers
 * Legacy endpoint disabled. Institute registration is handled exclusively via /api/auth/register.
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json(
      { success: false, error: "Authentication required to create a center" },
      { status: 401, headers: corsHeaders }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: "Direct center creation is disabled. Use /api/auth/register instead.",
    },
    { status: 405, headers: corsHeaders }
  );
}
