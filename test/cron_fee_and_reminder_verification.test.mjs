process.env.CRON_SECRET = "super_secure_cron_secret_32_chars_123";
process.env.JWT_SECRET = "test_jwt_secret_key_32_chars_ok";
process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://localhost:27017/test_tuitiondesk";

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

globalThis.mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };

// Import models
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
const FeeCreationLockModel = (await import("../tution-desk-be/src/models/FeeCreationLock.ts")).default;

// Import cron and engine functions
const { generateMonthlyFees } = await import("../tution-desk-be/src/lib/feeGenerator.ts");
const { generateOrGetMonthlyFee } = await import("../tution-desk-be/src/lib/feeService.ts");
const { checkReminderEligibility } = await import("../tution-desk-be/src/lib/reminderService.ts");
const { processScheduledFeeReminders } = await import("../tution-desk-be/src/lib/feeReminderScheduler.ts");

// Import cron route handlers
const { GET: generateFeesGetRoute, POST: generateFeesPostRoute } = await import(
  "../tution-desk-be/src/app/api/cron/generate-fees/route.ts"
);
const { GET: feeRemindersGetRoute, POST: feeRemindersPostRoute } = await import(
  "../tution-desk-be/src/app/api/cron/process-fee-reminders/route.ts"
);

function createMockCronRequest({
  method = "GET",
  url = "http://localhost:3000/api/cron/generate-fees",
  headers = {},
  body = null,
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }

  return {
    method,
    nextUrl: new URL(url),
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) || null,
    },
    json: async () => body || {},
  };
}

test("Cron Fee Generation & WhatsApp Reminder Verification Suite", async (t) => {
  const centerId = "center_cron_verify_101";
  const student1Id = "507f191e810c19729de86011";

  // Common lock mock that satisfies index verification and atomic locking
  const mockLockModel = {
    collection: {
      indexes: async () => [
        { key: { _id: 1 } },
        { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
        { key: { expiresAt: 1 }, expireAfterSeconds: 600, name: "expiresAt_1" },
      ],
    },
    create: async (doc) => doc,
    findOneAndUpdate: async () => null,
    findOne: async () => null,
    deleteOne: async () => ({ acknowledged: true, deletedCount: 1 }),
  };

  const mockCenterModel = {
    findOne: async () => ({ centerId, dueDateOffsetDays: 5 }),
  };

  // =========================================================================
  // Scenario 1: Standard Cycle (₹0 Advance)
  // Student with monthlyFee: 2500 and advanceBalance: 0 on their billing day:
  // -> Cron creates a Pending fee (originalAmountDue: 2500, amountDue: 2500, paidAmount: 0)
  // -> checkReminderEligibility / reminder discovery marks it eligible for WhatsApp reminder.
  // =========================================================================
  await t.test("Scenario 1: Standard Cycle (₹0 Advance) creates Pending fee and marks it eligible for WhatsApp reminder", async () => {
    let student = {
      _id: new mongoose.Types.ObjectId(student1Id),
      centerId,
      name: "Rohan Gupta",
      batch: "Class 10 CBSE",
      monthlyFee: 2500,
      billingCycleDate: 10,
      advanceBalance: 0,
      isActive: true,
      joiningDate: new Date("2026-01-01"),
      parentWhatsApp: "919876543210",
    };

    let createdFee = null;

    const mockStudentModel = {
      find: async () => [student],
      findById: async () => student,
      updateOne: async () => ({ modifiedCount: 1 }),
    };

    const mockFeeModel = {
      find: async () => [],
      findOne: async () => null,
      create: async (doc) => {
        createdFee = {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de860f1"),
          ...doc,
          dueDate: new Date("2026-11-15T00:00:00.000Z"),
        };
        return createdFee;
      },
    };

    const res = await generateOrGetMonthlyFee({
      centerId,
      studentId: student._id,
      student,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-10T10:00:00.000Z"),
      isManual: false,
      models: {
        Student: mockStudentModel,
        Fee: mockFeeModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(res.success, true);
    assert.equal(res.wasCreated, true);
    assert.equal(res.status, "created");
    assert.ok(createdFee);

    // Assert Fee attributes
    assert.equal(createdFee.status, "Pending", "Fee status must be Pending");
    assert.equal(createdFee.originalAmountDue, 2500, "originalAmountDue must be 2500");
    assert.equal(createdFee.amountDue, 2500, "amountDue must be 2500");
    assert.equal(createdFee.paidAmount, 0, "paidAmount must be 0");
    assert.equal(student.advanceBalance, 0, "advanceBalance must remain 0");

    // Assert WhatsApp Reminder Eligibility
    const reminderEligibility = checkReminderEligibility(
      createdFee,
      student,
      "auto_due_date",
      new Date("2026-11-16T10:00:00.000Z")
    );
    assert.equal(
      reminderEligibility.eligible,
      true,
      "Pending fee with due date arrived must be eligible for WhatsApp reminder"
    );
  });

  // =========================================================================
  // Scenario 2: Full Advance Auto-Deduction
  // Student with monthlyFee: 2500 and advanceBalance: 3500:
  // -> Cron creates a Paid fee (amountDue: 0, paidAmount: 2500)
  // -> Decrements student.advanceBalance to 1000
  // -> Reminder scheduler strictly skips sending a WhatsApp reminder.
  // =========================================================================
  await t.test("Scenario 2: Full Advance Auto-Deduction creates Paid fee, deducts wallet to 1000, and strictly skips WhatsApp reminder", async () => {
    let student = {
      _id: new mongoose.Types.ObjectId(student1Id),
      centerId,
      name: "Aanya Sharma",
      batch: "Class 10 CBSE",
      monthlyFee: 2500,
      billingCycleDate: 10,
      advanceBalance: 3500,
      isActive: true,
      joiningDate: new Date("2026-01-01"),
      parentWhatsApp: "919876543211",
    };

    let createdFee = null;
    let walletDeducted = 0;

    const mockStudentModel = {
      find: async () => [student],
      findById: async () => student,
      updateOne: async (query, update) => {
        if (update.$inc && typeof update.$inc.advanceBalance === "number") {
          student.advanceBalance += update.$inc.advanceBalance;
          walletDeducted = Math.abs(update.$inc.advanceBalance);
        }
        return { modifiedCount: 1 };
      },
    };

    const mockFeeModel = {
      find: async () => [],
      findOne: async () => null,
      create: async (doc) => {
        createdFee = {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de860f2"),
          ...doc,
          dueDate: new Date("2026-11-15T00:00:00.000Z"),
        };
        return createdFee;
      },
    };

    const res = await generateOrGetMonthlyFee({
      centerId,
      studentId: student._id,
      student,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-10T10:00:00.000Z"),
      isManual: false,
      models: {
        Student: mockStudentModel,
        Fee: mockFeeModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(res.success, true);
    assert.equal(res.wasCreated, true);
    assert.ok(createdFee);

    // Assert Paid fee status & wallet attributes
    assert.equal(createdFee.status, "Paid", "Status must be Paid when advance covers entire monthly fee");
    assert.equal(createdFee.originalAmountDue, 2500);
    assert.equal(createdFee.amountDue, 0, "amountDue must be 0");
    assert.equal(createdFee.paidAmount, 2500, "paidAmount must be 2500");
    assert.equal(createdFee.paymentMode, "Auto-Deducted from Wallet");
    assert.equal(createdFee.walletDeductedAmount, 2500);

    // Assert advance balance decremented correctly: 3500 - 2500 = 1000
    assert.equal(walletDeducted, 2500, "Wallet deduction must equal monthlyFee (2500)");
    assert.equal(student.advanceBalance, 1000, "student.advanceBalance must decrement to 1000");

    // Assert WhatsApp Reminder is strictly skipped
    const reminderEligibility = checkReminderEligibility(
      createdFee,
      student,
      "auto_due_date",
      new Date("2026-11-16T10:00:00.000Z")
    );
    assert.equal(
      reminderEligibility.eligible,
      false,
      "Paid fee must NOT be eligible for WhatsApp reminder"
    );
    assert.equal(
      reminderEligibility.reason,
      "fee_already_paid",
      "Ineligibility reason must be fee_already_paid"
    );
  });

  // =========================================================================
  // Scenario 3: Partial Advance Auto-Deduction
  // Student with monthlyFee: 2500 and advanceBalance: 1000:
  // -> Cron creates a Partial Paid fee (amountDue: 1500, paidAmount: 1000)
  // -> Sets student.advanceBalance to 0
  // -> Reminder eligibility allows reminding for the remaining ₹1,500.
  // =========================================================================
  await t.test("Scenario 3: Partial Advance Auto-Deduction creates Partial Paid fee (Due: ₹1500, Paid: ₹1000), resets wallet to 0, and allows reminder for ₹1500", async () => {
    let student = {
      _id: new mongoose.Types.ObjectId(student1Id),
      centerId,
      name: "Dev Patel",
      batch: "Class 10 CBSE",
      monthlyFee: 2500,
      billingCycleDate: 10,
      advanceBalance: 1000,
      isActive: true,
      joiningDate: new Date("2026-01-01"),
      parentWhatsApp: "919876543212",
    };

    let createdFee = null;

    const mockStudentModel = {
      find: async () => [student],
      findById: async () => student,
      updateOne: async (query, update) => {
        if (update.$set && update.$set.advanceBalance === 0) {
          student.advanceBalance = 0;
        }
        return { modifiedCount: 1 };
      },
    };

    const mockFeeModel = {
      find: async () => [],
      findOne: async () => null,
      create: async (doc) => {
        createdFee = {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de860f3"),
          ...doc,
          dueDate: new Date("2026-11-15T00:00:00.000Z"),
        };
        return createdFee;
      },
    };

    const res = await generateOrGetMonthlyFee({
      centerId,
      studentId: student._id,
      student,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-10T10:00:00.000Z"),
      isManual: false,
      models: {
        Student: mockStudentModel,
        Fee: mockFeeModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(res.success, true);
    assert.equal(res.wasCreated, true);
    assert.ok(createdFee);

    // Assert Partial Paid fee attributes
    assert.equal(createdFee.status, "Partial Paid", "Status must be Partial Paid");
    assert.equal(createdFee.originalAmountDue, 2500);
    assert.equal(createdFee.paidAmount, 1000, "paidAmount must equal partial advance (1000)");
    assert.equal(createdFee.amountDue, 1500, "amountDue must be remaining 1500");
    assert.equal(createdFee.walletDeductedAmount, 1000);

    // Assert student wallet exhausted to 0
    assert.equal(student.advanceBalance, 0, "advanceBalance must be 0 after partial deduction");

    // Assert WhatsApp Reminder is eligible for the remaining balance
    const reminderEligibility = checkReminderEligibility(
      createdFee,
      student,
      "auto_due_date",
      new Date("2026-11-16T10:00:00.000Z")
    );
    assert.equal(
      reminderEligibility.eligible,
      true,
      "Partial Paid fee must remain eligible for WhatsApp reminder"
    );
    assert.equal(createdFee.amountDue, 1500, "Reminder amount corresponds to ₹1,500 due");
  });

  // =========================================================================
  // Scenario 4: Idempotency (No Double Billing / Double Deduction)
  // Running the fee generator twice for the exact same billing month:
  // -> First run: creates fee, deducts advance balance (3500 -> 1000)
  // -> Second run: returns status reused, does NOT create a second fee, does NOT deduct advance again (remains 1000).
  // =========================================================================
  await t.test("Scenario 4: Idempotency guarantees no duplicate fee and zero double-deduction on repeat cron runs", async () => {
    let student = {
      _id: new mongoose.Types.ObjectId(student1Id),
      centerId,
      name: "Sneha Nair",
      batch: "Class 10 CBSE",
      monthlyFee: 2500,
      billingCycleDate: 10,
      advanceBalance: 3500,
      isActive: true,
      joiningDate: new Date("2026-01-01"),
    };

    let feeDatabase = [];

    const mockStudentModel = {
      find: async () => [student],
      findById: async () => student,
      updateOne: async (query, update) => {
        if (update.$inc && typeof update.$inc.advanceBalance === "number") {
          student.advanceBalance += update.$inc.advanceBalance;
        }
        return { modifiedCount: 1 };
      },
    };

    const mockFeeModel = {
      find: async () => feeDatabase,
      findOne: async (query) => {
        return feeDatabase.find((f) => f.billingMonth === query.billingMonth) || null;
      },
      create: async (doc) => {
        const created = {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de860f4"),
          ...doc,
        };
        feeDatabase.push(created);
        return created;
      },
    };

    // First Cron Run: Generates fee and deducts ₹2,500 advance
    const run1 = await generateOrGetMonthlyFee({
      centerId,
      studentId: student._id,
      student,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-10T10:00:00.000Z"),
      isManual: false,
      models: {
        Student: mockStudentModel,
        Fee: mockFeeModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(run1.success, true);
    assert.equal(run1.wasCreated, true);
    assert.equal(feeDatabase.length, 1);
    assert.equal(student.advanceBalance, 1000, "Advance balance must be 1000 after Run 1");

    // Second Cron Run (Idempotency Trigger for same billing month):
    const run2 = await generateOrGetMonthlyFee({
      centerId,
      studentId: student._id,
      student,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-10T11:00:00.000Z"),
      isManual: false,
      models: {
        Student: mockStudentModel,
        Fee: mockFeeModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(run2.success, true);
    assert.equal(run2.wasCreated, false, "Must NOT create a new fee on repeat run");
    assert.equal(run2.status, "reused", "Must report status 'reused'");
    assert.equal(feeDatabase.length, 1, "Database fee count must remain exactly 1");
    assert.equal(
      student.advanceBalance,
      1000,
      "CRITICAL: advanceBalance must NOT be deducted a second time (remains exactly 1000)"
    );
  });

  // =========================================================================
  // Scenario 5: Cron Auth / Endpoint Sanity
  // Verify /api/cron/generate-fees and reminder cron route:
  // -> Missing secret: HTTP 401
  // -> Invalid secret: HTTP 401
  // -> Valid secret: HTTP 200
  // =========================================================================
  await t.test("Scenario 5: Cron routes strictly reject unauthorized requests without valid secret (fail-closed security)", async () => {
    // 1. Missing secret on /api/cron/generate-fees -> 401
    const reqNoSecret = createMockCronRequest({
      method: "GET",
      url: "http://localhost:3000/api/cron/generate-fees",
      headers: {},
    });
    const resNoSecret = await generateFeesGetRoute(reqNoSecret);
    assert.equal(resNoSecret.status, 401, "Missing secret must return 401");
    const jsonNoSecret = await resNoSecret.json();
    assert.equal(jsonNoSecret.success, false);
    assert.match(jsonNoSecret.error, /Unauthorized/i);

    // 2. Invalid secret on /api/cron/generate-fees -> 401
    const reqBadSecret = createMockCronRequest({
      method: "POST",
      url: "http://localhost:3000/api/cron/generate-fees",
      headers: {
        authorization: "Bearer wrong_invalid_secret_key",
      },
    });
    const resBadSecret = await generateFeesPostRoute(reqBadSecret);
    assert.equal(resBadSecret.status, 401, "Invalid secret must return 401");
    const jsonBadSecret = await resBadSecret.json();
    assert.equal(jsonBadSecret.success, false);

    // 3. Missing secret on /api/cron/process-fee-reminders -> 401
    const reqReminderNoSecret = createMockCronRequest({
      method: "GET",
      url: "http://localhost:3000/api/cron/process-fee-reminders",
      headers: {},
    });
    const resReminderNoSecret = await feeRemindersGetRoute(reqReminderNoSecret);
    assert.equal(resReminderNoSecret.status, 401, "Reminder cron missing secret must return 401");
    const jsonReminderNoSecret = await resReminderNoSecret.json();
    assert.equal(jsonReminderNoSecret.success, false);

    // 4. Invalid secret on /api/cron/process-fee-reminders -> 401
    const reqReminderBadSecret = createMockCronRequest({
      method: "POST",
      url: "http://localhost:3000/api/cron/process-fee-reminders",
      headers: {
        "x-cron-secret": "wrong_cron_secret",
      },
    });
    const resReminderBadSecret = await feeRemindersPostRoute(reqReminderBadSecret);
    assert.equal(resReminderBadSecret.status, 401, "Reminder cron invalid secret must return 401");

    // 5. Valid secret on /api/cron/generate-fees -> 200
    // Mock StudentModel.find and FeeModel.find to return empty array for fast route validation
    const origStudentFind = StudentModel.find;
    const origFeeFind = FeeModel.find;
    StudentModel.find = async () => [];
    FeeModel.find = async () => [];

    try {
      const reqValid = createMockCronRequest({
        method: "GET",
        url: "http://localhost:3000/api/cron/generate-fees?day=10",
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      });
      const resValid = await generateFeesGetRoute(reqValid);
      assert.equal(resValid.status, 200, "Valid authorization must return 200 OK");
      const jsonValid = await resValid.json();
      assert.ok(jsonValid.message, "Must return completion message");
      assert.equal(typeof jsonValid.generatedCount, "number");
    } finally {
      StudentModel.find = origStudentFind;
      FeeModel.find = origFeeFind;
    }
  });
});
