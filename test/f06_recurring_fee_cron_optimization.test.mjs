import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyLockIndexIntegrity,
  resetLockIndexVerificationCache,
} from "../tution-desk-be/src/models/FeeCreationLock.ts";
import { generateMonthlyFees } from "../tution-desk-be/src/lib/feeGenerator.ts";
import { generateOrGetMonthlyFee } from "../tution-desk-be/src/lib/feeService.ts";

test("F-06: Recurring Fee Cron & Lock Index Optimization Suite", async (t) => {
  // =========================================================================
  // 1. VERIFICATION CACHING & PROCESS-LEVEL MEMOIZATION
  // =========================================================================
  await t.test("1. verifyLockIndexIntegrity caches successful verification at process/module scope", async () => {
    resetLockIndexVerificationCache();

    let indexInspectionCount = 0;
    const mockModel = {
      collection: {
        name: "feecreationlocks",
        indexes: async () => {
          indexInspectionCount++;
          return [
            { key: { _id: 1 }, name: "_id_" },
            { key: { lockKey: 1 }, name: "lockKey_1", unique: true },
          ];
        },
      },
    };

    // First call: executes indexes inspection
    const firstResult = await verifyLockIndexIntegrity(mockModel);
    assert.equal(firstResult, true, "First verification must succeed");
    assert.equal(indexInspectionCount, 1, "Must query indexes on first check");

    // Repeat calls (e.g. across 50 students in cron loop): must hit cache
    for (let i = 0; i < 50; i++) {
      const cachedResult = await verifyLockIndexIntegrity(mockModel);
      assert.equal(cachedResult, true, `Call #${i + 2} must return true from cache`);
    }

    assert.equal(
      indexInspectionCount,
      1,
      "indexInspectionCount must remain 1 after 50 consecutive calls"
    );
  });

  // =========================================================================
  // 2. CONCURRENT IN-FLIGHT DEDUPLICATION
  // =========================================================================
  await t.test("2. Concurrent calls share one in-flight verification promise", async () => {
    resetLockIndexVerificationCache();

    let indexInspectionCount = 0;
    let delayResolve;
    const delayedPromise = new Promise((resolve) => {
      delayResolve = resolve;
    });

    const mockModel = {
      collection: {
        name: "feecreationlocks",
        indexes: async () => {
          indexInspectionCount++;
          await delayedPromise;
          return [
            { key: { _id: 1 }, name: "_id_" },
            { key: { lockKey: 1 }, name: "lockKey_1", unique: true },
          ];
        },
      },
    };

    // Fire 10 concurrent verification calls simultaneously
    const calls = Array.from({ length: 10 }, () => verifyLockIndexIntegrity(mockModel));

    // Release the single in-flight resolution
    delayResolve();

    const results = await Promise.all(calls);
    for (const res of results) {
      assert.equal(res, true, "All concurrent callers must receive true");
    }

    assert.equal(
      indexInspectionCount,
      1,
      "collection.indexes() must be called exactly once across 10 concurrent requests"
    );
  });

  // =========================================================================
  // 3. FAILURE IS NOT CACHED PERMANENTLY (RETRY AFTER FAILURE)
  // =========================================================================
  await t.test("3. Failure is not cached permanently; allows retry after failure", async () => {
    resetLockIndexVerificationCache();

    let shouldSucceed = false;
    let checkCount = 0;

    const mockModel = {
      collection: {
        name: "feecreationlocks",
        indexes: async () => {
          checkCount++;
          if (!shouldSucceed) {
            // Missing unique index on lockKey
            return [{ key: { _id: 1 }, name: "_id_" }];
          }
          return [
            { key: { _id: 1 }, name: "_id_" },
            { key: { lockKey: 1 }, name: "lockKey_1", unique: true },
          ];
        },
      },
    };

    // First attempt fails (index missing: checks before and after sync)
    const firstAttempt = await verifyLockIndexIntegrity(mockModel);
    assert.equal(firstAttempt, false, "Must fail when unique index is absent");
    const countAfterFirst = checkCount;
    assert.ok(countAfterFirst >= 1, "Must query indexes on first attempt");

    // Second attempt still fails (index still missing: retry allowed!)
    const secondAttempt = await verifyLockIndexIntegrity(mockModel);
    assert.equal(secondAttempt, false, "Must fail again on retry when still absent");
    assert.ok(checkCount > countAfterFirst, "Must retry and not permanently cache failure");
    const countAfterSecond = checkCount;

    // Remediation: Index is now built in the background
    shouldSucceed = true;

    // Third attempt succeeds
    const thirdAttempt = await verifyLockIndexIntegrity(mockModel);
    assert.equal(thirdAttempt, true, "Must succeed on retry once index is present");
    assert.ok(checkCount > countAfterSecond, "Must query indexes on third attempt");
    const countAfterThird = checkCount;

    // Fourth attempt: now hits cache because it succeeded
    const fourthAttempt = await verifyLockIndexIntegrity(mockModel);
    assert.equal(fourthAttempt, true);
    assert.equal(checkCount, countAfterThird, "Must not re-query after successful verification");
  });

  // =========================================================================
  // 4. BATCH STUDENT QUERYING & IN-MEMORY MAP IN RECURRING CRON
  // =========================================================================
  await t.test("4. generateMonthlyFees batches student queries and eliminates N+1 Student.findById", async () => {
    resetLockIndexVerificationCache();

    let studentFindCount = 0;
    let studentFindByIdCount = 0;

    const mockStudents = [
      {
        _id: "student_batch_1",
        name: "Student Alpha",
        centerId: "center_test",
        monthlyFee: 2000,
        billingCycleDate: 10,
        advanceBalance: 0,
        isActive: true,
        joiningDate: new Date("2024-01-01"),
      },
      {
        _id: "student_batch_2",
        name: "Student Beta",
        centerId: "center_test",
        monthlyFee: 2500,
        billingCycleDate: 10,
        advanceBalance: 0,
        isActive: true,
        joiningDate: new Date("2024-01-01"),
      },
      {
        _id: "student_batch_3",
        name: "Student Gamma",
        centerId: "center_test",
        monthlyFee: 3000,
        billingCycleDate: 10,
        advanceBalance: 0,
        isActive: true,
        joiningDate: new Date("2024-01-01"),
      },
    ];

    const mockStudentModel = {
      find: async () => {
        studentFindCount++;
        return mockStudents;
      },
      findById: async () => {
        studentFindByIdCount++;
        return null;
      },
    };

    const mockFeeModel = {
      find: async () => [],
      findOne: async () => null,
      create: async (doc) => [{ ...doc, _id: "fee_" + Math.random().toString(36).slice(2) }],
    };

    const mockCenterModel = {
      findOne: async () => ({ centerId: "center_test", invoiceDueDayOffset: 5 }),
    };

    const mockLockModel = {
      collection: {
        indexes: async () => [
          { key: { _id: 1 } },
          { key: { lockKey: 1 }, unique: true },
        ],
      },
      create: async () => ({}),
      deleteOne: async () => ({}),
    };

    const result = await generateMonthlyFees({
      centerId: "center_test",
      overrideDay: 10,
      forceAllStudents: true,
      referenceDate: new Date("2026-11-10T05:30:00.000Z"),
      models: {
        Student: mockStudentModel,
        Fee: mockFeeModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.totalEligibleStudents, 3);
    assert.equal(result.generatedCount, 3);

    // Verify query counts: exactly 1 batch find, and ZERO Student.findById lookups in the loop!
    assert.equal(studentFindCount, 1, "Must execute exactly 1 batch Student.find()");
    assert.equal(
      studentFindByIdCount,
      0,
      "Must execute ZERO sequential Student.findById() calls during fee generation"
    );
  });

  // =========================================================================
  // 5. MISSING & INACTIVE STUDENTS ERROR FIDELITY
  // =========================================================================
  await t.test("5. Missing and inactive students in studentMap are strictly handled", async () => {
    resetLockIndexVerificationCache();

    const studentMap = new Map();
    studentMap.set("active_student", {
      _id: "active_student",
      name: "Active Student",
      centerId: "center_val",
      monthlyFee: 1500,
      isActive: true,
      joiningDate: new Date("2024-01-01"),
      billingCycleDate: 5,
    });
    studentMap.set("inactive_student", {
      _id: "inactive_student",
      name: "Deactivated Student",
      centerId: "center_val",
      monthlyFee: 1500,
      isActive: false,
      joiningDate: new Date("2024-01-01"),
      billingCycleDate: 5,
    });

    const mockModels = {
      Fee: { find: async () => [], findOne: async () => null, create: async () => {} },
      Center: { findOne: async () => ({ centerId: "center_val" }) },
      Student: { findById: async () => null },
      FeeCreationLock: {
        hasUniqueLockIndex: async () => true,
        create: async () => ({}),
        deleteOne: async () => ({}),
      },
    };

    // Case A: Missing student ID
    const missingRes = await generateOrGetMonthlyFee({
      centerId: "center_val",
      studentId: "unknown_id",
      studentMap,
      referenceDate: new Date("2026-11-10T05:30:00.000Z"),
      isManual: false,
      models: mockModels,
    });
    assert.equal(missingRes.success, false);
    assert.equal(missingRes.status, "skipped_ineligible");
    assert.match(missingRes.error, /Student not found with ID: unknown_id/);

    // Case B: Inactive student
    const inactiveRes = await generateOrGetMonthlyFee({
      centerId: "center_val",
      studentId: "inactive_student",
      studentMap,
      referenceDate: new Date("2026-11-10T05:30:00.000Z"),
      isManual: false,
      models: mockModels,
    });
    assert.equal(inactiveRes.success, false);
    assert.equal(inactiveRes.status, "skipped_ineligible");
    assert.match(inactiveRes.conflictReason, /is deactivated/);

    // Case C: Cross-center student
    studentMap.set("cross_center_student", {
      _id: "cross_center_student",
      name: "Cross Center Student",
      centerId: "OTHER_CENTER",
      monthlyFee: 1500,
      isActive: true,
      joiningDate: new Date("2024-01-01"),
      billingCycleDate: 5,
    });
    const crossRes = await generateOrGetMonthlyFee({
      centerId: "center_val",
      studentId: "cross_center_student",
      studentMap,
      referenceDate: new Date("2026-11-10T05:30:00.000Z"),
      isManual: false,
      models: mockModels,
    });
    assert.equal(crossRes.success, false);
    assert.equal(crossRes.status, "skipped_ineligible");
    assert.match(crossRes.error, /does not belong to center center_val/);
  });
});
