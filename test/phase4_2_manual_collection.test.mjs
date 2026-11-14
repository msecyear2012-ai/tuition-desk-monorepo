process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const { POST: manualCollectionRoute } = await import(
  "../tution-desk-be/src/app/api/fees/manual-collection/route.ts"
);

function createMockRequest({
  method = "POST",
  token,
  body,
  headers = {},
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
    nextUrl: new URL("http://localhost:3000/api/fees/manual-collection"),
    json: async () => body || {},
  };
}

test("Phase 4.2 Task 1: Manual Collection API & Idempotency Specification Suite", async (t) => {
  const centerId = "center_alpha";
  const studentId = "507f191e810c19729de860ea";
  const ownerId = "507f191e810c19729de860f1";
  const teacherAId = "507f191e810c19729de860f2";
  const teacherBId = "507f191e810c19729de860f3";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director",
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

  const mockStudent = {
    _id: studentId,
    centerId,
    name: "Aarav Sharma",
    batch: "Class 10-A",
    assignedTeacherId: teacherAId,
    parentWhatsApp: "+919876543210",
    monthlyFee: 2500,
    isActive: true,
  };

  // Helper to reset mocks
  function setupStudentLookup() {
    StudentModel.findById = async (id) =>
      String(id) === String(studentId) ? mockStudent : null;
  }

  // =========================================================================
  // 1. SUCCESSFUL FULL COLLECTION (TEACHER PROVISIONAL CASH)
  // =========================================================================
  await t.test("1. Teacher manual collection appends structured IPaymentEntry with provisional cash custody", async () => {
    setupStudentLookup();

    const pendingFee = {
      _id: "fee_pending_001",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      feeType: "monthly_recurring",
      notes: "Monthly recurring fee",
      paymentHistory: [],
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    let executedUpdate = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      assert.equal(query._id, "fee_pending_001");
      assert.equal(query.amountDue, 2500, "Optimistic balance precondition must match amountDue");
      executedUpdate = update;
      return {
        ...pendingFee,
        ...update.$set,
        paymentHistory: update.$push?.paymentHistory
          ? [...pendingFee.paymentHistory, update.$push.paymentHistory]
          : pendingFee.paymentHistory,
        populate: async () => ({
          ...pendingFee,
          ...update.$set,
          paymentHistory: [update.$push.paymentHistory],
          studentId: mockStudent,
        }),
      };
    };

    const req = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 2500,
        billingMonth: "2026-11",
        notes: "Full cash collected at desk",
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.settledExisting, true);
    assert.equal(json.idempotentReplay, false);
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 2500);
    assert.equal(json.data.originalAmountDue, 2500);

    // Verify structured IPaymentEntry
    const pushedEntry = executedUpdate.$push.paymentHistory;
    assert.ok(pushedEntry, "Must push structured payment entry");
    assert.equal(pushedEntry.amount, 2500);
    assert.equal(pushedEntry.paymentMode, "Cash");
    assert.equal(pushedEntry.isProvisional, true, "Teacher cash collection must be provisional");
    assert.equal(pushedEntry.custodyStatus, "teacher_custody");
    assert.equal(String(pushedEntry.receivedBy), teacherAId);
    assert.equal(pushedEntry.receivedByRole, "teacher");
    assert.equal(String(pushedEntry.recordedBy), teacherAId);
    assert.equal(pushedEntry.recordedByRole, "teacher");
    assert.deepEqual(pushedEntry.allocations, []);
  });

  // =========================================================================
  // 2. PARTIAL CASH COLLECTION & BALANCE REDUCTION
  // =========================================================================
  await t.test("2. Partial cash payment decrements amountDue, sets Partial Paid, and preserves originalAmountDue", async () => {
    setupStudentLookup();

    const pendingFee = {
      _id: "fee_pending_002",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    let updatedResult = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      updatedResult = {
        ...pendingFee,
        ...update.$set,
        paymentHistory: [update.$push.paymentHistory],
        populate: async () => ({
          ...pendingFee,
          ...update.$set,
          paymentHistory: [update.$push.paymentHistory],
          studentId: mockStudent,
        }),
      };
      return updatedResult;
    };

    const req = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 1000, // Partial payment
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.status, "Partial Paid");
    assert.equal(json.data.amountDue, 1500, "2500 - 1000 = 1500 remaining");
    assert.equal(json.data.paidAmount, 1000);
    assert.equal(json.data.originalAmountDue, 2500, "originalAmountDue must preserve invoice baseline");
  });

  // =========================================================================
  // 3. EXCESSIVE PAYMENT REJECTION (400 Bad Request)
  // =========================================================================
  await t.test("3. Excessive payment amount (> amountDue) returns HTTP 400 EXCESSIVE_PAYMENT_AMOUNT", async () => {
    setupStudentLookup();

    const partialFee = {
      _id: "fee_partial_003",
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Partial Paid",
      amountDue: 1500,
      paidAmount: 1000,
      feeType: "monthly_recurring",
    };

    FeeModel.find = async () => [partialFee];

    const req = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 1800, // 1800 > 1500 remaining
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 400);
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "EXCESSIVE_PAYMENT_AMOUNT");
    assert.ok(json.error.includes("exceeds the remaining balance of ₹1500"));
  });

  // =========================================================================
  // 4. IDEMPOTENT REQUEST REPLAY (EXACT SAME KEY & PAYLOAD)
  // =========================================================================
  await t.test("4. Duplicate submission with same Idempotency-Key returns cached receipt with idempotentReplay: true", async () => {
    setupStudentLookup();

    const testIdempotencyKey = "7b8b2e1e-28f4-4d89-9a7c-619f7823f001";
    const existingSettledFee = {
      _id: "fee_settled_004",
      centerId,
      studentId: mockStudent,
      billingMonth: "2026-11",
      status: "Partial Paid",
      amountDue: 1500,
      paidAmount: 1000,
      receiptNumber: "RCPT-FIRST1",
      paymentHistory: [
        {
          paymentId: "pay_entry_001",
          amount: 1000,
          receiptNumber: "RCPT-FIRST1",
          idempotencyKey: testIdempotencyKey,
          isProvisional: true,
          custodyStatus: "teacher_custody",
        },
      ],
    };

    // Mock durable lookup finding existing record with idempotencyKey
    FeeModel.findOne = async (query) => {
      if (query["paymentHistory.idempotencyKey"] === testIdempotencyKey) {
        return {
          ...existingSettledFee,
          populate: async () => existingSettledFee,
        };
      }
      return null;
    };

    let findOneAndUpdateCalled = false;
    FeeModel.findOneAndUpdate = async () => {
      findOneAndUpdateCalled = true;
      return null;
    };

    const req = createMockRequest({
      token: teacherAToken,
      headers: {
        "Idempotency-Key": testIdempotencyKey,
      },
      body: {
        studentId,
        amount: 1000,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.idempotentReplay, true, "Must flag idempotentReplay: true");
    assert.equal(json.data.receiptNumber, "RCPT-FIRST1", "Must return original receipt");
    assert.equal(findOneAndUpdateCalled, false, "Must not mutate database on replay");
  });

  // =========================================================================
  // 5. IDEMPOTENCY KEY WITH DIFFERENT PAYLOAD (REJECTION)
  // =========================================================================
  await t.test("5. Same Idempotency-Key with different amount or student returns HTTP 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", async () => {
    setupStudentLookup();

    const testIdempotencyKey = "7b8b2e1e-28f4-4d89-9a7c-619f7823f002";
    const existingSettledFee = {
      _id: "fee_settled_005",
      centerId,
      studentId: mockStudent,
      billingMonth: "2026-11",
      paymentHistory: [
        {
          amount: 1000, // Original was 1000
          receiptNumber: "RCPT-FIRST2",
          idempotencyKey: testIdempotencyKey,
        },
      ],
    };

    FeeModel.findOne = async (query) => {
      if (query["paymentHistory.idempotencyKey"] === testIdempotencyKey) {
        return {
          ...existingSettledFee,
          populate: async () => existingSettledFee,
        };
      }
      return null;
    };

    const req = createMockRequest({
      token: teacherAToken,
      headers: {
        "Idempotency-Key": testIdempotencyKey,
      },
      body: {
        studentId,
        amount: 2000, // DIFFERENT AMOUNT!
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 409);
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.ok(json.error.includes("different payment payload"));
  });

  // =========================================================================
  // 6. CONCURRENT DUPLICATE REQUESTS (IN-FLIGHT GUARD)
  // =========================================================================
  await t.test("6. Concurrent duplicate requests with same Idempotency-Key return HTTP 409 IDEMPOTENCY_IN_FLIGHT", async () => {
    setupStudentLookup();

    const inFlightKey = "7b8b2e1e-28f4-4d89-9a7c-619f7823f003";

    // Simulate FeeModel.find hanging while second request arrives
    let releaseFirst;
    const holdPromise = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    FeeModel.findOne = async () => null;

    FeeModel.find = async () => {
      await holdPromise;
      return [
        {
          _id: "fee_pending_006",
          centerId,
          studentId,
          billingMonth: "2026-11",
          status: "Pending",
          amountDue: 2500,
          paidAmount: 0,
          feeType: "monthly_recurring",
        },
      ];
    };

    FeeModel.findOneAndUpdate = (query, update) => ({
      _id: "fee_pending_006",
      status: "Paid",
      populate: async () => ({
        _id: "fee_pending_006",
        studentId: mockStudent,
      }),
    });

    const req1 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": inFlightKey },
      body: { studentId, amount: 2500, billingMonth: "2026-11" },
    });

    const req2 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": inFlightKey },
      body: { studentId, amount: 2500, billingMonth: "2026-11" },
    });

    // Start first request (holds in in-flight set, paused in FeeModel.find)
    const promise1 = manualCollectionRoute(req1);

    // Yield to allow req1 to add key to in-flight set
    await new Promise((r) => setImmediate(r));

    // Immediately start second request with identical key
    const res2 = await manualCollectionRoute(req2);
    const json2 = await res2.json();

    assert.equal(res2.status, 409);
    assert.equal(json2.code, "IDEMPOTENCY_IN_FLIGHT");
    assert.equal(res2.headers.get("retry-after"), "1");

    // Release first request to complete cleanly
    releaseFirst();
    const res1 = await promise1;
    assert.equal(res1.status, 200);
  });

  // =========================================================================
  // 7. CONCURRENT COLLECTIONS AGAINST THE SAME FEE (RACE GUARD)
  // =========================================================================
  await t.test("7. Concurrent collection race where amountDue changed rejects second write with 409 Conflict", async () => {
    setupStudentLookup();

    const candidateFee = {
      _id: "fee_pending_007",
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      feeType: "monthly_recurring",
    };

    FeeModel.find = async () => [candidateFee];
    FeeModel.findOne = async () => null;

    // Simulate atomic findOneAndUpdate matching 0 documents due to amountDue change
    FeeModel.findOneAndUpdate = async () => null;

    const req = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 1500,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 409);
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "CONCURRENT_MODIFICATION_CONFLICT");
    assert.ok(json.error.includes("already updated or settled by another transaction"));
  });

  // =========================================================================
  // 8. LEGACY FEE COMPATIBILITY (INITIALIZING originalAmountDue NON-DESTRUCTIVELY)
  // =========================================================================
  await t.test("8. Legacy Fee record without paymentHistory or originalAmountDue establishes baseline and preserves paidAmount", async () => {
    setupStudentLookup();

    // Legacy record: missing paymentHistory and originalAmountDue
    const legacyFee = {
      _id: "fee_legacy_008",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Partial Paid",
      amountDue: 1000,
      paidAmount: 1500, // Legacy historical paid amount
      feeType: "monthly_recurring",
      notes: "Legacy partial payment from October",
    };

    FeeModel.find = async () => [legacyFee];
    FeeModel.findOne = async () => null;

    let capturedSet = null;
    let capturedPush = null;

    FeeModel.findOneAndUpdate = async (query, update) => {
      capturedSet = update.$set;
      capturedPush = update.$push;
      return {
        ...legacyFee,
        ...update.$set,
        paymentHistory: [update.$push.paymentHistory],
        populate: async () => ({
          ...legacyFee,
          ...update.$set,
          paymentHistory: [update.$push.paymentHistory],
          studentId: mockStudent,
        }),
      };
    };

    const req = createMockRequest({
      token: ownerToken,
      body: {
        studentId,
        amount: 1000, // Clear remaining 1000
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 2500, "1500 historical + 1000 new = 2500 total");
    assert.equal(
      capturedSet.originalAmountDue,
      2500,
      "originalAmountDue must be calculated as 1000 remaining + 1500 prior = 2500"
    );

    // Verify Owner collection custody stamp
    const entry = capturedPush.paymentHistory;
    assert.equal(entry.isProvisional, false, "Owner collection must NOT be provisional");
    assert.equal(entry.custodyStatus, "owner_custody");
    assert.equal(String(entry.receivedBy), ownerId);
    assert.equal(entry.receivedByRole, "owner");
  });

  // =========================================================================
  // 9. REJECTION OF CORRUPTED LEGACY FINANCIAL RECORDS (HTTP 422)
  // =========================================================================
  await t.test("9. Corrupted legacy fee record (negative amountDue or contradictory status) returns HTTP 422 without silent repair", async () => {
    setupStudentLookup();

    // Corrupted record: Negative balance due
    const corruptedNegativeFee = {
      _id: "fee_corrupted_009",
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Partial Paid",
      amountDue: -500, // CORRUPTED!
      paidAmount: 3000,
      feeType: "monthly_recurring",
    };

    FeeModel.find = async () => [corruptedNegativeFee];

    let updateCalled = false;
    FeeModel.findOneAndUpdate = async () => {
      updateCalled = true;
      return null;
    };

    const req = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 500,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 422);
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "LEGACY_FINANCIAL_INCONSISTENCY");
    assert.equal(json.reconciliationRequired, true);
    assert.equal(updateCalled, false, "Must never execute write on corrupted financial record");
  });

  // =========================================================================
  // 10. ATTRIBUTION TAMPERING REJECTION (HTTP 400 IMMUTABLE_FIELD_TAMPERING)
  // =========================================================================
  await t.test("10. Request attempting to forge receivedBy or paymentHistory is rejected with HTTP 400 IMMUTABLE_FIELD_TAMPERING", async () => {
    setupStudentLookup();

    const reqWithForgery = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 1000,
        billingMonth: "2026-11",
        receivedBy: ownerId, // Forgery attempt!
        receivedByRole: "owner",
      },
    });

    const res = await manualCollectionRoute(reqWithForgery);
    assert.equal(res.status, 400);
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "IMMUTABLE_FIELD_TAMPERING");
    assert.ok(json.error.includes("strictly forbidden"));
  });

  // =========================================================================
  // 11. EXISTING FRONTEND RESPONSE COMPATIBILITY
  // =========================================================================
  await t.test("11. Response envelope preserves exact contract expected by AddFeeModal and StudentProfile", async () => {
    setupStudentLookup();

    const pendingFee = {
      _id: "fee_frontend_011",
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Pending",
      amountDue: 2000,
      paidAmount: 0,
      feeType: "monthly_recurring",
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    FeeModel.findOneAndUpdate = (query, update) => ({
      populate: async () => ({
        _id: "fee_frontend_011",
        receiptNumber: update.$set.receiptNumber,
        amountDue: update.$set.amountDue,
        paidAmount: update.$set.paidAmount,
        status: update.$set.status,
        studentId: mockStudent,
        paymentHistory: [update.$push.paymentHistory],
      }),
    });

    const req = createMockRequest({
      token: teacherAToken,
      body: {
        studentId,
        amount: 2000,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    // Verify top-level properties expected by frontend components:
    assert.equal(typeof json.success, "boolean");
    assert.equal(typeof json.message, "string");
    assert.ok(json.data);
    assert.equal(json.data._id, "fee_frontend_011");
    assert.ok(json.data.receiptNumber.startsWith("RCPT-"));
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 2000);
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.studentId.name, "Aarav Sharma");
  });

  // =========================================================================
  // 12. CROSS-TEACHER COLLECTIONS AGAINST SAME FEE (SEPARATE LINE ITEMS)
  // =========================================================================
  await t.test("12. Multiple partial collections by different teachers record independent line-item attribution", async () => {
    setupStudentLookup();

    // Fee already has payment 1 by Teacher Sharma
    const payment1 = {
      paymentId: "pay_sharma_001",
      amount: 1000,
      receiptNumber: "RCPT-SHARMA",
      receivedBy: teacherAId,
      receivedByRole: "teacher",
      recordedBy: teacherAId,
      recordedByRole: "teacher",
      isProvisional: true,
      custodyStatus: "teacher_custody",
      allocations: [],
    };

    const feeWithPayment1 = {
      _id: "fee_multi_teacher_012",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Partial Paid",
      originalAmountDue: 2500,
      amountDue: 1500,
      paidAmount: 1000,
      receiptNumber: "RCPT-SHARMA",
      feeType: "monthly_recurring",
      paymentHistory: [payment1],
    };

    FeeModel.find = async () => [feeWithPayment1];
    FeeModel.findOne = async () => null;

    let executedUpdate = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      executedUpdate = update;
      const payment2 = update.$push.paymentHistory;
      return {
        ...feeWithPayment1,
        ...update.$set,
        paymentHistory: [payment1, payment2],
        populate: async () => ({
          ...feeWithPayment1,
          ...update.$set,
          paymentHistory: [payment1, payment2],
          studentId: mockStudent,
        }),
      };
    };

    // Teacher Verma collects the remaining 1500
    const req = createMockRequest({
      token: teacherBToken,
      body: {
        studentId,
        amount: 1500,
        billingMonth: "2026-11",
        notes: "Second installment collected by Teacher Verma",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 2500);

    // Verify payment 2 attribution in $push
    const payment2Pushed = executedUpdate.$push.paymentHistory;
    assert.equal(payment2Pushed.amount, 1500);
    assert.equal(String(payment2Pushed.receivedBy), teacherBId, "Must attribute Teacher Verma");
    assert.equal(payment2Pushed.receivedByRole, "teacher");
    assert.equal(String(payment2Pushed.recordedBy), teacherBId);
    assert.equal(payment2Pushed.isProvisional, true);
    assert.notEqual(payment2Pushed.receiptNumber, "RCPT-SHARMA", "Must issue new receipt for second payment");
  });

  // =========================================================================
  // 13. STATIC SCHEMA DECLARATION, HYDRATION & SERIALIZATION
  // =========================================================================
  await t.test("13. Static schema declaration, direct dot-property access, hydration and serialization", async () => {
    const { PaymentEntrySchema } = await import("../tution-desk-be/src/models/Fee.ts");
    assert.ok(PaymentEntrySchema.path("idempotencyKey"), "PaymentEntrySchema must statically declare idempotencyKey");
    assert.equal(PaymentEntrySchema.path("idempotencyKey").instance, "String");

    const testEntry = {
      paymentId: "pay_entry_static_001",
      amount: 1200,
      paymentDate: new Date(),
      paymentMode: "Cash",
      receiptNumber: "RCPT-STATIC1",
      idempotencyKey: "key-static-direct-001",
      receivedBy: ownerId,
      receivedByRole: "owner",
      recordedBy: ownerId,
      recordedByRole: "owner",
    };

    const doc = new FeeModel({
      centerId,
      studentId,
      amountDue: 1200,
      month: "November 2026",
      title: "Static Schema Test",
      status: "Paid",
      receiptNumber: "RCPT-STATIC1",
      paymentHistory: [testEntry],
    });

    // Native dot-property access must NOT be undefined
    assert.equal(
      doc.paymentHistory[0].idempotencyKey,
      "key-static-direct-001",
      "Direct dot-property access must succeed on subdocument"
    );

    // Serialization to plain object
    const plainObj = doc.toObject();
    assert.equal(plainObj.paymentHistory[0].idempotencyKey, "key-static-direct-001");

    // JSON stringify
    const jsonParsed = JSON.parse(JSON.stringify(doc));
    assert.equal(jsonParsed.paymentHistory[0].idempotencyKey, "key-static-direct-001");

    // Hydration from raw data
    const rawBson = {
      _id: "fee_hydrated_013",
      centerId,
      studentId,
      amountDue: 1200,
      month: "November 2026",
      title: "Hydration Test",
      status: "Paid",
      receiptNumber: "RCPT-HYD1",
      paymentHistory: [
        {
          _id: "pay_sub_013",
          amount: 1200,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "RCPT-HYD1",
          idempotencyKey: "key-hydrated-002",
          receivedBy: ownerId,
          receivedByRole: "owner",
          recordedBy: ownerId,
          recordedByRole: "owner",
        },
      ],
    };

    const hydratedDoc = FeeModel.hydrate(rawBson);
    assert.equal(
      hydratedDoc.paymentHistory[0].idempotencyKey,
      "key-hydrated-002",
      "Hydrated document must support direct dot-property access"
    );
  });

  // =========================================================================
  // 14. CROSS-FEE KEY REUSE REJECTION (DIFFERENT BILLING MONTH)
  // =========================================================================
  await t.test("14. Same key + different billing month (Nov ₹2500 vs Dec ₹2500) returns HTTP 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", async () => {
    setupStudentLookup();

    const crossMonthKey = "key-cross-month-collision-014";

    // Fee from prior billing month (November 2026)
    const novFee = {
      _id: "fee_nov_014",
      centerId,
      studentId: mockStudent,
      billingMonth: "2026-11",
      month: "November 2026",
      feeType: "monthly_recurring",
      amountDue: 0,
      paidAmount: 2500,
      receiptNumber: "RCPT-NOV26",
      paymentHistory: [
        {
          paymentId: "pay_nov_014",
          amount: 2500,
          receiptNumber: "RCPT-NOV26",
          idempotencyKey: crossMonthKey,
          paymentMode: "Cash",
        },
      ],
    };

    FeeModel.findOne = async (query) => {
      if (query["paymentHistory.idempotencyKey"] === crossMonthKey) {
        return {
          ...novFee,
          populate: async () => novFee,
        };
      }
      return null;
    };

    // Client attempts to collect December 2026 with same key and same amount (2500)
    const req = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": crossMonthKey },
      body: {
        studentId,
        amount: 2500,
        billingMonth: "2026-12", // DECEMBER instead of NOVEMBER!
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 409, "Must return HTTP 409 Conflict for month mismatch");
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.ok(
      json.error.includes("billingMonth mismatch") || json.error.includes("payload parameter mismatch"),
      `Expected error to cite billingMonth mismatch: ${json.error}`
    );
  });

  // =========================================================================
  // 15. MATERIAL PAYLOAD FIELD MISMATCHES (PAYMENT MODE, FEE TYPE, UTR)
  // =========================================================================
  await t.test("15. Same key with changed payment mode, fee type, or UTR returns HTTP 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", async () => {
    setupStudentLookup();

    const testKey = "key-material-mismatch-015";
    const existingCashFee = {
      _id: "fee_cash_015",
      centerId,
      studentId: mockStudent,
      billingMonth: "2026-11",
      feeType: "monthly_recurring",
      amountDue: 0,
      paidAmount: 2000,
      receiptNumber: "RCPT-CASH15",
      utrNumber: "",
      paymentHistory: [
        {
          paymentId: "pay_cash_015",
          amount: 2000,
          receiptNumber: "RCPT-CASH15",
          idempotencyKey: testKey,
          paymentMode: "Cash",
        },
      ],
    };

    FeeModel.findOne = async (query) => {
      if (query["paymentHistory.idempotencyKey"] === testKey) {
        return {
          ...existingCashFee,
          populate: async () => existingCashFee,
        };
      }
      return null;
    };

    // Attempt 1: Changed payment mode (UPI instead of Cash)
    const reqModeMismatch = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": testKey },
      body: {
        studentId,
        amount: 2000,
        billingMonth: "2026-11",
        paymentMode: "UPI", // Changed from Cash!
      },
    });

    const resMode = await manualCollectionRoute(reqModeMismatch);
    assert.equal(resMode.status, 409);
    const jsonMode = await resMode.json();
    assert.equal(jsonMode.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.ok(jsonMode.error.includes("paymentMode mismatch"));

    // Attempt 2: Changed fee type (advance instead of monthly_recurring)
    const reqTypeMismatch = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": testKey },
      body: {
        studentId,
        amount: 2000,
        feeType: "advance", // Changed from monthly_recurring!
      },
    });

    const resType = await manualCollectionRoute(reqTypeMismatch);
    assert.equal(resType.status, 409);
    const jsonType = await resType.json();
    assert.equal(jsonType.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.ok(jsonType.error.includes("feeType mismatch"));

    // Attempt 3: Changed UTR (providing a UTR where original had none)
    const reqUtrMismatch = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": testKey },
      body: {
        studentId,
        amount: 2000,
        billingMonth: "2026-11",
        paymentMode: "Cash",
        utrNumber: "UPI-REF-99999", // Different UTR!
      },
    });

    const resUtr = await manualCollectionRoute(reqUtrMismatch);
    assert.equal(resUtr.status, 409);
    const jsonUtr = await resUtr.json();
    assert.equal(jsonUtr.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.ok(jsonUtr.error.includes("UTR"));
  });

  // =========================================================================
  // 16. CROSS-CENTER ISOLATION
  // =========================================================================
  await t.test("16. Cross-center isolation: Same idempotency key used in Center Alpha does NOT block Center Beta", async () => {
    const centerBetaId = "center_beta";
    const studentBetaId = "507f191e810c19729de860eb";

    const teacherBetaToken = await signToken({
      userId: teacherBId,
      teacherId: teacherBId,
      centerId: centerBetaId,
      role: "teacher",
      name: "Teacher Verma Beta",
    });

    const mockStudentBeta = {
      _id: studentBetaId,
      centerId: centerBetaId,
      name: "Rohan Verma",
      batch: "Class 12-B",
      monthlyFee: 3000,
      isActive: true,
    };

    StudentModel.findById = async (id) =>
      String(id) === studentBetaId ? mockStudentBeta : null;

    const sharedKey = "shared-uuid-across-centers-016";

    // Center Alpha has an existing fee with this key, but Center Beta has NONE
    FeeModel.findOne = async (query) => {
      if (query.centerId === "center_alpha" && query["paymentHistory.idempotencyKey"] === sharedKey) {
        return {
          _id: "fee_alpha_016",
          centerId: "center_alpha",
          studentId: mockStudent,
          amountDue: 0,
          paidAmount: 2500,
          receiptNumber: "RCPT-ALPHA16",
          paymentHistory: [{ idempotencyKey: sharedKey, amount: 2500 }],
        };
      }
      // For Center Beta, key does NOT exist
      return null;
    };

    // Center Beta pending fee
    const betaFee = {
      _id: "fee_beta_016",
      centerId: centerBetaId,
      studentId: studentBetaId,
      billingMonth: "2026-11",
      status: "Pending",
      amountDue: 3000,
      paidAmount: 0,
      feeType: "monthly_recurring",
    };

    FeeModel.find = async (q) => (q.centerId === centerBetaId ? [betaFee] : []);

    let executedCenterId = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      executedCenterId = query.centerId;
      return {
        ...betaFee,
        ...update.$set,
        paymentHistory: [update.$push.paymentHistory],
        populate: async () => ({
          ...betaFee,
          ...update.$set,
          paymentHistory: [update.$push.paymentHistory],
          studentId: mockStudentBeta,
        }),
      };
    };

    // Center Beta submits payment with the same sharedKey
    const req = createMockRequest({
      token: teacherBetaToken,
      headers: { "Idempotency-Key": sharedKey },
      body: {
        studentId: studentBetaId,
        amount: 3000,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200, "Center Beta must not be blocked by Center Alpha");
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.idempotentReplay, false, "Must be a NEW payment, not an idempotent replay from Alpha");
    assert.equal(executedCenterId, centerBetaId, "Query must strictly isolate to Center Beta");
  });

  // =========================================================================
  // 17. CONCURRENT DUPLICATE CREATION ACROSS SIMULATED INDEPENDENT PROCESSES (BRANCH A)
  // =========================================================================
  await t.test("17. Branch A concurrent creation race: Process 2 catches E11000 duplicate key and safely replays Process 1 fee", async () => {
    setupStudentLookup();

    const advanceKey = "key-concurrent-process-advance-017";
    let process1InsertedFee = null;

    // Simulate FeeModel.create behavior across two independent processes
    let callCount = 0;
    FeeModel.create = async (docData) => {
      callCount++;
      if (callCount === 1) {
        // Process 1 succeeds and creates the document in MongoDB
        process1InsertedFee = {
          _id: "fee_advance_proc1_017",
          ...docData,
          receiptNumber: "RCPT-PROC1-ADV",
          paymentHistory: [
            {
              ...docData.paymentHistory[0],
              receiptNumber: "RCPT-PROC1-ADV",
            },
          ],
        };
        return process1InsertedFee;
      }
      // Process 2 races concurrently; MongoDB throws duplicate key error E11000
      const err = new Error("E11000 duplicate key error collection: fees index: paymentHistory.idempotencyKey");
      err.code = 11000;
      throw err;
    };

    FeeModel.findById = () => ({
      populate: async () => ({
        ...process1InsertedFee,
        studentId: mockStudent,
      }),
    });

    FeeModel.findOne = (query) => {
      if (query["paymentHistory.idempotencyKey"] === advanceKey && process1InsertedFee) {
        return {
          ...process1InsertedFee,
          populate: async () => ({
            ...process1InsertedFee,
            studentId: mockStudent,
          }),
        };
      }
      return null;
    };

    // Process 1 executes advance collection
    const req1 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": advanceKey },
      body: {
        studentId,
        amount: 5000,
        feeType: "advance",
        notes: "Advance semester fee",
      },
    });

    const res1 = await manualCollectionRoute(req1);
    assert.equal(res1.status, 201);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.idempotentReplay, false);
    assert.equal(json1.data.receiptNumber, "RCPT-PROC1-ADV");

    // Process 2 (simulating independent container instance) runs with identical key
    const req2 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": advanceKey },
      body: {
        studentId,
        amount: 5000,
        feeType: "advance",
        notes: "Advance semester fee",
      },
    });

    const res2 = await manualCollectionRoute(req2);
    assert.equal(res2.status, 200, "Process 2 must handle E11000 and return HTTP 200 replay");
    const json2 = await res2.json();

    assert.equal(json2.success, true);
    assert.equal(json2.idempotentReplay, true, "Must be an idempotent replay");
    assert.equal(json2.data.receiptNumber, "RCPT-PROC1-ADV", "Must return Process 1's receipt");
  });

  // =========================================================================
  // 18. CONCURRENT DUPLICATE CREATION IN FALLBACK (NEW MONTHLY RECURRING FEE)
  // =========================================================================
  await t.test("18. Fallback concurrent creation race: Process 2 catches E11000 and safely replays Process 1 fee", async () => {
    setupStudentLookup();

    const fallbackKey = "key-concurrent-fallback-018";
    let process1FallbackFee = null;

    FeeModel.find = async () => []; // No candidate fee exists -> triggers fallback

    let callCount = 0;
    FeeModel.create = async (docData) => {
      callCount++;
      if (callCount === 1) {
        process1FallbackFee = {
          _id: "fee_fallback_proc1_018",
          ...docData,
          receiptNumber: "RCPT-FALLBACK-PROC1",
          paymentHistory: [
            {
              ...docData.paymentHistory[0],
              receiptNumber: "RCPT-FALLBACK-PROC1",
            },
          ],
        };
        return process1FallbackFee;
      }
      const err = new Error("E11000 duplicate key error collection: fees index: paymentHistory.idempotencyKey");
      err.code = 11000;
      throw err;
    };

    FeeModel.findById = () => ({
      populate: async () => ({
        ...process1FallbackFee,
        studentId: mockStudent,
      }),
    });

    FeeModel.findOne = (query) => {
      if (query["paymentHistory.idempotencyKey"] === fallbackKey && process1FallbackFee) {
        return {
          ...process1FallbackFee,
          populate: async () => ({
            ...process1FallbackFee,
            studentId: mockStudent,
          }),
        };
      }
      return null;
    };

    const req1 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": fallbackKey },
      body: {
        studentId,
        amount: 2500,
        billingMonth: "2026-11",
      },
    });

    const res1 = await manualCollectionRoute(req1);
    assert.equal(res1.status, 201);
    const json1 = await res1.json();
    assert.equal(json1.data.receiptNumber, "RCPT-FALLBACK-PROC1");

    const req2 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": fallbackKey },
      body: {
        studentId,
        amount: 2500,
        billingMonth: "2026-11",
      },
    });

    const res2 = await manualCollectionRoute(req2);
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.idempotentReplay, true);
    assert.equal(json2.data.receiptNumber, "RCPT-FALLBACK-PROC1");
  });

  // =========================================================================
  // 19. LEGITIMATE REPEATED PAYMENTS ARE NOT SUPPRESSED
  // =========================================================================
  await t.test("19. Legitimate repeated payment (without key or with unique new key) is not suppressed", async () => {
    setupStudentLookup();

    // Partial fee with balance remaining
    const partialFee = {
      _id: "fee_partial_019",
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Partial Paid",
      amountDue: 1500,
      paidAmount: 1000,
      feeType: "monthly_recurring",
    };

    FeeModel.find = async () => [partialFee];
    FeeModel.findOne = async () => null; // No key match

    let updateCount = 0;
    FeeModel.findOneAndUpdate = async (query, update) => {
      updateCount++;
      return {
        ...partialFee,
        ...update.$set,
        paymentHistory: [update.$push.paymentHistory],
        populate: async () => ({
          ...partialFee,
          ...update.$set,
          paymentHistory: [update.$push.paymentHistory],
          studentId: mockStudent,
        }),
      };
    };

    // First payment: ₹500 with unique key A
    const req1 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": "unique-payment-part-1-019" },
      body: { studentId, amount: 500, billingMonth: "2026-11" },
    });
    const res1 = await manualCollectionRoute(req1);
    assert.equal(res1.status, 200);
    assert.equal(updateCount, 1);

    // Second payment: ₹500 with unique key B
    const req2 = createMockRequest({
      token: teacherAToken,
      headers: { "Idempotency-Key": "unique-payment-part-2-019" },
      body: { studentId, amount: 500, billingMonth: "2026-11" },
    });
    const res2 = await manualCollectionRoute(req2);
    assert.equal(res2.status, 200);
    assert.equal(updateCount, 2, "Second legitimate payment must NOT be suppressed");
  });

  // =========================================================================
  // 20. LEGACY FEE HYDRATION WITHOUT IDEMPOTENCY KEY
  // =========================================================================
  await t.test("20. Legacy Fee hydration without idempotencyKey preserves backward compatibility", async () => {
    const legacyRaw = {
      _id: "fee_legacy_raw_020",
      centerId,
      studentId,
      amountDue: 1000,
      paidAmount: 1500,
      month: "November 2026",
      title: "Historical Fee",
      status: "Partial Paid",
      receiptNumber: "RCPT-LEG-020",
      paymentHistory: [
        {
          _id: "pay_legacy_020",
          amount: 1500,
          paymentDate: new Date("2026-10-15"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-LEG-020",
          receivedBy: teacherAId,
          receivedByRole: "teacher",
          recordedBy: teacherAId,
          recordedByRole: "teacher",
          // Note: idempotencyKey is completely absent in legacy data
        },
      ],
    };

    const hydrated = FeeModel.hydrate(legacyRaw);
    assert.equal(hydrated.paymentHistory[0].idempotencyKey, null, "Legacy subdocument should hydrate with idempotencyKey as null");
    assert.equal(hydrated.paymentHistory[0].amount, 1500);
    assert.equal(hydrated.paymentHistory[0].receiptNumber, "RCPT-LEG-020");

    // Serialization check
    const obj = hydrated.toObject();
    assert.equal(obj.paymentHistory[0].idempotencyKey, null);
  });
});
