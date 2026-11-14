import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");
const { Types } = mongoose;

test("Phase 4.1: Financial Models & Schemas Test Suite (Zero-DB Unit & Regression Validation)", async (t) => {
  // Dynamically import models
  const { Fee, calculatePaymentCustody, getFeePaymentEntries, getLockedAllocationAmount } =
    await import("../tution-desk-be/src/models/Fee.ts");
  const { CashHandover } = await import(
    "../tution-desk-be/src/models/CashHandover.ts"
  );

  // Helper to generate fresh ObjectIds
  const oid = () => new Types.ObjectId();

  // Modern offline validation helper (executes pre-validation middleware & path validators without DB connection)
  const validateDoc = async (doc) => {
    try {
      await doc.validate();
      return undefined;
    } catch (err) {
      return err;
    }
  };

  // =========================================================================
  // 1. Immutable attribution fields (Requirement 1)
  // =========================================================================
  await t.test("1.1 Legitimate initial creation works with valid attribution", async () => {
    const teacherId = oid();
    const fee = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      billingMonth: "2026-11",
      originalAmountDue: 2500,
      amountDue: 1000,
      paidAmount: 1500,
      dueDate: new Date("2026-11-10"),
      status: "Partial Paid",
      paymentHistory: [
        {
          amount: 1500,
          paymentDate: new Date("2026-11-02T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "PROV-MSEC-819201",
          isProvisional: true,
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          custodyStatus: "teacher_custody",
          allocations: [],
        },
      ],
    });

    const error = await validateDoc(fee);
    assert.equal(error, undefined, "Valid Fee document must pass validation");
    assert.equal(String(fee.paymentHistory[0].receivedBy), String(teacherId));
    assert.equal(String(fee.paymentHistory[0].recordedBy), String(teacherId));
  });

  await t.test("1.2 Missing receivedBy or recordedBy fails validation", async () => {
    const feeMissingRecv = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 500,
      dueDate: new Date(),
      status: "Paid",
      paymentHistory: [
        {
          amount: 500,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "RCPT-NO-RECV",
          receivedByRole: "teacher",
          recordedBy: oid(),
          recordedByRole: "teacher",
        },
      ],
    });
    const errRecv = await validateDoc(feeMissingRecv);
    assert.ok(errRecv?.errors["paymentHistory.0.receivedBy"], "Missing receivedBy must fail");

    const feeMissingRec = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 500,
      dueDate: new Date(),
      status: "Paid",
      paymentHistory: [
        {
          amount: 500,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "RCPT-NO-REC",
          receivedBy: oid(),
          receivedByRole: "teacher",
          recordedByRole: "teacher",
        },
      ],
    });
    const errRec = await validateDoc(feeMissingRec);
    assert.ok(errRec?.errors["paymentHistory.0.recordedBy"], "Missing recordedBy must fail");
  });

  await t.test("1.3 In-memory mutation on hydrated document is protected by immutable: true", () => {
    const originalTeacherId = oid();
    const forgedTeacherId = oid();
    const feeDoc = new Fee();
    feeDoc.init({
      _id: oid(),
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 1000,
      dueDate: new Date(),
      status: "Paid",
      paymentHistory: [
        {
          _id: oid(),
          amount: 1000,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "RCPT-IMMUTABLE-01",
          receivedBy: originalTeacherId,
          receivedByRole: "teacher",
          recordedBy: originalTeacherId,
          recordedByRole: "teacher",
          allocations: [],
        },
      ],
    });

    assert.equal(feeDoc.isNew, false, "Hydrated doc must have isNew = false");
    // Attempt in-memory mutation
    feeDoc.paymentHistory[0].receivedBy = forgedTeacherId;
    feeDoc.paymentHistory[0].recordedBy = forgedTeacherId;

    // Mongoose immutable: true ignores mutations on hydrated subdocs
    assert.equal(
      String(feeDoc.paymentHistory[0].receivedBy),
      String(originalTeacherId),
      "receivedBy must revert/reject in-memory mutation"
    );
    assert.equal(
      String(feeDoc.paymentHistory[0].recordedBy),
      String(originalTeacherId),
      "recordedBy must revert/reject in-memory mutation"
    );
  });

  // =========================================================================
  // 2. Partial approval and re-submission (Requirement 2)
  // =========================================================================
  await t.test("2. ₹1,000 payment: ₹700 verified + ₹300 pending allows re-submission of remaining ₹300", async () => {
    const teacherId = oid();
    const ho1 = oid();
    const ho2 = oid();

    // Handover 1 had ₹1,000 declared, but Owner only counted and verified ₹700
    // alloc_01: status "verified", verifiedAmount 700, allocatedAmount 1000
    // alloc_02: teacher brings remaining ₹300 in Handover 2
    const fee = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 1000,
      dueDate: new Date("2026-11-10"),
      status: "Paid",
      paymentHistory: [
        {
          amount: 1000,
          paymentDate: new Date("2026-11-02"),
          paymentMode: "Cash",
          receiptNumber: "PROV-MSEC-P1",
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          allocations: [
            {
              handoverId: ho1,
              handoverNumber: "HO-001",
              allocatedAmount: 1000,
              status: "verified",
              verifiedAmount: 700,
              verifiedAt: new Date("2026-11-03"),
            },
            {
              handoverId: ho2,
              handoverNumber: "HO-002",
              allocatedAmount: 300,
              status: "pending_verification",
            },
          ],
        },
      ],
    });

    // Verification balance check:
    // alloc_01 locks verifiedAmount (700). alloc_02 locks allocatedAmount (300).
    // Total locked = 700 + 300 = 1000 <= 1000. Must pass validation!
    const error = await validateDoc(fee);
    assert.equal(
      error,
      undefined,
      "Partial approval re-submission must pass validation without error"
    );

    const custody = calculatePaymentCustody(fee.paymentHistory[0]);
    assert.equal(custody.ownerVerifiedAmount, 700);
    assert.equal(custody.ownerPendingVerificationAmount, 300);
    assert.equal(custody.teacherInHandAmount, 0);
    assert.equal(custody.totalAmount, 1000);
  });

  // =========================================================================
  // 3. Rejected allocation re-submission (Requirement 3)
  // =========================================================================
  await t.test("3. Rejected ₹300 allocation can be resubmitted while preserving history", async () => {
    const teacherId = oid();
    const fee = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 300,
      dueDate: new Date(),
      status: "Paid",
      paymentHistory: [
        {
          amount: 300,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "PROV-MSEC-REJ",
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          allocations: [
            {
              handoverId: oid(),
              handoverNumber: "HO-REJ-01",
              allocatedAmount: 300,
              status: "rejected",
              rejectionReason: "Envelope missing currency notes",
            },
            {
              handoverId: oid(),
              handoverNumber: "HO-RESUBMIT-02",
              allocatedAmount: 300,
              status: "pending_verification",
            },
          ],
        },
      ],
    });

    const error = await validateDoc(fee);
    assert.equal(error, undefined, "Rejected allocation must allow clean re-submission");
    assert.equal(fee.paymentHistory[0].allocations.length, 2, "History must be preserved");
    assert.equal(fee.paymentHistory[0].allocations[0].status, "rejected");
    assert.equal(fee.paymentHistory[0].allocations[1].status, "pending_verification");
  });

  // =========================================================================
  // 4. Disputed allocation cannot be duplicated (Requirement 4)
  // =========================================================================
  await t.test("4. Disputed allocation locks allocated funds and prevents duplicate allocation", async () => {
    const teacherId = oid();
    const fee = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 1000,
      dueDate: new Date(),
      status: "Paid",
      paymentHistory: [
        {
          amount: 1000,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "PROV-MSEC-DISP",
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          allocations: [
            {
              handoverId: oid(),
              handoverNumber: "HO-DISP-01",
              allocatedAmount: 1000,
              status: "disputed",
              verifiedAmount: 700,
            },
            {
              handoverId: oid(),
              handoverNumber: "HO-DUP-02",
              allocatedAmount: 300, // Attempted duplicate allocation while HO-01 is under dispute
              status: "pending_verification",
            },
          ],
        },
      ],
    });

    // Disputed alloc locks full allocatedAmount (1000). Total locked = 1000 + 300 = 1300 > 1000.
    const error = await validateDoc(fee);
    assert.ok(error, "Attempting to allocate cash while under active dispute must be blocked");
    assert.ok(
      error.errors["paymentHistory.0.allocations"],
      "Must trigger validation error on paymentHistory.0.allocations"
    );
  });

  // =========================================================================
  // 5. Multiple allocations never exceed payment amount (Requirement 5)
  // =========================================================================
  await t.test("5. Multiple allocations never exceed ₹1,000 payment amount", async () => {
    const fee = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      amountDue: 0,
      paidAmount: 1000,
      dueDate: new Date(),
      status: "Paid",
      paymentHistory: [
        {
          amount: 1000,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "RCPT-OVERFLOW",
          receivedBy: oid(),
          receivedByRole: "teacher",
          recordedBy: oid(),
          recordedByRole: "teacher",
          allocations: [
            { handoverId: oid(), allocatedAmount: 400, status: "pending_verification" },
            { handoverId: oid(), allocatedAmount: 400, status: "pending_verification" },
            { handoverId: oid(), allocatedAmount: 300, status: "pending_verification" }, // 400 + 400 + 300 = 1100 > 1000
          ],
        },
      ],
    });

    const error = await validateDoc(fee);
    assert.ok(error, "Over-allocated allocations array must fail validation");
    assert.match(
      error.errors["paymentHistory.0.allocations"].message,
      /cannot exceed payment amount/
    );
  });

  // =========================================================================
  // 6. Custody derivation: Disputed ₹300 with ₹200 verified (Requirement 6)
  // =========================================================================
  await t.test("6. Disputed ₹300 allocation with ₹200 verified: ₹200 owner verified, ₹100 discrepancy", () => {
    const breakdown = calculatePaymentCustody({
      amount: 300,
      receiptNumber: "RCPT-DISP-01",
      paymentDate: new Date(),
      paymentMode: "Cash",
      receivedBy: oid(),
      receivedByRole: "teacher",
      recordedBy: oid(),
      recordedByRole: "teacher",
      allocations: [
        {
          handoverId: oid(),
          allocatedAmount: 300,
          verifiedAmount: 200,
          status: "disputed",
        },
      ],
    });

    assert.equal(breakdown.totalAmount, 300);
    assert.equal(breakdown.ownerVerifiedAmount, 200, "₹200 verified must be in Owner vault");
    assert.equal(breakdown.disputedDiscrepancyAmount, 100, "₹100 must be tracked as discrepancy");
    assert.equal(breakdown.teacherInHandAmount, 0, "Teacher has ₹0 in hand");
    assert.equal(breakdown.ownerPendingVerificationAmount, 0);

    // Exact reconciliation check
    assert.equal(
      breakdown.ownerVerifiedAmount +
        breakdown.disputedDiscrepancyAmount +
        breakdown.teacherInHandAmount +
        breakdown.ownerPendingVerificationAmount,
      breakdown.totalAmount
    );
  });

  // =========================================================================
  // 7. Shortage-confirmed allocation preserves custody & liability (Requirement 7)
  // =========================================================================
  await t.test("7. Shortage-confirmed allocation preserves verified custody and separate liability", () => {
    const breakdown = calculatePaymentCustody({
      amount: 1000,
      receiptNumber: "RCPT-SHORTAGE-CONF",
      paymentDate: new Date(),
      paymentMode: "Cash",
      receivedBy: oid(),
      receivedByRole: "teacher",
      recordedBy: oid(),
      recordedByRole: "teacher",
      allocations: [
        {
          handoverId: oid(),
          allocatedAmount: 1000,
          verifiedAmount: 700,
          status: "shortage_confirmed",
        },
      ],
    });

    assert.equal(breakdown.totalAmount, 1000);
    assert.equal(breakdown.ownerVerifiedAmount, 700, "₹700 verified remains in Owner vault");
    assert.equal(breakdown.disputedDiscrepancyAmount, 300, "₹300 confirmed shortage deficit");
    assert.equal(breakdown.teacherInHandAmount, 0, "Teacher has ₹0 physical cash in hand");
    assert.equal(
      breakdown.ownerVerifiedAmount + breakdown.disputedDiscrepancyAmount,
      breakdown.totalAmount
    );
  });

  // =========================================================================
  // 8. Incremental settlement invariant in CashHandover (Requirement 8)
  // =========================================================================
  await t.test("8.1 ₹300 discrepancy allows ₹200 and ₹100 settlements", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-SETTLE-01",
      teacherId: oid(),
      submittedAmount: 1000,
      approvedAmount: 700,
      discrepancyAmount: 300,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "RCPT-SETTLE-1",
        },
      ],
      incrementalSettlements: [
        {
          amountReceived: 200,
          receivedBy: oid(),
          remainingDiscrepancy: 100, // 300 - 200 = 100
        },
        {
          amountReceived: 100,
          receivedBy: oid(),
          remainingDiscrepancy: 0, // 100 - 100 = 0
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.equal(error, undefined, "Valid incremental settlements within discrepancy must pass");
  });

  await t.test("8.2 Incremental settlements exceeding discrepancy amount are rejected", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-SETTLE-02",
      teacherId: oid(),
      submittedAmount: 1000,
      approvedAmount: 700,
      discrepancyAmount: 300,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "RCPT-SETTLE-2",
        },
      ],
      incrementalSettlements: [
        {
          amountReceived: 200,
          receivedBy: oid(),
          remainingDiscrepancy: 100,
        },
        {
          amountReceived: 150, // 200 + 150 = 350 > 300!
          receivedBy: oid(),
          remainingDiscrepancy: 0,
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.ok(error, "Over-settlement must fail validation");
    assert.ok(
      error.errors["incrementalSettlements"],
      "Must trigger error on incrementalSettlements"
    );
    assert.match(
      error.errors["incrementalSettlements"].message,
      /cannot exceed handover discrepancy amount/
    );
  });

  await t.test("8.3 Incremental settlement with incorrect remainingDiscrepancy is rejected", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-SETTLE-03",
      teacherId: oid(),
      submittedAmount: 1000,
      approvedAmount: 700,
      discrepancyAmount: 300,
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "RCPT-SETTLE-3",
        },
      ],
      incrementalSettlements: [
        {
          amountReceived: 200,
          receivedBy: oid(),
          remainingDiscrepancy: 50, // Invalid: 300 - 200 must be 100, not 50!
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.ok(error, "Incorrect remainingDiscrepancy math must fail validation");
    assert.ok(error.errors["incrementalSettlements.0.remainingDiscrepancy"]);
  });

  // =========================================================================
  // 9. Legacy Fee documents validation & hydration (Requirement 9)
  // =========================================================================
  await t.test("9. Legacy Fee documents still validate and hydrate correctly", async () => {
    const legacyFeeId = oid();
    const legacyTeacherId = oid();
    const legacyFee = new Fee({
      _id: legacyFeeId,
      centerId: "msec-center",
      studentId: oid(),
      month: "October 2026",
      billingMonth: "2026-10",
      amountDue: 0,
      paidAmount: 2200,
      dueDate: new Date("2026-10-10"),
      status: "Paid",
      paymentDate: new Date("2026-10-05"),
      paymentMode: "Cash",
      receiptNumber: "LEGACY-RCPT-882",
      receivedBy: legacyTeacherId,
      receivedByRole: "owner",
      recordedBy: legacyTeacherId,
      recordedByRole: "owner",
      // NO paymentHistory, NO originalAmountDue
    });

    const error = await validateDoc(legacyFee);
    assert.equal(
      error,
      undefined,
      "Legacy Fee without paymentHistory must pass validation without errors"
    );

    const synthesized = getFeePaymentEntries(legacyFee);
    assert.equal(synthesized.length, 1);
    assert.equal(synthesized[0].amount, 2200);
    assert.equal(synthesized[0].receiptNumber, "LEGACY-RCPT-882");
    assert.equal(synthesized[0].custodyStatus, "owner_custody");

    const custody = calculatePaymentCustody(synthesized[0]);
    assert.equal(custody.ownerVerifiedAmount, 2200);
    assert.equal(custody.teacherInHandAmount, 0);
  });

  // =========================================================================
  // 10. Existing Phase 4.1 regression invariants (Requirement 10)
  // =========================================================================
  await t.test("10.1 Multiple partial payments by different teachers against same Fee", async () => {
    const teacher1Id = oid();
    const teacher2Id = oid();
    const fee = new Fee({
      centerId: "msec-center",
      studentId: oid(),
      month: "November 2026",
      billingMonth: "2026-11",
      originalAmountDue: 2500,
      amountDue: 0,
      paidAmount: 2500,
      dueDate: new Date("2026-11-10"),
      status: "Paid",
      paymentHistory: [
        {
          amount: 1500,
          paymentDate: new Date("2026-11-02T10:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "PROV-MSEC-001",
          receivedBy: teacher1Id,
          receivedByRole: "teacher",
          recordedBy: teacher1Id,
          recordedByRole: "teacher",
          allocations: [],
        },
        {
          amount: 1000,
          paymentDate: new Date("2026-11-04T12:00:00Z"),
          paymentMode: "Cash",
          receiptNumber: "PROV-MSEC-002",
          receivedBy: teacher2Id,
          receivedByRole: "teacher",
          recordedBy: teacher2Id,
          recordedByRole: "teacher",
          allocations: [],
        },
      ],
    });

    const error = await validateDoc(fee);
    assert.equal(error, undefined);
    assert.equal(fee.paymentHistory.length, 2);
    assert.equal(String(fee.paymentHistory[0].receivedBy), String(teacher1Id));
    assert.equal(String(fee.paymentHistory[1].receivedBy), String(teacher2Id));
  });

  await t.test("10.2 CashHandover rejects mismatch between submittedAmount and items sum", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-SUM-ERR",
      teacherId: oid(),
      submittedAmount: 3000, // 3000 vs items sum 2500
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "pending_approval",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1500,
          receiptNumber: "PROV-001",
        },
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "PROV-002",
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.ok(error?.errors["items"]);
  });

  await t.test("10.3 CashHandover invariant on full approval requires approvedAmount === submittedAmount", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-FULL-ERR",
      teacherId: oid(),
      submittedAmount: 1000,
      approvedAmount: 800, // approved != submitted on full approval
      discrepancyAmount: 0,
      status: "approved",
      discrepancyStatus: "none",
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "PROV-003",
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.ok(error?.errors["approvedAmount"]);
  });

  await t.test("10.4 CashHandover invariant on partial approval requires approved + discrepancy === submitted", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-PARTIAL-ERR",
      teacherId: oid(),
      submittedAmount: 1000,
      approvedAmount: 700,
      discrepancyAmount: 200, // 700 + 200 != 1000
      status: "partially_approved",
      discrepancyStatus: "disputed",
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "PROV-004",
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.ok(error?.errors["discrepancyAmount"]);
  });

  await t.test("10.5 CashHandover rejection requires mandatory rejectionReason", async () => {
    const handover = new CashHandover({
      centerId: "msec-center",
      handoverNumber: "HO-202611-REJ-ERR",
      teacherId: oid(),
      submittedAmount: 1000,
      approvedAmount: 0,
      discrepancyAmount: 0,
      status: "rejected",
      discrepancyStatus: "none",
      // rejectionReason omitted
      items: [
        {
          allocationId: oid(),
          paymentId: oid(),
          feeId: oid(),
          studentId: oid(),
          amount: 1000,
          receiptNumber: "PROV-005",
        },
      ],
      submittedAt: new Date(),
    });

    const error = await validateDoc(handover);
    assert.ok(error?.errors["rejectionReason"]);
  });
});
