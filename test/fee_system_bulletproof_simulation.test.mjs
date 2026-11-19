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

// Import route handlers
const { POST: manualCollectionRoute } = await import(
  "../tution-desk-be/src/app/api/fees/manual-collection/route.ts"
);
const { GET: feeSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/students/[id]/fee-summary/route.ts"
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

test("Bulletproof 4-Step Allocation & Simulation Suite", async (t) => {
  const centerId = "center_simulation_101";
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

  // State store across sequential steps
  let studentDoc = {
    _id: new mongoose.Types.ObjectId(studentId),
    centerId,
    name: "Aditya Verma",
    batch: "Grade 10 ICSE",
    assignedTeacherId: new mongoose.Types.ObjectId(teacherId),
    monthlyFee: 2500,
    dueDay: 10,
    billingCycleDate: 10,
    advanceBalance: 0,
    isActive: true,
    createdAt: new Date("2026-01-01"),
    joiningDate: new Date("2026-01-01"),
  };

  const feesStore = [];

  // Wire up mongoose model mocks using the persistent state store
  StudentModel.findById = async (id) => {
    if (String(id) === studentId) return studentDoc;
    return null;
  };

  StudentModel.findOne = async (query) => {
    if (query._id && String(query._id) === studentId) return studentDoc;
    return null;
  };

  StudentModel.findOneAndUpdate = async (filter, update) => {
    if (update.$inc && typeof update.$inc.advanceBalance === "number") {
      studentDoc.advanceBalance = (studentDoc.advanceBalance || 0) + update.$inc.advanceBalance;
    }
    return studentDoc;
  };

  FeeModel.find = (query) => {
    let result = feesStore.filter((f) => {
      if (query.centerId && f.centerId !== query.centerId) return false;
      if (query.studentId && String(f.studentId) !== String(query.studentId)) return false;
      if (query._id && query._id.$ne && String(f._id) === String(query._id.$ne)) return false;
      if (query.status && query.status.$in) {
        if (!query.status.$in.includes(f.status)) return false;
      }
      if (query.feeType && query.feeType.$ne && f.feeType === query.feeType.$ne) return false;
      if (query.isAdvance && query.isAdvance.$ne && f.isAdvance === query.isAdvance.$ne) return false;
      if (query.$or) {
        const matchesOr = query.$or.some((clause) => {
          if (clause.billingMonth && f.billingMonth === clause.billingMonth) return true;
          if (clause.month && clause.month.$in && clause.month.$in.includes(f.month)) return true;
          return false;
        });
        if (!matchesOr) return false;
      }
      return true;
    });

    const promise = Promise.resolve(result);
    promise.sort = (sortCriteria) => {
      if (sortCriteria && (sortCriteria.dueDate || sortCriteria.createdAt)) {
        result.sort((a, b) => {
          const dateA = a.dueDate ? new Date(a.dueDate).getTime() : 0;
          const dateB = b.dueDate ? new Date(b.dueDate).getTime() : 0;
          return dateA - dateB;
        });
      }
      return Promise.resolve(result);
    };
    return promise;
  };

  FeeModel.findOne = async (query) => {
    const found = feesStore.find((f) => {
      if (query.centerId && f.centerId !== query.centerId) return false;
      if (query.studentId && String(f.studentId) !== String(query.studentId)) return false;
      if (query._id && String(f._id) !== String(query._id)) return false;
      if (query["paymentHistory.idempotencyKey"]) {
        const hasKey = f.paymentHistory?.some(
          (p) => p.idempotencyKey === query["paymentHistory.idempotencyKey"]
        );
        if (!hasKey) return false;
      }
      if (query.$or) {
        const matchesOr = query.$or.some((clause) => {
          if (clause.billingMonth && f.billingMonth === clause.billingMonth) return true;
          if (clause.month && clause.month.$in && clause.month.$in.includes(f.month)) return true;
          return false;
        });
        if (!matchesOr) return false;
      }
      return true;
    });

    if (!found) return null;
    return {
      ...found,
      populate: async () => ({ ...found, studentId: studentDoc }),
    };
  };

  FeeModel.findById = (id) => {
    const found = feesStore.find((f) => String(f._id) === String(id));
    return {
      ...found,
      populate: async () => (found ? { ...found, studentId: studentDoc } : null),
    };
  };

  FeeModel.create = async (doc) => {
    const newDoc = {
      _id: new mongoose.Types.ObjectId(),
      createdAt: new Date(),
      ...doc,
      studentId: doc.studentId || studentDoc._id,
      paymentHistory: doc.paymentHistory ? [...doc.paymentHistory] : [],
    };
    feesStore.push(newDoc);
    return {
      ...newDoc,
      populate: async () => ({ ...newDoc, studentId: studentDoc }),
    };
  };

  FeeModel.findOneAndUpdate = async (query, update) => {
    const idx = feesStore.findIndex((f) => String(f._id) === String(query._id));
    if (idx === -1) return null;

    const current = feesStore[idx];
    const updated = {
      ...current,
      ...(update.$set || {}),
    };
    if (update.$push && update.$push.paymentHistory) {
      updated.paymentHistory = [...(current.paymentHistory || []), update.$push.paymentHistory];
    }
    feesStore[idx] = updated;

    return {
      ...updated,
      populate: async () => ({ ...updated, studentId: studentDoc }),
    };
  };

  FeeModel.updateOne = async () => ({ modifiedCount: 1 });

  // =========================================================================
  // Step 1: Record ₹1,500 (No prior invoice)
  // Expected: Invoiced ₹2,500, Paid ₹1,500, Due ₹1,000 (Partial Paid), Advance ₹0
  // =========================================================================
  await t.test("Step 1: Record ₹1,500 with no prior invoice creates Partial Paid fee (Invoiced ₹2500, Paid ₹1500, Due ₹1000, Advance ₹0)", async () => {
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 1500,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 201);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.settledExisting, false);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 1500);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1500);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 0);
    assert.equal(json.allocationBreakdown.summaryText, "₹1,500 applied to pending dues");

    // Verify stored fee record
    assert.equal(feesStore.length, 1);
    const fee1 = feesStore[0];
    assert.equal(fee1.originalAmountDue, 2500, "originalAmountDue must be student.monthlyFee (2500)");
    assert.equal(fee1.paidAmount, 1500, "paidAmount must be 1500");
    assert.equal(fee1.amountDue, 1000, "amountDue must be 1000");
    assert.equal(fee1.status, "Partial Paid");
    assert.equal(studentDoc.advanceBalance, 0);
  });

  // =========================================================================
  // Step 2: Record ₹2,000
  // Expected: Clears remaining ₹1,000 (Paid), surplus ₹1,000 routed to advanceBalance (Advance ₹1,000)
  // =========================================================================
  await t.test("Step 2: Record ₹2,000 clears remaining ₹1,000 due and routes surplus ₹1,000 to advanceBalance", async () => {
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 2000,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 2000);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 1000);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 1000);
    assert.equal(
      json.allocationBreakdown.summaryText,
      "₹1,000 due cleared, ₹1,000 saved as advance"
    );

    // Verify fee status updated to Paid
    const fee1 = feesStore.find((f) => f.billingMonth === "2026-11" && !f.isAdvance);
    assert.ok(fee1);
    assert.equal(fee1.status, "Paid");
    assert.equal(fee1.amountDue, 0);
    assert.equal(fee1.paidAmount, 2500);

    // Verify advance balance
    assert.equal(studentDoc.advanceBalance, 1000);

    // Verify advance fee document created
    const advanceFee = feesStore.find((f) => f.isAdvance === true);
    assert.ok(advanceFee);
    assert.equal(advanceFee.paidAmount, 1000);
    assert.equal(advanceFee.status, "Paid");
  });

  // =========================================================================
  // Step 3: Record ₹2,500 again in same month
  // Expected: HTTP 200 (NO 'Already Paid' 409 error), full ₹2,500 routed to advanceBalance (Total Advance ₹3,500)
  // =========================================================================
  await t.test("Step 3: Record ₹2,500 in already-paid month returns HTTP 200 and routes all ₹2,500 to advance (Advance ₹3,500)", async () => {
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        amount: 2500,
        billingMonth: "2026-11",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200, "Must return HTTP 200 instead of 409 FEE_ALREADY_PAID");
    const json = await res.json();

    assert.equal(json.success, true);
    assert.ok(json.allocationBreakdown);
    assert.equal(json.allocationBreakdown.totalReceived, 2500);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 0);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 2500);
    assert.equal(json.allocationBreakdown.summaryText, "₹2,500 saved as advance");

    // Verify student advanceBalance is now 1000 + 2500 = 3500
    assert.equal(studentDoc.advanceBalance, 3500);
  });

  // =========================================================================
  // Step 4: Call GET /api/students/[id]/fee-summary
  // Expected: summary.totalDue === 0, summary.advanceBalance === 3500, current month "paid"
  // =========================================================================
  await t.test("Step 4: GET /api/students/[id]/fee-summary reports totalDue: 0, advanceBalance: 3500, current month: 'paid'", async () => {
    const req = createMockRequest({
      method: "GET",
      token: ownerToken,
      url: `http://localhost:3000/api/students/${studentId}/fee-summary?year=2026`,
    });

    const res = await feeSummaryRoute(req, {
      params: Promise.resolve({ id: studentId }),
    });

    const json = await res.json();
    assert.equal(res.status, 200);

    assert.equal(json.success, true);
    assert.ok(json.data.summary);
    assert.equal(json.data.summary.totalDue, 0, "Total unpaid dues must be 0");
    assert.equal(json.data.summary.advanceBalance, 3500, "Advance balance must be 3500");
    assert.equal(json.data.summary.monthlyFee, 2500);

    // Verify months array has Nov (month 11) marked as 'paid'
    assert.ok(Array.isArray(json.data.months));
    assert.equal(json.data.months.length, 12);
    const novMonth = json.data.months.find((m) => m.month === 11);
    assert.ok(novMonth);
    assert.equal(novMonth.status, "paid");
    assert.equal(novMonth.amountPaid, 2500);
    assert.equal(novMonth.amountDue, 0);
  });

  // =========================================================================
  // Step 5: Repeat Step 3 as Teacher
  // Expected: Assert custodyStatus: "teacher_custody", recordedByRole: "teacher", isProvisional: true
  // =========================================================================
  await t.test("Step 5: Teacher recording payment on zero-due student preserves teacher cash custody on advance entry", async () => {
    const req = createMockRequest({
      token: teacherToken,
      body: {
        centerId,
        studentId,
        amount: 1000,
        billingMonth: "2026-11",
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.allocationBreakdown.totalReceived, 1000);
    assert.equal(json.allocationBreakdown.clearedDuesAmount, 0);
    assert.equal(json.allocationBreakdown.advanceSavedAmount, 1000);

    // Verify student advanceBalance is now 3500 + 1000 = 4500
    assert.equal(studentDoc.advanceBalance, 4500);

    // Check latest created advance fee
    const latestAdvanceFee = feesStore[feesStore.length - 1];
    assert.ok(latestAdvanceFee);
    assert.equal(latestAdvanceFee.isAdvance, true);
    assert.equal(latestAdvanceFee.paymentHistory.length, 1);

    const payment = latestAdvanceFee.paymentHistory[0];
    assert.equal(payment.amount, 1000);
    assert.equal(payment.custodyStatus, "teacher_custody", "Must have teacher_custody");
    assert.equal(payment.recordedByRole, "teacher", "recordedByRole must be teacher");
    assert.equal(String(payment.recordedBy), teacherId);
    assert.equal(payment.isProvisional, true, "Teacher cash collections must be provisional");
  });
});
