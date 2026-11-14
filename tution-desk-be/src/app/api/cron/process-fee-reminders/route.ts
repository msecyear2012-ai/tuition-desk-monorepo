import { NextRequest, NextResponse } from "next/server.js";
import crypto from "crypto";
import { processScheduledFeeReminders } from "../../../../lib/feeReminderScheduler.ts";

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

async function handleProcessReminders(request: NextRequest) {
  try {
    // 1. Security Check: Validate cron secret before DB execution (fail closed)
    const expectedSecret = process.env.CRON_SECRET;
    if (!expectedSecret || !expectedSecret.trim()) {
      console.error("FATAL: CRON_SECRET is not configured on server.");
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

    // 2. Parse Trigger Parameters (Query params or optional JSON body)
    const { searchParams } = request.nextUrl;
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};

    const centerId =
      (searchParams.get("centerId") || body.centerId || "")?.trim() || undefined;

    const studentId =
      (searchParams.get("studentId") || body.studentId || "")?.trim() || undefined;

    const feeId =
      (searchParams.get("feeId") || body.feeId || "")?.trim() || undefined;

    const limitParam = searchParams.get("limit") || body.limit;
    const limit =
      limitParam !== undefined && limitParam !== null && limitParam !== ""
        ? Number(limitParam)
        : undefined;

    const qaClockSimulation =
      searchParams.get("qaClockSimulation") === "true" ||
      body.qaClockSimulation === true;

    const rawRefDate =
      searchParams.get("referenceDate") || body.referenceDate;
    const referenceDate =
      rawRefDate && typeof rawRefDate === "string" ? new Date(rawRefDate) : undefined;

    // 3. Execute Idempotent Automated Fee Reminder Processing
    const summary = await processScheduledFeeReminders({
      centerId,
      studentId,
      feeId,
      limit,
      qaClockSimulation,
      referenceDate,
    });

    return NextResponse.json(
      {
        message: "Scheduled fee reminders processing complete",
        summary,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to process scheduled fee reminders";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Scheduled Fee Reminder Cron API
 * Triggered by external cron job / scheduler daily to dispatch automated fee reminders
 * for pending fees that have reached or passed their due date.
 * Requires Authorization: Bearer <CRON_SECRET> or x-cron-secret header.
 */
export async function GET(request: NextRequest) {
  return handleProcessReminders(request);
}

export async function POST(request: NextRequest) {
  return handleProcessReminders(request);
}
