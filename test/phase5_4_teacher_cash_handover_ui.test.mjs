process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
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
const { PUT: putResolveRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/resolve/route.ts"
);

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const { calculatePaymentCustody, getLockedAllocationAmount } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
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

test("Phase 5.4: Teacher Cash Handover UI & Lifecycle Integration Suite", async (t) => {
  const centerId = "center_alpha";
  const ownerId = "507f191e810c19729de860f1";
  const teacherId = "507f191e810c19729de860f2";
  const teacherTwoId = "507f191e810c19729de860f3";
  const studentId = "507f191e810c19729de860ea";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director Alpha",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    teacherId,
    centerId,
    role: "teacher",
    name: "Teacher Ramanujan",
  });

  const teacherTwoToken = await signToken({
    userId: teacherTwoId,
    teacherId: teacherTwoId,
    centerId,
    role: "teacher",
    name: "Teacher Aryabhata",
  });

  // TEST 1: Teacher submits eligible collections creating handover and locking allocations
  await t.test("1. Teacher submits eligible cash collections into handover envelope", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86001";
    const paymentId = "507f191e810c19729de86002";

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
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
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
          recordedBy: new mongoose.Types.ObjectId(teacherId),
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

    FeeModel.find = () => ({
      session: () => Promise.resolve([feeDoc]),
    });
    CashHandoverModel.prototype.save = async function () {
      return this;
    };

    try {
      const req = createMockRequest({
        method: "POST",
        token: teacherToken,
        body: {
          items: [
            {
              feeId,
              paymentId,
              amount: 1500,
              studentId,
              studentName: "Aarav Sharma",
              receiptNumber: "RCPT-001",
            },
          ],
          submissionNotes: "Collected from Aarav Sharma, Class 10",
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 201, `Expected 201 Created: ${JSON.stringify(data)}`);
      assert.equal(data.success, true);
      assert.equal(data.data.submittedAmount, 1500);
      assert.equal(data.data.status, "pending_approval");
      assert.equal(data.data.teacherId, teacherId);
      assert.ok(data.data.handoverNumber.startsWith("HO-"));

      // Verify allocation was recorded on payment entry
      const entry = feeDoc.paymentHistory[0];
      assert.equal(entry.allocations.length, 1);
      assert.equal(entry.allocations[0].allocatedAmount, 1500);
      assert.equal(entry.allocations[0].status, "pending_verification");

      // Verify financial invariants: student ledger must be untouched
      assert.equal(feeDoc.amountDue, 1000);
      assert.equal(feeDoc.paidAmount, 2000);
      assert.equal(feeDoc.status, "Partial Paid");
    } finally {
      FeeModel.find = origFeeFind;
      CashHandoverModel.prototype.save = origHandoverSave;
    }
  });

  // TEST 2: Partial handover allocation leaves correct remaining available cash
  await t.test("2. Partial handover allocation leaves remaining funds available for subsequent handovers", async () => {
    const paymentId = "507f191e810c19729de86012";

    const paymentEntry = {
      _id: new mongoose.Types.ObjectId(paymentId),
      amount: 3000,
      paymentMode: "Cash",
      isProvisional: true,
      custodyStatus: "teacher_custody",
      receivedBy: new mongoose.Types.ObjectId(teacherId),
      receivedByRole: "teacher",
      allocations: [
        {
          handoverId: new mongoose.Types.ObjectId(),
          handoverNumber: "HO-20261111-0001",
          allocatedAmount: 1200,
          status: "pending_verification",
          allocatedAt: new Date(),
        },
      ],
    };

    const locked = paymentEntry.allocations.reduce(
      (sum, a) => sum + getLockedAllocationAmount(a),
      0
    );
    assert.equal(locked, 1200);

    const remainingAvailable = paymentEntry.amount - locked;
    assert.equal(remainingAvailable, 1800);
  });

  // TEST 3: Owner full verification transitions envelope to approved and confirms safe custody
  await t.test("3. Owner fully verifies handover, transitioning to approved and clearing safe custody", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86021";
    const feeId = "507f191e810c19729de86022";
    const paymentId = "507f191e810c19729de86023";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-0002",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      teacherName: "Teacher Ramanujan",
      submittedAmount: 1500,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      items: [
        {
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          studentId: new mongoose.Types.ObjectId(studentId),
          studentName: "Aarav Sharma",
          receiptNumber: "RCPT-002",
          amount: 1500,
        },
      ],
      auditTrail: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      amountDue: 500,
      paidAmount: 1500,
      status: "Partial Paid",
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1500,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "teacher_custody",
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
          allocations: [
            {
              handoverId: handoverDoc._id,
              handoverNumber: "HO-20261111-0002",
              allocatedAmount: 1500,
              status: "pending_verification",
              allocatedAt: new Date(),
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
      session: () => Promise.resolve(handoverDoc),
    });
    FeeModel.find = () => ({
      session: () => Promise.resolve([feeDoc]),
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/verify`,
        body: {
          verifiedAmount: 1500,
          resolutionNotes: "Physical count verified matching exact envelope total",
        },
      });

      const res = await putVerifyRoute(req, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 200, `Expected 200: ${JSON.stringify(data)}`);
      assert.equal(data.success, true);
      assert.equal(handoverDoc.status, "approved");
      assert.equal(handoverDoc.approvedAmount, 1500);
      assert.equal(handoverDoc.discrepancyAmount, 0);

      // Verify payment allocation transitioned to verified
      const alloc = feeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "verified");
      assert.equal(alloc.verifiedAmount, 1500);

      // Verify custody cleared to institute safe
      const custody = calculatePaymentCustody(feeDoc.paymentHistory[0]);
      assert.equal(custody.custodyLabel, "owner_verified");
      assert.equal(custody.ownerVerifiedAmount, 1500);
      assert.equal(feeDoc.paymentHistory[0].custodyStatus, "owner_verified");
      assert.equal(feeDoc.paymentHistory[0].isProvisional, false);

      // Verify financial invariants: student balance untouched
      assert.equal(feeDoc.amountDue, 500);
      assert.equal(feeDoc.paidAmount, 1500);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 4: Owner partial verification creates shortage discrepancy and records audit
  await t.test("4. Owner partial verification records shortage discrepancy and partial allocation", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86031";
    const feeId = "507f191e810c19729de86032";
    const paymentId = "507f191e810c19729de86033";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-0003",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      teacherName: "Teacher Ramanujan",
      submittedAmount: 1000,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      items: [
        {
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
        },
      ],
      auditTrail: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      amountDue: 0,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "teacher_custody",
          allocations: [
            {
              handoverId: handoverDoc._id,
              handoverNumber: "HO-20261111-0003",
              allocatedAmount: 1000,
              status: "pending_verification",
              allocatedAt: new Date(),
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
      session: () => Promise.resolve(handoverDoc),
    });
    FeeModel.find = () => ({
      session: () => Promise.resolve([feeDoc]),
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/verify`,
        body: {
          verifiedAmount: 800,
          resolutionNotes: "Envelope physically counted ₹800; ₹200 shortage noted.",
        },
      });

      const res = await putVerifyRoute(req, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(handoverDoc.status, "partially_approved");
      assert.equal(handoverDoc.approvedAmount, 800);
      assert.equal(handoverDoc.discrepancyAmount, 200);
      assert.equal(handoverDoc.discrepancyStatus, "disputed");

      // Verify allocation records verifiedAmount
      const alloc = feeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "disputed");
      assert.equal(alloc.verifiedAmount, 800);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 5: Owner rejection requires mandatory reason and releases allocations back to teacher
  await t.test("5. Owner rejection requires mandatory reason and releases allocations back to teacher custody", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86041";
    const feeId = "507f191e810c19729de86042";
    const paymentId = "507f191e810c19729de86043";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-0004",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 1200,
      status: "pending_approval",
      items: [
        {
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1200,
        },
      ],
      auditTrail: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      amountDue: 0,
      paidAmount: 1200,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1200,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "teacher_custody",
          allocations: [
            {
              handoverId: handoverDoc._id,
              allocatedAmount: 1200,
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
      session: () => Promise.resolve(handoverDoc),
    });
    FeeModel.find = () => ({
      session: () => Promise.resolve([feeDoc]),
    });

    try {
      // 5a. Reject without reason fails with HTTP 400
      const emptyReasonReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/reject`,
        body: { rejectionReason: "   " },
      });
      const emptyRes = await putRejectRoute(emptyReasonReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(emptyRes.status, 400);

      // 5b. Valid rejection unlocks allocations
      const validReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/reject`,
        body: { rejectionReason: "Envelope torn and unsealed; please recount and resubmit." },
      });

      const res = await putRejectRoute(validReq, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(handoverDoc.status, "rejected");
      assert.equal(handoverDoc.rejectionReason, "Envelope torn and unsealed; please recount and resubmit.");

      // Check allocation status was set to rejected
      assert.equal(feeDoc.paymentHistory[0].allocations[0].status, "rejected");

      // Verify that rejected allocation is excluded from locked amounts (returning full availability)
      const lockedAfterReject = feeDoc.paymentHistory[0].allocations.reduce(
        (sum, a) => sum + getLockedAllocationAmount(a),
        0
      );
      assert.equal(lockedAfterReject, 0);
      const availableNow = feeDoc.paymentHistory[0].amount - lockedAfterReject;
      assert.equal(availableNow, 1200);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 6: RBAC: Teacher cannot verify or reject handovers
  await t.test("6. RBAC: Teacher cannot verify or reject handovers (HTTP 403 UNAUTHORIZED_ROLE)", async () => {
    const handoverId = "507f191e810c19729de86051";

    const verifyReq = createMockRequest({
      method: "PUT",
      token: teacherToken,
      url: `http://localhost:3000/api/handovers/${handoverId}/verify`,
      body: { verifiedAmount: 1000 },
    });
    const verifyRes = await putVerifyRoute(verifyReq, { params: Promise.resolve({ handoverId }) });
    assert.equal(verifyRes.status, 403);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.code, "UNAUTHORIZED_ROLE");

    const rejectReq = createMockRequest({
      method: "PUT",
      token: teacherToken,
      url: `http://localhost:3000/api/handovers/${handoverId}/reject`,
      body: { rejectionReason: "Teacher attempting rejection" },
    });
    const rejectRes = await putRejectRoute(rejectReq, { params: Promise.resolve({ handoverId }) });
    assert.equal(rejectRes.status, 403);
    const rejectData = await rejectRes.json();
    assert.equal(rejectData.code, "UNAUTHORIZED_ROLE");
  });

  // TEST 7: Over-allocation is rejected
  await t.test("7. Over-allocation exceeding available cash is rejected with INSUFFICIENT_AVAILABLE_FUNDS", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86061";
    const paymentId = "507f191e810c19729de86062";

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          isProvisional: true,
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
          allocations: [
            {
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
      session: () => Promise.resolve([feeDoc]),
    });

    try {
      // Available is 1000 - 600 = 400. Attempting to allocate 500 should fail.
      const req = createMockRequest({
        method: "POST",
        token: teacherToken,
        body: {
          items: [{ feeId, paymentId, amount: 500 }],
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.code, "INSUFFICIENT_AVAILABLE_FUNDS");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 8: Teacher cannot submit payment collected by another teacher
  await t.test("8. Teacher cannot submit cash collected by another faculty member", async () => {
    setupMockTransactionSupport();
    const feeId = "507f191e810c19729de86071";
    const paymentId = "507f191e810c19729de86072";

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          isProvisional: true,
          receivedBy: new mongoose.Types.ObjectId(teacherTwoId), // Collected by teacherTwo
          receivedByRole: "teacher",
          allocations: [],
        },
      ],
      save: async function () {
        return this;
      },
    };

    const origFeeFind = FeeModel.find;
    FeeModel.find = () => ({
      session: () => Promise.resolve([feeDoc]),
    });

    try {
      // Teacher 1 attempts to submit teacher 2's collected payment
      const req = createMockRequest({
        method: "POST",
        token: teacherToken,
        body: {
          items: [{ feeId, paymentId, amount: 1000 }],
        },
      });

      const res = await postHandoverRoute(req);
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.code, "UNAUTHORIZED_COLLECTOR_ALLOCATION");
    } finally {
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 9: Handover listing role scoping (Teacher vs Owner)
  await t.test("9. Handover listing role scoping: Teacher sees only own handovers; Owner sees all center handovers", async () => {
    const origHandoverFind = CashHandoverModel.find;
    const origTeacherFind = TeacherModel.find;

    let queriedFilter = null;
    CashHandoverModel.find = (filter) => {
      queriedFilter = filter;
      return {
        sort: () => ({
          lean: () => Promise.resolve([]),
        }),
      };
    };

    TeacherModel.find = () => ({
      select: () => Promise.resolve([]),
    });

    try {
      // 9a. Teacher request is scoped to teacher's own teacherId
      const teacherReq = createMockRequest({
        method: "GET",
        token: teacherToken,
        url: "http://localhost:3000/api/handovers",
      });
      await getHandoversRoute(teacherReq);
      assert.equal(queriedFilter.centerId, centerId);
      assert.equal(String(queriedFilter.teacherId), teacherId);

      // 9b. Owner request sees all center handovers without forced teacherId
      const ownerReq = createMockRequest({
        method: "GET",
        token: ownerToken,
        url: "http://localhost:3000/api/handovers",
      });
      await getHandoversRoute(ownerReq);
      assert.equal(queriedFilter.centerId, centerId);
      assert.equal(queriedFilter.teacherId, undefined);

      // 9c. Owner can filter by specific faculty
      const ownerFacultyReq = createMockRequest({
        method: "GET",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers?teacherId=${teacherId}`,
      });
      await getHandoversRoute(ownerFacultyReq);
      assert.equal(queriedFilter.centerId, centerId);
      assert.equal(String(queriedFilter.teacherId), teacherId);
    } finally {
      CashHandoverModel.find = origHandoverFind;
      TeacherModel.find = origTeacherFind;
    }
  });

  // TEST 10: Complete dispute initiation and Owner resolution workflow
  await t.test("10. Dispute workflow: Initiated on discrepancy, Owner resolves with cash_received", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86091";
    const feeId = "507f191e810c19729de86092";
    const paymentId = "507f191e810c19729de86093";
    const allocationId = "507f191e810c19729de86094";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-0005",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 1000,
      approvedAmount: 800,
      discrepancyAmount: 200,
      discrepancyStatus: "shortage_unresolved",
      discrepancyType: "shortage",
      status: "partially_approved",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
        },
      ],
      disputes: [],
      resolutions: [],
      incrementalSettlements: [],
      auditTrail: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      amountDue: 0,
      paidAmount: 1000,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
          paymentMode: "Cash",
          isProvisional: true,
          custodyStatus: "teacher_custody",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: handoverDoc._id,
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
      session: () => Promise.resolve(handoverDoc),
    });
    FeeModel.find = () => ({
      session: () => Promise.resolve([feeDoc]),
    });

    try {
      // 10a. Teacher logs dispute explaining the missing note was found
      const disputeReq = createMockRequest({
        method: "POST",
        token: teacherToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/dispute`,
        body: {
          reason: "Found missing ₹200 note in faculty drawer; delivering now.",
        },
      });

      const disputeRes = await postDisputeRoute(disputeReq, {
        params: Promise.resolve({ handoverId }),
      });
      const disputeData = await disputeRes.json();

      assert.equal(disputeRes.status, 200);
      assert.equal(disputeData.success, true);
      assert.equal(handoverDoc.discrepancyStatus, "disputed");
      assert.equal(handoverDoc.disputes.length, 1);
      assert.equal(
        handoverDoc.disputes[0].notes,
        "Found missing ₹200 note in faculty drawer; delivering now."
      );

      // 10b. Owner receives the remaining cash and resolves dispute
      const resolveReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "cash_received",
          amount: 200,
          notes: "Remaining ₹200 physically handed over and placed in safe.",
        },
      });

      const resolveRes = await putResolveRoute(resolveReq, {
        params: Promise.resolve({ handoverId }),
      });
      const resolveData = await resolveRes.json();

      assert.equal(resolveRes.status, 200);
      assert.equal(resolveData.success, true);
      assert.equal(handoverDoc.discrepancyStatus, "resolved");
      assert.equal(handoverDoc.incrementalSettlements.length, 1);
      assert.equal(handoverDoc.incrementalSettlements[0].amountReceived, 200);
      assert.equal(handoverDoc.incrementalSettlements[0].remainingDiscrepancy, 0);

      // Verify fee allocation updated to 1000 verified
      assert.equal(feeDoc.paymentHistory[0].allocations[0].verifiedAmount, 1000);
      assert.equal(feeDoc.paymentHistory[0].allocations[0].status, "verified");

      // Verify student ledger still completely intact
      assert.equal(feeDoc.amountDue, 0);
      assert.equal(feeDoc.paidAmount, 1000);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });
});
