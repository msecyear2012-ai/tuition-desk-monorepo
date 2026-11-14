process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "../tution-desk-be/node_modules/mongoose/index.js";

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const { calculatePaymentCustody, calculateFeeCustody } = await import("../tution-desk-be/src/models/Fee.ts");

test("Cash Handover Custody Status Enum Validation Suite", async (t) => {
  const centerId = "msce-8267";
  const studentId = new mongoose.Types.ObjectId();
  const teacherId = new mongoose.Types.ObjectId();

  await t.test("1. Schema enum includes all 7 canonical lifecycle custody statuses", () => {
    const paymentHistoryPath = FeeModel.schema.path("paymentHistory");
    const subdocSchema = paymentHistoryPath.schema;
    const custodyStatusPath = subdocSchema.path("custodyStatus");
    const enumValues = custodyStatusPath.enumValues;

    const expectedStatuses = [
      "teacher_custody",
      "teacher_in_hand",
      "owner_pending",
      "owner_verified",
      "owner_custody",
      "shortage_deficit",
      "split_custody",
    ];

    for (const status of expectedStatuses) {
      assert.ok(
        enumValues.includes(status),
        `Fee schema custodyStatus enum must include '${status}', found: ${JSON.stringify(enumValues)}`
      );
    }
    assert.equal(enumValues.length, 7, "Enum should contain exactly the 7 canonical statuses");
  });

  await t.test("2. Saving a Fee document with custodyStatus: 'owner_pending' validates cleanly without error", () => {
    const feeDoc = new FeeModel({
      centerId,
      studentId,
      feeType: "monthly_recurring",
      academicYear: "2026-2027",
      billingMonth: "2026-11",
      month: "November",
      dueDate: new Date("2026-11-10"),
      amountDue: 1500,
      originalAmountDue: 1500,
      amountPaid: 1500,
      paymentStatus: "paid",
      assignedTeacher: teacherId,
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId().toString(),
          receiptNumber: "REC-2026-0001",
          amount: 1500,
          paymentMode: "Cash",
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          custodyStatus: "owner_pending", // This was previously failing with ValidationError
          allocations: [],
        },
      ],
    });

    const validationError = feeDoc.validateSync();
    assert.equal(
      validationError,
      undefined,
      `Validation should succeed for 'owner_pending', but got: ${validationError?.message}`
    );
  });

  await t.test("3. All 7 canonical custody statuses validate cleanly on Fee paymentHistory", () => {
    const allStatuses = [
      "teacher_custody",
      "teacher_in_hand",
      "owner_pending",
      "owner_verified",
      "owner_custody",
      "shortage_deficit",
      "split_custody",
    ];

    for (const status of allStatuses) {
      const feeDoc = new FeeModel({
        centerId,
        studentId,
        feeType: "monthly_recurring",
        academicYear: "2026-2027",
        billingMonth: "2026-11",
        month: "November",
        dueDate: new Date("2026-11-10"),
        amountDue: 1000,
        originalAmountDue: 1000,
        amountPaid: 1000,
        paymentStatus: "paid",
        assignedTeacher: teacherId,
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId().toString(),
            receiptNumber: `REC-${status}`,
            amount: 1000,
            paymentMode: "Cash",
            receivedBy: teacherId,
            receivedByRole: "teacher",
            recordedBy: teacherId,
            recordedByRole: "teacher",
            custodyStatus: status,
            allocations: [],
          },
        ],
      });

      const err = feeDoc.validateSync();
      assert.equal(
        err,
        undefined,
        `Status '${status}' should validate cleanly, but got: ${err?.message}`
      );
    }
  });

  await t.test("4. Invalid custody status correctly triggers Mongoose ValidationError", () => {
    const feeDoc = new FeeModel({
      centerId,
      studentId,
      feeType: "monthly_recurring",
      academicYear: "2026-2027",
      billingMonth: "November 2026",
      amountDue: 1000,
      originalAmountDue: 1000,
      amountPaid: 1000,
      paymentStatus: "paid",
      assignedTeacher: teacherId,
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId().toString(),
          receiptNumber: "REC-INVALID",
          amount: 1000,
          paymentMode: "Cash",
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          custodyStatus: "invalid_unsupported_status",
          allocations: [],
        },
      ],
    });

    const err = feeDoc.validateSync();
    assert.ok(err, "Invalid custody status must produce a validation error");
    assert.match(
      err.errors["paymentHistory.0.custodyStatus"]?.message || "",
      /is not a valid custody status/,
      "Error message should mention invalid custody status"
    );
  });

  await t.test("5. calculatePaymentCustody correctly calculates lifecycle custody labels", () => {
    // A: In hand (no allocations)
    const inHandEntry = {
      amount: 1500,
      paymentMode: "Cash",
      allocations: [],
    };
    const inHandResult = calculatePaymentCustody(inHandEntry);
    assert.equal(inHandResult.custodyLabel, "teacher_in_hand");
    assert.equal(inHandResult.teacherInHandAmount, 1500);
    assert.equal(inHandResult.ownerPendingVerificationAmount, 0);
    assert.equal(inHandResult.ownerVerifiedAmount, 0);

    // B: Pending verification (submitted in handover envelope)
    const pendingEntry = {
      amount: 1500,
      paymentMode: "Cash",
      allocations: [
        {
          allocatedAmount: 1500,
          status: "pending_verification",
        },
      ],
    };
    const pendingResult = calculatePaymentCustody(pendingEntry);
    assert.equal(pendingResult.custodyLabel, "owner_pending");
    assert.equal(pendingResult.teacherInHandAmount, 0);
    assert.equal(pendingResult.ownerPendingVerificationAmount, 1500);

    // C: Owner verified (handover accepted)
    const verifiedEntry = {
      amount: 1500,
      paymentMode: "Cash",
      allocations: [
        {
          allocatedAmount: 1500,
          verifiedAmount: 1500,
          status: "verified",
        },
      ],
    };
    const verifiedResult = calculatePaymentCustody(verifiedEntry);
    assert.equal(verifiedResult.custodyLabel, "owner_verified");
    assert.equal(verifiedResult.ownerVerifiedAmount, 1500);
    assert.equal(verifiedResult.teacherInHandAmount, 0);

    // D: Split custody (partial allocation / partial handover)
    const splitEntry = {
      amount: 1500,
      paymentMode: "Cash",
      allocations: [
        {
          allocatedAmount: 800,
          status: "pending_verification",
        },
      ],
    };
    const splitResult = calculatePaymentCustody(splitEntry);
    assert.equal(splitResult.custodyLabel, "split_custody");
    assert.equal(splitResult.teacherInHandAmount, 700);
    assert.equal(splitResult.ownerPendingVerificationAmount, 800);

    // E: Disputed / confirmed shortage deficit
    const shortageEntry = {
      amount: 1500,
      paymentMode: "Cash",
      allocations: [
        {
          allocatedAmount: 1500,
          verifiedAmount: 0,
          status: "shortage_confirmed",
        },
      ],
    };
    const shortageResult = calculatePaymentCustody(shortageEntry);
    assert.equal(shortageResult.custodyLabel, "shortage_deficit");
    assert.equal(shortageResult.disputedDiscrepancyAmount, 1500);
  });

  await t.test("6. Full handover submission custody lifecycle transition simulates without validation errors", () => {
    // 1. Initial manual cash payment by teacher
    const feeDoc = new FeeModel({
      centerId,
      studentId,
      feeType: "monthly_recurring",
      academicYear: "2026-2027",
      billingMonth: "2026-11",
      month: "November",
      dueDate: new Date("2026-11-10"),
      amountDue: 1500,
      originalAmountDue: 1500,
      amountPaid: 1500,
      paymentStatus: "paid",
      assignedTeacher: teacherId,
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId().toString(),
          receiptNumber: "REC-LIFECYCLE-001",
          amount: 1500,
          paymentMode: "Cash",
          receivedBy: teacherId,
          receivedByRole: "teacher",
          recordedBy: teacherId,
          recordedByRole: "teacher",
          custodyStatus: "teacher_custody",
          allocations: [],
        },
      ],
    });
    assert.equal(feeDoc.validateSync(), undefined);

    const paymentEntry = feeDoc.paymentHistory[0];

    // 2. Teacher submits payment into Cash Handover envelope
    const handoverAllocationId = new mongoose.Types.ObjectId();
    paymentEntry.allocations.push({
      _id: handoverAllocationId,
      allocationId: handoverAllocationId,
      handoverId: new mongoose.Types.ObjectId(),
      handoverNumber: "HND-2026-0001",
      allocatedAmount: 1500,
      allocatedAt: new Date(),
      allocatedBy: teacherId,
      status: "pending_verification",
    });

    const custodyBreakdown = calculatePaymentCustody(paymentEntry);
    assert.equal(custodyBreakdown.custodyLabel, "owner_pending");
    paymentEntry.custodyStatus = custodyBreakdown.custodyLabel;

    // Must validate cleanly when saving feeDoc at line 276 of api/handovers/route.ts
    const submissionValidationError = feeDoc.validateSync();
    assert.equal(
      submissionValidationError,
      undefined,
      `Submission validation must not fail when custodyStatus is 'owner_pending'`
    );

    // 3. Owner verifies the cash handover
    paymentEntry.allocations[0].status = "verified";
    paymentEntry.allocations[0].verifiedAmount = 1500;
    paymentEntry.allocations[0].verifiedAt = new Date();

    const verifiedCustody = calculatePaymentCustody(paymentEntry);
    assert.equal(verifiedCustody.custodyLabel, "owner_verified");
    paymentEntry.custodyStatus = verifiedCustody.custodyLabel;

    const verificationValidationError = feeDoc.validateSync();
    assert.equal(
      verificationValidationError,
      undefined,
      `Verification validation must not fail when custodyStatus is 'owner_verified'`
    );

    // 4. Rejection lifecycle test: if rejected, allocation status is "rejected"
    paymentEntry.allocations[0].status = "rejected";
    const rejectedCustody = calculatePaymentCustody(paymentEntry);
    assert.equal(rejectedCustody.custodyLabel, "teacher_in_hand");
    paymentEntry.custodyStatus = rejectedCustody.custodyLabel;

    const rejectionValidationError = feeDoc.validateSync();
    assert.equal(
      rejectionValidationError,
      undefined,
      `Rejection validation must not fail when custodyStatus is 'teacher_in_hand'`
    );
  });
});
