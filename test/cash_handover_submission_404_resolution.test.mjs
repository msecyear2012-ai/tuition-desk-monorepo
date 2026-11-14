process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "../tution-desk-be/node_modules/mongoose/index.js";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: postHandoverRoute } = await import("../tution-desk-be/src/app/api/handovers/route.ts");
const { PUT: verifyHandoverRoute } = await import("../tution-desk-be/src/app/api/handovers/[handoverId]/verify/route.ts");
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const { matchPaymentEntry, matchPaymentAllocation } = await import("../tution-desk-be/src/models/Fee.ts");
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const StaffNotificationModel = (await import("../tution-desk-be/src/models/StaffNotification.ts")).default;

function createMockRequest({
  token,
  url = "http://localhost:3000/api/handovers",
  method = "POST",
  body = null,
  headers = {},
}) {
  const reqUrl = new URL(url);
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    reqHeaders.set(k, v);
  }

  return {
    method,
    url: reqUrl.toString(),
    nextUrl: reqUrl,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    json: async () => body,
  };
}

function mockQuery(result) {
  const queryObj = {
    session: () => queryObj,
    populate: () => queryObj,
    sort: () => queryObj,
    lean: async () => result,
    distinct: async () => result,
    then: (resolve) => resolve(result),
  };
  return queryObj;
}

test("Cash Handover Submission 404 Root Cause & Resolution Suite", async (t) => {
  const centerId = "msce-8267";
  const ownerId = "6ae869d9c117e0a550dcb247";
  const teacherJitenderId = "6ae9ba93d29bd04896bac676";
  const teacherOtherId = "6ae9ba93d29bd04896bac699";
  const studentShobhaId = "6aed8bfcb1bcf9141efc2931";
  const feeId = "6aeed8a6b1bcf9141efc30aa";

  // Distinct subdocument _id vs logical paymentId reproducing the exact reported mismatch
  const subdocEntryId = "6aeed8a6b1bcf9141efc30bb";
  const logicalPaymentId = "6af476374a83ba2ca81c373b";

  const teacherJitenderToken = await signToken({
    userId: teacherJitenderId,
    centerId,
    role: "teacher",
    teacherId: teacherJitenderId,
    name: "Jitender Kumar",
  });

  const teacherOtherToken = await signToken({
    userId: teacherOtherId,
    centerId,
    role: "teacher",
    teacherId: teacherOtherId,
    name: "Other Teacher",
  });

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Dr. Sharma",
  });

  // Mock student Shobha
  const mockStudentShobha = {
    _id: new mongoose.Types.ObjectId(studentShobhaId),
    centerId,
    name: "shobha",
    batch: "Class 10 - Science",
    assignedTeacherId: null,
  };

  // Helper to build mock fee with distinct _id and paymentId in paymentHistory
  function buildMockFee(overrides = {}) {
    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: mockStudentShobha,
      month: "Nov 2026",
      amountDue: 0,
      paidAmount: 1500,
      status: "Paid",
      assignedTeacherId: null,
      receivedBy: new mongoose.Types.ObjectId(teacherJitenderId),
      receivedByRole: "teacher",
      recordedBy: new mongoose.Types.ObjectId(teacherJitenderId),
      recordedByRole: "teacher",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(subdocEntryId),
          paymentId: new mongoose.Types.ObjectId(logicalPaymentId),
          amount: 1500,
          paymentMode: "Cash",
          paymentDate: new Date("2026-11-11T05:30:00Z"),
          receiptNumber: "RCPT-QBZPC9",
          recordedBy: new mongoose.Types.ObjectId(teacherJitenderId),
          recordedByRole: "teacher",
          receivedBy: new mongoose.Types.ObjectId(teacherJitenderId),
          receivedByRole: "teacher",
          custodyStatus: "teacher_custody",
          allocations: [],
        },
      ],
      save: async () => feeDoc,
      ...overrides,
    };
    return feeDoc;
  }

  // Mock mongoose transactions
  const origStartSession = mongoose.startSession;
  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: async () => {},
  });

  t.after(() => {
    mongoose.startSession = origStartSession;
  });

  await t.test("1. matchPaymentEntry correctly resolves both _id and paymentId without JS operator precedence bugs", () => {
    const entry = {
      _id: new mongoose.Types.ObjectId(subdocEntryId),
      paymentId: new mongoose.Types.ObjectId(logicalPaymentId),
    };

    // Submitting logical paymentId MUST match
    assert.equal(
      matchPaymentEntry(entry, logicalPaymentId),
      true,
      "Must match logical paymentId"
    );

    // Submitting subdoc _id MUST match
    assert.equal(
      matchPaymentEntry(entry, subdocEntryId),
      true,
      "Must match subdoc _id"
    );

    // Unrelated ID must return false
    assert.equal(
      matchPaymentEntry(entry, "6ae9ba93d29bd04896bac999"),
      false,
      "Must not match unrelated ID"
    );

    // Null/undefined/empty must return false
    assert.equal(matchPaymentEntry(entry, null), false);
    assert.equal(matchPaymentEntry(entry, ""), false);
    assert.equal(matchPaymentEntry(null, logicalPaymentId), false);
  });

  await t.test("2. Reproduce reported error resolution: Submitting envelope with logical paymentId 6af476374a83ba2ca81c373b succeeds (HTTP 201)", async () => {
    const mockFee = buildMockFee();

    const origFeeFind = FeeModel.find;
    FeeModel.find = (filter) => {
      if (filter?._id?.$in && filter._id.$in.map(String).includes(feeId)) {
        return mockQuery([mockFee]);
      }
      return mockQuery([]);
    };

    const origHandoverSave = CashHandoverModel.prototype.save;
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      // Teacher Jitender submits Shobha's ₹1,500 cash payment using the logical paymentId
      const req = createMockRequest({
        token: teacherJitenderToken,
        body: {
          items: [
            {
              feeId: feeId,
              paymentId: logicalPaymentId, // The exact ID that previously failed with 404
              amount: 1500,
              studentName: "shobha",
            },
          ],
          submissionNotes: "Handing over Shobha collection",
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 201, `Expected HTTP 201, got ${res.status}: ${JSON.stringify(data)}`);
      assert.equal(data.success, true);
      assert.equal(data.data.submittedAmount, 1500);
      assert.equal(data.data.status, "pending_approval");

      // Verify payment allocation was appended to entry
      const entry = mockFee.paymentHistory[0];
      assert.equal(entry.allocations.length, 1);
      assert.equal(entry.allocations[0].allocatedAmount, 1500);
      assert.equal(entry.allocations[0].status, "pending_verification");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  await t.test("3. Dual-resolution: Submitting envelope with subdocument _id also resolves successfully (HTTP 201)", async () => {
    const mockFee = buildMockFee();

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => mockQuery([mockFee]);

    const origHandoverSave = CashHandoverModel.prototype.save;
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        token: teacherJitenderToken,
        body: {
          items: [
            {
              feeId: feeId,
              paymentId: subdocEntryId, // Subdoc _id variant
              amount: 1500,
              studentName: "shobha",
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 201);
      assert.equal(data.success, true);
      assert.equal(data.data.submittedAmount, 1500);
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  await t.test("4. Cross-Teacher Isolation: Unrelated teacher cannot submit Jitender's collection (HTTP 403)", async () => {
    const mockFee = buildMockFee();

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => mockQuery([mockFee]);

    try {
      const req = createMockRequest({
        token: teacherOtherToken, // Unrelated teacher
        body: {
          items: [
            {
              feeId: feeId,
              paymentId: logicalPaymentId,
              amount: 1500,
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.success, false);
      assert.equal(data.code, "UNAUTHORIZED_COLLECTOR_ALLOCATION");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  await t.test("5. Invalid payment ID returns HTTP 404 PAYMENT_ENTRY_NOT_FOUND", async () => {
    const mockFee = buildMockFee();

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => mockQuery([mockFee]);

    try {
      const req = createMockRequest({
        token: teacherJitenderToken,
        body: {
          items: [
            {
              feeId: feeId,
              paymentId: "6af999999999999999999999", // Non-existent payment
              amount: 1500,
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 404);
      assert.equal(data.code, "PAYMENT_ENTRY_NOT_FOUND");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  await t.test("6. Invalid fee ID returns HTTP 404 FEE_NOT_FOUND", async () => {
    const origFeeFind = FeeModel.find;
    FeeModel.find = () => mockQuery([]); // No fee found

    try {
      const req = createMockRequest({
        token: teacherJitenderToken,
        body: {
          items: [
            {
              feeId: "6ae999999999999999999999",
              paymentId: logicalPaymentId,
              amount: 1500,
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 404);
      assert.equal(data.code, "FEE_NOT_FOUND");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  await t.test("7. Subsequent Owner Verification resolves payment entry and allocation cleanly", async () => {
    const handoverDocId = new mongoose.Types.ObjectId();
    const allocationDocId = new mongoose.Types.ObjectId();

    const mockFee = buildMockFee();
    // Simulate payment entry already locked with pending allocation
    mockFee.paymentHistory[0].allocations = [
      {
        _id: allocationDocId,
        allocationId: allocationDocId,
        handoverId: handoverDocId,
        allocatedAmount: 1500,
        status: "pending_verification",
      },
    ];

    const mockHandover = {
      _id: handoverDocId,
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherJitenderId),
      submittedAmount: 1500,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      items: [
        {
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(logicalPaymentId),
          allocationId: allocationDocId,
          amount: 1500,
        },
      ],
      save: async () => mockHandover,
    };

    const origHandoverFind = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => mockQuery(mockHandover);

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => mockQuery([mockFee]);

    try {
      const req = createMockRequest({
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverDocId}/verify`,
        method: "PUT",
        body: {
          receivedAmount: 1500,
        },
      });

      const res = await verifyHandoverRoute(req, {
        params: Promise.resolve({ handoverId: String(handoverDocId) }),
      });
      const data = await res.json();

      assert.equal(res.status, 200, `Expected 200: ${JSON.stringify(data)}`);
      assert.equal(data.success, true);
      assert.equal(data.data.status, "approved");

      // Verify allocation was marked verified
      assert.equal(mockFee.paymentHistory[0].allocations[0].status, "verified");
      assert.equal(mockFee.paymentHistory[0].allocations[0].verifiedAmount, 1500);
    } finally {
      CashHandoverModel.findOne = origHandoverFind;
      FeeModel.find = origFeeFind;
    }
  });
});
