import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const PaymentProofModel = (await import("../tution-desk-be/src/models/PaymentProof.ts")).default;
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

test("MSEC — Rejected Proof -> Cash Collection -> Settlement Lifecycle Suite", async (t) => {
  const centerId = "center_reject_settle_test";
  const studentId = "507f191e810c19729de860e1";
  const ownerId = "507f191e810c19729de860a1";
  const feeId1 = "507f191e810c19729de860f1"; // Advance fee with rejected proof
  const feeId2 = "507f191e810c19729de860f2"; // Monthly recurring fee with rejected proof

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director",
  });

  const mockStudent = {
    _id: studentId,
    centerId,
    name: "Priya Patel",
    batch: "Class 10 - Science",
    parentWhatsApp: "+919988776655",
    monthlyFee: 2000,
    isActive: true,
  };

  StudentModel.findById = async (id) =>
    String(id) === String(studentId) ? mockStudent : null;

  // Mock Advance Fee that had proof rejected
  let targetAdvanceFee = {
    _id: feeId1,
    centerId,
    studentId,
    month: "Advance Fee Payment",
    feeType: "advance",
    title: "Advance Fee Payment",
    amountDue: 5,
    paidAmount: 0,
    originalAmountDue: 5,
    status: "Pending",
    isAdvance: true,
    rejectionReason: "wrong details",
    hasPaymentProof: true,
    paymentHistory: [],
    notes: "",
    toObject() {
      return { ...this };
    },
  };

  FeeModel.findOne = async (query) => {
    if (query._id && String(query._id) === String(feeId1)) {
      return targetAdvanceFee;
    }
    return null;
  };

  FeeModel.findOneAndUpdate = async (query, update, opts) => {
    if (String(query._id) === String(feeId1)) {
      const setFields = update.$set || {};
      const pushFields = update.$push || {};
      targetAdvanceFee = {
        ...targetAdvanceFee,
        ...setFields,
        paymentHistory: [
          ...(targetAdvanceFee.paymentHistory || []),
          ...(pushFields.paymentHistory ? [pushFields.paymentHistory] : []),
        ],
      };
      return targetAdvanceFee;
    }
    return null;
  };

  // =========================================================================
  // 1. Full Cash Collection on Targeted Advance Fee with Rejected Proof
  // =========================================================================
  await t.test("1. Full cash collection on targeted feeId settles that exact document to Paid and clears active rejectionReason", async () => {
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        feeId: feeId1,
        feeType: "advance",
        amount: 5,
        paymentMode: "Cash",
        notes: "Full settlement at front desk",
      },
    });

    const res = await manualCollectionPost(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.settledExisting, true);
    assert.equal(body.data.status, "Paid");
    assert.equal(body.data.amountDue, 0);
    assert.equal(body.data.paidAmount, 5);
    assert.equal(body.data.rejectionReason, null);
    assert.ok(body.data.receiptNumber.startsWith("RCPT-"));
    assert.equal(body.data.paymentHistory.length, 1);
  });

  // =========================================================================
  // 2. Duplicate Collection on Same Fee is Blocked
  // =========================================================================
  await t.test("2. Attempting another payment on the now-Paid fee is blocked with 409 FEE_ALREADY_PAID", async () => {
    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        feeId: feeId1,
        feeType: "advance",
        amount: 5,
        paymentMode: "Cash",
      },
    });

    const res = await manualCollectionPost(req);
    assert.equal(res.status, 409);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, "FEE_ALREADY_PAID");
  });

  // =========================================================================
  // 3. Partial Cash Collection on Fee with Rejected Proof
  // =========================================================================
  await t.test("3. Partial cash collection on targeted fee updates remaining balance to Partial Paid and clears active rejectionReason", async () => {
    // Setup fresh fee with ₹5 due
    let targetPartialFee = {
      _id: feeId2,
      centerId,
      studentId,
      month: "Advance Fee Payment",
      feeType: "advance",
      title: "Advance Fee Payment",
      amountDue: 5,
      paidAmount: 0,
      originalAmountDue: 5,
      status: "Pending",
      isAdvance: true,
      rejectionReason: "wrong",
      hasPaymentProof: true,
      paymentHistory: [],
      notes: "",
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = async (query) => {
      if (query._id && String(query._id) === String(feeId2)) {
        return targetPartialFee;
      }
      return null;
    };

    FeeModel.findOneAndUpdate = async (query, update, opts) => {
      if (String(query._id) === String(feeId2)) {
        const setFields = update.$set || {};
        const pushFields = update.$push || {};
        targetPartialFee = {
          ...targetPartialFee,
          ...setFields,
          paymentHistory: [
            ...(targetPartialFee.paymentHistory || []),
            ...(pushFields.paymentHistory ? [pushFields.paymentHistory] : []),
          ],
        };
        return targetPartialFee;
      }
      return null;
    };

    const req = createMockRequest({
      token: ownerToken,
      body: {
        centerId,
        studentId,
        feeId: feeId2,
        feeType: "advance",
        amount: 2, // Partial payment of ₹2 on ₹5
        paymentMode: "Cash",
        notes: "Partial payment",
      },
    });

    const res = await manualCollectionPost(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.settledExisting, true);
    assert.equal(body.data.status, "Partial Paid");
    assert.equal(body.data.amountDue, 3);
    assert.equal(body.data.paidAmount, 2);
    assert.equal(body.data.rejectionReason, null);
    assert.equal(body.data.paymentHistory.length, 1);
  });

  // =========================================================================
  // 4. OverdueStudentItem UI suppresses rejection notice when fee is Paid or Partial Paid
  // =========================================================================
  await t.test("4. OverdueStudentItem.tsx suppresses rejection banner when fee is Paid or Partial Paid", () => {
    const itemPath = path.resolve("src/components/fees/OverdueStudentItem.tsx");
    const content = fs.readFileSync(itemPath, "utf-8");
    assert.ok(
      content.includes("!isPaidTab && !isPartialPaid"),
      "Must exclude Partial Paid and Paid from rendering the rejection notice"
    );
  });

  // =========================================================================
  // 5. Parent Portal API resolves Partial Paid and suppresses rejection reason for non-Pending
  // =========================================================================
  await t.test("5. Parent portal [token]/route.ts includes Partial Paid and clears rejectionReason for settled/partial fees", () => {
    const portalRoutePath = path.resolve("tution-desk-be/src/app/api/parent/portal/[token]/route.ts");
    const content = fs.readFileSync(portalRoutePath, "utf-8");
    assert.ok(
      content.includes('f.status === "Partial Paid"'),
      "Parent portal query must include Partial Paid"
    );
    assert.ok(
      content.includes('pendingFee.status === "Pending"'),
      "Rejection reason must only be attached when fee status is strictly Pending"
    );
  });
});
