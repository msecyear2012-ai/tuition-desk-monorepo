process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: postDisputeRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/dispute/route.ts"
);
const { POST: postResolveRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/resolve/route.ts"
);
const { POST: postSettleRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/settle/route.ts"
);
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const { calculatePaymentCustody } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  method = "POST",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/handovers/HO-001/dispute",
}) {
  const reqHeaders = new Headers(headers);
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

function setupMockTransactionSupport() {
  let transactionActive = false;
  const session = {
    startTransaction: () => {
      transactionActive = true;
    },
    commitTransaction: async () => {
      transactionActive = false;
    },
    abortTransaction: async () => {
      transactionActive = false;
    },
    endSession: async () => {
      transactionActive = false;
    },
    inTransaction: () => transactionActive,
  };

  mongoose.startSession = async () => session;
  return session;
}

test("Phase 4.3 Task 3: Cash Dispute & Incremental Settlement Specification Suite", async (t) => {
  const centerId = "center_alpha";
  const centerBetaId = "center_beta";

  const ownerId = "507f191e810c19729de860f1";
  const teacherAId = "507f191e810c19729de860f2";
  const teacherBId = "507f191e810c19729de860f3";

  const studentAId = "507f191e810c19729de860ea";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director Alpha",
  });

  const teacherAToken = await signToken({
    userId: teacherAId,
    teacherId: teacherAId,
    centerId,
    role: "teacher",
    name: "Teacher Sharma",
  });

  const teacherBToken = await signToken({
    userId: teacherBId,
    teacherId: teacherBId,
    centerId,
    role: "teacher",
    name: "Teacher Verma",
  });

  const centerBetaOwnerToken = await signToken({
    userId: "507f191e810c19729de860f9",
    centerId: centerBetaId,
    role: "owner",
    name: "Center Director Beta",
  });

  // 1. Teacher can initiate dispute on own handover with valid reason
  await t.test("1. Teacher initiates dispute on own handover, updating status and linking allocation", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 3000,
      approvedAmount: 2500,
      discrepancyAmount: 500,
      status: "partially_approved",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 3000,
          receiptNumber: "RCPT-001",
        },
      ],
      disputes: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 3000,
      originalAmountDue: 3000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 3000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 3000,
              verifiedAmount: 2500,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          notes: "I recount the cash envelope and believe ₹500 slipped behind the desk drawer in Room 3",
          evidenceUrl: "https://storage.tuitiondesk.com/evidence/room3.jpg",
        },
      });

      const res = await postDisputeRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(mockHandover.discrepancyStatus, "disputed");
      assert.equal(mockHandover.disputes.length, 1);
      assert.equal(String(mockHandover.disputes[0].initiatedBy), teacherAId);
      assert.equal(mockHandover.disputes[0].initiatedByRole, "teacher");
      assert.equal(
        mockHandover.disputes[0].notes,
        "I recount the cash envelope and believe ₹500 slipped behind the desk drawer in Room 3"
      );
      assert.equal(
        mockHandover.disputes[0].evidenceUrl,
        "https://storage.tuitiondesk.com/evidence/room3.jpg"
      );

      // Fee allocation linked to dispute
      const alloc = mockFeeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "disputed");
      assert.ok(alloc.disputeId instanceof mongoose.Types.ObjectId);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 2. Owner can initiate dispute on center handover with valid reason
  await t.test("2. Owner initiates dispute on center handover successfully", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86011";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA2",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 2000,
      approvedAmount: 1500,
      discrepancyAmount: 500,
      status: "partially_approved",
      discrepancyStatus: "none",
      items: [],
      disputes: [],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          notes: "Bundle count revealed 15 notes of 100 missing from the taped packet",
        },
      });

      const res = await postDisputeRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      assert.equal(mockHandover.discrepancyStatus, "disputed");
      assert.equal(mockHandover.disputes.length, 1);
      assert.equal(String(mockHandover.disputes[0].initiatedBy), ownerId);
      assert.equal(mockHandover.disputes[0].initiatedByRole, "owner");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 3. Teacher cannot dispute another teacher's handover
  await t.test("3. Teacher cannot dispute another teacher's handover (HTTP 403 UNAUTHORIZED_TEACHER_DISPUTE)", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86012";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA3",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId), // Submitted by Teacher A
      discrepancyAmount: 500,
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      // Teacher B attempts to dispute Teacher A's handover
      const req = createMockRequest({
        method: "POST",
        token: teacherBToken,
        body: { notes: "I want to dispute Teacher A's envelope" },
      });

      const res = await postDisputeRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "UNAUTHORIZED_TEACHER_DISPUTE");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 4. Cross-center dispute initiation is rejected
  await t.test("4. Cross-center dispute initiation rejected with HTTP 403 CROSS_CENTER_ACCESS_FORBIDDEN", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId, // Center Alpha
      discrepancyAmount: 500,
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: centerBetaOwnerToken, // Owner of Center Beta
        body: { notes: "Cross center attempt" },
      });

      const res = await postDisputeRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "CROSS_CENTER_ACCESS_FORBIDDEN");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 5. Missing dispute reason is rejected
  await t.test("5. Missing or empty dispute reason rejected with HTTP 400 DISPUTE_REASON_REQUIRED", async () => {
    const handoverId = "507f191e810c19729de86010";
    const req = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: { notes: "   " },
    });

    const res = await postDisputeRoute(req, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.code, "DISPUTE_REASON_REQUIRED");
  });

  // 6. Duplicate active dispute on same unresolved discrepancy is rejected
  await t.test("6. Duplicate active dispute by the same user rejected with HTTP 409 DUPLICATE_ACTIVE_DISPUTE", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      discrepancyAmount: 500,
      discrepancyStatus: "disputed",
      disputes: [
        {
          _id: new mongoose.Types.ObjectId(),
          initiatedBy: new mongoose.Types.ObjectId(teacherAId),
          initiatedByRole: "teacher",
          notes: "Initial dispute note",
          timestamp: new Date(),
        },
      ],
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: { notes: "Second duplicate dispute note" },
      });

      const res = await postDisputeRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.code, "DUPLICATE_ACTIVE_DISPUTE");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 7. Dispute initiation on fully resolved handover or zero discrepancy is rejected
  await t.test("7. Dispute initiation on resolved handover rejected with HTTP 409 DISCREPANCY_ALREADY_RESOLVED", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      discrepancyAmount: 500,
      discrepancyStatus: "resolved", // Already resolved!
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: { notes: "Attempt to dispute resolved discrepancy" },
      });

      const res = await postDisputeRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.code, "DISCREPANCY_ALREADY_RESOLVED");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 8. Owner dispute resolution: cash_received increases verified cash and records incremental settlement
  await t.test("8. Owner dispute resolution with cash_received records physical recovery and updates fee custody", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86015";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA5",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 1000,
      approvedAmount: 700,
      discrepancyAmount: 300,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 1000,
          receiptNumber: "RCPT-005",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "split_custody",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1000,
              verifiedAmount: 700,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 300,
          reason: "Teacher brought missing ₹300 cash envelope",
          auditReference: "AUD-CASH-REC-01",
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      assert.equal(mockHandover.discrepancyStatus, "resolved");

      // Incremental settlement recorded
      assert.equal(mockHandover.incrementalSettlements.length, 1);
      assert.equal(mockHandover.incrementalSettlements[0].amountReceived, 300);
      assert.equal(mockHandover.incrementalSettlements[0].remainingDiscrepancy, 0);

      // Resolution recorded
      assert.equal(mockHandover.resolutions.length, 1);
      assert.equal(mockHandover.resolutions[0].resolutionType, "cash_received");
      assert.equal(mockHandover.resolutions[0].amount, 300);

      // Fee allocation verifiedAmount updated to full ₹1000
      const alloc = mockFeeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.verifiedAmount, 1000);
      assert.equal(alloc.status, "verified");

      // Custody derived to owner_verified and provisional cleared
      assert.equal(mockFeeDoc.paymentHistory[0].custodyStatus, "owner_verified");
      assert.equal(mockFeeDoc.paymentHistory[0].isProvisional, false);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 9. Incremental partial settlements: multi-step recovery (₹300 then ₹200 on ₹500 discrepancy)
  await t.test("9. Multi-step incremental settlements track remainingDiscrepancy correctly", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86016";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    // Original handover: 10,000, approved: 9,500, discrepancy: 500
    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA6",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 10000,
      approvedAmount: 9500,
      discrepancyAmount: 500,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 10000,
          receiptNumber: "RCPT-006",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 10000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 10000,
          paymentMode: "Cash",
          isProvisional: true,
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 10000,
              verifiedAmount: 9500,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      // Step 1: Recover ₹300
      const req1 = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 300,
          reason: "Partial physical recovery step 1",
        },
      });

      const res1 = await postResolveRoute(req1, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res1.status, 200);
      assert.equal(mockHandover.incrementalSettlements.length, 1);
      assert.equal(mockHandover.incrementalSettlements[0].amountReceived, 300);
      assert.equal(mockHandover.incrementalSettlements[0].remainingDiscrepancy, 200);
      assert.equal(mockHandover.discrepancyStatus, "disputed"); // Still 200 unresolved!
      assert.equal(mockFeeDoc.paymentHistory[0].allocations[0].verifiedAmount, 9800);

      // Step 2: Recover remaining ₹200
      const req2 = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 200,
          reason: "Final physical recovery step 2",
        },
      });

      const res2 = await postResolveRoute(req2, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res2.status, 200);
      assert.equal(mockHandover.incrementalSettlements.length, 2);
      assert.equal(mockHandover.incrementalSettlements[1].amountReceived, 200);
      assert.equal(mockHandover.incrementalSettlements[1].remainingDiscrepancy, 0);
      assert.equal(mockHandover.discrepancyStatus, "resolved"); // Fully resolved!
      assert.equal(mockFeeDoc.paymentHistory[0].allocations[0].verifiedAmount, 10000);
      assert.equal(mockFeeDoc.paymentHistory[0].allocations[0].status, "verified");
      assert.equal(mockFeeDoc.paymentHistory[0].isProvisional, false);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 10. Over-settlement attempt (> unresolved discrepancy) is strictly prevented
  await t.test("10. Attempting settlement exceeding remaining discrepancy returns HTTP 400 EXCEEDS_UNRESOLVED_DISCREPANCY", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86017";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA7",
      centerId,
      discrepancyAmount: 500,
      incrementalSettlements: [
        {
          amountReceived: 300,
          remainingDiscrepancy: 200,
        },
      ],
      discrepancyStatus: "disputed",
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      // Remaining is 200, but Owner attempts to settle 250!
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 250,
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.code, "EXCEEDS_UNRESOLVED_DISCREPANCY");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 11. Dedicated /settle endpoint interoperability
  await t.test("11. Dedicated /settle endpoint processes incremental recovery seamlessly", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86018";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA8",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 1000,
      approvedAmount: 800,
      discrepancyAmount: 200,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1000,
          receiptNumber: "RCPT-008",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1000,
              verifiedAmount: 800,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          amountReceived: 200,
          reason: "Cash handed directly at front desk",
        },
      });

      const res = await postSettleRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      assert.equal(mockHandover.incrementalSettlements.length, 1);
      assert.equal(mockHandover.incrementalSettlements[0].amountReceived, 200);
      assert.equal(mockHandover.discrepancyStatus, "resolved");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 12. Owner dispute resolution: accounting_adjustment requires mandatory reason and audit reference
  await t.test("12. Accounting adjustment requires reason and auditRef, resolves discrepancy without cash receipt", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86019";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA9",
      centerId,
      submittedAmount: 1000,
      approvedAmount: 800,
      discrepancyAmount: 200,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1000,
          receiptNumber: "RCPT-009",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1000,
              verifiedAmount: 800,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      // 12a: Missing reason is rejected
      const badReq = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "accounting_adjustment",
          amount: 200,
          reason: "   ",
        },
      });
      const badRes = await postResolveRoute(badReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(badRes.status, 400);
      const badJson = await badRes.json();
      assert.equal(badJson.code, "MANDATORY_REASON_REQUIRED");

      // 12b: Valid accounting adjustment
      const goodReq = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "accounting_adjustment",
          amount: 200,
          reason: "Approved center emergency stationery expense voucher #V-102",
          auditReference: "AUD-EXP-202611-102",
        },
      });
      const goodRes = await postResolveRoute(goodReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(goodRes.status, 200);

      // Status resolved
      assert.equal(mockHandover.discrepancyStatus, "resolved");

      // Resolution logged with full audit reference
      assert.equal(mockHandover.resolutions.length, 1);
      assert.equal(mockHandover.resolutions[0].resolutionType, "accounting_adjustment");
      assert.equal(mockHandover.resolutions[0].amount, 200);
      assert.equal(mockHandover.resolutions[0].auditReference, "AUD-EXP-202611-102");

      // Zero physical cash added to incrementalSettlements
      assert.equal(mockHandover.incrementalSettlements.length, 0);

      // Verified amount on allocation remains unchanged at 800
      assert.equal(mockFeeDoc.paymentHistory[0].allocations[0].verifiedAmount, 800);
      assert.ok(mockFeeDoc.paymentHistory[0].allocations[0].notes.includes("AUD-EXP-202611-102"));
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 13. Owner dispute resolution: shortage_confirmed records confirmed deficit
  await t.test("13. Shortage confirmed records drawer deficit liability without student impact", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86020";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA10",
      centerId,
      submittedAmount: 1000,
      approvedAmount: 700,
      discrepancyAmount: 300,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1000,
          receiptNumber: "RCPT-010",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "split_custody",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1000,
              verifiedAmount: 700,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "shortage_confirmed",
          amount: 300,
          reason: "Unexplained drawer deficit confirmed by center management",
          auditReference: "AUD-SHORTAGE-202611-01",
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      assert.equal(mockHandover.discrepancyStatus, "shortage_confirmed");
      assert.equal(mockHandover.resolutions.length, 1);
      assert.equal(mockHandover.resolutions[0].resolutionType, "shortage_confirmed");
      assert.equal(mockHandover.resolutions[0].amount, 300);

      // Fee allocation updated to shortage_confirmed
      const alloc = mockFeeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "shortage_confirmed");

      // Student balance strictly untouched
      assert.equal(mockFeeDoc.amountDue, 0);
      assert.equal(mockFeeDoc.paidAmount, 1000);
      assert.equal(mockFeeDoc.status, "Paid");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 14. Teacher cannot resolve disputes
  await t.test("14. Teacher role is rejected from resolving disputes with HTTP 403 UNAUTHORIZED_ROLE", async () => {
    const handoverId = "507f191e810c19729de86010";
    const req = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: {
        resolutionType: "cash_received",
        amount: 200,
      },
    });

    const res = await postResolveRoute(req, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.code, "UNAUTHORIZED_ROLE");
  });

  // 15. Cross-center resolution rejected
  await t.test("15. Cross-center dispute resolution rejected with HTTP 403 CROSS_CENTER_ACCESS_FORBIDDEN", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId, // Center Alpha
      discrepancyAmount: 500,
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: centerBetaOwnerToken, // Owner of Center Beta
        body: {
          resolutionType: "cash_received",
          amount: 500,
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "CROSS_CENTER_ACCESS_FORBIDDEN");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 16. Student financial balance invariance across all operations
  await t.test("16. Student financial ledger (amountDue, paidAmount, status) is strictly immutable during dispute and settlement", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86021";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA11",
      centerId,
      discrepancyAmount: 500,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 2500,
          receiptNumber: "RCPT-011",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 500,
      paidAmount: 2500,
      originalAmountDue: 3000,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 2500,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 2500,
              verifiedAmount: 2000,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 500,
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      // Invariants strictly preserved
      assert.equal(mockFeeDoc.amountDue, 500);
      assert.equal(mockFeeDoc.paidAmount, 2500);
      assert.equal(mockFeeDoc.originalAmountDue, 3000);
      assert.equal(mockFeeDoc.status, "Partial Paid");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 17. Collector attribution immutability
  await t.test("17. Collector attribution (receivedBy, recordedBy) remains immutable during dispute resolution", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86022";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA12",
      centerId,
      discrepancyAmount: 500,
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1000,
          receiptNumber: "RCPT-012",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1000,
              verifiedAmount: 500,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 500,
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      const entry = mockFeeDoc.paymentHistory[0];
      assert.equal(String(entry.receivedBy), teacherAId);
      assert.equal(entry.receivedByRole, "teacher");
      assert.equal(String(entry.recordedBy), teacherAId);
      assert.equal(entry.recordedByRole, "teacher");

      // Resolver identity captured on resolution and allocation verifiedBy
      assert.equal(String(entry.allocations[0].verifiedBy), ownerId);
      assert.equal(String(mockHandover.resolutions[0].resolvedBy), ownerId);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 18. Parent collection totals remain unchanged
  await t.test("18. No double counting of recovered cash as new parent collections", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86023";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA13",
      centerId,
      discrepancyAmount: 400,
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1500,
          receiptNumber: "RCPT-013",
        },
      ],
      incrementalSettlements: [],
      resolutions: [],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1500,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1500,
              verifiedAmount: 1100,
              status: "disputed",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 400,
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      // Payment entries remain exactly 1, amount remains 1500
      assert.equal(mockFeeDoc.paymentHistory.length, 1);
      assert.equal(mockFeeDoc.paymentHistory[0].amount, 1500);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 19. Full historical audit preservation
  await t.test("19. Historical audit arrays preserve complete chain of disputes, resolutions and settlements", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86024";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA14",
      centerId,
      discrepancyAmount: 500,
      disputes: [
        {
          _id: new mongoose.Types.ObjectId(),
          initiatedBy: new mongoose.Types.ObjectId(teacherAId),
          initiatedByRole: "teacher",
          notes: "Initial dispute note",
          timestamp: new Date("2026-11-01T10:00:00Z"),
        },
      ],
      resolutions: [],
      incrementalSettlements: [],
      items: [],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "accounting_adjustment",
          amount: 500,
          reason: "Approved center stationery adjustment",
          auditReference: "AUD-REF-CHAIN-01",
        },
      });

      const res = await postResolveRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      // Both dispute and resolution entries are preserved together
      assert.equal(mockHandover.disputes.length, 1);
      assert.equal(mockHandover.resolutions.length, 1);
      assert.equal(mockHandover.resolutions[0].auditReference, "AUD-REF-CHAIN-01");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 20. Concurrency protection
  await t.test("20. Concurrency race protection prevents double-resolving already resolved handover", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86025";

    let currentStatus = "disputed";
    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA15",
      centerId,
      discrepancyAmount: 500,
      get discrepancyStatus() {
        return currentStatus;
      },
      set discrepancyStatus(val) {
        currentStatus = val;
      },
      incrementalSettlements: [],
      resolutions: [],
      items: [],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [],
    });

    try {
      // First request resolves the discrepancy
      const req1 = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 500,
        },
      });
      const res1 = await postResolveRoute(req1, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res1.status, 200);
      assert.equal(currentStatus, "resolved");

      // Concurrent second request fails with HTTP 409
      const req2 = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          resolutionType: "cash_received",
          amount: 500,
        },
      });
      const res2 = await postResolveRoute(req2, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res2.status, 409);
      const json2 = await res2.json();
      assert.equal(json2.code, "DISCREPANCY_ALREADY_RESOLVED");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 21. Transaction-unavailable fail-safe behavior (HTTP 503)
  await t.test("21. Missing transaction capability returns HTTP 503 TRANSACTIONS_UNAVAILABLE", async () => {
    const origStartSession = mongoose.startSession;
    mongoose.startSession = null; // Transactions unsupported

    const handoverId = "507f191e810c19729de86010";

    try {
      // Test dispute route fail-safe
      const disputeReq = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: { notes: "Testing fail-safe on dispute" },
      });
      const disputeRes = await postDisputeRoute(disputeReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(disputeRes.status, 503);
      const disputeJson = await disputeRes.json();
      assert.equal(disputeJson.code, "TRANSACTIONS_UNAVAILABLE");

      // Test resolve route fail-safe
      const resolveReq = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: { resolutionType: "cash_received", amount: 100 },
      });
      const resolveRes = await postResolveRoute(resolveReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(resolveRes.status, 503);
      const resolveJson = await resolveRes.json();
      assert.equal(resolveJson.code, "TRANSACTIONS_UNAVAILABLE");
    } finally {
      mongoose.startSession = origStartSession;
    }
  });
});
