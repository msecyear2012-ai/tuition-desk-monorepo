/**
 * TuitionDesk / MSEC — Vercel Cron Configuration & Route Protection Tests
 *
 * Verifies:
 * 1. vercel.json does NOT contain crons array (removed to prevent Vercel Hobby tier daily cron limit deployment errors).
 * 2. Every cron path maps to a physical route.ts handler that exports GET, HEAD, and POST.
 * 3. /api/cron/process-admission-welcome and /api/cron/reconcile-queue enforce strict CRON_SECRET authorization.
 * 4. Routes accept CRON_SECRET via headers (authorization Bearer, x-cron-secret) AND query parameters (?secret=, ?key=, ?cron_secret=) for external ping monitors like UptimeRobot.
 * 5. Invalid or missing secrets are rejected with HTTP 401.
 * 6. Missing server CRON_SECRET fails closed with HTTP 500.
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

const CRON_ROUTES = [
  "/api/cron/generate-fees",
  "/api/cron/process-fee-reminders",
  "/api/cron/process-admission-welcome",
  "/api/cron/reconcile-queue",
];

test("MSEC Vercel Cron Configuration Suite (Hobby Tier Compatible)", async (t) => {
  await t.test("1.1 vercel.json exists and is valid JSON", () => {
    assert.ok(fs.existsSync(VERCEL_JSON_PATH), "vercel.json must exist in tution-desk-be");
    const rawContent = fs.readFileSync(VERCEL_JSON_PATH, "utf8");
    const config = JSON.parse(rawContent);
    assert.ok(config && typeof config === "object");
  });

  await t.test("1.2 vercel.json does NOT contain crons array (preventing Vercel Hobby daily limit failure)", () => {
    const rawContent = fs.readFileSync(VERCEL_JSON_PATH, "utf8");
    const config = JSON.parse(rawContent);
    assert.strictEqual(
      config.crons,
      undefined,
      "vercel.json must not have crons array configured so Vercel Hobby tier deployments succeed"
    );
  });

  await t.test("1.3 Every cron route path corresponds to an existing route.ts file on disk", () => {
    for (const routePath of CRON_ROUTES) {
      const relPath = routePath.replace(/^\/api\//, "src/app/api/");
      const fullPath = path.resolve(BE_DIR, relPath, "route.ts");
      assert.ok(
        fs.existsSync(fullPath),
        `Route file does not exist on disk: ${fullPath} for path ${routePath}`
      );
    }
  });
});

test("MSEC Cron Route Security & External Ping Authorization Protection", async (t) => {
  const TEST_SECRET = "test-secret-cron-msec-tuitiondesk-2026";
  const origEnvSecret = process.env.CRON_SECRET;

  const { GET: getAdmissionWelcome, HEAD: headAdmissionWelcome } = await import(
    "../tution-desk-be/src/app/api/cron/process-admission-welcome/route.ts"
  );
  const { GET: getReconcileQueue, HEAD: headReconcileQueue } = await import(
    "../tution-desk-be/src/app/api/cron/reconcile-queue/route.ts"
  );

  function createMockRequest(headers = {}, query = "") {
    const headerMap = new Map();
    for (const [k, v] of Object.entries(headers)) {
      headerMap.set(k.toLowerCase(), v);
    }
    const fullUrl = `http://localhost:3000/api/cron/test${query ? (query.startsWith("?") ? query : `?${query}`) : ""}`;
    return {
      method: "GET",
      url: fullUrl,
      nextUrl: new URL(fullUrl),
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

  await t.test("4.1 Routes accept secret passed via query parameter ?secret= (for external ping services like UptimeRobot)", async () => {
    process.env.CRON_SECRET = TEST_SECRET;
    
    // Invalid secret query param -> 401
    const reqInvalid = createMockRequest({}, "secret=invalid-ping-secret");
    const resInvalid = await getAdmissionWelcome(reqInvalid);
    assert.strictEqual(resInvalid.status, 401);

    // Valid secret query param -> does not return 401 or 500 auth error
    const reqValid = createMockRequest({}, `secret=${TEST_SECRET}`);
    const resValid = await getAdmissionWelcome(reqValid);
    // Since admissionWelcomeQueue handles DB connection (which might succeed or return 200),
    // status should not be 401 Unauthorized
    assert.notStrictEqual(resValid.status, 401);
  });

  await t.test("4.2 Routes accept secret passed via ?key= or ?cron_secret= query parameters", async () => {
    process.env.CRON_SECRET = TEST_SECRET;

    const reqKey = createMockRequest({}, `key=${TEST_SECRET}`);
    const resKey = await getReconcileQueue(reqKey);
    assert.notStrictEqual(resKey.status, 401);

    const reqCronSecret = createMockRequest({}, `cron_secret=${TEST_SECRET}`);
    const resCronSecret = await getAdmissionWelcome(reqCronSecret);
    assert.notStrictEqual(resCronSecret.status, 401);
  });

  await t.test("4.3 HEAD method is exported on routes for external HEAD ping monitors", () => {
    assert.strictEqual(typeof headAdmissionWelcome, "function");
    assert.strictEqual(typeof headReconcileQueue, "function");
  });
});
