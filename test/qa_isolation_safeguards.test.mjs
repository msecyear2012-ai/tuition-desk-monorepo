import test from "node:test";
import assert from "node:assert/strict";

// Environment preservation
const originalEnv = { ...process.env };
function resetEnv() {
  process.env = { ...originalEnv };
}

// Global mongoose mock to prevent real DB connection during unit tests
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

// Import backend modules under test
const { generateMonthlyFees } = await import(
  "../tution-desk-be/src/lib/feeGenerator.ts"
);
const { GET: getGenerateFees, POST: postGenerateFees } = await import(
  "../tution-desk-be/src/app/api/cron/generate-fees/route.ts"
);
const { processScheduledFeeReminders } = await import(
  "../tution-desk-be/src/lib/feeReminderScheduler.ts"
);
const { GET: getProcessReminders, POST: postProcessReminders } = await import(
  "../tution-desk-be/src/app/api/cron/process-fee-reminders/route.ts"
);
const {
  normalizeIndianPhone,
  isPhoneAllowedForLiveDispatch,
  isLiveDispatchEnabled,
  sendFeeReminder,
  sendCustomWhatsAppMessage,
} = await import("../tution-desk-be/src/lib/whatsappService.ts");

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
const { default: FeeCreationLockModel } = await import(
  "../tution-desk-be/src/models/FeeCreationLock.ts"
);

// Import microservice BaileysProvider
const BaileysProvider = (await import("../whatsapp-server/providers/BaileysProvider.js")).default ||
  (await import("../whatsapp-server/providers/BaileysProvider.js"));

function createMockCronRequest({
  method = "GET",
  url = "http://localhost:3001/api/cron/generate-fees",
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

test("TuitionDesk QA Isolation Safeguards & Verification Suite", async (suite) => {
  suite.afterEach(resetEnv);

  // ---------------------------------------------------------------------------
  // Test 1: Scoped fee generation with studentId selects ONLY the QA student
  // ---------------------------------------------------------------------------
  await suite.test(
    "1. Scoped fee generation with studentId=6af1f73ab1bcf9141efc36ad selects ONLY the QA student",
    async () => {
      const originalFind = StudentModel.find;
      const originalStudentFindOne = StudentModel.findOne;
      const originalStudentFindById = StudentModel.findById;
      const originalFeeFind = FeeModel.find;
      const originalFeeFindOne = FeeModel.findOne;
      const originalFeeCreate = FeeModel.create;
      const originalCenterFindOne = CenterModel.findOne;
      const originalLockIndexes = FeeCreationLockModel.collection?.indexes;
      const originalLockCreate = FeeCreationLockModel.create;
      const originalLockFindOneAndUpdate = FeeCreationLockModel.findOneAndUpdate;
      const originalLockDeleteOne = FeeCreationLockModel.deleteOne;

      let capturedQuery = null;

      try {
        if (!FeeCreationLockModel.collection) {
          FeeCreationLockModel.collection = {};
        }
        FeeCreationLockModel.collection.indexes = async () => [
          { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
          { key: { expiresAt: 1 }, expireAfterSeconds: 600, name: "expiresAt_1" },
        ];
        FeeCreationLockModel.create = async (doc) => doc;
        FeeCreationLockModel.findOneAndUpdate = async () => null;
        FeeCreationLockModel.deleteOne = async () => ({ deletedCount: 1 });

        const mockQaStudent = {
          _id: "6af1f73ab1bcf9141efc36ad",
          name: "QA_STU_MANUAL_ACCEPTANCE_20261109_WF01",
          centerId: "msce-8267",
          billingCycleDate: 10,
          monthlyFee: 2500,
          parentWhatsApp: "919999900011",
          joiningDate: new Date("2026-11-09T00:00:00.000Z"),
          isActive: true,
          toString: () => "6af1f73ab1bcf9141efc36ad",
        };

        StudentModel.find = (query) => {
          capturedQuery = query;
          return Promise.resolve([mockQaStudent]);
        };

        StudentModel.findOne = () => Promise.resolve(mockQaStudent);
        StudentModel.findById = () => Promise.resolve(mockQaStudent);
        CenterModel.findOne = () => ({
          select: () => ({
            lean: async () => ({
              feeDueDateOffsetDays: 0,
            }),
          }),
        });

        const mockGeneratedFee = {
          _id: "fee_qa_nov_2026_gen",
          studentId: "6af1f73ab1bcf9141efc36ad",
          centerId: "msce-8267",
          billingMonth: "2026-11",
          totalAmount: 2500,
          pendingAmount: 2500,
          status: "Pending",
          dueDate: new Date("2026-11-10T00:00:00.000Z"),
        };

        FeeModel.find = () => Promise.resolve([]);
        FeeModel.findOne = () => Promise.resolve(null);
        FeeModel.create = () => Promise.resolve([mockGeneratedFee]);

        const result = await generateMonthlyFees({
          centerId: "msce-8267",
          studentId: "6af1f73ab1bcf9141efc36ad",
          overrideDay: 10,
          referenceDate: new Date("2026-11-10T05:30:00.000Z"),
        });

        // Query MUST include both centerId and the exact studentId
        assert.ok(capturedQuery, "StudentModel.find must be called with a query");
        assert.equal(capturedQuery.centerId, "msce-8267");
        assert.equal(capturedQuery._id, "6af1f73ab1bcf9141efc36ad");
        assert.equal(capturedQuery.isActive.$ne, false);
        assert.equal(result.totalEligibleStudents, 1);
        assert.equal(result.generatedCount, 1);
      } finally {
        StudentModel.find = originalFind;
        StudentModel.findOne = originalStudentFindOne;
        StudentModel.findById = originalStudentFindById;
        FeeModel.find = originalFeeFind;
        FeeModel.findOne = originalFeeFindOne;
        FeeModel.create = originalFeeCreate;
        CenterModel.findOne = originalCenterFindOne;
        if (FeeCreationLockModel.collection) {
          FeeCreationLockModel.collection.indexes = originalLockIndexes;
        }
        FeeCreationLockModel.create = originalLockCreate;
        FeeCreationLockModel.findOneAndUpdate = originalLockFindOneAndUpdate;
        FeeCreationLockModel.deleteOne = originalLockDeleteOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Test 2: Other students are excluded when studentId is scoped (Route & Generator)
  // ---------------------------------------------------------------------------
  await suite.test(
    "2. Other students are strictly excluded when studentId is scoped",
    async () => {
      process.env.CRON_SECRET = "test_cron_secret_32_characters_long!";

      const originalFind = StudentModel.find;
      const originalStudentFindOne = StudentModel.findOne;
      const originalFeeFindOne = FeeModel.findOne;
      const originalCenterFindOne = CenterModel.findOne;

      let capturedRouteQuery = null;

      try {
        StudentModel.find = (query) => {
          capturedRouteQuery = query;
          // If query has studentId = 6af1f73ab1bcf9141efc36ad, return ONLY that student
          if (query._id === "6af1f73ab1bcf9141efc36ad") {
            return Promise.resolve([
              {
                _id: "6af1f73ab1bcf9141efc36ad",
                name: "QA_STU_MANUAL_ACCEPTANCE_20261109_WF01",
                centerId: "msce-8267",
                billingCycleDate: 10,
                monthlyFee: 2500,
                parentWhatsApp: "919999900011",
                isActive: true,
                toString: () => "6af1f73ab1bcf9141efc36ad",
              },
            ]);
          }
          // Any other query returns empty array
          return Promise.resolve([]);
        };

        StudentModel.findOne = () =>
          Promise.resolve({
            _id: "6af1f73ab1bcf9141efc36ad",
            name: "QA_STU_MANUAL_ACCEPTANCE_20261109_WF01",
            centerId: "msce-8267",
            billingCycleDate: 10,
            monthlyFee: 2500,
            parentWhatsApp: "919999900011",
            isActive: true,
          });

        CenterModel.findOne = () => ({
          select: () => ({
            lean: async () => ({
              feeDueDateOffsetDays: 0,
            }),
          }),
        });

        FeeModel.findOne = () =>
          Promise.resolve({
            _id: "fee_existing",
            studentId: "6af1f73ab1bcf9141efc36ad",
            centerId: "msce-8267",
            billingMonth: "2026-11",
          });

        // Test GET with searchParams
        const req = createMockCronRequest({
          method: "GET",
          url: "http://localhost:3001/api/cron/generate-fees?centerId=msce-8267&studentId=6af1f73ab1bcf9141efc36ad&day=10",
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        });

        const res = await getGenerateFees(req);
        assert.equal(res.status, 200);
        assert.ok(capturedRouteQuery);
        assert.equal(capturedRouteQuery.centerId, "msce-8267");
        assert.equal(capturedRouteQuery._id, "6af1f73ab1bcf9141efc36ad");

        // Test POST with JSON body
        let capturedPostBodyQuery = null;
        StudentModel.find = (query) => {
          capturedPostBodyQuery = query;
          return Promise.resolve([]);
        };

        const postReq = createMockCronRequest({
          method: "POST",
          url: "http://localhost:3001/api/cron/generate-fees",
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
            "content-type": "application/json",
          },
          body: {
            centerId: "msce-8267",
            studentId: "6af1f73ab1bcf9141efc36ad",
            overrideDay: 10,
          },
        });

        const postRes = await postGenerateFees(postReq);
        assert.equal(postRes.status, 200);
        assert.ok(capturedPostBodyQuery);
        assert.equal(capturedPostBodyQuery.centerId, "msce-8267");
        assert.equal(capturedPostBodyQuery._id, "6af1f73ab1bcf9141efc36ad");
      } finally {
        StudentModel.find = originalFind;
        StudentModel.findOne = originalStudentFindOne;
        FeeModel.findOne = originalFeeFindOne;
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Test 3: Scoped reminder processing claims ONLY QA student's fee
  // ---------------------------------------------------------------------------
  await suite.test(
    "3. Scoped reminder processing claims ONLY QA student's fee, leaving other pending fees untouched",
    async () => {
      process.env.CRON_SECRET = "test_cron_secret_32_characters_long!";

      const originalFeeFind = FeeModel.find;
      const originalFeeFindOne = FeeModel.findOne;
      const originalFeeFindOneAndUpdate = FeeModel.findOneAndUpdate;
      const originalFeeUpdateOne = FeeModel.updateOne;
      const originalLogCreate = FeeReminderLogModel.create;
      const originalCenterFindOne = CenterModel.findOne;

      let capturedFeeFilter = null;
      let capturedClaimedFeeId = null;

      try {
        const mockQaFee = {
          _id: "fee_qa_nov_2026_id",
          studentId: {
            _id: "6af1f73ab1bcf9141efc36ad",
            name: "QA_STU_MANUAL_ACCEPTANCE_20261109_WF01",
            parentWhatsApp: "919999900011",
            isActive: true,
          },
          centerId: "msce-8267",
          billingMonth: "2026-11",
          totalAmount: 2500,
          pendingAmount: 2500,
          status: "Pending",
          dueDate: new Date("2026-11-10T00:00:00.000Z"),
          reminderLockUntil: null,
          lastReminderSentAt: null,
          save: async () => {},
        };

        CenterModel.findOne = () => ({
          select: () => ({
            lean: async () => ({
              messagingTemplates: {},
            }),
          }),
        });

        FeeModel.find = (filter) => {
          capturedFeeFilter = filter;
          return {
            sort: () => ({
              limit: () => ({
                populate: () => Promise.resolve([mockQaFee]),
              }),
            }),
          };
        };

        FeeModel.findOne = () => ({
          populate: async () => mockQaFee,
        });

        FeeModel.findOneAndUpdate = (query, update) => {
          capturedClaimedFeeId = String(query._id);
          return Promise.resolve(mockQaFee);
        };

        FeeModel.updateOne = async () => ({ modifiedCount: 1 });
        FeeReminderLogModel.create = () => Promise.resolve({});

        const summary = await processScheduledFeeReminders({
          centerId: "msce-8267",
          studentId: "6af1f73ab1bcf9141efc36ad",
          referenceDate: new Date("2026-11-10T05:30:00.000Z"),
        });

        // feeFilter must be strictly scoped to both centerId and studentId
        assert.ok(capturedFeeFilter);
        assert.equal(capturedFeeFilter.centerId, "msce-8267");
        assert.equal(capturedFeeFilter.studentId, "6af1f73ab1bcf9141efc36ad");
        assert.deepEqual(capturedFeeFilter.status, { $in: ["Pending", "Partial Paid"] });
        assert.ok(capturedFeeFilter.dueDate, "dueDate constraint must be enforced");
        assert.equal(capturedClaimedFeeId, "fee_qa_nov_2026_id");
        assert.equal(summary.totalPendingDiscovered, 1);
        assert.equal(summary.eligibleCount, 1);
        assert.equal(summary.simulatedCount, 1);
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
  // Test 4: Missing or empty allowlist in QA live mode fails closed
  // ---------------------------------------------------------------------------
  await suite.test(
    "4. When QA_LIVE_MODE='true' and QA_LIVE_RECIPIENT_ALLOWLIST is missing/empty, isLiveDispatchEnabled() fails closed",
    () => {
      process.env.QA_LIVE_MODE = "true";
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      // 4.1 Missing allowlist
      delete process.env.QA_LIVE_RECIPIENT_ALLOWLIST;
      assert.equal(isPhoneAllowedForLiveDispatch("919999900011"), false);
      assert.equal(isLiveDispatchEnabled("919999900011"), false);

      // 4.2 Empty allowlist string
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "";
      assert.equal(isPhoneAllowedForLiveDispatch("919999900011"), false);
      assert.equal(isLiveDispatchEnabled("919999900011"), false);

      // 4.3 Whitespace-only allowlist string
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "   ";
      assert.equal(isPhoneAllowedForLiveDispatch("919999900011"), false);
      assert.equal(isLiveDispatchEnabled("919999900011"), false);

      // 4.4 Non-digit/garbage allowlist
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = ",,, ,  ";
      assert.equal(isPhoneAllowedForLiveDispatch("919999900011"), false);
      assert.equal(isLiveDispatchEnabled("919999900011"), false);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 5: Non-allowlisted recipient rejected by Layer 1 & Layer 2
  // ---------------------------------------------------------------------------
  await suite.test(
    "5. Non-allowlisted recipient (e.g. 8368948820 / Shobha) is rejected by Layer 1 & Layer 2",
    async () => {
      process.env.QA_LIVE_MODE = "true";
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "919999900011";
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      const shobhaPhone = "8368948820";

      // Layer 1: Backend service guard
      assert.equal(isPhoneAllowedForLiveDispatch(shobhaPhone), false);
      assert.equal(isLiveDispatchEnabled(shobhaPhone), false);

      // Layer 2: BaileysProvider socket boundary
      let rawSocketSendMessageCalled = false;
      const mockSock = {
        sendMessage: async () => {
          rawSocketSendMessageCalled = true;
          return { key: { id: "sent_id" } };
        },
      };

      const provider = new BaileysProvider({
        mongooseInstance: { connection: { readyState: 0 } },
      });
      // Attach an active session to test Layer 2 interception
      provider.sessions.set("msce-8267", {
        sock: mockSock,
        isReady: true,
        status: "connected",
        generation: 1,
      });

      const result = await provider.sendMessage({
        centerId: "msce-8267",
        phone: shobhaPhone,
        message: "Fee reminder for Shobha",
      });

      assert.equal(rawSocketSendMessageCalled, false, "Socket sendMessage MUST NOT be invoked for non-allowlisted number");
      assert.equal(result.success, true);
      assert.equal(result.simulated, true);
      assert.equal(result.accepted, false);
      assert.equal(result.delivered, false);
      assert.equal(result.status, "simulated_blocked");
    }
  );

  // ---------------------------------------------------------------------------
  // Test 6: Approved recipient passes Layer 1 & Layer 2 when allowlisted
  // ---------------------------------------------------------------------------
  await suite.test(
    "6. Approved recipient (919999900011) passes both Layer 1 and Layer 2 when allowlisted",
    async () => {
      process.env.QA_LIVE_MODE = "true";
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "919999900011";
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      const qaNumber12 = "919999900011";
      const qaNumber10 = "9999900011";
      const qaNumberPlus = "+91 99999 00011";

      // Layer 1: All formats of the approved number are permitted
      assert.equal(isPhoneAllowedForLiveDispatch(qaNumber12), true);
      assert.equal(isLiveDispatchEnabled(qaNumber12), true);
      assert.equal(isLiveDispatchEnabled(qaNumber10), true);
      assert.equal(isLiveDispatchEnabled(qaNumberPlus), true);

      // Layer 2: BaileysProvider passes allowed number through to socket
      let rawSocketSendMessageCalled = false;
      let recipientPassedToSock = null;

      const mockSock = {
        sendMessage: async (jid, content) => {
          rawSocketSendMessageCalled = true;
          recipientPassedToSock = jid;
          return { key: { id: "mock_sent_meta_id_123" } };
        },
      };

      const provider = new BaileysProvider({
        mongooseInstance: { connection: { readyState: 0 } },
      });
      provider.sessions.set("msce-8267", {
        sock: mockSock,
        isReady: true,
        status: "connected",
        generation: 1,
      });

      const result = await provider.sendMessage({
        centerId: "msce-8267",
        phone: qaNumber10,
        message: "Test QA Reminder",
      });

      assert.equal(rawSocketSendMessageCalled, true, "Socket sendMessage SHOULD be invoked for allowlisted number");
      assert.equal(recipientPassedToSock, "919999900011@s.whatsapp.net");
      assert.equal(result.success, true);
      assert.equal(result.accepted, true);
      assert.equal(result.delivered, false);
      assert.equal(result.messageId, "mock_sent_meta_id_123");
    }
  );

  // ---------------------------------------------------------------------------
  // Test 7: Campaign dispatch & manual reminder cannot bypass allowlist guard
  // ---------------------------------------------------------------------------
  await suite.test(
    "7. Campaign dispatch and direct/manual message functions cannot bypass allowlist guard",
    async () => {
      process.env.QA_LIVE_MODE = "true";
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "919999900011";
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      const originalCenterFindOne = CenterModel.findOne;
      CenterModel.findOne = () => ({
        select: () => ({
          lean: async () => ({
            messagingTemplates: {},
          }),
        }),
      });

      try {
        const unauthorizedPhone = "8368948820";

        // Direct sendCustomWhatsAppMessage (used by campaigns)
        const customMsgResult = await sendCustomWhatsAppMessage(
          "msce-8267",
          unauthorizedPhone,
          "Special campaign offer announcement"
        );
        assert.equal(customMsgResult.simulated, true);
        assert.equal(customMsgResult.accepted, false);
        assert.equal(customMsgResult.delivered, false);

        // Direct sendFeeReminder (used by manual remind button)
        const feeReminderResult = await sendFeeReminder(
          "msce-8267",
          unauthorizedPhone,
          "Shobha",
          2500,
          "2026-11-10",
          "http://localhost:3000/p/some-id"
        );
        assert.equal(feeReminderResult.simulated, true);
        assert.equal(feeReminderResult.accepted, false);
        assert.equal(feeReminderResult.delivered, false);
      } finally {
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Test 8: Phone normalization correctly formats 10, 11, and 12-digit Indian numbers
  // ---------------------------------------------------------------------------
  await suite.test(
    "8. Phone normalization formats 10-digit, 11-digit (leading 0), and 12-digit Indian numbers",
    () => {
      // 10 digits -> prefixed with 91
      assert.equal(normalizeIndianPhone("9876543210"), "919876543210");
      assert.equal(normalizeIndianPhone("9999900011"), "919999900011");

      // 11 digits with leading 0 -> 0 stripped and prefixed with 91
      assert.equal(normalizeIndianPhone("09876543210"), "919876543210");
      assert.equal(normalizeIndianPhone("09999900011"), "919999900011");

      // 12 digits starting with 91 -> intact
      assert.equal(normalizeIndianPhone("919876543210"), "919876543210");
      assert.equal(normalizeIndianPhone("919999900011"), "919999900011");

      // Formatting characters: spaces, dashes, parentheses, plus
      assert.equal(normalizeIndianPhone("+91 99999 00011"), "919999900011");
      assert.equal(normalizeIndianPhone("+91-98765-43210"), "919876543210");
      assert.equal(normalizeIndianPhone("(09876) 543210"), "919876543210");

      // Non-10/11/12 edge cases
      assert.equal(normalizeIndianPhone("12345"), "12345");
      assert.equal(normalizeIndianPhone(""), "");
    }
  );
});
