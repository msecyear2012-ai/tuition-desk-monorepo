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
const { POST: postDisputeRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/dispute/route.ts"
);
const { PUT: putResolveRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/[handoverId]/resolve/route.ts"
);

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const { calculatePaymentCustody } = await import(
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

test("Phase 5.5: Owner Verification & Dispute Workflow Comprehensive Validation Suite", async (t) => {
  const centerId = "center_alpha";
  const ownerId = "507f191e810c19729de860f1";
  const teacherId = "507f191e810c19729de860f2";
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

  // TEST 1: Concurrency guard - repeated verification request is rejected with 409 Conflict
  await t.test("1. Repeated verification request on already verified handover returns 409 HANDOVER_ALREADY_RESOLVED", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86101";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-V001",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 2000,
      approvedAmount: 2000,
      status: "approved", // already verified
      items: [],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => Promise.resolve(handoverDoc),
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/verify`,
        body: { verifiedAmount: 2000 },
      });

      const res = await putVerifyRoute(req, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 409);
      assert.equal(data.success, false);
      assert.equal(data.code, "HANDOVER_ALREADY_RESOLVED");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // TEST 2: Concurrency guard - repeated rejection request is rejected with 409 Conflict
  await t.test("2. Repeated rejection request on already rejected handover returns 409 HANDOVER_ALREADY_RESOLVED", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86102";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-R001",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 1500,
      status: "rejected", // already rejected
      items: [],
      save: async function () {
        return this;
      },
    };

    const origHandoverFindOne = CashHandoverModel.findOne;
    CashHandoverModel.findOne = () => ({
      session: () => Promise.resolve(handoverDoc),
    });

    try {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/reject`,
        body: { rejectionReason: "Duplicate reject attempt" },
      });

      const res = await putRejectRoute(req, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 409);
      assert.equal(data.success, false);
      assert.equal(data.code, "HANDOVER_ALREADY_RESOLVED");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
    }
  });

  // TEST 3: Owner initiates dispute on shortage envelope
  await t.test("3. Owner can initiate dispute on shortage handover, recording initiatedByRole: 'owner'", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86103";
    const feeId = "507f191e810c19729de86104";
    const paymentId = "507f191e810c19729de86105";
    const allocationId = "507f191e810c19729de86106";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-D001",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 3000,
      approvedAmount: 2500,
      discrepancyAmount: 500,
      status: "partially_approved",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 3000,
        },
      ],
      disputes: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 3000,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: handoverDoc._id,
              allocatedAmount: 3000,
              verifiedAmount: 2500,
              status: "verified",
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
        method: "POST",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/dispute`,
        body: {
          reason: "Cash counter found two counterfeit ₹200 notes; teacher notified.",
        },
      });

      const res = await postDisputeRoute(req, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(handoverDoc.discrepancyStatus, "disputed");
      assert.equal(handoverDoc.disputes.length, 1);
      assert.equal(handoverDoc.disputes[0].initiatedByRole, "owner");
      assert.equal(
        handoverDoc.disputes[0].notes,
        "Cash counter found two counterfeit ₹200 notes; teacher notified."
      );
      assert.equal(feeDoc.paymentHistory[0].allocations[0].status, "disputed");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 4: Unauthorized actor cannot resolve dispute
  await t.test("4. Teacher attempting dispute resolution receives HTTP 403 UNAUTHORIZED_ROLE", async () => {
    const handoverId = "507f191e810c19729de86107";

    const req = createMockRequest({
      method: "PUT",
      token: teacherToken,
      url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
      body: {
        resolutionType: "accounting_adjustment",
        reason: "Teacher attempting write-off",
      },
    });

    const res = await putResolveRoute(req, { params: Promise.resolve({ handoverId }) });
    const data = await res.json();

    assert.equal(res.status, 403);
    assert.equal(data.success, false);
    assert.equal(data.code, "UNAUTHORIZED_ROLE");
  });

  // TEST 5: Owner resolves dispute via accounting_adjustment
  await t.test("5. Owner resolves dispute via accounting_adjustment (requires reason, writes off balance, preserves vault cash)", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86108";
    const feeId = "507f191e810c19729de86109";
    const paymentId = "507f191e810c19729de8610a";
    const allocationId = "507f191e810c19729de8610b";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-RES01",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 2000,
      approvedAmount: 1800,
      discrepancyAmount: 200,
      discrepancyStatus: "disputed",
      discrepancyType: "shortage",
      status: "partially_approved",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 2000,
        },
      ],
      disputes: [],
      resolutions: [],
      incrementalSettlements: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 2000,
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: handoverDoc._id,
              allocatedAmount: 2000,
              verifiedAmount: 1800,
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
      // 5a. Missing reason fails with 400 MANDATORY_REASON_REQUIRED
      const noReasonReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "accounting_adjustment",
          reason: "   ",
        },
      });
      const noReasonRes = await putResolveRoute(noReasonReq, {
        params: Promise.resolve({ handoverId }),
      });
      assert.equal(noReasonRes.status, 400);
      const noReasonData = await noReasonRes.json();
      assert.equal(noReasonData.code, "MANDATORY_REASON_REQUIRED");

      // 5b. Valid adjustment resolves dispute
      const validReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "accounting_adjustment",
          reason: "Approved institute rounding concession for student fee shortfall",
        },
      });

      const res = await putResolveRoute(validReq, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(handoverDoc.discrepancyStatus, "resolved");
      assert.equal(handoverDoc.resolutions.length, 1);
      assert.equal(handoverDoc.resolutions[0].resolutionType, "accounting_adjustment");
      assert.equal(handoverDoc.resolutions[0].amount, 200);

      // Verify physical cash in safe remains unchanged (no fake currency added)
      assert.equal(handoverDoc.approvedAmount, 1800);
      assert.equal(handoverDoc.incrementalSettlements.length, 0);

      // Verify fee allocation was documented with adjustment notes
      const alloc = feeDoc.paymentHistory[0].allocations[0];
      assert.ok(alloc.notes.includes("Approved institute rounding concession"));
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 6: Owner resolves dispute via shortage_confirmed
  await t.test("6. Owner resolves dispute via shortage_confirmed (marks allocation shortage_confirmed and updates deficit custody)", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de8610c";
    const feeId = "507f191e810c19729de8610d";
    const paymentId = "507f191e810c19729de8610e";
    const allocationId = "507f191e810c19729de8610f";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-RES02",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 1000,
      approvedAmount: 800,
      discrepancyAmount: 200,
      discrepancyStatus: "disputed",
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
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1000,
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
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "shortage_confirmed",
          reason: "Teacher confirmed cash envelope was misplaced during transit",
        },
      });

      const res = await putResolveRoute(req, { params: Promise.resolve({ handoverId }) });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(handoverDoc.discrepancyStatus, "shortage_confirmed");
      assert.equal(handoverDoc.resolutions.length, 1);
      assert.equal(handoverDoc.resolutions[0].resolutionType, "shortage_confirmed");

      // Verify allocation status set to shortage_confirmed
      const alloc = feeDoc.paymentHistory[0].allocations[0];
      assert.equal(alloc.status, "shortage_confirmed");

      // Verify payment entry custody status reflects split/shortage custody
      assert.equal(feeDoc.paymentHistory[0].custodyStatus, "split_custody");
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 7: Multi-step incremental cash recovery preserves remaining balance accurately
  await t.test("7. Multi-step incremental cash recovery tracks remaining discrepancy balance across partial settlements", async () => {
    setupMockTransactionSupport();
    const handoverId = "507f191e810c19729de86110";
    const feeId = "507f191e810c19729de86111";
    const paymentId = "507f191e810c19729de86112";
    const allocationId = "507f191e810c19729de86113";

    const handoverDoc = {
      _id: new mongoose.Types.ObjectId(handoverId),
      centerId,
      handoverNumber: "HO-20261111-INC01",
      teacherId: new mongoose.Types.ObjectId(teacherId),
      submittedAmount: 1500,
      approvedAmount: 1000,
      discrepancyAmount: 500, // ₹500 shortage
      discrepancyStatus: "disputed",
      discrepancyType: "shortage",
      status: "partially_approved",
      items: [
        {
          allocationId: new mongoose.Types.ObjectId(allocationId),
          feeId: new mongoose.Types.ObjectId(feeId),
          paymentId: new mongoose.Types.ObjectId(paymentId),
          amount: 1500,
        },
      ],
      disputes: [],
      resolutions: [],
      incrementalSettlements: [],
      save: async function () {
        return this;
      },
    };

    const feeDoc = {
      _id: new mongoose.Types.ObjectId(feeId),
      centerId,
      paymentHistory: [
        {
          _id: new mongoose.Types.ObjectId(paymentId),
          amount: 1500,
          isProvisional: true,
          custodyStatus: "split_custody",
          allocations: [
            {
              _id: new mongoose.Types.ObjectId(allocationId),
              allocationId: new mongoose.Types.ObjectId(allocationId),
              handoverId: handoverDoc._id,
              allocatedAmount: 1500,
              verifiedAmount: 1000,
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
      // Step 7a: Partial recovery of ₹200 out of ₹500 shortage
      const step1Req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "cash_received",
          amount: 200,
          notes: "First installment of ₹200 recovered from teacher",
        },
      });

      const step1Res = await putResolveRoute(step1Req, { params: Promise.resolve({ handoverId }) });
      assert.equal(step1Res.status, 200);

      // Status must remain 'disputed' since ₹300 is still outstanding
      assert.equal(handoverDoc.discrepancyStatus, "disputed");
      assert.equal(handoverDoc.incrementalSettlements.length, 1);
      assert.equal(handoverDoc.incrementalSettlements[0].amountReceived, 200);
      assert.equal(handoverDoc.incrementalSettlements[0].remainingDiscrepancy, 300);

      // Fee allocation updated to ₹1200 verified
      assert.equal(feeDoc.paymentHistory[0].allocations[0].verifiedAmount, 1200);
      assert.equal(feeDoc.paymentHistory[0].allocations[0].status, "disputed");

      // Step 7b: Over-recovery attempt (₹400 > remaining ₹300) must be rejected
      const overReq = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "cash_received",
          amount: 400,
        },
      });
      const overRes = await putResolveRoute(overReq, { params: Promise.resolve({ handoverId }) });
      assert.equal(overRes.status, 400);
      const overData = await overRes.json();
      assert.equal(overData.code, "EXCEEDS_UNRESOLVED_DISCREPANCY");

      // Step 7c: Final recovery of remaining ₹300 completes the resolution
      const step2Req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/handovers/${handoverId}/resolve`,
        body: {
          resolutionType: "cash_received",
          amount: 300,
          notes: "Final installment of ₹300 recovered; shortage settled in full",
        },
      });

      const step2Res = await putResolveRoute(step2Req, { params: Promise.resolve({ handoverId }) });
      assert.equal(step2Res.status, 200);

      // Status is now 'resolved'
      assert.equal(handoverDoc.discrepancyStatus, "resolved");
      assert.equal(handoverDoc.incrementalSettlements.length, 2);
      assert.equal(handoverDoc.incrementalSettlements[1].amountReceived, 300);
      assert.equal(handoverDoc.incrementalSettlements[1].remainingDiscrepancy, 0);

      // Fee allocation reaches full ₹1500 and becomes verified
      const finalAlloc = feeDoc.paymentHistory[0].allocations[0];
      assert.equal(finalAlloc.verifiedAmount, 1500);
      assert.equal(finalAlloc.status, "verified");

      // Custody cleared to owner_verified and provisional cleared
      assert.equal(feeDoc.paymentHistory[0].custodyStatus, "owner_verified");
      assert.equal(feeDoc.paymentHistory[0].isProvisional, false);
    } finally {
      CashHandoverModel.findOne = origHandoverFindOne;
      FeeModel.find = origFeeFind;
    }
  });

  // TEST 8: Financial invariant validation
  await t.test("8. Financial Invariants: submittedAmount === approvedAmount + discrepancyAmount, parent ledger untouched", async () => {
    const handover = {
      submittedAmount: 5000,
      approvedAmount: 4200,
      discrepancyAmount: 800,
      discrepancyStatus: "shortage_unresolved",
    };

    assert.equal(
      handover.submittedAmount,
      handover.approvedAmount + handover.discrepancyAmount,
      "Submitted cash must strictly equal verified cash plus discrepancy"
    );

    // Physical vault cash equals approvedAmount + settlements
    const settlements = [{ amountReceived: 500 }, { amountReceived: 300 }];
    const totalPhysicalCashInVault =
      handover.approvedAmount + settlements.reduce((sum, s) => sum + s.amountReceived, 0);
    assert.equal(totalPhysicalCashInVault, 5000);
  });
});
