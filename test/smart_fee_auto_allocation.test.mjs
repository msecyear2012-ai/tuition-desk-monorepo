process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://localhost:27017/test";

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

global.mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };

// Import models & auth
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;

// Import route handler
const { POST: manualCollectionRoute } = await import(
  "../tution-desk-be/src/app/api/fees/manual-collection/route.ts"
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
  reqHeaders.set("content-type", "application/json");

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

test("Smart Fee Auto-Allocation Suite (Phase 3)", async (t) => {
  const centerId = "center_auto_alloc";
  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";
  const studentId = "507f191e810c19729de86011";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Director",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    centerId,
    role: "teacher",
    teacherId: teacherId,
    name: "Teacher Raman",
  });

  // Base mock student
  let mockStudent = {
    _id: new mongoose.Types.ObjectId(studentId),
    centerId,
    name: "Aarav Sharma",
    batch: "Grade 10 Science",
    assignedTeacherId: new mongoose.Types.ObjectId(teacherId),
    monthlyFee: 1000,
    dueDay: 10,
    advanceBalance: 0,
    isActive: true,
  };

  const setupMocks = (initialStudent = mockStudent) => {
    mockStudent = { ...initialStudent, advanceBalance: 0 };
    StudentModel.findById = async (id) => {
      if (String(id) === studentId) return mockStudent;
      return null;
    };
    StudentModel.findOneAndUpdate = async (filter, update) => {
      if (update.$inc && typeof update.$inc.advanceBalance === "number") {
        mockStudent.advanceBalance = (mockStudent.advanceBalance || 0) + update.$inc.advanceBalance;
      }
      return mockStudent;
    };
    StudentModel.findOne = async () => mockStudent;
  };

  // =========================================================================
  // Test 1: Exact payment matching due
  // =========================================================================
  await t.test("1. Exact payment matching due clears invoice cleanly with 0 advance", async () => {
    setupMocks();

    const fee1Id = new mongoose.Types.ObjectId("507f191e810c19729de860a1");
    let fee1 = {
      _id: fee1Id,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 1000,
      paidAmount: 0,
      originalAmountDue: 1000,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    FeeModel.find = async (query) => {
      if (query.billingMonth === "2026-11" || query.$or) return [fee1];
      if (query.status) return [fee1];
      return [];
    };
    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(fee1Id)) return fee1;
      return null;
    };
    FeeModel.findOneAndUpdate = async (query, update) => {
      fee1 = {
        ...fee1,
        ...update.$set,
        paymentHistory: [...fee1.paymentHistory, update.$push.paymentHistory],
      };
      return {
        ...fee1,
        populate: async () => ({ ...fee1, studentId: mockStudent }),
      };
    };

    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 1000,
        billingMonth: "2026-11",
        feeId: String(fee1Id),
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.equal(json.settledExisting, true);
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 1000);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 1000);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1000);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 0);
    assert.deepEqual(json.allocationBreakdown.clearedFeeIds, [String(fee1Id)]);
    assert.equal(json.allocationBreakdown.summaryText, "₹1,000 due cleared");
    assert.equal(mockStudent.advanceBalance, 0);
  });

  // =========================================================================
  // Test 2: Partial payment on pending due
  // =========================================================================
  await t.test("2. Partial payment updates remaining due to Partial Paid without advance", async () => {
    setupMocks();

    const fee1Id = new mongoose.Types.ObjectId("507f191e810c19729de860a2");
    let fee1 = {
      _id: fee1Id,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 1000,
      paidAmount: 0,
      originalAmountDue: 1000,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    FeeModel.find = async () => [fee1];
    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(fee1Id)) return fee1;
      return null;
    };
    FeeModel.findOneAndUpdate = async (query, update) => {
      fee1 = {
        ...fee1,
        ...update.$set,
        paymentHistory: [...fee1.paymentHistory, update.$push.paymentHistory],
      };
      return {
        ...fee1,
        populate: async () => ({ ...fee1, studentId: mockStudent }),
      };
    };

    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 500,
        billingMonth: "2026-11",
        feeId: String(fee1Id),
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.equal(json.data.status, "Partial Paid");
    assert.equal(json.data.amountDue, 500);
    assert.equal(json.data.paidAmount, 500);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 500);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 500);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 0);
    assert.deepEqual(json.allocationBreakdown.clearedFeeIds, []);
    assert.equal(json.allocationBreakdown.summaryText, "₹500 applied to pending dues");
    assert.equal(mockStudent.advanceBalance, 0);
  });

  // =========================================================================
  // Test 3: Overpayment auto-clearing dues + crediting surplus to advanceBalance
  // =========================================================================
  await t.test("3. Overpayment clears candidate due and auto-saves surplus to advanceBalance", async () => {
    setupMocks();

    const fee1Id = new mongoose.Types.ObjectId("507f191e810c19729de860a3");
    let fee1 = {
      _id: fee1Id,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 1000,
      paidAmount: 0,
      originalAmountDue: 1000,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    let advanceFeeCreated = null;

    FeeModel.find = async (query) => {
      if (query._id && query._id.$ne) return [];
      return [fee1];
    };
    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(fee1Id)) return fee1;
      if (advanceFeeCreated && query._id && String(query._id) === String(advanceFeeCreated._id)) {
        return advanceFeeCreated;
      }
      return null;
    };
    FeeModel.findOneAndUpdate = async (query, update) => {
      fee1 = {
        ...fee1,
        ...update.$set,
        paymentHistory: [...fee1.paymentHistory, update.$push.paymentHistory],
      };
      return {
        ...fee1,
        populate: async () => ({ ...fee1, studentId: mockStudent }),
      };
    };
    FeeModel.create = async (doc) => {
      advanceFeeCreated = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de860aa"),
        ...doc,
      };
      return advanceFeeCreated;
    };
    FeeModel.updateOne = async () => ({ modifiedCount: 1 });

    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 1500, // ₹1,000 due + ₹500 surplus
        billingMonth: "2026-11",
        feeId: String(fee1Id),
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 1000);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 1500);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1000);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 500);
    assert.deepEqual(json.allocationBreakdown.clearedFeeIds, [String(fee1Id)]);
    assert.equal(
      json.allocationBreakdown.summaryText,
      "₹1,000 due cleared, ₹500 saved as advance"
    );

    // Verify surplus was credited to student's advanceBalance
    assert.equal(mockStudent.advanceBalance, 500);
    assert.ok(advanceFeeCreated);
    assert.equal(advanceFeeCreated.feeType, "advance");
    assert.equal(advanceFeeCreated.isAdvance, true);
    assert.equal(advanceFeeCreated.paidAmount, 500);
  });

  // =========================================================================
  // Test 4: Multiple pending fees cleared FIFO
  // =========================================================================
  await t.test("4. Multiple pending fees are cleared sequentially oldest-first (FIFO)", async () => {
    setupMocks();

    const feeJanId = new mongoose.Types.ObjectId("507f191e810c19729de860b1");
    const feeFebId = new mongoose.Types.ObjectId("507f191e810c19729de860b2");

    let feeJan = {
      _id: feeJanId,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-01",
      month: "January 2026",
      dueDate: new Date("2026-01-10"),
      status: "Pending",
      amountDue: 500,
      paidAmount: 0,
      originalAmountDue: 500,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    let feeFeb = {
      _id: feeFebId,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-02",
      month: "February 2026",
      dueDate: new Date("2026-02-10"),
      status: "Pending",
      amountDue: 1000,
      paidAmount: 0,
      originalAmountDue: 1000,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    FeeModel.find = async (query) => {
      if (query._id && query._id.$ne) {
        return [feeFeb];
      }
      return [feeJan];
    };
    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(feeJanId)) return feeJan;
      if (query._id && String(query._id) === String(feeFebId)) return feeFeb;
      return null;
    };
    FeeModel.findOneAndUpdate = async (query, update) => {
      if (String(query._id) === String(feeJanId)) {
        feeJan = {
          ...feeJan,
          ...update.$set,
          paymentHistory: [...feeJan.paymentHistory, update.$push.paymentHistory],
        };
        return {
          ...feeJan,
          populate: async () => ({ ...feeJan, studentId: mockStudent }),
        };
      }
      if (String(query._id) === String(feeFebId)) {
        feeFeb = {
          ...feeFeb,
          ...update.$set,
          paymentHistory: [...feeFeb.paymentHistory, update.$push.paymentHistory],
        };
        return {
          ...feeFeb,
          populate: async () => ({ ...feeFeb, studentId: mockStudent }),
        };
      }
      return null;
    };

    // User pays ₹1,200: covers ₹500 on Jan (cleared), and ₹700 on Feb (partial, leaving ₹300)
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 1200,
        billingMonth: "2026-01",
        feeId: String(feeJanId),
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.equal(feeJan.status, "Paid");
    assert.equal(feeJan.amountDue, 0);
    assert.equal(feeFeb.status, "Partial Paid");
    assert.equal(feeFeb.amountDue, 300);
    assert.equal(feeFeb.paidAmount, 700);

    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 1200);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1200);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 0);
    assert.deepEqual(json.allocationBreakdown.clearedFeeIds, [String(feeJanId)]);
    assert.equal(json.allocationBreakdown.summaryText, "₹1,200 due cleared");
    assert.equal(mockStudent.advanceBalance, 0);
  });

  // =========================================================================
  // Test 5: Multiple pending fees cleared FIFO + surplus saved as advance
  // =========================================================================
  await t.test("5. Payment exceeding all pending dues clears all FIFO and saves leftover as advance", async () => {
    setupMocks();

    const feeJanId = new mongoose.Types.ObjectId("507f191e810c19729de860c1");
    const feeFebId = new mongoose.Types.ObjectId("507f191e810c19729de860c2");

    let feeJan = {
      _id: feeJanId,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-01",
      month: "January 2026",
      status: "Pending",
      amountDue: 500,
      paidAmount: 0,
      originalAmountDue: 500,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    let feeFeb = {
      _id: feeFebId,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-02",
      month: "February 2026",
      status: "Pending",
      amountDue: 1000,
      paidAmount: 0,
      originalAmountDue: 1000,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    let advanceFeeCreated = null;

    FeeModel.find = async (query) => {
      if (query._id && query._id.$ne) {
        return [feeFeb];
      }
      return [feeJan];
    };
    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(feeJanId)) return feeJan;
      if (query._id && String(query._id) === String(feeFebId)) return feeFeb;
      if (advanceFeeCreated && query._id && String(query._id) === String(advanceFeeCreated._id)) {
        return advanceFeeCreated;
      }
      return null;
    };
    FeeModel.findOneAndUpdate = async (query, update) => {
      if (String(query._id) === String(feeJanId)) {
        feeJan = {
          ...feeJan,
          ...update.$set,
          paymentHistory: [...feeJan.paymentHistory, update.$push.paymentHistory],
        };
        return {
          ...feeJan,
          populate: async () => ({ ...feeJan, studentId: mockStudent }),
        };
      }
      if (String(query._id) === String(feeFebId)) {
        feeFeb = {
          ...feeFeb,
          ...update.$set,
          paymentHistory: [...feeFeb.paymentHistory, update.$push.paymentHistory],
        };
        return {
          ...feeFeb,
          populate: async () => ({ ...feeFeb, studentId: mockStudent }),
        };
      }
      return null;
    };
    FeeModel.create = async (doc) => {
      advanceFeeCreated = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de860cc"),
        ...doc,
      };
      return advanceFeeCreated;
    };
    FeeModel.updateOne = async () => ({ modifiedCount: 1 });

    // User pays ₹2,000: clears Jan (₹500), clears Feb (₹1000), surplus ₹500 saved as advance
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 2000,
        billingMonth: "2026-01",
        feeId: String(feeJanId),
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.equal(feeJan.status, "Paid");
    assert.equal(feeJan.amountDue, 0);
    assert.equal(feeFeb.status, "Paid");
    assert.equal(feeFeb.amountDue, 0);

    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 2000);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1500);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 500);
    assert.deepEqual(json.allocationBreakdown.clearedFeeIds, [
      String(feeJanId),
      String(feeFebId),
    ]);
    assert.equal(
      json.allocationBreakdown.summaryText,
      "₹1,500 due cleared, ₹500 saved as advance"
    );
    assert.equal(mockStudent.advanceBalance, 500);
    assert.ok(advanceFeeCreated);
    assert.equal(advanceFeeCreated.paidAmount, 500);
  });

  // =========================================================================
  // Test 6: Pure advance payment (0 pending dues)
  // =========================================================================
  await t.test("6. Pure advance payment credits student advanceBalance with correct summaryText", async () => {
    setupMocks();

    let advanceFeeCreated = null;
    FeeModel.find = async () => [];
    FeeModel.findOne = async (query) => {
      if (advanceFeeCreated && query._id && String(query._id) === String(advanceFeeCreated._id)) {
        return advanceFeeCreated;
      }
      return null;
    };
    FeeModel.create = async (doc) => {
      advanceFeeCreated = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de860dd"),
        ...doc,
      };
      return advanceFeeCreated;
    };
    FeeModel.findById = () => ({
      populate: async () => ({
        ...advanceFeeCreated,
        studentId: mockStudent,
      }),
    });
    FeeModel.updateOne = async () => ({ modifiedCount: 1 });

    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 500,
        feeType: "advance",
        isAdvance: true,
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 201);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 500);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 0);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 500);
    assert.deepEqual(json.allocationBreakdown.clearedFeeIds, []);
    assert.equal(json.allocationBreakdown.summaryText, "₹500 saved as advance");
    assert.equal(mockStudent.advanceBalance, 500);
  });

  // =========================================================================
  // Test 7: Teacher custody attribution preserved across cleared fee and advance
  // =========================================================================
  await t.test("7. Teacher custody is preserved across both cleared fee and advance surplus (Handover Safe)", async () => {
    setupMocks();

    const fee1Id = new mongoose.Types.ObjectId("507f191e810c19729de860e1");
    let fee1 = {
      _id: fee1Id,
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 1000,
      paidAmount: 0,
      originalAmountDue: 1000,
      feeType: "monthly_recurring",
      paymentHistory: [],
    };

    let advanceFeeCreated = null;

    FeeModel.find = async (query) => {
      if (query._id && query._id.$ne) return [];
      return [fee1];
    };
    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(fee1Id)) return fee1;
      if (advanceFeeCreated && query._id && String(query._id) === String(advanceFeeCreated._id)) {
        return advanceFeeCreated;
      }
      return null;
    };
    FeeModel.findOneAndUpdate = async (query, update) => {
      fee1 = {
        ...fee1,
        ...update.$set,
        paymentHistory: [...fee1.paymentHistory, update.$push.paymentHistory],
      };
      return {
        ...fee1,
        populate: async () => ({ ...fee1, studentId: mockStudent }),
      };
    };
    FeeModel.create = async (doc) => {
      advanceFeeCreated = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de860ee"),
        ...doc,
      };
      return advanceFeeCreated;
    };
    FeeModel.updateOne = async () => ({ modifiedCount: 1 });

    // Teacher collects ₹1,500 cash on student with ₹1,000 pending due
    const req = createMockRequest({
      token: teacherToken,
      body: {
        centerId,
        studentId,
        amount: 1500,
        billingMonth: "2026-11",
        feeId: String(fee1Id),
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionRoute(req);
    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.equal(json.allocationBreakdown.totalReceived, 1500);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1000);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 500);

    // 1. Verify cleared fee payment entry has teacher custody
    assert.equal(fee1.paymentHistory.length, 1);
    const fee1Payment = fee1.paymentHistory[0];
    assert.equal(fee1Payment.amount, 1000);
    assert.equal(fee1Payment.custodyStatus, "teacher_custody");
    assert.equal(String(fee1Payment.recordedBy), teacherId);
    assert.equal(fee1Payment.recordedByRole, "teacher");
    assert.equal(fee1Payment.isProvisional, true);

    // 2. Verify surplus advance fee payment entry has teacher custody
    assert.ok(advanceFeeCreated);
    assert.equal(advanceFeeCreated.paymentHistory.length, 1);
    const advancePayment = advanceFeeCreated.paymentHistory[0];
    assert.equal(advancePayment.amount, 500);
    assert.equal(advancePayment.custodyStatus, "teacher_custody");
    assert.equal(String(advancePayment.recordedBy), teacherId);
    assert.equal(advancePayment.recordedByRole, "teacher");
    assert.equal(advancePayment.isProvisional, true);

    // 3. Verify total teacher custody across both records equals exact total cash collected
    const totalTeacherCashInHand = fee1Payment.amount + advancePayment.amount;
    assert.equal(totalTeacherCashInHand, 1500, "Every single rupee collected must remain in teacher custody");
  });
});
