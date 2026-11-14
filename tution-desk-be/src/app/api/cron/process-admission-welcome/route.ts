import { NextRequest, NextResponse } from "next/server.js";
import crypto from "crypto";
import { processPendingAdmissionWelcomeJobs } from "../../../../lib/admissionWelcomeQueue.ts";

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

async function handleProcessQueue(request: NextRequest) {
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

    const incomingSecret =
      request.headers.get("x-cron-secret") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

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

    // 2. Parse optional centerId and limit parameters
    const searchParams = request.nextUrl
      ? request.nextUrl.searchParams
      : new URL(request.url).searchParams;
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};

    const centerId = searchParams.get("centerId") || body.centerId;
    const limit = Number(searchParams.get("limit") || body.limit) || 25;

    // 3. Process pending jobs sequentially
    const summary = await processPendingAdmissionWelcomeJobs(
      centerId || undefined,
      limit
    );

    return NextResponse.json(
      {
        success: true,
        message: "Admission welcome queue processed",
        summary,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error ? error.message : "Failed to process queue";
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
  return handleProcessQueue(request);
}

export async function POST(request: NextRequest) {
  return handleProcessQueue(request);
}
