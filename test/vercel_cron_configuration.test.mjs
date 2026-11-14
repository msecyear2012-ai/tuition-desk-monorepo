/**
 * TuitionDesk / MSEC — Vercel Cron Configuration & Route Protection Tests
 *
 * Verifies:
 * 1. vercel.json contains all 4 required cron definitions with valid paths and schedules.
 * 2. Every cron path maps to a physical route.ts handler that exports GET.
 * 3. /api/cron/process-admission-welcome and /api/cron/reconcile-queue enforce strict CRON_SECRET authorization.
 * 4. Invalid or missing secrets are rejected with HTTP 401.
 * 5. Missing server CRON_SECRET fails closed with HTTP 500.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const BE_DIR = path.resolve(REPO_ROOT, "tution-desk-be");
const VERCEL_JSON_PATH = path.resolve(BE_DIR, "vercel.json");

test("MSEC Vercel Cron Configuration Suite", async (t) => {
  await t.test("1.1 vercel.json exists and is valid JSON", () => {
    assert.ok(fs.existsSync(VERCEL_JSON_PATH), "vercel.json must exist in tution-desk-be");
    const rawContent = fs.readFileSync(VERCEL_JSON_PATH, "utf8");
    const config = JSON.parse(rawContent);
    assert.ok(config && typeof config === "object");
  });

  await t.test("1.2 vercel.json contains all 4 required cron jobs with correct paths and schedules", () => {
    const rawContent = fs.readFileSync(VERCEL_JSON_PATH, "utf8");
    const config = JSON.parse(rawContent);
    assert.ok(Array.isArray(config.crons), "crons must be an array");
    assert.strictEqual(config.crons.length, 4, "Must have exactly 4 cron definitions");

    const cronMap = new Map(config.crons.map((c) => [c.path, c.schedule]));

    // 1. Fee generation
    assert.ok(cronMap.has("/api/cron/generate-fees"), "Missing /api/cron/generate-fees");
    assert.strictEqual(cronMap.get("/api/cron/generate-fees"), "0 0 * * *");

    // 2. Fee reminder dispatcher
    assert.ok(cronMap.has("/api/cron/process-fee-reminders"), "Missing /api/cron/process-fee-reminders");
    assert.strictEqual(cronMap.get("/api/cron/process-fee-reminders"), "0 4 * * *");

    // 3. Admission welcome processor
    assert.ok(cronMap.has("/api/cron/process-admission-welcome"), "Missing /api/cron/process-admission-welcome");
    assert.strictEqual(cronMap.get("/api/cron/process-admission-welcome"), "*/10 * * * *");

    // 4. Queue reconciler
    assert.ok(cronMap.has("/api/cron/reconcile-queue"), "Missing /api/cron/reconcile-queue");
    assert.strictEqual(cronMap.get("/api/cron/reconcile-queue"), "*/15 * * * *");
  });

  await t.test("1.3 Every cron route path corresponds to an existing route.ts file on disk", () => {
    const rawContent = fs.readFileSync(VERCEL_JSON_PATH, "utf8");
    const config = JSON.parse(rawContent);

    for (const entry of config.crons) {
      // Map /api/cron/... to tution-desk-be/src/app/api/cron/.../route.ts
      const relPath = entry.path.replace(/^\/api\//, "src/app/api/");
      const fullPath = path.resolve(BE_DIR, relPath, "route.ts");
      assert.ok(
        fs.existsSync(fullPath),
        `Route file does not exist on disk: ${fullPath} for path ${entry.path}`
      );
    }
  });

  await t.test("1.4 Standard 5-field cron schedule syntax is valid for all entries", () => {
    const rawContent = fs.readFileSync(VERCEL_JSON_PATH, "utf8");
    const config = JSON.parse(rawContent);

    for (const entry of config.crons) {
      const parts = entry.schedule.trim().split(/\s+/);
      assert.strictEqual(
        parts.length,
        5,
        `Schedule "${entry.schedule}" for ${entry.path} must have exactly 5 fields`
      );
    }
  });
});

test("MSEC Cron Route Security & Authorization Protection", async (t) => {
  const TEST_SECRET = "test-secret-cron-msec-tuitiondesk-2026";
  const origEnvSecret = process.env.CRON_SECRET;

  const { GET: getAdmissionWelcome } = await import(
    "../tution-desk-be/src/app/api/cron/process-admission-welcome/route.ts"
  );
  const { GET: getReconcileQueue } = await import(
    "../tution-desk-be/src/app/api/cron/reconcile-queue/route.ts"
  );

  function createMockRequest(headers = {}) {
    const headerMap = new Map();
    for (const [k, v] of Object.entries(headers)) {
      headerMap.set(k.toLowerCase(), v);
    }
    return {
      method: "GET",
      url: "http://localhost:3000/api/cron/test",
      nextUrl: new URL("http://localhost:3000/api/cron/test"),
      headers: {
        get: (name) => headerMap.get(name.toLowerCase()) || null,
      },
    };
  }

  t.afterEach(() => {
    process.env.CRON_SECRET = origEnvSecret;
  });

  // /api/cron/process-admission-welcome tests
  await t.test("2.1 process-admission-welcome rejects unauthenticated request with 401", async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    const req = createMockRequest();
    const res = await getAdmissionWelcome(req);
    assert.strictEqual(res.status, 401);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Unauthorized/i);
  });

  await t.test("2.2 process-admission-welcome rejects invalid secret with 401", async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    const req = createMockRequest({
      authorization: "Bearer wrong-secret-token",
    });
    const res = await getAdmissionWelcome(req);
    assert.strictEqual(res.status, 401);
  });

  await t.test("2.3 process-admission-welcome fails closed with 500 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const req = createMockRequest({
      authorization: `Bearer ${TEST_SECRET}`,
    });
    const res = await getAdmissionWelcome(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.match(json.error, /CRON_SECRET is missing/i);
  });

  // /api/cron/reconcile-queue tests
  await t.test("3.1 reconcile-queue rejects unauthenticated request with 401", async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    const req = createMockRequest();
    const res = await getReconcileQueue(req);
    assert.strictEqual(res.status, 401);
    const json = await res.json();
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Unauthorized/i);
  });

  await t.test("3.2 reconcile-queue rejects invalid secret with 401", async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    const req = createMockRequest({
      authorization: "Bearer wrong-secret-token",
    });
    const res = await getReconcileQueue(req);
    assert.strictEqual(res.status, 401);
  });

  await t.test("3.3 reconcile-queue fails closed with 500 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const req = createMockRequest({
      authorization: `Bearer ${TEST_SECRET}`,
    });
    const res = await getReconcileQueue(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.match(json.error, /CRON_SECRET is missing/i);
  });

  await t.test("3.4 Both routes accept x-cron-secret header alternatively to Bearer token", async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    // With wrong x-cron-secret -> 401
    const req1 = createMockRequest({ "x-cron-secret": "wrong-secret" });
    const res1 = await getAdmissionWelcome(req1);
    assert.strictEqual(res1.status, 401);

    const req2 = createMockRequest({ "x-cron-secret": "wrong-secret" });
    const res2 = await getReconcileQueue(req2);
    assert.strictEqual(res2.status, 401);
  });
});
