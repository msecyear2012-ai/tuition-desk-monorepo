process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { PUT: putVerifyRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/verify/route.ts"
);
const { PUT: putRejectRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/reject/route.ts"
);
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const { calculatePaymentCustody, getLockedAllocationAmount } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  method = "PUT",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/handovers/HO-001/verify",
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

test("Phase 4.3 Task 2: Owner Handover Verification & Rejection Specification Suite", async (t) => {
  const centerId = "center_alpha";
  const centerBetaId = "center_beta";

  const ownerId = "507f191e810c19729de860f1";
  const teacherAId = "507f191e810c19729de860f2";

  const studentAId = "507f191e810c19729de860ea";
  const studentBId = "507f191e810c19729de860eb";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director Alpha",
  });

  const teacherToken = await signToken({
    userId: teacherAId,
    teacherId: teacherAId,
    centerId,
    role: "teacher",
    name: "Teacher Sharma",
  });

  const centerBetaOwnerToken = await signToken({
    userId: "507f191e810c19729de860f9",
    centerId: centerBetaId,
    role: "owner",
    name: "Center Director Beta",
  });

  // 1. Owner full verification (status: "approved")
  await t.test("1. Owner full verification transitions handover to approved and confirms fee custody", async () => {
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
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
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
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 1000,
      paidAmount: 3000,
      originalAmountDue: 4000,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 3000,
          paymentDate: new Date("2026-11-01T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-001",
          isProvisional: true,
          custodyStatus: "owner_pending",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              handoverNumber: "HO-20261111-AAA1",
              allocatedAmount: 3000,
              status: "pending_verification",
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
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 3000 },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(mockHandover.status, "approved");
      assert.equal(mockHandover.approvedAmount, 3000);
      assert.equal(mockHandover.discrepancyAmount, 0);
      assert.equal(mockHandover.discrepancyStatus, "none");
      assert.equal(String(mockHandover.approvedBy), ownerId);
      assert.ok(mockHandover.approvedAt instanceof Date);

      // Fee allocation updated
      const alloc = mockFeeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "verified");
      assert.equal(alloc.verifiedAmount, 3000);
      assert.equal(String(alloc.verifiedBy), ownerId);
      assert.ok(alloc.verifiedAt instanceof Date);

      // Entry custody derived to owner_verified and provisional cleared
      assert.equal(mockFeeDoc.paymentHistory[0].custodyStatus, "owner_verified");
      assert.equal(mockFeeDoc.paymentHistory[0].isProvisional, false);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 2. Owner partial verification (status: "partially_approved", discrepancyStatus: "disputed")
  await t.test("2. Owner partial verification records discrepancy and marks allocation disputed", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86011";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA2",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 2000,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 2000,
          receiptNumber: "RCPT-002",
        },
      ],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 2000,
      originalAmountDue: 2000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 2000,
          paymentDate: new Date("2026-11-01T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-002",
          isProvisional: true,
          custodyStatus: "owner_pending",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              handoverNumber: "HO-20261111-AAA2",
              allocatedAmount: 2000,
              status: "pending_verification",
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
        method: "PUT",
        token: ownerToken,
        body: {
          verifiedAmount: 1500,
          notes: "₹500 shortage detected in envelope",
        },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      assert.equal(mockHandover.status, "partially_approved");
      assert.equal(mockHandover.approvedAmount, 1500);
      assert.equal(mockHandover.discrepancyAmount, 500);
      assert.equal(mockHandover.discrepancyStatus, "disputed");

      // Fee allocation updated with disputed shortage
      const alloc = mockFeeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "disputed");
      assert.equal(alloc.verifiedAmount, 1500);
      assert.equal(alloc.notes, "₹500 shortage detected in envelope");

      // Payment remains provisional
      assert.equal(mockFeeDoc.paymentHistory[0].isProvisional, true);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 3. Multiple-item verification with split amounts
  await t.test("3. Multiple-item verification handles item-level verified amounts correctly", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86012";
    const fee1Id = "507f191e810c19729de86001";
    const fee2Id = "507f191e810c19729de86004";
    const payment1Id = "507f191e810c19729de86002";
    const payment2Id = "507f191e810c19729de86005";
    const alloc1Id = "507f191e810c19729de86003";
    const alloc2Id = "507f191e810c19729de86006";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA3",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 3000,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(alloc1Id),
          paymentId: new mongoose.Types.ObjectId(payment1Id),
          feeId: new mongoose.Types.ObjectId(fee1Id),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 2000,
          receiptNumber: "RCPT-003-1",
        },
        {
          allocationId: new mongoose.Types.ObjectId(alloc2Id),
          paymentId: new mongoose.Types.ObjectId(payment2Id),
          feeId: new mongoose.Types.ObjectId(fee2Id),
          studentId: new mongoose.Types.ObjectId(studentBId),
          amount: 1000,
          receiptNumber: "RCPT-003-2",
        },
      ],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc1 = {
      _id: new mongoose.Types.ObjectId(fee1Id),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 2000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(payment1Id),
          paymentId: new mongoose.Types.ObjectId(payment1Id),
          amount: 2000,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(alloc1Id),
              allocationId: new mongoose.Types.ObjectId(alloc1Id),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 2000,
              status: "pending_verification",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc2 = {
      _id: new mongoose.Types.ObjectId(fee2Id),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentBId),
      amountDue: 0,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(payment2Id),
          paymentId: new mongoose.Types.ObjectId(payment2Id),
          amount: 1000,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(alloc2Id),
              allocationId: new mongoose.Types.ObjectId(alloc2Id),
              handoverId: new mongoose.Types.ObjectId(handoverId),
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

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc1, mockFeeDoc2],
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: {
          items: [
            { allocationId: alloc1Id, verifiedAmount: 2000 },
            { allocationId: alloc2Id, verifiedAmount: 800 },
          ],
        },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      assert.equal(mockHandover.approvedAmount, 2800);
      assert.equal(mockHandover.discrepancyAmount, 200);
      assert.equal(mockHandover.status, "partially_approved");
      assert.equal(mockHandover.discrepancyStatus, "disputed");

      // Fee 1 allocation fully verified
      assert.equal(mockFeeDoc1.paymentHistory[0].allocations[0].status, "verified");
      assert.equal(mockFeeDoc1.paymentHistory[0].allocations[0].verifiedAmount, 2000);

      // Fee 2 allocation disputed with shortage
      assert.equal(mockFeeDoc2.paymentHistory[0].allocations[0].status, "disputed");
      assert.equal(mockFeeDoc2.paymentHistory[0].allocations[0].verifiedAmount, 800);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 4. Teacher verification rejected (HTTP 403)
  await t.test("4. Teacher role is rejected with HTTP 403 UNAUTHORIZED_ROLE on verification", async () => {
    const handoverId = "507f191e810c19729de86010";
    const req = createMockRequest({
      method: "PUT",
      token: teacherToken,
      body: { verifiedAmount: 1000 },
    });

    const res = await putVerifyRoute(req, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.code, "UNAUTHORIZED_ROLE");
  });

  // 5. Cross-center verification rejected (HTTP 403)
  await t.test("5. Cross-center verification rejected with HTTP 403 CROSS_CENTER_ACCESS_FORBIDDEN", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId, // Center Alpha
      status: "pending_approval",
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: centerBetaOwnerToken, // Owner of Center Beta
        body: { verifiedAmount: 1000 },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "CROSS_CENTER_ACCESS_FORBIDDEN");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 6. Missing rejection reason rejected (HTTP 400)
  await t.test("6. Missing or empty rejection reason is rejected with HTTP 400 REJECTION_REASON_REQUIRED", async () => {
    const handoverId = "507f191e810c19729de86010";
    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: { rejectionReason: "   " },
    });

    const res = await putRejectRoute(req, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.code, "REJECTION_REASON_REQUIRED");
  });

  // 7. Owner rejection preserves historical allocation records
  await t.test("7. Owner rejection preserves historical allocation records and sets status to rejected", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86013";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA4",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 1000,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 1000,
          receiptNumber: "RCPT-004",
        },
      ],
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
      originalAmountDue: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentDate: new Date("2026-11-01T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-004",
          isProvisional: true,
          custodyStatus: "owner_pending",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              handoverNumber: "HO-20261111-AAA4",
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
        method: "PUT",
        token: ownerToken,
        body: {
          rejectionReason: "Cash denomination count mismatch with physical envelope",
        },
      });

      const res = await putRejectRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);
      assert.equal(mockHandover.status, "rejected");
      assert.equal(
        mockHandover.rejectionReason,
        "Cash denomination count mismatch with physical envelope"
      );
      assert.ok(mockHandover.rejectedAt instanceof Date);

      // Allocation history is preserved, not deleted
      const entry = mockFeeDoc.paymentHistory[0];
      assert.equal(entry.allocations.length, 1);
      assert.equal(entry.allocations[0].status, "rejected");
      assert.equal(
        entry.allocations[0].rejectionReason,
        "Cash denomination count mismatch with physical envelope"
      );
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 8. Rejected allocation releases funds and becomes available for resubmission
  await t.test("8. Rejected allocation releases funds back to teacher_in_hand custody", async () => {
    const paymentEntry = {
      amount: 2000,
      allocations: [
        {
          handoverId: new mongoose.Types.ObjectId(),
          allocatedAmount: 2000,
          status: "rejected",
          rejectionReason: "Envelope torn",
        },
      ],
    };

    // getLockedAllocationAmount must return 0 for rejected allocations
    const lockedAmount = getLockedAllocationAmount(paymentEntry.allocations[0]);
    assert.equal(lockedAmount, 0);

    // Custody derivation must return entire 2000 as teacher_in_hand
    const custody = calculatePaymentCustody(paymentEntry);
    assert.equal(custody.teacherInHandAmount, 2000);
    assert.equal(custody.ownerPendingVerificationAmount, 0);
    assert.equal(custody.ownerVerifiedAmount, 0);
    assert.equal(custody.custodyLabel, "teacher_in_hand");
  });

  // 9. Duplicate verification prevented on already resolved handover (HTTP 409)
  await t.test("9. Duplicate verification rejected with HTTP 409 HANDOVER_ALREADY_RESOLVED", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      status: "approved", // Already approved!
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1000 },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.code, "HANDOVER_ALREADY_RESOLVED");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 10. Verification cannot exceed allocated amount (HTTP 400)
  await t.test("10. Verified amount exceeding allocated amount returns HTTP 400 INVALID_VERIFICATION_AMOUNT", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      submittedAmount: 1000,
      status: "pending_approval",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId("507f191e810c19729de86003"),
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86002"),
          feeId: new mongoose.Types.ObjectId("507f191e810c19729de86001"),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 1000,
          receiptNumber: "RCPT-001",
        },
      ],
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1500 }, // 1500 > 1000
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.code, "INVALID_VERIFICATION_AMOUNT");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // 11. Fee outstanding (amountDue), paidAmount, and status remain completely unchanged
  await t.test("11. Student financial balances remain strictly invariant across verification and rejection", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      submittedAmount: 2000,
      status: "pending_approval",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 2000,
          receiptNumber: "RCPT-001",
        },
      ],
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
          amount: 2000,
          paymentDate: new Date("2026-11-01T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-001",
          isProvisional: true,
          custodyStatus: "owner_pending",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 2000,
              status: "pending_verification",
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
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 2000 },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      // Financial balance invariants strictly preserved
      assert.equal(mockFeeDoc.amountDue, 500);
      assert.equal(mockFeeDoc.paidAmount, 2500);
      assert.equal(mockFeeDoc.originalAmountDue, 3000);
      assert.equal(mockFeeDoc.status, "Partial Paid");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 12. Parent collection totals remain unchanged (no double counting)
  await t.test("12. Parent payment line items and totals undergo zero duplication during verification", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      submittedAmount: 1500,
      status: "pending_approval",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 1500,
          receiptNumber: "RCPT-001",
        },
      ],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 0,
      paidAmount: 1500,
      originalAmountDue: 1500,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1500,
          paymentDate: new Date("2026-11-01T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-001",
          isProvisional: true,
          custodyStatus: "owner_pending",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: new mongoose.Types.ObjectId(handoverId),
              allocatedAmount: 1500,
              status: "pending_verification",
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
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1500 },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      // Total payments remain 1, total amount remains 1500
      assert.equal(mockFeeDoc.paymentHistory.length, 1);
      assert.equal(mockFeeDoc.paymentHistory[0].amount, 1500);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 13. Original collector attribution (receivedBy, recordedBy) remains immutable
  await t.test("13. Collector attribution remains immutable when verified by Owner", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      submittedAmount: 1000,
      status: "pending_approval",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 1000,
          receiptNumber: "RCPT-001",
        },
      ],
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
              status: "pending_verification",
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
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1000 },
      });

      const res = await putVerifyRoute(req, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res.status, 200);

      // Attribution strictly untouched
      const entry = mockFeeDoc.paymentHistory[0];
      assert.equal(String(entry.receivedBy), teacherAId);
      assert.equal(entry.receivedByRole, "teacher");
      assert.equal(String(entry.recordedBy), teacherAId);
      assert.equal(entry.recordedByRole, "teacher");

      // Verification attribution stored separately on allocation and handover
      assert.equal(String(entry.allocations[0].verifiedBy), ownerId);
      assert.equal(String(mockHandover.approvedBy), ownerId);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 14. Concurrent verification race protection
  await t.test("14. Concurrent verification attempts on transitioning handover return HTTP 409", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86010";

    // Simulate first request succeeds and transitions status to approved
    let state = "pending_approval";
    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-20261111-AAA1",
      centerId,
      get status() {
        return state;
      },
      set status(val) {
        state = val;
      },
      submittedAmount: 1000,
      items: [
        {
          allocationId: new mongoose.Types.ObjectId("507f191e810c19729de86003"),
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86002"),
          feeId: new mongoose.Types.ObjectId("507f191e810c19729de86001"),
          studentId: new mongoose.Types.ObjectId(studentAId),
          amount: 1000,
          receiptNumber: "RCPT-001",
        },
      ],
      save: async function () {
        return this;
      },
    };

    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86001"),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86002"),
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86002"),
          amount: 1000,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId("507f191e810c19729de86003"),
              allocationId: new mongoose.Types.ObjectId("507f191e810c19729de86003"),
              handoverId: new mongoose.Types.ObjectId(handoverId),
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

    const origHandoverFindOne = CashHandoverModel.findOne;
    const origFeeFind = FeeModel.find;

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    try {
      // First request
      const req1 = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1000 },
      });
      const res1 = await putVerifyRoute(req1, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res1.status, 200);
      assert.equal(state, "approved");

      // Concurrent second request arrives after status was committed
      const req2 = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1000 },
      });
      const res2 = await putVerifyRoute(req2, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(res2.status, 409);
      const json2 = await res2.json();
      assert.equal(json2.code, "HANDOVER_ALREADY_RESOLVED");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // 15. Transaction-unavailable fail-safe behavior (HTTP 503)
  await t.test("15. Missing transaction capability returns HTTP 503 TRANSACTIONS_UNAVAILABLE", async () => {
    const origStartSession = mongoose.startSession;
    mongoose.startSession = null; // Transactions unsupported

    const handoverId = "507f191e810c19729de86010";

    try {
      // Test verify route fail-safe
      const verifyReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 1000 },
      });
      const verifyRes = await putVerifyRoute(verifyReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(verifyRes.status, 503);
      const verifyJson = await verifyRes.json();
      assert.equal(verifyJson.code, "TRANSACTIONS_UNAVAILABLE");

      // Test reject route fail-safe
      const rejectReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { rejectionReason: "No cash in envelope" },
      });
      const rejectRes = await putRejectRoute(rejectReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(rejectRes.status, 503);
      const rejectJson = await rejectRes.json();
      assert.equal(rejectJson.code, "TRANSACTIONS_UNAVAILABLE");
    } finally {
      mongoose.startSession = origStartSession;
    }
  });
});
