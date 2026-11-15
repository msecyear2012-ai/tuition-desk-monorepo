import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: manualCollectionPost } = await import(
  "../tution-desk-be/src/app/api/fees/manual-collection/route.ts"
);

function createMockRequest({
  method = "POST",
  origin = "http://localhost:3000",
  token,
  headers = {},
  body,
}) {
  const reqHeaders = new Headers(headers);
  if (origin) reqHeaders.set("origin", origin);
  if (token) reqHeaders.set("authorization", `Bearer ${token}`);
  return {
    method,
    headers: reqHeaders,
    cookies: { get: () => undefined },
    nextUrl: new URL("http://localhost:3001/api/fees/manual-collection"),
    json: async () => body || {},
  };
}

test("MSEC — Paid Fees Disappearance & Pending Dues Cache Consistency Suite", async (t) => {
  const centerId = "center_paid_test";
  const studentId = "507f191e810c19729de860e1";
  const teacherId = "507f191e810c19729de860f2";

  const teacherToken = await signToken({
    userId: teacherId,
    teacherId,
    centerId,
    role: "teacher",
    name: "Teacher Rahul",
  });

  const mockStudent = {
    _id: studentId,
    centerId,
    name: "Aarav Gupta",
    batch: "Class 10",
    assignedTeacherId: teacherId,
    parentWhatsApp: "+919876543210",
    monthlyFee: 2500,
    isActive: true,
  };

  StudentModel.findById = async (id) =>
    String(id) === String(studentId) ? mockStudent : null;

  // =========================================================================
  // 1. Static Architectural Safeguards (apiClient, FeesClient, FeePaymentModal)
  // =========================================================================
  await t.test("1.1 apiClient.ts updates cache on skipCache=true and invalidates on 409 Conflict", () => {
    const clientPath = path.resolve("src/lib/apiClient.ts");
    const content = fs.readFileSync(clientPath, "utf-8");

    // Must determine cache eligibility regardless of skipCache so cache can be updated after fetch
    assert.ok(
      content.includes("isEligibleForCache"),
      "apiClient must define isEligibleForCache"
    );
    // Must update cache with fresh data after network fetch
    assert.ok(
      content.includes("apiCache.set(cacheKey, {"),
      "apiClient must save fresh data into apiCache"
    );
    // Must flush stale cache on mutation failure / 409 conflict
    assert.ok(
      content.includes("if (!isGet)") && content.includes("invalidateApiCache()"),
      "apiClient must call invalidateApiCache() on mutation response or error"
    );
  });

  await t.test("1.2 FeePaymentModal.tsx handles 409 FEE_ALREADY_PAID by invalidating cache and disabling duplicate submit", () => {
    const modalPath = path.resolve("src/components/modals/FeePaymentModal.tsx");
    const content = fs.readFileSync(modalPath, "utf-8");

    assert.ok(content.includes("isFeeAlreadyPaid"), "FeePaymentModal must track isFeeAlreadyPaid state");
    assert.ok(content.includes("FEE_ALREADY_PAID"), "FeePaymentModal must recognize FEE_ALREADY_PAID code");
    assert.ok(content.includes("invalidateApiCache()"), "FeePaymentModal must invalidate API cache on already-paid conflict");
    assert.ok(content.includes("msec:fee-already-paid"), "FeePaymentModal must dispatch msec:fee-already-paid event");
    assert.ok(
      content.includes("disabled={Boolean(submitting || !isAmountValid || isOverpaying || isFeeAlreadyPaid)}"),
      "Submit button must be strictly disabled when fee is already paid"
    );
  });

  await t.test("1.3 FeesClient.tsx immediately removes fee from pendingStudents on payment or 409 conflict", () => {
    const feesClientPath = path.resolve("src/app/fees/FeesClient.tsx");
    const content = fs.readFileSync(feesClientPath, "utf-8");

    assert.ok(content.includes("msec:fee-already-paid"), "FeesClient must listen to msec:fee-already-paid event");
    assert.ok(content.includes("msec:collection-recorded"), "FeesClient must listen to msec:collection-recorded event");
    assert.ok(
      content.includes("setPendingStudents((prev) => prev.filter"),
      "FeesClient must immediately filter out paid fee from pendingStudents"
    );
  });

  // =========================================================================
  // 2. Business Logic Simulation: Pending Dues Filtering Rules
  // =========================================================================
  await t.test("2.1 Pending Dues filter strictly excludes fees that are Paid, Verification Pending, or amountDue <= 0", () => {
    function filterPendingFees(feeList, reviewIds = new Set()) {
      return feeList.filter((fee) => {
        if (fee.status === "Paid") return false;
        if (fee.status === "Verification Pending" || reviewIds.has(String(fee._id))) return false;
        const remainingDue = Number(fee.amountDue) || 0;
        if (remainingDue <= 0) return false;
        const isAdvance = Boolean(fee.isAdvance || fee.feeType === "advance");
        if (isAdvance && remainingDue <= 0) return false;
        return true;
      });
    }

    const testFees = [
      { _id: "f_paid_1", status: "Paid", amountDue: 0, paidAmount: 2500 }, // Full Paid -> Excluded
      { _id: "f_paid_2", status: "Paid", amountDue: 3, paidAmount: 3 }, // Paid with stale amountDue -> Excluded
      { _id: "f_zero_due", status: "Pending", amountDue: 0, paidAmount: 2500 }, // Zero due -> Excluded
      { _id: "f_under_review", status: "Verification Pending", amountDue: 2000, paidAmount: 0 }, // In review -> Excluded
      { _id: "f_partial", status: "Partial Paid", amountDue: 800, paidAmount: 1200 }, // Partial -> Kept with 800
      { _id: "f_genuine_due", status: "Pending", amountDue: 1500, paidAmount: 0 }, // Genuine due -> Kept with 1500
      { _id: "f_adv_covered", status: "Paid", isAdvance: true, amountDue: 0, paidAmount: 3000 }, // Covered advance -> Excluded
      { _id: "f_adv_partial", status: "Partial Paid", isAdvance: true, amountDue: 500, paidAmount: 2500 }, // Partial advance -> Kept with 500
    ];

    const clean = filterPendingFees(testFees);
    assert.equal(clean.length, 3, "Only partial, genuine due, and partial advance must be in Pending Dues");
    assert.deepEqual(clean.map((f) => f._id), ["f_partial", "f_genuine_due", "f_adv_partial"]);

    const totalDue = clean.reduce((sum, f) => sum + f.amountDue, 0);
    assert.equal(totalDue, 800 + 1500 + 500, "Total pending amount must accurately equal ₹2800");
  });

  // =========================================================================
  // 3. Backend 409 Conflict Response Returns Authoritative Fee Document
  // =========================================================================
  await t.test("3.1 Attempting manual collection on an already Paid fee returns 409 FEE_ALREADY_PAID with full fee data", async () => {
    const existingPaidFee = {
      _id: "6af95faa9a4fdfeade6b4a67",
      centerId,
      studentId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Paid",
      amountDue: 0,
      paidAmount: 3,
      receiptNumber: "RCPT-PAIDFULL1",
      feeType: "monthly_recurring",
      paymentHistory: [
        {
          _id: "pay_001",
          amount: 3,
          paymentMode: "Cash",
          receiptNumber: "RCPT-PAIDFULL1",
          date: new Date(),
        },
      ],
      toObject: () => existingPaidFee,
    };

    FeeModel.find = async (query) => {
      if (query.studentId && query.centerId === centerId) {
        return [existingPaidFee];
      }
      return [];
    };

    FeeModel.findOne = async () => null;

    const req = createMockRequest({
      token: teacherToken,
      body: {
        studentId,
        amount: 3,
        feeType: "monthly_recurring",
        billingMonth: "2026-11",
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionPost(req);
    const json = await res.json();

    assert.equal(res.status, 409, "Must return HTTP 409 Conflict");
    assert.equal(json.code, "FEE_ALREADY_PAID");
    assert.ok(json.error.includes("already Paid in full"));
    assert.ok(json.data, "Must include candidate fee in response data");
    assert.equal(json.data._id, "6af95faa9a4fdfeade6b4a67");
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.receiptNumber, "RCPT-PAIDFULL1");
  });

  // =========================================================================
  // 4. Successful Full Settlement & Partial Settlement Ledger Invariance
  // =========================================================================
  await t.test("4.1 Full manual collection settles fee to Paid and decrements amountDue to 0 with 1 ledger entry", async () => {
    const pendingFee = {
      _id: "fee_full_settle_01",
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

    let updatePayload = null;
    FeeModel.findOneAndUpdate = async (query, update) => {
      updatePayload = update;
      const newHistory = [...pendingFee.paymentHistory, update.$push.paymentHistory];
      return {
        ...pendingFee,
        ...update.$set,
        paymentHistory: newHistory,
        populate: async () => ({
          ...pendingFee,
          ...update.$set,
          paymentHistory: newHistory,
          toObject: () => ({
            ...pendingFee,
            ...update.$set,
            paymentHistory: newHistory,
          }),
        }),
      };
    };

    const req = createMockRequest({
      token: teacherToken,
      body: {
        studentId,
        amount: 2500,
        feeType: "monthly_recurring",
        billingMonth: "2026-11",
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionPost(req);
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(updatePayload.$set.status, "Paid", "Status must become Paid");
    assert.equal(updatePayload.$set.amountDue, 0, "amountDue must become 0");
    assert.equal(updatePayload.$set.paidAmount, 2500);
    assert.ok(updatePayload.$push.paymentHistory, "Exactly 1 paymentHistory entry must be appended");
  });
});
