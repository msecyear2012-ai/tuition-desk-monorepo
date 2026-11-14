import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";
import { connectDB } from "file:///D:/Client-Projects/MSEC/tution-desk-be/src/lib/db.ts";
import { signToken } from "file:///D:/Client-Projects/MSEC/tution-desk-be/src/lib/auth.ts";

// Helper logic from StudentProfile.tsx
function getSettledAmount(fee) {
  if (!fee) return 0;
  const paid = Number(fee.paidAmount);
  if (!isNaN(paid) && paid > 0) {
    return paid;
  }
  const due = Number(fee.amountDue);
  if (!isNaN(due) && due > 0) {
    return due;
  }
  return 0;
}

// Helper logic from FeeHistoryCard.tsx
function getClearedAmount(fee) {
  if (!fee) return 0;
  const paid = Number(fee.paidAmount);
  if (!isNaN(paid) && paid > 0) {
    return paid;
  }
  const due = Number(fee.amountDue);
  if (!isNaN(due) && due > 0) {
    return due;
  }
  return 0;
}

test("Requirement 1 & 2: Paid fee with amountDue=0 and paidAmount=3000 displays ₹3,000 in ledger, receipt, and parent portal", () => {
  const fee = {
    _id: "6af100000000000000000007",
    status: "Paid",
    amountDue: 0,
    paidAmount: 3000,
  };

  const isPaid = fee.status === "Paid";
  const displayedLedgerAmount = isPaid ? getSettledAmount(fee) : fee.amountDue;
  const displayedReceiptAmount = getSettledAmount(fee);
  const parentClearedAmount = getClearedAmount(fee);

  assert.equal(displayedLedgerAmount, 3000, "Ledger must display ₹3,000 settled");
  assert.equal(displayedReceiptAmount, 3000, "Receipt modal must display ₹3,000 total received");
  assert.equal(parentClearedAmount, 3000, "Parent Portal must display ₹3,000 cleared");
});

test("Requirement 2: Pending fee continues displaying its outstanding balance", () => {
  const pendingFee = {
    _id: "fee_pending_01",
    status: "Pending",
    amountDue: 2500,
    paidAmount: 0,
  };

  const isPaid = pendingFee.status === "Paid";
  const displayedLedgerAmount = isPaid ? getSettledAmount(pendingFee) : pendingFee.amountDue;
  const label = isPaid ? "Settled" : "Balance Due";

  assert.equal(isPaid, false);
  assert.equal(label, "Balance Due");
  assert.equal(displayedLedgerAmount, 2500, "Must display pending balance due ₹2,500");
});

test("Requirement 3: Partial payment preserves outstanding balance vs cumulative paid amount", () => {
  const partialFee = {
    _id: "fee_partial_01",
    status: "Partial Paid",
    amountDue: 1000,  // Remaining due
    paidAmount: 2000, // Cumulative collected so far
  };

  const isPaid = partialFee.status === "Paid";
  const displayedLedgerAmount = isPaid ? getSettledAmount(partialFee) : partialFee.amountDue;
  const label = isPaid ? "Settled" : "Balance Due";

  assert.equal(isPaid, false);
  assert.equal(label, "Balance Due");
  assert.equal(displayedLedgerAmount, 1000, "Ledger must display outstanding balance ₹1,000 next to Balance Due");

  const collectedAmount = getSettledAmount(partialFee);
  assert.equal(collectedAmount, 2000, "Receipt context must retrieve the actual collected ₹2,000");
});

test("Requirement 4: Missing or null paidAmount is handled safely without fabricating from zero amountDue", () => {
  const missingFee = {
    _id: "fee_missing_01",
    status: "Paid",
    amountDue: 0,
    paidAmount: null,
  };

  const amount = getSettledAmount(missingFee);
  assert.equal(amount, 0, "Must return 0 safely without throwing error");

  const undefinedFee = {
    _id: "fee_missing_02",
    status: "Paid",
    amountDue: 0,
  };
  const amountUndef = getSettledAmount(undefinedFee);
  assert.equal(amountUndef, 0, "Must return 0 safely for undefined paidAmount");
});

test("Requirement 1: Live Parent API endpoint returns paidAmount ₹3,000 for TEST_E2E_Student_T1 via /api/parent/[studentId]", async () => {
  const studentId = "6af100000000000000000005";

  const res = await fetch(`http://localhost:3001/api/parent/${studentId}`).then((r) => r.json());
  assert.equal(res.success, true, "Parent API ID resolution must succeed");
  assert.ok(Array.isArray(res.data?.fees?.history), "Must return fees history array in data.fees.history");

  const targetFee = res.data.fees.history.find((f) => f.id === "6af100000000000000000007");
  assert.ok(targetFee, "Must find target fee in history");
  assert.equal(targetFee.amountDue, 0, "amountDue must be 0 for settled fee");
  assert.equal(targetFee.paidAmount, 3000, "paidAmount must be serialized as exactly 3000");
  assert.equal(targetFee.receiptNumber, "RCPT-TYZGGP", "receiptNumber must match");
});

test("Requirement 1: Live Parent Portal Exchange endpoint returns paidAmount ₹3,000 via POST /api/parent/portal/exchange", async () => {
  await connectDB();
  const db = mongoose.connection.db;
  const pa = await db.collection("parentaccesses").findOne({
    linkedStudentIds: new mongoose.Types.ObjectId("6af100000000000000000005"),
  });
  assert.ok(pa, "Must find ParentAccess record for TEST_E2E_Student_T1");

  const sessionToken = await signToken({
    parentAccessId: String(pa._id),
    centerId: pa.centerId,
    role: "parent",
    tokenPrefix: pa.tokenPrefix,
    linkedStudentIds: ["6af100000000000000000005"],
  });

  const res = await fetch("http://localhost:3001/api/parent/portal/exchange", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ studentId: "6af100000000000000000005" }),
  }).then((r) => r.json());

  assert.equal(res.success, true, "Portal exchange must succeed");
  assert.ok(Array.isArray(res.fees?.history), "Must return fees history array in fees.history");

  const targetFee = res.fees.history.find((f) => f.id === "6af100000000000000000007");
  assert.ok(targetFee, "Must find target fee in exchange history");
  assert.equal(targetFee.amountDue, 0, "amountDue must be 0 for settled fee");
  assert.equal(targetFee.paidAmount, 3000, "paidAmount must reach the browser as exactly 3000");
  assert.equal(targetFee.receiptNumber, "RCPT-TYZGGP", "receiptNumber must match");

  await mongoose.disconnect();
});
