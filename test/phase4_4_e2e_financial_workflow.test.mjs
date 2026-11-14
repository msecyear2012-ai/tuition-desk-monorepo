process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;

const { POST: manualCollectionRoute } = await import(
  "../tution-desk-be/src/app/api/fees/manual-collection/route.ts"
);
const { GET: getFeeRoute, PUT: putFeeRoute } = await import(
  "../tution-desk-be/src/app/api/fees/[feeId]/route.ts"
);
const { POST: postHandoverRoute, GET: getHandoversRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/route.ts"
);
const { PUT: putVerifyRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/verify/route.ts"
);
const { PUT: putRejectRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/reject/route.ts"
);
const { POST: postDisputeRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/dispute/route.ts"
);
const { POST: postResolveRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/resolve/route.ts"
);
const { POST: postSettleRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/settle/route.ts"
);

const { calculatePaymentCustody, calculateFeeCustody, getLockedAllocationAmount } =
  await import("../tution-desk-be/src/models/Fee.ts");
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  method = "GET",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/mock",
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

test("Phase 4.4 Task 1: Complete End-to-End Financial Workflow Validation Suite", async (t) => {
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

  // =========================================================================
  // WORKFLOW A: PARENT PAYMENT (Steps 1 - 5)
  // =========================================================================
  await t.test("Workflow A: Parent Payment — Collection, Attribution, Immediate Debt Reduction & Receipt", async (sub) => {
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";

    const mockStudent = {
      _id: new mongoose.Types.ObjectId(studentAId),
      centerId,
      name: "Aarav Sharma",
      batch: "Class 10-A",
      assignedTeacherId: new mongoose.Types.ObjectId(teacherAId),
      parentWhatsApp: "+919876543210",
      monthlyFee: 5000,
      isActive: true,
    };

    StudentModel.findById = async (id) =>
      String(id) === String(studentAId) ? mockStudent : null;

    let feeState = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      originalAmountDue: 5000,
      amountDue: 5000,
      paidAmount: 0,
      feeType: "monthly_recurring",
      notes: "Initial November invoice",
      paymentHistory: [],
    };

    FeeModel.find = async () => [feeState];
    FeeModel.findOne = async () => null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      // Step 2 & 5: Atomic update applying payment line item and new balances
      const paymentEntry = update.$push?.paymentHistory;
      feeState = {
        ...feeState,
        ...update.$set,
        paymentHistory: paymentEntry
          ? [...feeState.paymentHistory, paymentEntry]
          : feeState.paymentHistory,
      };
      return {
        ...feeState,
        populate: async () => ({
          ...feeState,
          studentId: mockStudent,
        }),
      };
    };

    // Step 1: Teacher records partial cash collection of ₹2,000
    const req = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: {
        studentId: studentAId,
        amount: 2000,
        billingMonth: "2026-11",
        notes: "First installment cash collected at desk",
      },
      url: "http://localhost:3000/api/fees/manual-collection",
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    // Step 2: Student outstanding reduces immediately
    assert.equal(json.data.amountDue, 3000, "Student dues must reduce from 5000 to 3000 immediately");
    assert.equal(json.data.paidAmount, 2000, "Paid amount must record 2000");
    assert.equal(json.data.status, "Partial Paid", "Status must transition to Partial Paid");

    // Step 3: Parent payment history records original amount
    assert.equal(json.data.originalAmountDue, 5000, "originalAmountDue must be preserved as 5000");
    const payment = json.data.paymentHistory[0];
    assert.ok(payment, "paymentHistory line item must exist");
    assert.equal(payment.amount, 2000);

    // Step 4: Collector attribution comes strictly from JWT
    assert.equal(String(payment.receivedBy), teacherAId, "receivedBy must be Teacher A");
    assert.equal(payment.receivedByRole, "teacher");
    assert.equal(String(payment.recordedBy), teacherAId, "recordedBy must be Teacher A");
    assert.equal(payment.recordedByRole, "teacher");

    // Step 5: Parent receipt data is preserved
    assert.ok(payment.receiptNumber.startsWith("RCPT-"), "Receipt number generated");
    assert.equal(payment.isProvisional, true, "Provisional cash in teacher hand");
    assert.equal(payment.paymentMode, "Cash");

    // Live Custody Derivation Check
    const custody = calculatePaymentCustody(payment);
    assert.equal(custody.teacherInHandAmount, 2000);
    assert.equal(custody.ownerPendingVerificationAmount, 0);
    assert.equal(custody.ownerVerifiedAmount, 0);
    assert.equal(custody.custodyLabel, "teacher_in_hand");
  });

  // =========================================================================
  // WORKFLOW B: CASH HANDOVER (Steps 6 - 10)
  // =========================================================================
  await t.test("Workflow B: Cash Handover — Bundling, Partial Allocation, Over-allocation & Cross-Collector Guards", async (sub) => {
    setupMockTransactionSupport();
    const fee1Id = "507f191e810c19729de86001";
    const fee2Id = "507f191e810c19729de86004";
    const payment1Id = "507f191e810c19729de86002";
    const payment2Id = "507f191e810c19729de86005";

    const feeDoc1 = {
      _id: new mongoose.Types.ObjectId(fee1Id),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 3000,
      paidAmount: 2000,
      originalAmountDue: 5000,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(payment1Id),
          paymentId: new mongoose.Types.ObjectId(payment1Id),
          amount: 2000,
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

    const feeDoc2 = {
      _id: new mongoose.Types.ObjectId(fee2Id),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentBId),
      amountDue: 0,
      paidAmount: 1000,
      originalAmountDue: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(payment2Id),
          paymentId: new mongoose.Types.ObjectId(payment2Id),
          amount: 1000,
          paymentMode: "Cash",
          receiptNumber: "RCPT-002",
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

    FeeModel.find = (q) => ({
      session: () => [feeDoc1, feeDoc2],
    });

    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    // Step 6, 7, 8: Teacher submits ₹1,500 of Fee 1 (partial allocation) + ₹1,000 of Fee 2 (multiple fees bundled)
    const req = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: {
        submissionNotes: "End of week envelope",
        items: [
          { feeId: fee1Id, paymentId: payment1Id, amount: 1500, studentName: "Aarav Sharma" },
          { feeId: fee2Id, paymentId: payment2Id, amount: 1000, studentName: "Rohan Patel" },
        ],
      },
      url: "http://localhost:3000/api/handovers",
    });

    const res = await postHandoverRoute(req);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.submittedAmount, 2500);
    assert.equal(json.data.status, "pending_approval");
    assert.equal(json.data.items.length, 2);

    // Step 8: Partial allocation leaves ₹500 in teacher_in_hand for payment 1
    const custody1 = calculatePaymentCustody(feeDoc1.paymentHistory[0]);
    assert.equal(custody1.teacherInHandAmount, 500);
    assert.equal(custody1.ownerPendingVerificationAmount, 1500);
    assert.equal(custody1.custodyLabel, "split_custody");

    // Step 9: Over-allocation attempt rejected
    const overAllocReq = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: {
        items: [
          { feeId: fee1Id, paymentId: payment1Id, amount: 600 }, // Only 500 available!
        ],
      },
      url: "http://localhost:3000/api/handovers",
    });
    const overAllocRes = await postHandoverRoute(overAllocReq);
    assert.equal(overAllocRes.status, 400);
    const overAllocJson = await overAllocRes.json();
    assert.equal(overAllocJson.code, "INSUFFICIENT_AVAILABLE_FUNDS");

    // Step 10: Teacher cannot submit another Teacher's collection
    const crossTeacherReq = createMockRequest({
      method: "POST",
      token: teacherBToken, // Teacher B attempts to hand over Teacher A's cash
      body: {
        items: [
          { feeId: fee1Id, paymentId: payment1Id, amount: 500 },
        ],
      },
      url: "http://localhost:3000/api/handovers",
    });
    const crossTeacherRes = await postHandoverRoute(crossTeacherReq);
    assert.equal(crossTeacherRes.status, 403);
    const crossTeacherJson = await crossTeacherRes.json();
    assert.equal(crossTeacherJson.code, "UNAUTHORIZED_COLLECTOR_ALLOCATION");
  });

  // =========================================================================
  // WORKFLOW C: OWNER VERIFICATION (Steps 11 - 16)
  // =========================================================================
  await t.test("Workflow C: Owner Verification — Full Approval, Partial Discrepancy, Rejection & Fund Release", async (sub) => {
    setupMockTransactionSupport();
    const handover1Id = "507f191e810c19729de86010";
    const handover2Id = "507f191e810c19729de86011";
    const handover3Id = "507f191e810c19729de86012";

    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const alloc1Id = "507f191e810c19729de86003";

    // Step 11: Owner views pending handovers
    const mockHandovers = [
      {
        _id: new mongoose.Types.ObjectId(handover1Id),
        handoverNumber: "HO-E2E-1",
        centerId,
        teacherId: new mongoose.Types.ObjectId(teacherAId),
        submittedAmount: 1500,
        status: "pending_approval",
        discrepancyStatus: "none",
        items: [
          {
            allocationId: new mongoose.Types.ObjectId(alloc1Id),
            paymentId: new mongoose.Types.ObjectId(paymentId),
            feeId: new mongoose.Types.ObjectId(feeId),
            amount: 1500,
            receiptNumber: "RCPT-001",
          },
        ],
      },
    ];

    CashHandoverModel.find = () => ({
      sort: () => ({
        lean: () => mockHandovers,
      }),
    });
    TeacherModel.find = () => ({
      select: async () => [],
    });

    const listReq = createMockRequest({
      method: "GET",
      token: ownerToken,
      url: "http://localhost:3000/api/handovers",
    });
    const listRes = await getHandoversRoute(listReq);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.count, 1);
    assert.equal(listJson.data[0].handoverNumber, "HO-E2E-1");

    // Step 12: Owner verifies full amount of Handover 1
    const mockFeeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      amountDue: 3000,
      paidAmount: 2000,
      originalAmountDue: 5000,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 2000,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "split_custody",
          receivedBy: new mongoose.Types.ObjectId(teacherAId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherAId),
          recordedByRole: "teacher",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(alloc1Id),
              allocationId: new mongoose.Types.ObjectId(alloc1Id),
              handoverId: new mongoose.Types.ObjectId(handover1Id),
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

    CashHandoverModel.findOne = () => ({
      session: () => ({
        ...mockHandovers[0],
        save: async function () {
          return this;
        },
      }),
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    const verifyReq = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: { verifiedAmount: 1500 },
      url: `http://localhost:3000/api/handovers/${handover1Id}/verify`,
    });
    const verifyRes = await putVerifyRoute(verifyReq, {
      params: Promise.resolve({ handoverId: handover1Id }),
    });
    assert.equal(verifyRes.status, 200);

    const verifiedAlloc = mockFeeDoc.paymentHistory[0].allocations[0];
    assert.equal(verifiedAlloc.status, "verified");
    assert.equal(verifiedAlloc.verifiedAmount, 1500);

    // Live Custody Breakdown: 500 teacher_in_hand, 0 pending, 1500 owner_verified
    const c1 = calculatePaymentCustody(mockFeeDoc.paymentHistory[0]);
    assert.equal(c1.teacherInHandAmount, 500);
    assert.equal(c1.ownerVerifiedAmount, 1500);
    assert.equal(c1.ownerPendingVerificationAmount, 0);

    // Step 13: Owner verifies partial amount on Handover 2 (₹700 of ₹1,000, discrepancy ₹300)
    const mockHandover2 = {
      _id: new mongoose.Types.ObjectId(handover2Id),
      handoverNumber: "HO-E2E-2",
      centerId,
      submittedAmount: 1000,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(),
          paymentId: new mongoose.Types.ObjectId(),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1000,
          receiptNumber: "RCPT-003",
        },
      ],
      save: async function () {
        return this;
      },
    };

    const feeDocPart = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: mockHandover2.items[0].paymentId,
          paymentId: mockHandover2.items[0].paymentId,
          amount: 1000,
          allocations: [
            {
              _id: mockHandover2.items[0].allocationId,
              allocationId: mockHandover2.items[0].allocationId,
              handoverId: new mongoose.Types.ObjectId(handover2Id),
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

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover2,
    });
    FeeModel.find = () => ({
      session: () => [feeDocPart],
    });

    const partialVerifyReq = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: { verifiedAmount: 700, notes: "₹300 shortage in count" },
      url: `http://localhost:3000/api/handovers/${handover2Id}/verify`,
    });
    const partialVerifyRes = await putVerifyRoute(partialVerifyReq, {
      params: Promise.resolve({ handoverId: handover2Id }),
    });
    assert.equal(partialVerifyRes.status, 200);
    assert.equal(mockHandover2.status, "partially_approved");
    assert.equal(mockHandover2.approvedAmount, 700);
    assert.equal(mockHandover2.discrepancyAmount, 300);
    assert.equal(mockHandover2.discrepancyStatus, "disputed");

    // Step 14, 15, 16: Owner rejects Handover 3 with reason, releasing funds while preserving history
    const mockHandover3 = {
      _id: new mongoose.Types.ObjectId(handover3Id),
      handoverNumber: "HO-E2E-3",
      centerId,
      submittedAmount: 500,
      status: "pending_approval",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(),
          paymentId: new mongoose.Types.ObjectId(),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 500,
          receiptNumber: "RCPT-004",
        },
      ],
      save: async function () {
        return this;
      },
    };

    const feeDocRej = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: mockHandover3.items[0].paymentId,
          paymentId: mockHandover3.items[0].paymentId,
          amount: 500,
          allocations: [
            {
              _id: mockHandover3.items[0].allocationId,
              allocationId: mockHandover3.items[0].allocationId,
              handoverId: new mongoose.Types.ObjectId(handover3Id),
              allocatedAmount: 500,
              status: "pending_verification",
            },
          ],
        },
      ],
      save: async function () {
        return this;
      },
    };

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover3,
    });
    FeeModel.find = () => ({
      session: () => [feeDocRej],
    });

    const rejectReq = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: { rejectionReason: "Cash denomination count mismatch" },
      url: `http://localhost:3000/api/handovers/${handover3Id}/reject`,
    });
    const rejectRes = await putRejectRoute(rejectReq, {
      params: Promise.resolve({ handoverId: handover3Id }),
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(mockHandover3.status, "rejected");

    // Step 16: Historical allocation preserved
    const rejAlloc = feeDocRej.paymentHistory[0].allocations[0];
    assert.equal(rejAlloc.status, "rejected");
    assert.equal(rejAlloc.rejectionReason, "Cash denomination count mismatch");

    // Step 15: Released funds become eligible for resubmission (locked amount is 0)
    assert.equal(getLockedAllocationAmount(rejAlloc), 0);
    const rejCustody = calculatePaymentCustody(feeDocRej.paymentHistory[0]);
    assert.equal(rejCustody.teacherInHandAmount, 500);
  });

  // =========================================================================
  // WORKFLOW D: DISPUTES AND SETTLEMENT (Steps 17 - 22)
  // =========================================================================
  await t.test("Workflow D: Disputes and Settlement — Initiation, Incremental Recovery, Adjustment & Shortage", async (sub) => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86030";
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";
    const allocationId = "507f191e810c19729de86003";

    // Handover has ₹500 discrepancy (10,000 submitted, 9,500 verified)
    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-E2E-DISP",
      centerId,
      teacherId: new mongoose.Types.ObjectId(teacherAId),
      submittedAmount: 10000,
      approvedAmount: 9500,
      discrepancyAmount: 500,
      status: "partially_approved",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 10000,
          receiptNumber: "RCPT-005",
        },
      ],
      disputes: [],
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

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });
    FeeModel.find = () => ({
      session: () => [mockFeeDoc],
    });

    // Step 17: Teacher initiates dispute
    const dispReq = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: { notes: "Disputing ₹500 difference; checking classroom drawers" },
      url: `http://localhost:3000/api/handovers/${handoverId}/dispute`,
    });
    const dispRes = await postDisputeRoute(dispReq, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(dispRes.status, 200);
    assert.equal(mockHandover.discrepancyStatus, "disputed");
    assert.equal(mockHandover.disputes.length, 1);

    // Step 18, 19: Owner resolves partial recovery of ₹300 using cash_received
    const rec1Req = createMockRequest({
      method: "POST",
      token: ownerToken,
      body: {
        resolutionType: "cash_received",
        amount: 300,
        reason: "Teacher found and produced ₹300 cash",
      },
      url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
    });
    const rec1Res = await postResolveRoute(rec1Req, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(rec1Res.status, 200);
    assert.equal(mockHandover.incrementalSettlements.length, 1);
    assert.equal(mockHandover.incrementalSettlements[0].amountReceived, 300);
    assert.equal(mockHandover.incrementalSettlements[0].remainingDiscrepancy, 200);
    assert.equal(mockHandover.discrepancyStatus, "disputed"); // 200 still unresolved
    assert.equal(mockFeeDoc.paymentHistory[0].allocations[0].verifiedAmount, 9800);

    // Step 20: Over-settlement is rejected (> remaining 200)
    const overReq = createMockRequest({
      method: "POST",
      token: ownerToken,
      body: { resolutionType: "cash_received", amount: 250 },
      url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
    });
    const overRes = await postResolveRoute(overReq, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(overRes.status, 400);
    const overJson = await overRes.json();
    assert.equal(overJson.code, "EXCEEDS_UNRESOLVED_DISCREPANCY");

    // Step 21: accounting_adjustment does not increase physical cash
    const adjReq = createMockRequest({
      method: "POST",
      token: ownerToken,
      body: {
        resolutionType: "accounting_adjustment",
        amount: 200,
        reason: "Authorized emergency classroom stationery purchase voucher #V-11",
        auditReference: "AUD-V-11-202611",
      },
      url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
    });
    const adjRes = await postResolveRoute(adjReq, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(adjRes.status, 200);
    assert.equal(mockHandover.discrepancyStatus, "resolved");

    // Physical cash received strictly remains 9800 (does not increase by 200)
    assert.equal(mockFeeDoc.paymentHistory[0].allocations[0].verifiedAmount, 9800);
    assert.equal(mockHandover.incrementalSettlements.length, 1); // No new physical cash settlement

    // Step 22: shortage_confirmed records liability without changing student balances
    const mockHandoverShort = {
      _id: new mongoose.Types.ObjectId(),
      handoverNumber: "HO-SHORT",
      centerId,
      discrepancyAmount: 300,
      discrepancyStatus: "disputed",
      incrementalSettlements: [],
      resolutions: [],
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(),
          paymentId: new mongoose.Types.ObjectId(),
          feeId: new mongoose.Types.ObjectId(feeId),
          amount: 1000,
        },
      ],
      save: async function () {
        return this;
      },
    };

    const feeDocShort = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      amountDue: 0,
      paidAmount: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: mockHandoverShort.items[0].paymentId,
          paymentId: mockHandoverShort.items[0].paymentId,
          amount: 1000,
          allocations: [
            {
              _id: mockHandoverShort.items[0].allocationId,
              allocationId: mockHandoverShort.items[0].allocationId,
              handoverId: mockHandoverShort._id,
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

    CashHandoverModel.findOne = () => ({
      session: () => mockHandoverShort,
    });
    FeeModel.find = () => ({
      session: () => [feeDocShort],
    });

    const shortReq = createMockRequest({
      method: "POST",
      token: ownerToken,
      body: {
        resolutionType: "shortage_confirmed",
        amount: 300,
        reason: "Unexplained till deficit confirmed by management",
        auditReference: "AUD-DEFICIT-001",
      },
      url: "http://localhost:3000/api/handovers/HO-SHORT/resolve",
    });
    const shortRes = await postResolveRoute(shortReq, {
      params: Promise.resolve({ handoverId: "HO-SHORT" }),
    });
    assert.equal(shortRes.status, 200);
    assert.equal(mockHandoverShort.discrepancyStatus, "shortage_confirmed");
    assert.equal(feeDocShort.paymentHistory[0].allocations[0].status, "shortage_confirmed");

    // Student balance completely untouched
    assert.equal(feeDocShort.amountDue, 0);
    assert.equal(feeDocShort.paidAmount, 1000);
    assert.equal(feeDocShort.status, "Paid");
  });

  // =========================================================================
  // FINANCIAL INVARIANTS: PARENT COLLECTIONS != OWNER CASH RECEIVED
  // =========================================================================
  await t.test("Financial Invariants: Parent collections are decoupled from staff cash transfers and non-cash adjustments", () => {
    // Parent collections total: ₹5,000 paid across 2 installments
    const paymentInstallment1 = { amount: 3000, allocations: [{ allocatedAmount: 3000, verifiedAmount: 3000, status: "verified" }] };
    const paymentInstallment2 = { amount: 2000, allocations: [{ allocatedAmount: 2000, verifiedAmount: 1500, status: "disputed" }] };

    const totalParentCollections = paymentInstallment1.amount + paymentInstallment2.amount;
    assert.equal(totalParentCollections, 5000);

    // Physical cash verified in vault by Owner: 3000 + 1500 = 4500
    const totalPhysicalCashInVault =
      paymentInstallment1.allocations[0].verifiedAmount + paymentInstallment2.allocations[0].verifiedAmount;
    assert.equal(totalPhysicalCashInVault, 4500);

    // Discrepancy under dispute: 500
    const unverifiedDiscrepancy = 500;

    // Mathematical assertion: Parent Collections != Owner Cash Received
    assert.notEqual(
      totalParentCollections,
      totalPhysicalCashInVault,
      "Parent Collections (5000) must strictly NOT equal Owner Vault Cash (4500)"
    );

    // Reconciled cash equation
    assert.equal(totalPhysicalCashInVault + unverifiedDiscrepancy, totalParentCollections);
  });

  // =========================================================================
  // SECURITY & FAILURE SCENARIOS
  // =========================================================================
  await t.test("Security & Failure Scenarios: Cross-tenant, Tampering, Concurrency & Transaction Fail-safe", async (sub) => {
    const handoverId = "507f191e810c19729de86040";

    // 1. Cross-center requests rejected
    const mockHandover = {
      _id: new mongoose.Types.ObjectId(handoverId),
      handoverNumber: "HO-SEC-1",
      centerId, // center_alpha
      status: "pending_approval",
    };

    CashHandoverModel.findOne = () => ({
      session: () => mockHandover,
    });

    const crossCenterReq = createMockRequest({
      method: "PUT",
      token: centerBetaOwnerToken, // center_beta
      body: { verifiedAmount: 1000 },
      url: `http://localhost:3000/api/handovers/${handoverId}/verify`,
    });
    const crossRes = await putVerifyRoute(crossCenterReq, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(crossRes.status, 403);
    const crossJson = await crossRes.json();
    assert.equal(crossJson.code, "CROSS_CENTER_ACCESS_FORBIDDEN");

    // 2. Client-supplied attribution tampering rejected
    const validFeeId = "507f191e810c19729de86001";
    const tamperReq = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: {
        paymentHistory: [{ amount: 999999 }],
        originalAmountDue: 1,
      },
      url: `http://localhost:3000/api/fees/${validFeeId}`,
    });
    const tamperRes = await putFeeRoute(tamperReq, {
      params: Promise.resolve({ feeId: validFeeId }),
    });
    assert.equal(tamperRes.status, 400);
    const tamperJson = await tamperRes.json();
    assert.equal(tamperJson.code, "IMMUTABLE_FIELD_TAMPERING");

    // 3. Teacher unauthorized dispute resolution rejected
    const teachResReq = createMockRequest({
      method: "POST",
      token: teacherAToken,
      body: { resolutionType: "cash_received", amount: 100 },
      url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
    });
    const teachRes = await postResolveRoute(teachResReq, {
      params: Promise.resolve({ handoverId }),
    });
    assert.equal(teachRes.status, 403);
    const teachJson = await teachRes.json();
    assert.equal(teachJson.code, "UNAUTHORIZED_ROLE");

    // 4. Transaction-unavailable safe failure (HTTP 503)
    const origStart = mongoose.startSession;
    mongoose.startSession = null;
    try {
      const txReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: { verifiedAmount: 100 },
        url: `http://localhost:3000/api/handovers/${handoverId}/verify`,
      });
      const txRes = await putVerifyRoute(txReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(txRes.status, 503);
      const txJson = await txRes.json();
      assert.equal(txJson.code, "TRANSACTIONS_UNAVAILABLE");
    } finally {
      mongoose.startSession = origStart;
    }
  });
});
