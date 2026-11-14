import test from "node:test";
import assert from "node:assert/strict";

const originalEnv = { ...process.env };
function resetEnv() {
  process.env = { ...originalEnv };
}

// Global mongoose mock to prevent real DB connection in unit test runs
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const {
  processScheduledFeeReminders,
  validateQaClockSimulation,
  QA_CLOCK_SIMULATION_TARGET,
} = await import("../tution-desk-be/src/lib/feeReminderScheduler.ts");

const { GET: getProcessReminders, POST: postProcessReminders } = await import(
  "../tution-desk-be/src/app/api/cron/process-fee-reminders/route.ts"
);

const { default: StudentModel } = await import(
  "../tution-desk-be/src/models/Student.ts"
);
const { default: FeeModel } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const { default: FeeReminderLogModel } = await import(
  "../tution-desk-be/src/models/FeeReminderLog.ts"
);
const { default: CenterModel } = await import(
  "../tution-desk-be/src/models/Center.ts"
);

function createMockCronRequest({
  method = "GET",
  url = "http://localhost:3001/api/cron/process-fee-reminders",
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

test("TuitionDesk QA Clock Simulation & Isolation Suite", async (suite) => {
  suite.afterEach(resetEnv);

  const mockQaFee = {
    _id: "6af2be59960e044faeca1749",
    studentId: {
      _id: "6af1f73ab1bcf9141efc36ad",
      name: "QA_STU_MANUAL_ACCEPTANCE_20261109_WF01",
      parentWhatsApp: "919999900011",
      isActive: true,
    },
    centerId: "msce-8267",
    billingMonth: "2026-11",
    totalAmount: 2500,
    amountDue: 2500,
    status: "Pending",
    dueDate: new Date("2026-11-15T06:48:56.571Z"),
    reminderLockUntil: null,
    lastReminderSentAt: null,
    save: async () => {},
  };

  // ---------------------------------------------------------------------------
  // Test 1: Actual current time (Nov 10) strictly rejects future-due fee (Nov 15)
  // ---------------------------------------------------------------------------
  await suite.test(
    "1. Actual current time strictly rejects future-due QA fee (dueDate: Nov 15)",
    async () => {
      const originalFeeFind = FeeModel.find;
      let capturedQuery = null;

      try {
        FeeModel.find = (filter) => {
          capturedQuery = filter;
          // In real MongoDB, dueDate: { $lte: dueThreshold } filters out Nov 15 on Nov 10
          if (mockQaFee.dueDate <= filter.dueDate.$lte) {
            return {
              sort: () => ({ limit: () => ({ populate: () => Promise.resolve([mockQaFee]) }) }),
            };
          }
          return {
            sort: () => ({ limit: () => ({ populate: () => Promise.resolve([]) }) }),
          };
        };

        // Run with actual current time (no QA clock simulation)
        const summary = await processScheduledFeeReminders({
          centerId: "msce-8267",
          studentId: "6af1f73ab1bcf9141efc36ad",
          feeId: "6af2be59960e044faeca1749",
          referenceDate: new Date("2026-11-10T12:00:00+05:30"),
        });

        assert.ok(capturedQuery);
        assert.equal(summary.totalPendingDiscovered, 0);
        assert.equal(summary.eligibleCount, 0);
        assert.equal(summary.dispatchedCount, 0);
      } finally {
        FeeModel.find = originalFeeFind;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Test 2: QA reference time (2026-11-15T12:00:00+05:30) makes exact fee eligible
  // ---------------------------------------------------------------------------
  await suite.test(
    "2. QA reference time (2026-11-15T12:00:00+05:30) makes exact QA fee eligible",
    async () => {
      const originalFeeFind = FeeModel.find;
      const originalFeeFindOne = FeeModel.findOne;
      const originalFeeFindOneAndUpdate = FeeModel.findOneAndUpdate;
      const originalFeeUpdateOne = FeeModel.updateOne;
      const originalLogCreate = FeeReminderLogModel.create;
      const originalCenterFindOne = CenterModel.findOne;

      let capturedQuery = null;
      let claimedFeeId = null;

      try {
        CenterModel.findOne = () => ({
          select: () => ({
            lean: async () => ({ messagingTemplates: {} }),
          }),
        });

        FeeModel.find = (filter) => {
          capturedQuery = filter;
          if (mockQaFee.dueDate <= filter.dueDate.$lte) {
            return {
              sort: () => ({ limit: () => ({ populate: () => Promise.resolve([mockQaFee]) }) }),
            };
          }
          return {
            sort: () => ({ limit: () => ({ populate: () => Promise.resolve([]) }) }),
          };
        };

        FeeModel.findOne = () => ({
          populate: async () => mockQaFee,
        });

        FeeModel.findOneAndUpdate = (query, update) => {
          claimedFeeId = String(query._id);
          return Promise.resolve(mockQaFee);
        };

        FeeModel.updateOne = async () => ({ modifiedCount: 1 });
        FeeReminderLogModel.create = () => Promise.resolve({ _id: "mock_log_qa" });

        const summary = await processScheduledFeeReminders({
          centerId: "msce-8267",
          studentId: "6af1f73ab1bcf9141efc36ad",
          feeId: "6af2be59960e044faeca1749",
          qaClockSimulation: true,
          referenceDate: new Date("2026-11-15T12:00:00+05:30"),
        });

        assert.ok(capturedQuery);
        assert.equal(capturedQuery.centerId, "msce-8267");
        assert.equal(capturedQuery.studentId, "6af1f73ab1bcf9141efc36ad");
        assert.equal(capturedQuery._id, "6af2be59960e044faeca1749");
        assert.equal(summary.totalPendingDiscovered, 1);
        assert.equal(summary.eligibleCount, 1);
        assert.equal(summary.simulatedCount, 1);
        assert.equal(claimedFeeId, "6af2be59960e044faeca1749");
      } finally {
        FeeModel.find = originalFeeFind;
        FeeModel.findOne = originalFeeFindOne;
        FeeModel.findOneAndUpdate = originalFeeFindOneAndUpdate;
        FeeModel.updateOne = originalFeeUpdateOne;
        FeeReminderLogModel.create = originalLogCreate;
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Test 3: Another student's fee cannot be selected or claimed under QA scoping
  // ---------------------------------------------------------------------------
  await suite.test(
    "3. Another student's fee cannot be selected or claimed under QA scoping",
    async () => {
      const otherStudentFee = {
        _id: "fee_shobha_id",
        studentId: {
          _id: "6aed8bfcb1bcf9141efc2931",
          name: "Shobha",
          parentWhatsApp: "8368948820",
          isActive: true,
        },
        centerId: "msce-8267",
        dueDate: new Date("2026-11-10T00:00:00.000Z"),
      };

      const originalFeeFind = FeeModel.find;
      let capturedFilter = null;

      try {
        FeeModel.find = (filter) => {
          capturedFilter = filter;
          // Filter strictly matches studentId and _id
          if (filter.studentId === "6af1f73ab1bcf9141efc36ad" && filter._id === "6af2be59960e044faeca1749") {
            return {
              sort: () => ({ limit: () => ({ populate: () => Promise.resolve([]) }) }),
            };
          }
          // Should never query without QA scoping
          return {
            sort: () => ({ limit: () => ({ populate: () => Promise.resolve([otherStudentFee]) }) }),
          };
        };

        const summary = await processScheduledFeeReminders({
          centerId: "msce-8267",
          studentId: "6af1f73ab1bcf9141efc36ad",
          feeId: "6af2be59960e044faeca1749",
          qaClockSimulation: true,
          referenceDate: new Date("2026-11-15T12:00:00+05:30"),
        });

        assert.equal(capturedFilter.studentId, "6af1f73ab1bcf9141efc36ad");
        assert.equal(capturedFilter._id, "6af2be59960e044faeca1749");
        assert.equal(summary.dispatchedCount, 0);
      } finally {
        FeeModel.find = originalFeeFind;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Test 4: Missing QA flag fails closed to actual system time
  // ---------------------------------------------------------------------------
  await suite.test(
    "4. Missing QA flag fails closed to actual system time",
    () => {
      // 4.1 qaClockSimulation is false
      const resFalse = validateQaClockSimulation({
        qaClockSimulation: false,
        centerId: "msce-8267",
        studentId: "6af1f73ab1bcf9141efc36ad",
        feeId: "6af2be59960e044faeca1749",
        referenceDate: "2026-11-15T12:00:00+05:30",
      });
      assert.equal(resFalse, null);

      // 4.2 qaClockSimulation omitted (undefined)
      const resUnset = validateQaClockSimulation({
        centerId: "msce-8267",
        studentId: "6af1f73ab1bcf9141efc36ad",
        feeId: "6af2be59960e044faeca1749",
        referenceDate: "2026-11-15T12:00:00+05:30",
      });
      assert.equal(resUnset, null);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 5: Mismatched target IDs strictly fail closed
  // ---------------------------------------------------------------------------
  await suite.test(
    "5. Mismatched target IDs (studentId, feeId, centerId) strictly fail closed",
    () => {
      const validRef = "2026-11-15T12:00:00+05:30";

      // 5.1 Mismatched centerId
      assert.equal(
        validateQaClockSimulation({
          qaClockSimulation: true,
          centerId: "other-center-9999",
          studentId: "6af1f73ab1bcf9141efc36ad",
          feeId: "6af2be59960e044faeca1749",
          referenceDate: validRef,
        }),
        null
      );

      // 5.2 Mismatched studentId
      assert.equal(
        validateQaClockSimulation({
          qaClockSimulation: true,
          centerId: "msce-8267",
          studentId: "6aed8bfcb1bcf9141efc2931", // Shobha
          feeId: "6af2be59960e044faeca1749",
          referenceDate: validRef,
        }),
        null
      );

      // 5.3 Mismatched feeId
      assert.equal(
        validateQaClockSimulation({
          qaClockSimulation: true,
          centerId: "msce-8267",
          studentId: "6af1f73ab1bcf9141efc36ad",
          feeId: "6aeed8a6b1bcf9141efc30aa", // Shobha fee
          referenceDate: validRef,
        }),
        null
      );

      // 5.4 Exact match passes
      const validRes = validateQaClockSimulation({
        qaClockSimulation: true,
        centerId: "msce-8267",
        studentId: "6af1f73ab1bcf9141efc36ad",
        feeId: "6af2be59960e044faeca1749",
        referenceDate: validRef,
      });
      assert.ok(validRes instanceof Date);
      assert.equal(validRes.toISOString(), new Date(validRef).toISOString());
    }
  );

  // ---------------------------------------------------------------------------
  // Test 6: Route handler passes QA clock parameters and honors auth
  // ---------------------------------------------------------------------------
  await suite.test(
    "6. Route handler /api/cron/process-fee-reminders safely passes QA clock parameters",
    async () => {
      process.env.CRON_SECRET = "test_cron_secret_32_characters_long!";

      const originalFeeFind = FeeModel.find;
      let capturedRouteFilter = null;

      try {
        FeeModel.find = (filter) => {
          capturedRouteFilter = filter;
          return {
            sort: () => ({ limit: () => ({ populate: () => Promise.resolve([]) }) }),
          };
        };

        const req = createMockCronRequest({
          method: "GET",
          url: "http://localhost:3001/api/cron/process-fee-reminders?centerId=msce-8267&studentId=6af1f73ab1bcf9141efc36ad&feeId=6af2be59960e044faeca1749&qaClockSimulation=true&referenceDate=2026-11-15T12:00:00%2B05:30",
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        });

        const res = await getProcessReminders(req);
        assert.equal(res.status, 200);
        assert.ok(capturedRouteFilter);
        assert.equal(capturedRouteFilter.centerId, "msce-8267");
        assert.equal(capturedRouteFilter.studentId, "6af1f73ab1bcf9141efc36ad");
        assert.equal(capturedRouteFilter._id, "6af2be59960e044faeca1749");
      } finally {
        FeeModel.find = originalFeeFind;
      }
    }
  );
});
