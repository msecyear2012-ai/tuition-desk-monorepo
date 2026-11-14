process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: postHandoverRoute, GET: getHandoversRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/route.ts"
);
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const { calculateFeeCustody } = await import("../tution-desk-be/src/models/Fee.ts");
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  method = "POST",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/handovers",
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

test("Phase 4.3 Task 1: Cash Handover Submission & Listing API Specification Suite", async (t) => {
  const centerId = "center_alpha";
  const centerBetaId = "center_beta";

  const ownerId = "507f191e810c19729de860f1";
  const teacherAId = "507f191e810c19729de860f2";
  const teacherBId = "507f191e810c19729de860f3";

  const studentAId = "507f191e810c19729de860ea";
  const studentBId = "507f191e810c19729de860eb";

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

  // Mock Session Support to simulate MongoDB transactions in test runner
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

  // 1. Teacher submits eligible cash
  await t.test("1. Teacher submits eligible provisional cash handover, updating allocations to pending_verification", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";

    const initialFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 1000,
      paidAmount: 2000,
      originalAmountDue: 3000,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 2000,
          paymentDate: new Date("2026-11-01T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-001",
          isProvisional: true,
          custodyStatus: "teacher_custody",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;
    let savedHandover = null;

    FeeModel.find = (q) => {
      const query = {
        session: () => [initialFeeDoc],
      };
      return query;
    };

    CashHandoverModel.prototype.save = async function () {
      savedHandover = this;
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          submissionNotes: "First week cash collection",
          items: [
            {
              feeId,
              paymentId,
              amount: 2000,
              studentName: "Student Alpha",
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.handoverNumber.startsWith("HO-"));
      assert.equal(json.data.submittedAmount, 2000);
      assert.equal(json.data.status, "pending_approval");
      assert.equal(json.data.items.length, 1);

      // Verify Fee allocation was added with status pending_verification
      const entry = initialFeeDoc.paymentHistory[0];
      assert.equal(entry.allocations.length, 1);
      assert.equal(entry.allocations[0].status, "pending_verification");
      assert.equal(entry.allocations[0].allocatedAmount, 2000);
      assert.equal(String(entry.allocations[0].allocatedBy), teacherAId);

      // Verify custody changed to owner_pending
      assert.equal(entry.custodyStatus, "owner_pending");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 2. Owner submits eligible cash
  await t.test("2. Owner submits eligible cash collection handover successfully", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86003";
    const paymentId = "507f191e810c19729de86004";

    const initialFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentBId),
      amountDue: 0,
      paidAmount: 1500,
      originalAmountDue: 1500,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1500,
          paymentDate: new Date("2026-11-02T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-OWNER-01",
          isProvisional: false,
          custodyStatus: "owner_custody",
          receivedBy: new mongoose.Types.ObjectId(ownerId),
          receivedByRole: "owner",
          recordedBy: new mongoose.Types.ObjectId(ownerId),
          recordedByRole: "owner",
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;

    FeeModel.find = () => ({
      session: () => [initialFeeDoc],
    });

    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          submissionNotes: "Owner desk cash handover to vault",
          items: [
            {
              feeId,
              paymentId,
              amount: 1500,
              studentName: "Student Beta",
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.submittedAmount, 1500);
      assert.equal(json.data.status, "pending_approval");
      assert.equal(initialFeeDoc.paymentHistory[0].allocations.length, 1);
      assert.equal(initialFeeDoc.paymentHistory[0].allocations[0].status, "pending_verification");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 3. Multiple payment allocations in one handover
  await t.test("3. Multiple payment allocations across different fees bundled in one handover", async () => {
    setupMockTransactionSupport();
    const fee1Id = "507f191e810c19729de86011";
    const pay1Id = "507f191e810c19729de86012";

    const fee2Id = "507f191e810c19729de86013";
    const pay2Id = "507f191e810c19729de86014";

    const feeDoc1 = {
      _id: new mongoose.Types.ObjectId(fee1Id),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 700,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(pay1Id),
          paymentId: new mongoose.Types.ObjectId(pay1Id),
          amount: 700,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const feeDoc2 = {
      _id: new mongoose.Types.ObjectId(fee2Id),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentBId),
      amountDue: 0,
      paidAmount: 800,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(pay2Id),
          paymentId: new mongoose.Types.ObjectId(pay2Id),
          amount: 800,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;

    FeeModel.find = () => ({
      session: () => [feeDoc1, feeDoc2],
    });

    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [
            { feeId: fee1Id, paymentId: pay1Id, amount: 700 },
            { feeId: fee2Id, paymentId: pay2Id, amount: 800 },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.data.submittedAmount, 1500);
      assert.equal(json.data.items.length, 2);
      assert.equal(feeDoc1.paymentHistory[0].allocations.length, 1);
      assert.equal(feeDoc2.paymentHistory[0].allocations.length, 1);
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 4. Partial allocation
  await t.test("4. Partial allocation: allocating ₹400 of a ₹1,000 payment leaves ₹600 in-hand", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86021";
    const paymentId = "507f191e810c19729de86022";

    const feeDoc = {
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
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;

    FeeModel.find = () => ({
      session: () => [feeDoc],
    });
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 400 }],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.data.submittedAmount, 400);

      // Verify Fee state
      const entry = feeDoc.paymentHistory[0];
      assert.equal(entry.allocations.length, 1);
      assert.equal(entry.allocations[0].allocatedAmount, 400);

      // Verify custody breakdown
      const custody = calculateFeeCustody(feeDoc);
      assert.equal(custody.ownerPendingVerificationAmount, 400);
      assert.equal(custody.teacherInHandAmount, 600);
      assert.equal(custody.custodyLabel, "split_custody");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 5. Insufficient available balance rejected
  await t.test("5. Insufficient available balance rejected with HTTP 400 INSUFFICIENT_AVAILABLE_FUNDS", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86031";
    const paymentId = "507f191e810c19729de86032";

    const feeDoc = {
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
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [
            {
              allocationId: new mongoose.Types.ObjectId(),
              handoverId: new mongoose.Types.ObjectId(),
              allocatedAmount: 600,
              status: "pending_verification",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });

    try {
      // Attempt to allocate ₹500 when only ₹400 is available
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 500 }],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.code, "INSUFFICIENT_AVAILABLE_FUNDS");
      assert.equal(feeDoc.paymentHistory[0].allocations.length, 1, "Zero new allocations added");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  // 6. Duplicate allocation rejected
  await t.test("6. Duplicate allocation on fully allocated payment rejected", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86041";
    const paymentId = "507f191e810c19729de86042";

    const feeDoc = {
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
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [
            {
              allocationId: new mongoose.Types.ObjectId(),
              handoverId: new mongoose.Types.ObjectId(),
              allocatedAmount: 1000,
              status: "pending_verification",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 1000 }],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.code, "INSUFFICIENT_AVAILABLE_FUNDS");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  // 7. Cross-center allocation rejected
  await t.test("7. Cross-center allocation rejected with HTTP 403 CROSS_CENTER_ACCESS_FORBIDDEN", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86051";
    const paymentId = "507f191e810c19729de86052";

    const feeBetaDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId: centerBetaId, // Belongs to Center Beta!
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => ({
      session: () => [feeBetaDoc],
    });

    try {
      // Center Alpha teacher attempts to allocate Center Beta fee
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 1000 }],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "CROSS_CENTER_ACCESS_FORBIDDEN");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  // 8. Unauthorized Teacher access rejected
  await t.test("8. Unauthorized Teacher cannot hand over cash collected by another teacher", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86061";
    const paymentId = "507f191e810c19729de86062";

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          // Received by Teacher B, NOT Teacher A
          receivedBy: new mongoose.Types.ObjectId(teacherBId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });

    try {
      // Teacher A attempts to hand over Teacher B's collected payment
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 1000 }],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "UNAUTHORIZED_COLLECTOR_ALLOCATION");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  // 9. Submission does not change student outstanding
  await t.test("9. Handover submission does not alter student amountDue or fee status", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86071";
    const paymentId = "507f191e810c19729de86072";

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      originalAmountDue: 2500,
      amountDue: 1500,
      paidAmount: 1000,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 1000 }],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 201);

      // Invariants: student balances must remain completely unchanged
      assert.equal(feeDoc.amountDue, 1500, "amountDue must not change during handover submission");
      assert.equal(feeDoc.paidAmount, 1000, "paidAmount must not change during handover submission");
      assert.equal(feeDoc.status, "Partial Paid", "Fee status must not change during handover submission");
      assert.equal(feeDoc.originalAmountDue, 2500, "originalAmountDue must not change");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 10. Submission does not double-count parent collection
  await t.test("10. Physical cash transfer does not double-count parent payment totals", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86081";
    const paymentId = "507f191e810c19729de86082";

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [{ feeId, paymentId, amount: 1000 }],
        },
      });

      await postHandoverRoute(req);

      // Fee paidAmount remains exactly 1000, not 2000
      assert.equal(feeDoc.paidAmount, 1000, "Paid amount must never double count");
      assert.equal(feeDoc.amountDue, 0);
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 11. Concurrent allocation race
  await t.test("11. Concurrent allocation race: over-allocation of the same payment is prevented", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86091";
    const paymentId = "507f191e810c19729de86092";

    // Payment has ₹1,000 available
    const feeDoc = {
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
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      // First submission allocates ₹700 (succeeds)
      const req1 = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: { items: [{ feeId, paymentId, amount: 700 }] },
      });
      const res1 = await postHandoverRoute(req1);
      assert.equal(res1.status, 201);

      // Second submission attempts to allocate another ₹700 (total ₹1400 > ₹1000)
      const req2 = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: { items: [{ feeId, paymentId, amount: 700 }] },
      });
      const res2 = await postHandoverRoute(req2);
      assert.equal(res2.status, 400);
      const json2 = await res2.json();
      assert.equal(json2.code, "INSUFFICIENT_AVAILABLE_FUNDS");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 12. GET role-based visibility
  await t.test("12. GET role-based visibility: Owner sees all, Teacher sees only own submissions", async () => {
    const mockHandovers = [
      {
        _id: "ho_1",
        centerId,
        handoverNumber: "HO-001",
        teacherId: new mongoose.Types.ObjectId(teacherAId),
        submittedAmount: 1000,
        approvedAmount: 0,
        status: "pending_approval",
        submittedAt: new Date("2026-11-01"),
      },
      {
        _id: "ho_2",
        centerId,
        handoverNumber: "HO-002",
        teacherId: new mongoose.Types.ObjectId(teacherBId),
        submittedAmount: 2000,
        approvedAmount: 2000,
        status: "approved",
        submittedAt: new Date("2026-11-02"),
      },
    ];

    const origHandoverFind = CashHandoverModel.find;
    const origTeacherFind = TeacherModel.find;

    CashHandoverModel.find = (filter) => {
      let filtered = mockHandovers.filter((h) => h.centerId === filter.centerId);
      if (filter.teacherId) {
        filtered = filtered.filter((h) => String(h.teacherId) === String(filter.teacherId));
      }
      if (filter.status) {
        filtered = filtered.filter((h) => h.status === filter.status);
      }
      return {
        sort: () => ({
          lean: async () => filtered,
        }),
      };
    };

    TeacherModel.find = () => ({
      select: async () => [
        { _id: teacherAId, name: "Teacher Sharma" },
        { _id: teacherBId, name: "Teacher Verma" },
      ],
    });

    try {
      // 1. Owner GET sees both handovers
      const ownerReq = createMockRequest({ method: "GET", token: ownerToken });
      const ownerRes = await getHandoversRoute(ownerReq);
      assert.equal(ownerRes.status, 200);
      const ownerJson = await ownerRes.json();
      assert.equal(ownerJson.count, 2);

      // 2. Teacher A GET sees ONLY Handover 1
      const teacherAReq = createMockRequest({ method: "GET", token: teacherAToken });
      const teacherARes = await getHandoversRoute(teacherAReq);
      assert.equal(teacherARes.status, 200);
      const teacherAJson = await teacherARes.json();
      assert.equal(teacherAJson.count, 1);
      assert.equal(teacherAJson.data[0].handoverNumber, "HO-001");

      // 3. Teacher B GET sees ONLY Handover 2
      const teacherBReq = createMockRequest({ method: "GET", token: teacherBToken });
      const teacherBRes = await getHandoversRoute(teacherBReq);
      assert.equal(teacherBRes.status, 200);
      const teacherBJson = await teacherBRes.json();
      assert.equal(teacherBJson.count, 1);
      assert.equal(teacherBJson.data[0].handoverNumber, "HO-002");

      // 4. Center Beta user sees 0 handovers
      const betaReq = createMockRequest({ method: "GET", token: centerBetaOwnerToken });
      const betaRes = await getHandoversRoute(betaReq);
      assert.equal(betaRes.status, 200);
      const betaJson = await betaRes.json();
      assert.equal(betaJson.count, 0);
    } finally {
      CashHandoverModel.find = origHandoverFind;
      TeacherModel.find = origTeacherFind;
    }
  });

  // 13. Rejected historical allocations remain preserved
  await t.test("13. Rejected historical allocations remain preserved while releasing funds for resubmission", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de860a1";
    const paymentId = "507f191e810c19729de860a2";
    const oldAllocationId = new mongoose.Types.ObjectId();

    // Payment has a previously rejected allocation of ₹500
    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 500,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 500,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          allocations: [
            {
              _id: oldAllocationId,
              allocationId: oldAllocationId,
              handoverId: new mongoose.Types.ObjectId(),
              handoverNumber: "HO-REJECTED-001",
              allocatedAmount: 500,
              status: "rejected",
              rejectionReason: "Envelope count shortfall",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    const origHandoverSave = CashHandoverModel.prototype.save;
    FeeModel.find = () => ({
      session: () => [feeDoc],
    });
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      // Re-submitting the ₹500 that was previously rejected
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: { items: [{ feeId, paymentId, amount: 500 }] },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 201);

      // Verify both allocations exist (historical rejected + new pending_verification)
      const entry = feeDoc.paymentHistory[0];
      assert.equal(entry.allocations.length, 2);
      assert.equal(entry.allocations[0].status, "rejected", "Historical rejected allocation must remain intact");
      assert.equal(entry.allocations[1].status, "pending_verification", "New allocation must be pending_verification");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // 14. Transaction unavailability safe fail
  await t.test("14. Fails safely with HTTP 503 when multi-document transactions are unavailable", async () => {
    const origStartSession = mongoose.startSession;
    mongoose.startSession = null; // Simulate standalone or unsupported environment

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherAToken,
        body: {
          items: [
            {
              feeId: "507f191e810c19729de86001",
              paymentId: "507f191e810c19729de86002",
              amount: 1000,
            },
          ],
        },
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 503);
      const json = await res.json();
      assert.equal(json.code, "TRANSACTIONS_UNAVAILABLE");
    } finally {
      mongoose.startSession = origStartSession;
    }
  });
});
