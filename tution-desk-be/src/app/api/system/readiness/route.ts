import { NextRequest, NextResponse } from "next/server.js";
import crypto from "crypto";
import connectDB from "../../../../lib/db.ts";
import { verifyDatabaseIndexes } from "../../../../lib/indexManager.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";

export const dynamic = "force-dynamic";

function isAuthorizedViaSecret(provided: string, expected: string): boolean {
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

export async function GET(request: NextRequest | Request) {
  try {
    // 1. Authorization: either valid CRON_SECRET or authenticated Owner JWT
    const expectedSecret = process.env.CRON_SECRET;
    const url = new URL(request.url);
    const incomingSecret =
      request.headers.get("x-cron-secret") ||
      request.headers.get("x-preflight-secret") ||
      url.searchParams.get("secret");

    let isAuthorized = false;

    if (expectedSecret && incomingSecret && isAuthorizedViaSecret(incomingSecret, expectedSecret)) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      const user = await getAuthenticatedUser(request as NextRequest).catch(() => null);
      if (user && user.role === "owner") {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Preflight check requires valid secret or Owner session" },
        { status: 401 }
      );
    }

    // 2. Connect to database
    const conn = await connectDB();
    const db = conn.connection.db;

    if (!db) {
      return NextResponse.json(
        { success: false, error: "Database handle unavailable" },
        { status: 500 }
      );
    }

    // 3. Perform index readiness audit
    const report = await verifyDatabaseIndexes(db);
    const isReady = report.isHealthy && report.criticalLocksVerified;
    const status = isReady
      ? "READY"
      : !report.criticalLocksVerified
      ? "CRITICAL_LOCKS_MISSING"
      : report.conflictCount > 0
      ? "CONFLICT_DETECTED"
      : "MISSING_INDEXES";

    return NextResponse.json(
      {
        success: isReady,
        ready: isReady,
        database: report.databaseName,
        status,
        metrics: {
          totalRequired: report.totalRequired,
          verifiedCount: report.verifiedCount,
          missingCount: report.missingCount,
          conflictCount: report.conflictCount,
        },
        summary: report.summary,
        remedialCommand:
          !isReady
            ? `npx tsx scripts/manage-indexes.ts --apply --expected-db=${report.databaseName}`
            : undefined,
      },
      { status: isReady ? 200 : 503 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Preflight verification failed";
    return NextResponse.json(
      { success: false, ready: false, error: message },
      { status: 500 }
    );
  }
}
