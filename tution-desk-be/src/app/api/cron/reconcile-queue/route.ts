import { NextRequest, NextResponse } from "next/server.js";
import crypto from "crypto";
import { reconcileStaleInFlightRecords } from "../../../../lib/queueReconciler.ts";

export const dynamic = "force-dynamic";

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

async function handleReconcileQueue(request: NextRequest) {
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

    // 2. Parse optional centerId and staleThresholdMs parameters
    const centerId = searchParams.get("centerId")?.trim() || undefined;
    const staleThresholdParam = searchParams.get("staleThresholdMs");
    const staleThresholdMs = staleThresholdParam
      ? parseInt(staleThresholdParam, 10)
      : undefined;

    // 3. Run concurrency-safe reconciliation
    const summary = await reconcileStaleInFlightRecords({
      centerId,
      staleThresholdMs: Number.isFinite(staleThresholdMs) ? staleThresholdMs : undefined,
    });

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      summary,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Reconciliation worker error";
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleReconcileQueue(request);
}

export async function HEAD(request: NextRequest) {
  return handleReconcileQueue(request);
}

export async function POST(request: NextRequest) {
  return handleReconcileQueue(request);
}
