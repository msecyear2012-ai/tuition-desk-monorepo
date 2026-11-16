import { NextRequest, NextResponse } from "next/server.js";
import crypto from "crypto";
import { processApprovedCampaigns } from "../../../../lib/campaignDispatcher.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

function isCronSecretValid(provided: string, expected: string): boolean {
  try {
    const provBuf = Buffer.from(provided, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (provBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(provBuf, expBuf);
  } catch {
    return false;
  }
}

async function handleProcessCampaigns(request: NextRequest) {
  try {
    // 1. Validate CRON_SECRET authorization (fail closed)
    const expectedSecret = process.env.CRON_SECRET;
    if (!expectedSecret || !expectedSecret.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Server configuration error: CRON_SECRET is missing",
        },
        { status: 500 }
      );
    }

    const searchParams = request.nextUrl
      ? request.nextUrl.searchParams
      : new URL(request.url).searchParams;

    const incomingSecret =
      request.headers.get("x-cron-secret") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      searchParams.get("secret") ||
      searchParams.get("cron_secret") ||
      searchParams.get("key");

    if (
      !incomingSecret ||
      !isCronSecretValid(incomingSecret.trim(), expectedSecret.trim())
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized: Invalid or missing cron secret authorization",
        },
        { status: 401 }
      );
    }

    // 2. Parse optional centerId and chunkLimit parameters
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};

    const centerId = searchParams.get("centerId") || body.centerId;
    const chunkLimit =
      Number(searchParams.get("chunkLimit") || searchParams.get("limit") || body.chunkLimit || body.limit) || 15;

    // 3. Process approved & in_progress campaigns in safe batches
    const results = await processApprovedCampaigns(
      centerId || undefined,
      chunkLimit
    );

    return NextResponse.json(
      {
        success: true,
        message: "Message campaigns processed successfully",
        results,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error ? error.message : "Failed to process campaigns";
    return NextResponse.json(
      {
        success: false,
        error: errMsg,
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleProcessCampaigns(request);
}

export async function HEAD(request: NextRequest) {
  return handleProcessCampaigns(request);
}

export async function POST(request: NextRequest) {
  return handleProcessCampaigns(request);
}
