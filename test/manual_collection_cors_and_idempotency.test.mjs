process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { handleCorsPreflight, getCorsHeaders } = await import("../tution-desk-be/src/lib/cors.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const {
  POST: manualCollectionPost,
  OPTIONS: manualCollectionOptions,
} = await import("../tution-desk-be/src/app/api/fees/manual-collection/route.ts");
const {
  POST: underscoreManualCollectionPost,
  OPTIONS: underscoreManualCollectionOptions,
} = await import("../tution-desk-be/src/app/api/fees/manual_collection/route.ts");

function createMockRequest({
  method = "POST",
  url = "http://localhost:3001/api/fees/manual-collection",
  origin = "http://localhost:3000",
  token,
  headers = {},
  body,
}) {
  const reqHeaders = new Headers(headers);
  if (origin) {
    reqHeaders.set("origin", origin);
  }
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: new URL(url),
    json: async () => body || {},
  };
}

test("MSEC — Manual Cash Collection CORS & Idempotency Suite", async (t) => {
  const centerId = "center_cors_test";
  const studentId = "507f191e810c19729de860e1";
  const ownerId = "507f191e810c19729de860f1";
  const teacherId = "507f191e810c19729de860f2";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Director",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    teacherId,
    centerId,
    role: "teacher",
    name: "Teacher Rahul",
  });

  const mockStudent = {
    _id: studentId,
    centerId,
    name: "Aarav Gupta",
    batch: "Class 10",
    assignedTeacherId: teacherId,
    parentWhatsApp: "+919876543210",
    monthlyFee: 2000,
    isActive: true,
  };

  StudentModel.findById = async (id) =>
    String(id) === String(studentId) ? mockStudent : null;

  // =========================================================================
  // 1. CORS Preflight (OPTIONS) Verification
  // =========================================================================
  await t.test("1.1 OPTIONS preflight on /api/fees/manual-collection succeeds for localhost:3000", async () => {
    const req = createMockRequest({
      method: "OPTIONS",
      url: "http://localhost:3001/api/fees/manual-collection",
      origin: "http://localhost:3000",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, idempotency-key, x-center-id",
      },
    });

    const res = await manualCollectionOptions(req);
    assert.equal(res.status, 204, "Preflight must return HTTP 204 No Content");

    const allowOrigin = res.headers.get("access-control-allow-origin");
    const allowMethods = res.headers.get("access-control-allow-methods");
    const allowHeaders = res.headers.get("access-control-allow-headers") || "";
    const allowCredentials = res.headers.get("access-control-allow-credentials");

    assert.equal(allowOrigin, "http://localhost:3000", "Must return exact request origin");
    assert.notEqual(allowOrigin, "*", "Must NEVER use wildcard origin with credentials");
    assert.equal(allowCredentials, "true", "Credentials must be allowed");
    assert.ok(allowMethods.includes("POST"), "Allowed methods must include POST");

    // Case-insensitive check and explicit header inclusion
    const lowerAllowHeaders = allowHeaders.toLowerCase();
    assert.ok(
      lowerAllowHeaders.includes("idempotency-key"),
      "Access-Control-Allow-Headers must include idempotency-key"
    );
    assert.ok(
      lowerAllowHeaders.includes("x-idempotency-key"),
      "Access-Control-Allow-Headers must include x-idempotency-key"
    );
    assert.ok(
      lowerAllowHeaders.includes("x-center-id"),
      "Access-Control-Allow-Headers must include x-center-id"
    );
    assert.ok(
      lowerAllowHeaders.includes("content-type"),
      "Access-Control-Allow-Headers must include Content-Type"
    );
    assert.ok(
      lowerAllowHeaders.includes("authorization"),
      "Access-Control-Allow-Headers must include Authorization"
    );
  });

  await t.test("1.2 OPTIONS preflight on underscore alias /api/fees/manual_collection succeeds identically", async () => {
    const req = createMockRequest({
      method: "OPTIONS",
      url: "http://localhost:3001/api/fees/manual_collection",
      origin: "http://localhost:3000",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, idempotency-key",
      },
    });

    const res = await underscoreManualCollectionOptions(req);
    assert.equal(res.status, 204, "Underscore endpoint must return 204");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const allowHeaders = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
    assert.ok(allowHeaders.includes("idempotency-key"));
  });

  await t.test("1.3 OPTIONS preflight rejects unauthorized cross-origin attacker with 403 and zero CORS headers", async () => {
    const req = createMockRequest({
      method: "OPTIONS",
      origin: "https://evil-hacker-site.com",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "idempotency-key",
      },
    });

    const res = await manualCollectionOptions(req);
    assert.equal(res.status, 403, "Unapproved origin preflight must return HTTP 403");
    assert.equal(res.headers.get("access-control-allow-origin"), null, "Must NOT emit Access-Control-Allow-Origin");
  });

  // =========================================================================
  // 2. Successful POST with CORS & Idempotency Key
  // =========================================================================
  await t.test("2.1 POST with Idempotency-Key succeeds and returns valid CORS headers", async () => {
    const idempotencyKey = `manual_test_${Date.now()}_abc123`;
    const pendingFee = {
      _id: "fee_cors_001",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 2000,
      paidAmount: 0,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    let recordedPaymentEntry = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      recordedPaymentEntry = update.$push?.paymentHistory;
      return {
        ...pendingFee,
        ...update.$set,
        paymentHistory: [recordedPaymentEntry],
        populate: async () => ({
          ...pendingFee,
          ...update.$set,
          paymentHistory: [recordedPaymentEntry],
          toObject: () => ({
            ...pendingFee,
            ...update.$set,
            paymentHistory: [recordedPaymentEntry],
          }),
        }),
      };
    };

    const req = createMockRequest({
      method: "POST",
      origin: "http://localhost:3000",
      token: teacherToken,
      headers: {
        "idempotency-key": idempotencyKey,
      },
      body: {
        studentId,
        amount: 2000,
        feeType: "monthly_recurring",
        billingMonth: "2026-11",
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionPost(req);
    const json = await res.json();

    assert.equal(res.status, 200, "Collection must succeed with 200");
    assert.equal(json.success, true);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.ok(recordedPaymentEntry, "Payment history entry must be appended");
    assert.equal(recordedPaymentEntry.amount, 2000);
    assert.equal(recordedPaymentEntry.idempotencyKey, idempotencyKey);
  });

  // =========================================================================
  // 3. Duplicate POST with Same Idempotency Key (Idempotent Replay)
  // =========================================================================
  await t.test("3.1 Duplicate POST with same Idempotency-Key replays existing receipt without duplicate ledger entries", async () => {
    const idempotencyKey = `manual_dup_${Date.now()}`;
    const settledEntry = {
      _id: "entry_settled_001",
      amount: 2000,
      paymentMode: "Cash",
      receiptNumber: "RCPT-DUPTEST1",
      idempotencyKey,
      date: new Date(),
    };

    const existingFee = {
      _id: "fee_cors_002",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Paid",
      amountDue: 0,
      paidAmount: 2000,
      feeType: "monthly_recurring",
      paymentHistory: [settledEntry],
      populate: async () => ({
        ...existingFee,
        toObject: () => existingFee,
      }),
      toObject: () => existingFee,
    };

    // findOne resolves matching fee by idempotencyKey
    FeeModel.findOne = async (query) => {
      if (
        query.centerId === centerId &&
        query["paymentHistory.idempotencyKey"] === idempotencyKey
      ) {
        return existingFee;
      }
      return null;
    };

    let findOneAndUpdateCalled = false;
    FeeModel.findOneAndUpdate = async () => {
      findOneAndUpdateCalled = true;
    };

    const req = createMockRequest({
      method: "POST",
      origin: "http://localhost:3000",
      token: teacherToken,
      headers: {
        "idempotency-key": idempotencyKey,
      },
      body: {
        studentId,
        amount: 2000,
        feeType: "monthly_recurring",
        billingMonth: "2026-11",
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionPost(req);
    const json = await res.json();

    assert.equal(res.status, 200, "Replay must return HTTP 200");
    assert.equal(json.success, true);
    assert.equal(json.idempotentReplay, true, "Must flag idempotentReplay: true");
    assert.equal(findOneAndUpdateCalled, false, "Must NEVER execute findOneAndUpdate on idempotent replay");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  // =========================================================================
  // 4. Same Idempotency Key with Modified Payload (Payload Mismatch Rejection)
  // =========================================================================
  await t.test("4.1 Same Idempotency-Key with different amount returns HTTP 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", async () => {
    const idempotencyKey = `manual_mismatch_${Date.now()}`;
    const settledEntry = {
      _id: "entry_mismatch_001",
      amount: 2000,
      paymentMode: "Cash",
      receiptNumber: "RCPT-MISMATCH1",
      idempotencyKey,
      date: new Date(),
    };

    const existingFee = {
      _id: "fee_cors_003",
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Paid",
      amountDue: 0,
      paidAmount: 2000,
      feeType: "monthly_recurring",
      paymentHistory: [settledEntry],
    };

    FeeModel.findOne = async () => existingFee;

    const req = createMockRequest({
      method: "POST",
      origin: "http://localhost:3000",
      token: teacherToken,
      headers: {
        "idempotency-key": idempotencyKey,
      },
      body: {
        studentId,
        amount: 1500, // Different amount!
        feeType: "monthly_recurring",
        billingMonth: "2026-11",
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionPost(req);
    const json = await res.json();

    assert.equal(res.status, 409, "Must return HTTP 409 Conflict on payload mismatch");
    assert.equal(json.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  // =========================================================================
  // 5. Security & Authorization Perimeter
  // =========================================================================
  await t.test("5.1 Missing authentication token returns HTTP 401 with CORS headers", async () => {
    const req = createMockRequest({
      method: "POST",
      origin: "http://localhost:3000",
      token: null, // No token
      body: { studentId, amount: 1000 },
    });

    const res = await manualCollectionPost(req);
    assert.equal(res.status, 401, "Must return HTTP 401 Unauthorized");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  await t.test("5.2 Unauthorized role (parent) cannot call manual collection (HTTP 403)", async () => {
    const parentToken = await signToken({
      userId: "parent_user_123",
      centerId,
      role: "parent",
    });

    const req = createMockRequest({
      method: "POST",
      origin: "http://localhost:3000",
      token: parentToken,
      body: { studentId, amount: 1000 },
    });

    const res = await manualCollectionPost(req);
    assert.equal(res.status, 403, "Must return HTTP 403 Forbidden for parent role");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });
});
