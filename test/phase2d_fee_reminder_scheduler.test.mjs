import test from "node:test";
import assert from "node:assert/strict";

const randomHex24 = () =>
  "507f191e810c19729de8" + Math.floor(1000 + Math.random() * 9000);

process.env.CRON_SECRET = "test_cron_secret_reminder_scheduler_32chars!";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/test_tuitiondesk";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-phase2d-reminders";
process.env.WHATSAPP_MODE = "simulation";
process.env.ENABLE_LIVE_WHATSAPP = "false";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-64-chars-length";

// Ensure connectDB does not attempt real network connection in tests
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const { GET, POST, maxDuration } = await import(
  "../tution-desk-be/src/app/api/cron/process-fee-reminders/route.ts"
);
const { processScheduledFeeReminders } = await import(
  "../tution-desk-be/src/lib/feeReminderScheduler.ts"
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

function createMockRequest({
  method = "GET",
  url = "http://localhost:3000/api/cron/process-fee-reminders",
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

test("TuitionDesk Phase 2D: Scheduled Fee Reminder Processing & Security Suite", async (t) => {
  const originalStudentFind = StudentModel.find;
  const originalStudentFindById = StudentModel.findById;
  const originalFeeFind = FeeModel.find;
  const originalFeeFindOne = FeeModel.findOne;
  const originalFeeFindOneAndUpdate = FeeModel.findOneAndUpdate;
  const originalFeeUpdateOne = FeeModel.updateOne;
  const originalLogCreate = FeeReminderLogModel.create;

  t.afterEach(() => {
    StudentModel.find = originalStudentFind;
    StudentModel.findById = originalStudentFindById;
    FeeModel.find = originalFeeFind;
    FeeModel.findOne = originalFeeFindOne;
    FeeModel.findOneAndUpdate = originalFeeFindOneAndUpdate;
    FeeModel.updateOne = originalFeeUpdateOne;
    FeeReminderLogModel.create = originalLogCreate;
  });

  await t.test(
    "1. Server fails closed with 500 if CRON_SECRET is missing or empty in environment",
    async () => {
      const savedSecret = process.env.CRON_SECRET;
      try {
        process.env.CRON_SECRET = "";

        const req = createMockRequest({
          headers: { authorization: "Bearer some_token" },
        });

        const res = await GET(req);
        assert.equal(res.status, 500);
        const json = await res.json();
        assert.equal(json.success, false);
        assert.match(json.error, /CRON_SECRET is missing/i);
      } finally {
        process.env.CRON_SECRET = savedSecret;
      }
    }
  );

  await t.test(
    "2. Missing or invalid authorization headers reject request with 401 Unauthorized",
    async () => {
      // 2.1 Missing headers
      const reqNoAuth = createMockRequest({ headers: {} });
      const resNoAuth = await GET(reqNoAuth);
      assert.equal(resNoAuth.status, 401);
      const jsonNoAuth = await resNoAuth.json();
      assert.equal(jsonNoAuth.success, false);

      // 2.2 Invalid Bearer
      const reqBadBearer = createMockRequest({
        headers: { authorization: "Bearer invalid_cron_secret_token" },
      });
      const resBadBearer = await GET(reqBadBearer);
      assert.equal(resBadBearer.status, 401);

      // 2.3 Invalid x-cron-secret
      const reqBadHeader = createMockRequest({
        headers: { "x-cron-secret": "wrong_cron_token" },
      });
      const resBadHeader = await POST(reqBadHeader);
      assert.equal(resBadHeader.status, 401);
    }
  );

  await t.test(
    "3. Authorized GET request with Authorization: Bearer <CRON_SECRET> invokes scheduled reminder processor",
    async () => {
      const centerId = "center_auto_remind";
      const now = new Date("2026-11-09T10:00:00.000Z");

      // Setup mock fees in DB
      FeeModel.find = () => ({
        sort: () => ({
          limit: () => ({
            populate: async () => [],
          }),
        }),
      });

      const req = createMockRequest({
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        url: `http://localhost:3000/api/cron/process-fee-reminders?centerId=${centerId}`,
      });

      const res = await GET(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.summary.success, true);
      assert.equal(json.summary.totalPendingDiscovered, 0);
    }
  );

  await t.test(
    "4. Due Date Respect: Pending fees with future dueDate are strictly excluded",
    async () => {
      const centerId = "center_future_check";
      const refDate = new Date("2026-11-09T10:00:00.000Z");
      const futureDue = new Date("2026-11-15T10:00:00.000Z"); // 6 days in future

      let capturedFilter = null;
      FeeModel.find = (filter) => {
        capturedFilter = filter;
        return {
          sort: () => ({
            limit: () => ({
              populate: async () => [],
            }),
          }),
        };
      };

      await processScheduledFeeReminders({
        centerId,
        referenceDate: refDate,
      });

      assert.ok(capturedFilter, "Query filter should be captured");
      assert.deepEqual(capturedFilter.dueDate, { $lte: refDate });
      assert.deepEqual(capturedFilter.status, { $in: ["Pending", "Partial Paid"] });
    }
  );

  await t.test(
    "5. Discovery and Processing: Dispatches reminder for due pending fee and respects simulation",
    async () => {
      const centerId = "center_discovery_test";
      const refDate = new Date("2026-11-09T10:00:00.000Z");
      const feeId = randomHex24();
      const studentId = randomHex24();

      const mockStudent = {
        _id: studentId,
        centerId,
        name: "Rohan Verma",
        parentWhatsApp: "919999900011",
        isActive: true,
      };

      const mockFee = {
        _id: feeId,
        centerId,
        studentId: mockStudent,
        amountDue: 2500,
        dueDate: new Date("2026-11-05T00:00:00.000Z"), // Overdue by 4 days
        status: "Pending",
        reminderCount: 0,
        reminderPaused: false,
        lastReminderSentAt: null,
      };

      FeeModel.find = () => ({
        sort: () => ({
          limit: () => ({
            populate: async () => [mockFee],
          }),
        }),
      });

      FeeModel.findOne = () => ({
        populate: async () => mockFee,
      });

      FeeModel.findOneAndUpdate = async () => mockFee;
      FeeModel.updateOne = async () => ({ modifiedCount: 1 });
      FeeReminderLogModel.create = async (doc) => ({ _id: randomHex24(), ...doc });

      let mockSendCalled = false;
      const mockSendFn = async (cId, phone, name, amount, dueDate, magicLink) => {
        mockSendCalled = true;
        assert.equal(cId, centerId);
        assert.equal(phone, "919999900011");
        assert.equal(amount, 2500);
        return {
          success: true,
          simulated: true,
          messageId: "mock_sim_123",
        };
      };

      const summary = await processScheduledFeeReminders({
        centerId,
        referenceDate: refDate,
        sendFn: mockSendFn,
      });

      assert.equal(summary.success, true);
      assert.equal(summary.totalPendingDiscovered, 1);
      assert.equal(summary.eligibleCount, 1);
      assert.equal(summary.simulatedCount, 1);
      assert.equal(mockSendCalled, true);
    }
  );

  await t.test(
    "6. 7-Day Follow-Up Cooldown: Fees reminded within last 7 days are skipped",
    async () => {
      const centerId = "center_cooldown_test";
      const refDate = new Date("2026-11-09T10:00:00.000Z");
      const feeId = randomHex24();
      const studentId = randomHex24();

      const mockStudent = {
        _id: studentId,
        centerId,
        name: "Sneha Patel",
        parentWhatsApp: "919999900022",
        isActive: true,
      };

      const mockFeeRecentReminder = {
        _id: feeId,
        centerId,
        studentId: mockStudent,
        amountDue: 3000,
        dueDate: new Date("2026-11-01T00:00:00.000Z"),
        status: "Pending",
        reminderCount: 1, // Follow-up reminder
        reminderPaused: false,
        lastReminderSentAt: new Date("2026-11-06T10:00:00.000Z"), // Only 3 days ago!
      };

      FeeModel.find = () => ({
        sort: () => ({
          limit: () => ({
            populate: async () => [mockFeeRecentReminder],
          }),
        }),
      });

      let mockSendCalled = false;
      const mockSendFn = async () => {
        mockSendCalled = true;
        return { success: true };
      };

      const summary = await processScheduledFeeReminders({
        centerId,
        referenceDate: refDate,
        sendFn: mockSendFn,
      });

      assert.equal(summary.totalPendingDiscovered, 1);
      assert.equal(summary.eligibleCount, 0);
      assert.equal(summary.skippedCount, 1);
      assert.equal(mockSendCalled, false, "Should not dispatch reminder during active 7-day cooldown");
      assert.match(summary.details[0].reason, /7-day cooldown/i);
    }
  );

  await t.test(
    "7. Status Exclusion: Inactive students and paused reminders are strictly skipped",
    async () => {
      const centerId = "center_exclusion_test";
      const refDate = new Date("2026-11-09T10:00:00.000Z");

      const studentInactive = {
        _id: randomHex24(),
        centerId,
        name: "Deactivated Student",
        parentWhatsApp: "919999900033",
        isActive: false, // Inactive!
      };

      const feeInactive = {
        _id: randomHex24(),
        centerId,
        studentId: studentInactive,
        amountDue: 2000,
        dueDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "Pending",
        reminderCount: 0,
        reminderPaused: false,
      };

      FeeModel.find = () => ({
        sort: () => ({
          limit: () => ({
            populate: async () => [feeInactive],
          }),
        }),
      });

      let mockSendCalled = false;
      const summary = await processScheduledFeeReminders({
        centerId,
        referenceDate: refDate,
        sendFn: async () => {
          mockSendCalled = true;
          return { success: true };
        },
      });

      assert.equal(summary.totalPendingDiscovered, 1);
      assert.equal(summary.skippedCount, 1);
      assert.equal(mockSendCalled, false);
      assert.match(summary.details[0].reason, /deactivated/i);
    }
  );

  await t.test(
    "8. Concurrency Safety: Atomic claim prevents duplicate dispatch under concurrent triggers",
    async () => {
      const centerId = "center_concurrency_test";
      const refDate = new Date("2026-11-09T10:00:00.000Z");
      const feeId = randomHex24();

      const mockStudent = {
        _id: randomHex24(),
        centerId,
        name: "Amit Kumar",
        parentWhatsApp: "919999900044",
        isActive: true,
      };

      const mockFee = {
        _id: feeId,
        centerId,
        studentId: mockStudent,
        amountDue: 2500,
        dueDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "Pending",
        reminderCount: 0,
        reminderPaused: false,
      };

      FeeModel.find = () => ({
        sort: () => ({
          limit: () => ({
            populate: async () => [mockFee],
          }),
        }),
      });

      FeeModel.findOne = () => ({
        populate: async () => mockFee,
      });

      // Simulate concurrent worker already claimed the lock
      FeeModel.findOneAndUpdate = async () => null; // Returns null = lock already held!

      let mockSendCalled = false;
      const summary = await processScheduledFeeReminders({
        centerId,
        referenceDate: refDate,
        sendFn: async () => {
          mockSendCalled = true;
          return { success: true };
        },
      });

      assert.equal(summary.totalPendingDiscovered, 1);
      assert.equal(summary.eligibleCount, 1);
      assert.equal(summary.failedCount, 1);
      assert.equal(mockSendCalled, false, "Should not dispatch if atomic lease was not acquired");
      assert.match(summary.details[0].reason, /locked by another operation/i);
    }
  );

  await t.test(
    "9. Route Configuration: Route exports maxDuration = 60 for Vercel serverless execution",
    async () => {
      assert.equal(typeof maxDuration, "number");
      assert.equal(maxDuration, 60, "maxDuration must be set to 60 seconds");
    }
  );

  await t.test(
    "10. Default Batch Limit: Omitted limit defaults strictly to 8 (and custom limits are honored)",
    async () => {
      const capturedLimits = [];
      FeeModel.find = () => ({
        sort: () => ({
          limit: (n) => {
            capturedLimits.push(n);
            return {
              populate: async () => [],
            };
          },
        }),
      });

      // Default when limit is omitted
      await processScheduledFeeReminders({
        centerId: "center_limit_test",
      });
      assert.equal(capturedLimits[0], 8, "Default batch limit must be 8");

      // Custom limit passes through within [1, 100]
      await processScheduledFeeReminders({
        centerId: "center_limit_test",
        limit: 5,
      });
      assert.equal(capturedLimits[1], 5, "Custom batch limit of 5 must be respected");

      // Clamped above 100
      await processScheduledFeeReminders({
        centerId: "center_limit_test",
        limit: 150,
      });
      assert.equal(capturedLimits[2], 100, "Limits above 100 must be clamped to 100");
    }
  );

  await t.test(
    "11. Retry/Recovery & Failure Isolation: Failed dispatch releases atomic lock cleanly and logs failure",
    async () => {
      const centerId = "center_failure_recovery_test";
      const refDate = new Date("2026-11-09T10:00:00.000Z");
      const feeId = randomHex24();
      const studentId = randomHex24();

      const mockStudent = {
        _id: studentId,
        centerId,
        name: "Rahul Verma",
        parentWhatsApp: "919999900055",
        isActive: true,
      };

      const mockFee = {
        _id: feeId,
        centerId,
        studentId: mockStudent,
        amountDue: 3000,
        dueDate: new Date("2026-11-01T00:00:00.000Z"),
        status: "Pending",
        reminderCount: 0,
        reminderPaused: false,
        reminderLockUntil: null,
      };

      FeeModel.find = () => ({
        sort: () => ({
          limit: () => ({
            populate: async () => [mockFee],
          }),
        }),
      });

      FeeModel.findOne = () => ({
        populate: async () => mockFee,
      });

      // Mock atomic claim acquisition
      FeeModel.findOneAndUpdate = async () => mockFee;

      let releasedLockSet = null;
      FeeModel.updateOne = async (query, update) => {
        if (update?.$set?.reminderLockUntil !== undefined) {
          releasedLockSet = update.$set.reminderLockUntil;
        }
        return { modifiedCount: 1 };
      };

      let loggedRecord = null;
      FeeReminderLogModel.create = async (doc) => {
        loggedRecord = doc;
        return { _id: randomHex24(), ...doc };
      };

      // Simulate a dispatch failure (e.g. microservice unreachable or provider rejected)
      const summary = await processScheduledFeeReminders({
        centerId,
        referenceDate: refDate,
        sendFn: async () => {
          return {
            success: false,
            accepted: false,
            delivered: false,
            error: "WhatsApp gateway network error (timeout)",
          };
        },
      });

      assert.equal(summary.totalPendingDiscovered, 1);
      assert.equal(summary.eligibleCount, 1);
      assert.equal(summary.failedCount, 1);
      assert.equal(summary.dispatchedCount, 0);
      assert.equal(summary.details[0].status, "failed");
      assert.match(summary.details[0].reason, /network error/i);

      // Lock must be released (null) so that the record does not stay stuck in memory or DB
      assert.equal(releasedLockSet, null, "Atomic claim lease must be released on failure");

      // Failure must be logged for manual retry
      assert.ok(loggedRecord, "FeeReminderLog must record the failed attempt");
      assert.equal(loggedRecord.status, "failed");
      assert.equal(loggedRecord.feeId, feeId);
    }
  );
});
