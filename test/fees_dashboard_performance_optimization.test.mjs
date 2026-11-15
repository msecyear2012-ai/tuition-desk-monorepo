/**
 * TuitionDesk / MSEC — Fees Dashboard Performance & Pagination Regression Suite
 *
 * Verifies:
 * 1. GET /api/fees applies field projection on studentId populate (avoiding full document serialization).
 * 2. GET /api/fees respects limit and skip/page parameters for server-side pagination.
 * 3. GET /api/fees/summary (Owner) queries only fees with recorded payments (preventing full collection scan).
 * 4. GET /api/fees/summary hydrates student names only for the sliced top-10 recent collections.
 * 5. Tenant isolation is strictly preserved: centerId is derived exclusively from JWT claims.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const mongoose = require(path.resolve(__dirname, "../tution-desk-be/node_modules/mongoose"));

// Ensure mock connectDB does not attempt real network connection
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const { GET: getFees } = await import(
  "../tution-desk-be/src/app/api/fees/route.ts"
);
const { GET: getFeesSummary } = await import(
  "../tution-desk-be/src/app/api/fees/summary/route.ts"
);
const { default: FeeModel } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const { default: StudentModel } = await import(
  "../tution-desk-be/src/models/Student.ts"
);
const { default: CenterModel } = await import(
  "../tution-desk-be/src/models/Center.ts"
);
const { default: TeacherModel } = await import(
  "../tution-desk-be/src/models/Teacher.ts"
);
const { default: CashHandoverModel } = await import(
  "../tution-desk-be/src/models/CashHandover.ts"
);
const { signToken } = await import(
  "../tution-desk-be/src/lib/auth.ts"
);

function createMockRequest(url, token) {
  const parsed = new URL(url);
  return {
    method: "GET",
    url,
    nextUrl: parsed,
    cookies: {
      get: (name) =>
        name === "auth_token" ? { value: token } : undefined,
    },
    headers: {
      get: (name) => {
        if (name.toLowerCase() === "authorization") return `Bearer ${token}`;
        return null;
      },
    },
    json: async () => ({}),
  };
}

test("Fees Dashboard Performance & Pagination Suite", async (t) => {
  const TEST_CENTER_ID = "center-perf-test-001";
  const OWNER_USER_ID = new mongoose.Types.ObjectId().toString();

  process.env.JWT_SECRET = "super-secure-jwt-test-secret-key-32-chars-long";

  const ownerToken = await signToken({
    userId: OWNER_USER_ID,
    centerId: TEST_CENTER_ID,
    role: "owner",
    name: "Test Center Owner",
  });

  // Save original model methods
  const origFeeFind = FeeModel.find;
  const origFeeAggregate = FeeModel.aggregate;
  const origFeeCountDocuments = FeeModel.countDocuments;
  const origStudentFind = StudentModel.find;
  const origCenterFindOne = CenterModel.findOne;
  const origTeacherFind = TeacherModel.find;
  const origCashHandoverFind = CashHandoverModel.find;

  t.afterEach(() => {
    FeeModel.find = origFeeFind;
    FeeModel.aggregate = origFeeAggregate;
    FeeModel.countDocuments = origFeeCountDocuments;
    StudentModel.find = origStudentFind;
    CenterModel.findOne = origCenterFindOne;
    TeacherModel.find = origTeacherFind;
    CashHandoverModel.find = origCashHandoverFind;
  });

  await t.test("1. GET /api/fees applies student projection and pagination limits", async () => {
    let capturedPopulateArgs = null;
    let capturedSkip = null;
    let capturedLimit = null;

    const mockFees = [
      {
        _id: new mongoose.Types.ObjectId(),
        amountDue: 500,
        status: "Pending",
        studentId: {
          _id: new mongoose.Types.ObjectId(),
          name: "Alice",
          batch: "Morning Batch",
          parentWhatsApp: "9876543210",
        },
        toObject: function () {
          return this;
        },
      },
    ];

    FeeModel.find = function (filter) {
      assert.strictEqual(filter.centerId, TEST_CENTER_ID, "Must filter by authenticated centerId");
      return {
        populate: function (path, fields) {
          capturedPopulateArgs = { path, fields };
          return this;
        },
        sort: function () {
          return this;
        },
        skip: function (s) {
          capturedSkip = s;
          return this;
        },
        limit: function (l) {
          capturedLimit = l;
          return this;
        },
        then: function (resolve) {
          resolve(mockFees);
        },
      };
    };

    CenterModel.findOne = () => ({
      select: () =>
        Promise.resolve({ _id: new mongoose.Types.ObjectId(), name: "Test Institute" }),
    });
    TeacherModel.find = () => ({
      select: () => Promise.resolve([]),
    });

    const req = createMockRequest(
      "http://localhost:3000/api/fees?status=Pending&limit=25&page=2",
      ownerToken
    );

    const res = await getFees(req);
    const body = await res.json();
    if (res.status !== 200) console.error("TEST 1 ERROR:", body);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data.length, 1);

    // Verify projection is applied (not unprojected populate)
    assert.ok(capturedPopulateArgs, "Must call populate on studentId");
    assert.strictEqual(capturedPopulateArgs.path, "studentId");
    assert.strictEqual(capturedPopulateArgs.fields, "name batch parentWhatsApp phone");

    // Verify pagination skip and limit are applied
    assert.strictEqual(capturedLimit, 25, "Limit must be 25");
    assert.strictEqual(capturedSkip, 25, "Skip must be (page 2 - 1) * 25 = 25");
  });

  await t.test("2. GET /api/fees/summary (Owner) queries only fees with recorded payments", async () => {
    let capturedFeeFilter = null;
    let capturedSelect = null;
    let studentFindQueried = false;

    FeeModel.aggregate = async () => [{ total: 1500 }];
    FeeModel.countDocuments = async () => 3;

    const dummyStudentId = new mongoose.Types.ObjectId();
    const mockPaymentFees = [
      {
        _id: new mongoose.Types.ObjectId(),
        studentId: dummyStudentId,
        paidAmount: 500,
        status: "Paid",
        paymentHistory: [
          {
            amount: 500,
            paymentDate: new Date(),
            receiptNumber: "REC-001",
            receivedByRole: "owner",
          },
        ],
      },
    ];

    FeeModel.find = function (filter) {
      capturedFeeFilter = filter;
      return {
        select: function (fields) {
          capturedSelect = fields;
          return this;
        },
        lean: function () {
          return Promise.resolve(mockPaymentFees);
        },
      };
    };

    TeacherModel.find = () => ({
      select: () => ({
        lean: () => Promise.resolve([]),
      }),
    });

    CashHandoverModel.find = () => ({
      lean: () => Promise.resolve([]),
    });

    StudentModel.find = function (filter) {
      studentFindQueried = true;
      assert.ok(filter._id?.$in, "Should query by $in for top recent collections only");
      return {
        select: () => ({
          lean: () => Promise.resolve([{ _id: dummyStudentId, name: "Bob" }]),
        }),
      };
    };

    const req = createMockRequest("http://localhost:3000/api/fees/summary", ownerToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data.role, "owner");
    assert.strictEqual(body.data.recentCollections.length, 1);
    assert.strictEqual(body.data.recentCollections[0].studentName, "Bob");

    // Verify that the query filtered for fees with payments
    assert.strictEqual(capturedFeeFilter.centerId, TEST_CENTER_ID);
    assert.ok(capturedFeeFilter.$or, "Must have $or condition for payment fees");
    assert.ok(capturedSelect, "Must use select projection");
    assert.ok(studentFindQueried, "Must hydrate student names for top recent collections");
  });

  await t.test("3. Tenant isolation: Client-supplied centerId query param is ignored; authenticated centerId is enforced", async () => {
    let queriedCenterId = null;

    FeeModel.find = function (filter) {
      queriedCenterId = filter.centerId;
      return {
        populate: () => ({
          sort: () => Promise.resolve([]),
        }),
      };
    };
    CenterModel.findOne = () => ({
      select: () =>
        Promise.resolve({ _id: new mongoose.Types.ObjectId(), name: "Test Institute" }),
    });
    TeacherModel.find = () => ({
      select: () => Promise.resolve([]),
    });

    // Client maliciously attempts to query a different centerId via searchParams
    const req = createMockRequest(
      "http://localhost:3000/api/fees?centerId=hacked-victim-center-999",
      ownerToken
    );

    const res = await getFees(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      queriedCenterId,
      TEST_CENTER_ID,
      "API must derive centerId from JWT session, never from client searchParams"
    );
  });
});
