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
const { GET: getFeeRoute, PUT: putFeeRoute } = await import(
  "../tution-desk-be/src/app/api/fees/[feeId]/route.ts"
);

function createMockRequest({
  method = "POST",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/fees/manual-collection",
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

test("Phase 5.3: Teacher Fee Collection & Payment History UI Backend Integration Suite", async (t) => {
  const centerId = "center_alpha";
  const studentId = "507f191e810c19729de860ea";
  const ownerId = "507f191e810c19729de860f1";
  const teacherId = "507f191e810c19729de860f2";

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

  const mockStudent = {
    _id: studentId,
    centerId,
    name: "Aarav Sharma",
    batch: "Class 10-A",
    assignedTeacherId: teacherId,
    parentWhatsApp: "+919876543210",
    phone: "+919876543210",
    parentPhone: "+919876543210",
    monthlyFee: 2500,
    isActive: true,
  };

  function setupStudentLookup() {
    StudentModel.findById = async (id) =>
      String(id) === String(studentId) ? mockStudent : null;
  }

  // =========================================================================
  // 1. PARTIAL PAYMENT CALCULATION & "Partial Paid" STATUS TRANSITION
  // =========================================================================
  await t.test("1. Teacher partial cash collection updates balance to ₹1,500 and transitions status to 'Partial Paid'", async () => {
    setupStudentLookup();

    const feeId = "507f191e810c19729de86001";
    const pendingFee = {
      _id: feeId,
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      originalAmountDue: 2500,
      feeType: "monthly_recurring",
      notes: "Initial monthly invoice",
      paymentHistory: [],
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    let executedUpdate = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      assert.equal(query._id, feeId);
      assert.equal(query.amountDue, 2500, "Precondition requires exact matching amountDue");
      executedUpdate = update;

      const newHistory = update.$push?.paymentHistory
        ? [...pendingFee.paymentHistory, update.$push.paymentHistory]
        : pendingFee.paymentHistory;

      return {
        ...pendingFee,
        ...update.$set,
        paymentHistory: newHistory,
        populate: async () => ({
          ...pendingFee,
          ...update.$set,
          paymentHistory: newHistory,
          studentId: mockStudent,
        }),
      };
    };

    const req = createMockRequest({
      token: teacherToken,
      headers: {
        "Idempotency-Key": "client_key_part_001",
      },
      body: {
        feeId,
        studentId,
        amount: 1000,
        billingMonth: "2026-11",
        paymentMode: "Cash",
        paymentDate: "2026-11-10",
        notes: "Partial payment installment 1",
        idempotencyKey: "client_key_part_001",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.settledExisting, true);

    // Verify status transition & balance calculation
    assert.equal(executedUpdate.$set.status, "Partial Paid", "Status must transition to 'Partial Paid'");
    assert.equal(executedUpdate.$set.amountDue, 1500, "amountDue must decrement from 2500 to 1500");
    assert.equal(executedUpdate.$set.paidAmount, 1000, "paidAmount must become 1000");

    // Verify paymentHistory entry attributes
    const entry = executedUpdate.$push.paymentHistory;
    assert.ok(entry, "Payment entry must be appended to paymentHistory");
    assert.equal(entry.amount, 1000);
    assert.equal(entry.paymentMode, "Cash");
    assert.equal(entry.isProvisional, true, "Teacher collected cash must be provisional");
    assert.equal(entry.receivedByRole, "teacher");
    assert.equal(String(entry.receivedBy), teacherId);
    assert.ok(entry.receiptNumber.startsWith("RCPT-"));

    // Verify custody breakdown
    assert.equal(json.custodyBreakdown.totalAmount, 1000);
    assert.equal(json.custodyBreakdown.teacherInHandAmount, 1000);
    assert.equal(json.custodyBreakdown.ownerVerifiedAmount, 0);
  });

  // =========================================================================
  // 2. FULL PAYMENT SETTLING REMAINING BALANCE & "Paid" STATUS TRANSITION
  // =========================================================================
  await t.test("2. Teacher collects remaining balance on Partial Paid fee, transitioning to 'Paid' with ₹0 due", async () => {
    setupStudentLookup();

    const feeId = "507f191e810c19729de86002";
    const existingHistoryEntry = {
      _id: "507f191e810c19729de86011",
      paymentId: "507f191e810c19729de86011",
      amount: 1000,
      paymentDate: new Date("2026-11-10"),
      paymentMode: "Cash",
      receiptNumber: "RCPT-PART01",
      isProvisional: true,
      receivedBy: teacherId,
      receivedByRole: "teacher",
      custodyStatus: "teacher_custody",
      allocations: [],
    };

    const partialFee = {
      _id: feeId,
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Partial Paid",
      amountDue: 1500,
      paidAmount: 1000,
      originalAmountDue: 2500,
      feeType: "monthly_recurring",
      paymentHistory: [existingHistoryEntry],
    };

    FeeModel.find = async () => [partialFee];
    FeeModel.findOne = async () => null;

    let executedUpdate = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      assert.equal(query._id, feeId);
      assert.equal(query.amountDue, 1500);
      executedUpdate = update;

      const newHistory = [...partialFee.paymentHistory, update.$push.paymentHistory];

      return {
        ...partialFee,
        ...update.$set,
        paymentHistory: newHistory,
        populate: async () => ({
          ...partialFee,
          ...update.$set,
          paymentHistory: newHistory,
          studentId: mockStudent,
        }),
      };
    };

    const req = createMockRequest({
      token: teacherToken,
      headers: {
        "Idempotency-Key": "client_key_part_002",
      },
      body: {
        feeId,
        studentId,
        amount: 1500,
        billingMonth: "2026-11",
        paymentMode: "Cash",
        paymentDate: "2026-11-11",
        notes: "Settling second half",
        idempotencyKey: "client_key_part_002",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(executedUpdate.$set.status, "Paid", "Status must become 'Paid' when balance reaches 0");
    assert.equal(executedUpdate.$set.amountDue, 0, "amountDue must be 0");
    assert.equal(executedUpdate.$set.paidAmount, 2500, "paidAmount must equal full 2500");

    // Custody breakdown should reflect sum of both payments in provisional teacher custody
    assert.equal(json.custodyBreakdown.totalAmount, 2500);
    assert.equal(json.custodyBreakdown.teacherInHandAmount, 2500);
    assert.equal(json.custodyBreakdown.ownerVerifiedAmount, 0);
  });

  // =========================================================================
  // 3. OWNER DIRECT COLLECTION (OFFICIAL CUSTODY)
  // =========================================================================
  await t.test("3. Owner collects fee directly, marking payment official and cleared to owner custody", async () => {
    setupStudentLookup();

    const feeId = "507f191e810c19729de86003";
    const pendingFee = {
      _id: feeId,
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    let executedUpdate = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      executedUpdate = update;
      const newHistory = [update.$push.paymentHistory];
      return {
        ...pendingFee,
        ...update.$set,
        paymentHistory: newHistory,
        populate: async () => ({
          ...pendingFee,
          ...update.$set,
          paymentHistory: newHistory,
          studentId: mockStudent,
        }),
      };
    };

    const req = createMockRequest({
      token: ownerToken,
      body: {
        feeId,
        studentId,
        amount: 2500,
        billingMonth: "2026-11",
        paymentMode: "UPI",
        notes: "Direct UPI payment received at institute office",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    const entry = executedUpdate.$push.paymentHistory;
    assert.equal(entry.isProvisional, false, "Owner collected payment is not provisional");
    assert.equal(entry.receivedByRole, "owner");
    assert.equal(entry.custodyStatus, "owner_custody");

    assert.equal(json.custodyBreakdown.totalAmount, 2500);
    assert.equal(entry.isProvisional, false, "Owner collected payment is not provisional");
    assert.equal(entry.receivedByRole, "owner");
    assert.equal(entry.custodyStatus, "owner_custody");
  });

  // =========================================================================
  // 4. DUPLICATE SUBMISSION PREVENTION (IDEMPOTENCY KEY)
  // =========================================================================
  await t.test("4. Duplicate submission with existing idempotency key is intercepted and returns settledExisting without double decrement", async () => {
    setupStudentLookup();

    const feeId = "507f191e810c19729de86004";
    const existingKey = "idemp_duplicate_test_123";
    const existingPayment = {
      _id: "507f191e810c19729de86014",
      paymentId: "507f191e810c19729de86014",
      idempotencyKey: existingKey,
      amount: 1500,
      paymentMode: "Cash",
      receiptNumber: "RCPT-IDEMP01",
      isProvisional: true,
      receivedBy: teacherId,
      receivedByRole: "teacher",
    };

    const alreadySettledFee = {
      _id: feeId,
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Partial Paid",
      amountDue: 1000,
      paidAmount: 1500,
      paymentHistory: [existingPayment],
      populate: async () => ({
        _id: feeId,
        centerId,
        studentId: mockStudent,
        billingMonth: "2026-11",
        status: "Partial Paid",
        amountDue: 1000,
        paidAmount: 1500,
        paymentHistory: [existingPayment],
      }),
    };

    // findOne finds the existing idempotency key
    FeeModel.findOne = async (query) => {
      if (query["paymentHistory.idempotencyKey"] === existingKey) {
        return alreadySettledFee;
      }
      return null;
    };

    let updateWasCalled = false;
    FeeModel.findOneAndUpdate = async () => {
      updateWasCalled = true;
      throw new Error("findOneAndUpdate must NOT be invoked on duplicate idempotency key");
    };

    const req = createMockRequest({
      token: teacherToken,
      headers: {
        "Idempotency-Key": existingKey,
      },
      body: {
        feeId,
        studentId,
        amount: 1500,
        billingMonth: "2026-11",
        idempotencyKey: existingKey,
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.settledExisting, true, "Must flag settledExisting: true");
    assert.equal(updateWasCalled, false, "Database update must not be performed on duplicate");
    assert.equal(json.data.amountDue, 1000, "Balance must remain unchanged");
  });

  // =========================================================================
  // 5. FINANCIAL VALIDATION & ERROR HANDLING
  // =========================================================================
  await t.test("5.1. Excessive payment amount returns HTTP 400 EXCESSIVE_PAYMENT_AMOUNT", async () => {
    setupStudentLookup();

    const feeId = "507f191e810c19729de86005";
    const pendingFee = {
      _id: feeId,
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Pending",
      amountDue: 2000,
      paidAmount: 0,
      paymentHistory: [],
    };

    FeeModel.find = async () => [pendingFee];
    FeeModel.findOne = async () => null;

    const req = createMockRequest({
      token: teacherToken,
      body: {
        feeId,
        studentId,
        amount: 3000, // Exceeds 2000 due
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 400);
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "EXCESSIVE_PAYMENT_AMOUNT");
    assert.ok(json.error.includes("exceeds the remaining balance"));
  });

  await t.test("5.2. Invalid amount (zero or negative) returns HTTP 400 error", async () => {
    const invalidAmounts = [0, -500, NaN];

    for (const amt of invalidAmounts) {
      const req = createMockRequest({
        token: teacherToken,
        body: {
          feeId: "507f191e810c19729de86005",
          studentId,
          amount: amt,
          billingMonth: "2026-11",
        },
      });

      const res = await manualCollectionRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.ok(json.error.includes("greater than 0"));
    }
  });

  await t.test("5.3. Cannot collect manual payment when status is Verification Pending (returns HTTP 409 VERIFICATION_PENDING_CONFLICT)", async () => {
    setupStudentLookup();

    const feeId = "507f191e810c19729de86006";
    const reviewFee = {
      _id: feeId,
      centerId,
      studentId,
      billingMonth: "2026-11",
      status: "Verification Pending",
      amountDue: 2500,
      paidAmount: 0,
      utrNumber: "UPI1234567890",
      paymentHistory: [],
    };

    FeeModel.find = async () => [reviewFee];
    FeeModel.findOne = async () => null;

    const req = createMockRequest({
      token: teacherToken,
      body: {
        feeId,
        studentId,
        amount: 2500,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 409, "Must return HTTP 409 Conflict");
    const json = await res.json();

    assert.equal(json.success, false);
    assert.equal(json.code, "VERIFICATION_PENDING_CONFLICT");
    assert.ok(json.error.includes("online payment verification"));
  });

  // =========================================================================
  // 6. RBAC & PERMISSION BOUNDARIES (TEACHER FORBIDDEN DIRECT STATUS UPDATE)
  // =========================================================================
  await t.test("6.1. Teacher is strictly forbidden from directly updating fee status or marking Paid via PUT /api/fees/[feeId]", async () => {
    const feeId = "507f191e810c19729de86007";
    const sampleFee = {
      _id: feeId,
      centerId,
      studentId: mockStudent,
      assignedTeacherId: teacherId,
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      save: async function () {
        return this;
      },
    };

    FeeModel.findOne = () => sampleFee;

    // Teacher tries to mark status: "Paid" directly
    const reqMarkPaid = createMockRequest({
      method: "PUT",
      url: `http://localhost:3000/api/fees/${feeId}`,
      token: teacherToken,
      body: { status: "Paid" },
    });

    const resMarkPaid = await putFeeRoute(reqMarkPaid, {
      params: Promise.resolve({ feeId }),
    });
    assert.equal(resMarkPaid.status, 403, "Teacher must receive HTTP 403 when trying to change status");
    const jsonMarkPaid = await resMarkPaid.json();
    assert.equal(jsonMarkPaid.success, false);
    assert.ok(jsonMarkPaid.error.includes("manual collection API"));
  });

  await t.test("6.2. Owner can approve or update fee status via PUT /api/fees/[feeId]", async () => {
    const feeId = "507f191e810c19729de86008";
    const sampleFee = {
      _id: feeId,
      centerId,
      studentId: mockStudent,
      assignedTeacherId: teacherId,
      status: "Verification Pending",
      amountDue: 2500,
      paidAmount: 0,
      utrNumber: "UPI9876543210",
      save: async function () {
        return this;
      },
      populate: async function () {
        return this;
      },
    };

    FeeModel.findOne = () => sampleFee;

    const reqOwnerApprove = createMockRequest({
      method: "PUT",
      url: `http://localhost:3000/api/fees/${feeId}`,
      token: ownerToken,
      body: { status: "Paid" },
    });

    const resOwnerApprove = await putFeeRoute(reqOwnerApprove, {
      params: Promise.resolve({ feeId }),
    });
    assert.equal(resOwnerApprove.status, 200, "Owner must succeed with HTTP 200");
    const jsonOwnerApprove = await resOwnerApprove.json();
    assert.equal(jsonOwnerApprove.success, true);
    assert.equal(jsonOwnerApprove.data.status, "Paid");
  });

  // =========================================================================
  // 7. FEE DETAIL API & ATTRIBUTION ENRICHMENT
  // =========================================================================
  await t.test("7. GET /api/fees/[feeId] returns complete payment history, custody breakdown, and preserves contact privacy for Teacher", async () => {
    const feeId = "507f191e810c19729de86009";
    const detailedFee = {
      _id: feeId,
      centerId,
      studentId: mockStudent,
      assignedTeacherId: teacherId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Partial Paid",
      amountDue: 1000,
      paidAmount: 1500,
      originalAmountDue: 2500,
      paymentHistory: [
        {
          _id: "507f191e810c19729de86029",
          paymentId: "507f191e810c19729de86029",
          amount: 1500,
          paymentDate: new Date("2026-11-10T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-HIST001",
          isProvisional: true,
          receivedBy: teacherId,
          receivedByRole: "teacher",
          receivedByName: "Teacher Ramanujan",
          custodyStatus: "teacher_custody",
          allocations: [
            {
              allocationId: "507f191e810c19729de86039",
              handoverId: "507f191e810c19729de86049",
              allocatedAmount: 1500,
              status: "pending_verification",
              handoverNumber: "HND-202611-001",
            },
          ],
        },
      ],
      populate: async function () {
        return this;
      },
    };

    FeeModel.findOne = () => ({
      ...detailedFee,
      populate: async () => detailedFee,
    });
    FeeModel.findById = () => ({
      select: () => ({
        lean: async () => null,
      }),
    });

    const reqTeacher = createMockRequest({
      method: "GET",
      url: `http://localhost:3000/api/fees/${feeId}`,
      token: teacherToken,
    });

    const resTeacher = await getFeeRoute(reqTeacher, {
      params: Promise.resolve({ feeId }),
    });
    assert.equal(resTeacher.status, 200);
    const json = await resTeacher.json();

    assert.equal(json.success, true);
    assert.equal(json.data.status, "Partial Paid");
    assert.equal(json.data.amountDue, 1000);
    assert.equal(json.data.paidAmount, 1500);
    assert.equal(json.data.originalAmountDue, 2500);

    // Verify payment history
    assert.equal(json.data.paymentHistory.length, 1);
    const hist = json.data.paymentHistory[0];
    assert.equal(hist.receiptNumber, "RCPT-HIST001");
    assert.equal(hist.amount, 1500);
    assert.equal(hist.receivedByName, "Teacher Ramanujan");
    assert.equal(hist.receivedByRole, "teacher");
    assert.equal(hist.isProvisional, true);
    assert.equal(hist.allocations[0].status, "pending_verification");
    assert.equal(hist.allocations[0].handoverNumber, "HND-202611-001");

    // Verify contact privacy sanitization for Teacher
    const student = json.data.studentId;
    assert.notEqual(student.parentWhatsApp, "+919876543210", "Teacher must not see raw parent WhatsApp");
    assert.ok(student.parentWhatsApp.endsWith("3210"), "Masked phone retains last 4 digits");
    assert.ok(student.parentWhatsApp.startsWith("****"), "Masked phone starts with asterisks");
  });
});
