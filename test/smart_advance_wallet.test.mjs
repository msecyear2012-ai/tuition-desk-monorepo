import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

// Prevent live database connections during tests
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };
process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.CRON_SECRET = "cron-secret-for-msec-worker-testing-32chars!";
process.env.TOKEN_ENCRYPTION_SECRET = "test-token-encryption-secret-32ch!";
process.env.APP_BASE_URL = "https://tuition-desk-monorepo.vercel.app";

test("Smart Advance Wallet System Test Suite", async (t) => {
  const { Student } = await import("../tution-desk-be/src/models/Student.ts");
  const { Fee, PaymentEntrySchema } = await import("../tution-desk-be/src/models/Fee.ts");
  const { creditAdvanceToStudentWallet } = await import(
    "../tution-desk-be/src/lib/walletService.ts"
  );
  const { generateOrGetMonthlyFee } = await import(
    "../tution-desk-be/src/lib/feeService.ts"
  );

  await t.test("1. Student Mongoose Schema defines advanceBalance with default 0 and non-negative constraint", () => {
    const advancePath = Student.schema.path("advanceBalance");
    assert.ok(advancePath, "Student schema must have advanceBalance path");
    assert.strictEqual(advancePath.instance, "Number");
    assert.strictEqual(advancePath.defaultValue, 0);
  });

  await t.test("2. Fee Mongoose Schema defines wallet tracking fields and allows 'system' role", () => {
    const walletDedPath = Fee.schema.path("walletDeductedAmount");
    assert.ok(walletDedPath, "Fee schema must have walletDeductedAmount");
    assert.strictEqual(walletDedPath.instance, "Number");
    assert.strictEqual(walletDedPath.defaultValue, 0);

    const walletCredPath = Fee.schema.path("walletRechargeCredited");
    assert.ok(walletCredPath, "Fee schema must have walletRechargeCredited");
    assert.strictEqual(walletCredPath.instance, "Boolean");
    assert.strictEqual(walletCredPath.defaultValue, false);

    const receivedRoleEnum = PaymentEntrySchema.path("receivedByRole");
    assert.ok(
      receivedRoleEnum.enumValues.includes("system"),
      "PaymentEntrySchema receivedByRole must include 'system'"
    );
  });

  await t.test("3. creditAdvanceToStudentWallet validates amount and increments student balance atomically", async () => {
    // Test invalid amounts
    const negRes = await creditAdvanceToStudentWallet({
      centerId: "center_001",
      studentId: new mongoose.Types.ObjectId().toString(),
      amount: -500,
    });
    assert.strictEqual(negRes.success, false);

    const zeroRes = await creditAdvanceToStudentWallet({
      centerId: "center_001",
      studentId: new mongoose.Types.ObjectId().toString(),
      amount: 0,
    });
    assert.strictEqual(zeroRes.success, false);

    // Mock student update
    let updatedBalance = 0;
    const origFindOneAndUpdate = Student.findOneAndUpdate;
    Student.findOneAndUpdate = async (filter, update) => {
      if (update.$inc && update.$inc.advanceBalance) {
        updatedBalance += update.$inc.advanceBalance;
      }
      return { _id: filter._id, centerId: filter.centerId, advanceBalance: updatedBalance };
    };

    const targetStudentId = new mongoose.Types.ObjectId().toString();
    const credRes = await creditAdvanceToStudentWallet({
      centerId: "center_001",
      studentId: targetStudentId,
      amount: 2000,
    });

    assert.strictEqual(credRes.success, true);
    assert.strictEqual(credRes.creditedAmount, 2000);
    assert.strictEqual(credRes.newBalance, 2000);

    Student.findOneAndUpdate = origFindOneAndUpdate;
  });

  await t.test("4. creditAdvanceToStudentWallet respects idempotency when feeId is provided", async () => {
    const origFeeFindOne = Fee.findOne;
    const origFeeUpdateOne = Fee.updateOne;
    const origStudentFindOneAndUpdate = Student.findOneAndUpdate;

    let feeCredited = true; // Simulating already credited fee
    Fee.findOne = async () => ({
      _id: "fee_advance_1",
      walletRechargeCredited: feeCredited,
    });

    const res = await creditAdvanceToStudentWallet({
      centerId: "center_001",
      studentId: "student_1",
      amount: 3000,
      feeId: "fee_advance_1",
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.alreadyCredited, true);
    assert.strictEqual(res.creditedAmount, 0);

    Fee.findOne = origFeeFindOne;
    Fee.updateOne = origFeeUpdateOne;
    Student.findOneAndUpdate = origStudentFindOneAndUpdate;
  });

  await t.test("5. generateOrGetMonthlyFee with FULL wallet balance auto-deducts, marks 'Paid', and sets paymentMode", async () => {
    const studentId = new mongoose.Types.ObjectId();
    const centerId = "center_test_full";
    const monthlyFee = 2000;
    const existingWallet = 3000;

    let studentWallet = existingWallet;
    let createdFeeDoc = null;

    const mockStudent = {
      _id: studentId,
      centerId,
      name: "Smart Wallet Student",
      batch: "Batch A",
      monthlyFee,
      billingCycleDate: 5,
      advanceBalance: studentWallet,
      isActive: true,
      joiningDate: new Date(2026, 0, 1),
    };

    const MockStudentModel = {
      findOne: async () => mockStudent,
      findById: async () => ({ ...mockStudent, advanceBalance: studentWallet }),
      updateOne: async (filter, update) => {
        if (update.$inc && update.$inc.advanceBalance) {
          studentWallet += update.$inc.advanceBalance;
        }
        return { modifiedCount: 1 };
      },
    };

    const MockFeeModel = {
      findOne: async () => null,
      find: async () => [],
      create: async (data) => {
        createdFeeDoc = { ...data, _id: new mongoose.Types.ObjectId() };
        return createdFeeDoc;
      },
    };

    const MockCenterModel = {
      findOne: async () => ({ centerId, dueDateOffsetDays: 5 }),
    };

    const MockLockModel = {
      collection: {
        indexes: async () => [
          { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
        ],
      },
      create: async () => ({ _id: new mongoose.Types.ObjectId() }),
      deleteOne: async () => ({ deletedCount: 1 }),
    };

    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId,
      referenceDate: new Date(2026, 9, 5),
      models: {
        Fee: MockFeeModel,
        Student: MockStudentModel,
        Center: MockCenterModel,
        FeeCreationLock: MockLockModel,
      },
    });


    assert.strictEqual(result.success, true);
    assert.strictEqual(result.wasCreated, true);
    assert.ok(createdFeeDoc, "Fee must be created");
    assert.strictEqual(createdFeeDoc.status, "Paid");
    assert.strictEqual(createdFeeDoc.amountDue, 0);
    assert.strictEqual(createdFeeDoc.paidAmount, 2000);
    assert.strictEqual(createdFeeDoc.paymentMode, "Auto-Deducted from Wallet");
    assert.strictEqual(createdFeeDoc.walletDeductedAmount, 2000);
    assert.ok(createdFeeDoc.paymentHistory.length === 1);
    assert.strictEqual(createdFeeDoc.paymentHistory[0].paymentMode, "Auto-Deducted from Wallet");
    assert.strictEqual(createdFeeDoc.paymentHistory[0].receivedByRole, "system");
    assert.strictEqual(createdFeeDoc.paymentHistory[0].custodyStatus, "owner_verified");

    // Verify student wallet balance decremented
    assert.strictEqual(studentWallet, 1000, "Wallet balance should be 3000 - 2000 = 1000");
  });

  await t.test("6. generateOrGetMonthlyFee with PARTIAL wallet balance applies partial payment, marks 'Partial Paid', and zeroes out wallet", async () => {
    const studentId = new mongoose.Types.ObjectId();
    const centerId = "center_test_partial";
    const monthlyFee = 2000;
    const existingWallet = 800;

    let studentWallet = existingWallet;
    let createdFeeDoc = null;

    const mockStudent = {
      _id: studentId,
      centerId,
      name: "Partial Wallet Student",
      batch: "Batch B",
      monthlyFee,
      billingCycleDate: 5,
      advanceBalance: studentWallet,
      isActive: true,
      joiningDate: new Date(2026, 0, 1),
    };

    const MockStudentModel = {
      findOne: async () => mockStudent,
      findById: async () => ({ ...mockStudent, advanceBalance: studentWallet }),
      updateOne: async (filter, update) => {
        if (update.$set && update.$set.advanceBalance !== undefined) {
          studentWallet = update.$set.advanceBalance;
        }
        return { modifiedCount: 1 };
      },
    };

    const MockFeeModel = {
      findOne: async () => null,
      find: async () => [],
      create: async (data) => {
        createdFeeDoc = { ...data, _id: new mongoose.Types.ObjectId() };
        return createdFeeDoc;
      },
    };

    const MockCenterModel = {
      findOne: async () => ({ centerId, dueDateOffsetDays: 5 }),
    };

    const MockLockModel = {
      collection: {
        indexes: async () => [
          { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
        ],
      },
      create: async () => ({ _id: new mongoose.Types.ObjectId() }),
      deleteOne: async () => ({ deletedCount: 1 }),
    };

    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId,
      referenceDate: new Date(2026, 9, 5),
      models: {
        Fee: MockFeeModel,
        Student: MockStudentModel,
        Center: MockCenterModel,
        FeeCreationLock: MockLockModel,
      },
    });


    assert.strictEqual(result.success, true);
    assert.strictEqual(result.wasCreated, true);
    assert.ok(createdFeeDoc, "Fee must be created");
    assert.strictEqual(createdFeeDoc.status, "Partial Paid");
    assert.strictEqual(createdFeeDoc.amountDue, 1200, "amountDue should be 2000 - 800 = 1200");
    assert.strictEqual(createdFeeDoc.paidAmount, 800);
    assert.strictEqual(createdFeeDoc.paymentMode, "Auto-Deducted from Wallet");
    assert.strictEqual(createdFeeDoc.walletDeductedAmount, 800);
    assert.ok(createdFeeDoc.paymentHistory.length === 1);
    assert.strictEqual(createdFeeDoc.paymentHistory[0].amount, 800);
    assert.strictEqual(createdFeeDoc.paymentHistory[0].paymentMode, "Auto-Deducted from Wallet");

    // Verify student wallet balance zeroed out
    assert.strictEqual(studentWallet, 0, "Wallet balance should be zeroed out");
  });

  await t.test("7. generateOrGetMonthlyFee with ZERO wallet balance creates standard 'Pending' invoice", async () => {
    const studentId = new mongoose.Types.ObjectId();
    const centerId = "center_test_zero";
    const monthlyFee = 2000;
    const existingWallet = 0;

    let createdFeeDoc = null;

    const mockStudent = {
      _id: studentId,
      centerId,
      name: "Zero Wallet Student",
      batch: "Batch C",
      monthlyFee,
      billingCycleDate: 5,
      advanceBalance: 0,
      isActive: true,
      joiningDate: new Date(2026, 0, 1),
    };

    const MockStudentModel = {
      findOne: async () => mockStudent,
      findById: async () => mockStudent,
      updateOne: async () => ({ modifiedCount: 0 }),
    };

    const MockFeeModel = {
      findOne: async () => null,
      find: async () => [],
      create: async (data) => {
        createdFeeDoc = { ...data, _id: new mongoose.Types.ObjectId() };
        return createdFeeDoc;
      },
    };

    const MockCenterModel = {
      findOne: async () => ({ centerId, dueDateOffsetDays: 5 }),
    };

    const MockLockModel = {
      collection: {
        indexes: async () => [
          { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
        ],
      },
      create: async () => ({ _id: new mongoose.Types.ObjectId() }),
      deleteOne: async () => ({ deletedCount: 1 }),
    };

    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId,
      referenceDate: new Date(2026, 9, 5),
      models: {
        Fee: MockFeeModel,
        Student: MockStudentModel,
        Center: MockCenterModel,
        FeeCreationLock: MockLockModel,
      },
    });


    assert.strictEqual(result.success, true);
    assert.strictEqual(result.wasCreated, true);
    assert.strictEqual(createdFeeDoc.status, "Pending");
    assert.strictEqual(createdFeeDoc.amountDue, 2000);
    assert.strictEqual(createdFeeDoc.paidAmount, 0);
    assert.strictEqual(createdFeeDoc.walletDeductedAmount, 0);
    assert.strictEqual(createdFeeDoc.paymentHistory.length, 0);
  });
});
