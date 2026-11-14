process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "../tution-desk-be/node_modules/mongoose/index.js";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const FeeReminderLog = (
  await import("../tution-desk-be/src/models/FeeReminderLog.ts")
).default;
const { AdmissionWelcomeJob } = await import(
  "../tution-desk-be/src/models/AdmissionWelcomeJob.ts"
);
const MessageCampaign = (
  await import("../tution-desk-be/src/models/MessageCampaign.ts")
).default;

const {
  TERMINAL_FEE_SUCCESS_STATUSES,
  TERMINAL_FEE_FAILED_STATUSES,
  PROTECTED_FEE_STATUSES,
  TERMINAL_ADMISSION_SUCCESS_STATUSES,
  TERMINAL_ADMISSION_FAILED_STATUSES,
  PROTECTED_ADMISSION_STATUSES,
  TERMINAL_CAMPAIGN_STATUSES,
  PROTECTED_CAMPAIGN_STATUSES,
  previewWhatsAppLogCleanup,
  executeWhatsAppLogCleanup,
} = await import("../tution-desk-be/src/lib/whatsappLogCleanupService.ts");

const {
  GET: cleanupGetRoute,
  POST: cleanupPostRoute,
} = await import("../tution-desk-be/src/app/api/whatsapp/logs/cleanup/route.ts");

function createMockRequest({
  token,
  url = "http://localhost:3000/api/whatsapp/logs/cleanup",
  method = "GET",
  body = null,
  headers = {},
}) {
  const reqUrl = new URL(url);
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    reqHeaders.set(k, v);
  }

  return {
    method,
    url: reqUrl.toString(),
    nextUrl: reqUrl,
    headers: reqHeaders,
    cookies: {
      get: (name) => {
        if (name === "auth_token" && token) {
          return { value: token };
        }
        return undefined;
      },
    },
    json: async () => body,
  };
}

test("MSEC Phase 8.3 & 8.4 — WhatsApp Dispatch Log Cleanup Specification Suite", async (t) => {
  const centerA = "center-msec-cleanup-101";
  const centerB = "center-msec-cleanup-202";

  const ownerId = new mongoose.Types.ObjectId().toString();
  const teacherId = new mongoose.Types.ObjectId().toString();
  const parentId = new mongoose.Types.ObjectId().toString();

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerA,
    role: "owner",
    name: "Owner Jitender",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    centerId: centerA,
    role: "teacher",
    teacherId: teacherId,
    name: "Teacher Ritu",
  });

  const parentToken = await signToken({
    userId: parentId,
    centerId: centerA,
    role: "parent",
    name: "Parent Rajesh",
  });

  // In-memory test stores
  let mockFeeLogs = [];
  let mockAdmissionJobs = [];
  let mockCampaigns = [];

  function evaluateCondition(itemValue, cond) {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$in" in cond) {
        return cond.$in.includes(itemValue);
      }
      if ("$nin" in cond) {
        return !cond.$nin.includes(itemValue);
      }
      if ("$exists" in cond) {
        const exists = itemValue !== undefined;
        return exists === cond.$exists;
      }
      if ("$lte" in cond) {
        if (!itemValue) return false;
        return new Date(itemValue).getTime() <= new Date(cond.$lte).getTime();
      }
      if ("$gt" in cond) {
        if (!itemValue) return false;
        return new Date(itemValue).getTime() > new Date(cond.$gt).getTime();
      }
    }
    if (cond === null) {
      return itemValue === null || itemValue === undefined;
    }
    return itemValue === cond;
  }

  function matchesItem(item, query) {
    if (!query) return true;
    for (const [key, val] of Object.entries(query)) {
      if (key === "$or") {
        const anyPass = val.some((sub) => matchesItem(item, sub));
        if (!anyPass) return false;
        continue;
      }
      if (key === "$and") {
        const allPass = val.every((sub) => matchesItem(item, sub));
        if (!allPass) return false;
        continue;
      }
      const itemVal = item[key];
      if (!evaluateCondition(itemVal, val)) {
        return false;
      }
    }
    return true;
  }

  // Hook Mongoose Model methods
  FeeReminderLog.countDocuments = async (query = {}) => {
    return mockFeeLogs.filter((i) => matchesItem(i, query)).length;
  };
  FeeReminderLog.deleteMany = async (query = {}) => {
    const beforeCount = mockFeeLogs.length;
    mockFeeLogs = mockFeeLogs.filter((i) => !matchesItem(i, query));
    return { deletedCount: beforeCount - mockFeeLogs.length };
  };

  AdmissionWelcomeJob.countDocuments = async (query = {}) => {
    return mockAdmissionJobs.filter((i) => matchesItem(i, query)).length;
  };
  AdmissionWelcomeJob.deleteMany = async (query = {}) => {
    const beforeCount = mockAdmissionJobs.length;
    mockAdmissionJobs = mockAdmissionJobs.filter((i) => !matchesItem(i, query));
    return { deletedCount: beforeCount - mockAdmissionJobs.length };
  };

  MessageCampaign.countDocuments = async (query = {}) => {
    return mockCampaigns.filter((i) => matchesItem(i, query)).length;
  };
  MessageCampaign.find = (query = {}) => {
    const results = mockCampaigns.filter((i) => matchesItem(i, query));
    const p = Promise.resolve(results);
    p.select = () => p;
    p.lean = () => p;
    return p;
  };
  MessageCampaign.deleteMany = async (query = {}) => {
    const beforeCount = mockCampaigns.length;
    mockCampaigns = mockCampaigns.filter((i) => !matchesItem(i, query));
    return { deletedCount: beforeCount - mockCampaigns.length };
  };

  function seedTestData() {
    const past = new Date(Date.now() - 3600000);
    const future = new Date(Date.now() + 3600000);

    // Center A Fee Reminder Logs
    mockFeeLogs = [
      // Terminal Successful (2)
      { _id: "fee-1", centerId: centerA, status: "delivered", studentName: "Aman", retryLockUntil: null },
      { _id: "fee-2", centerId: centerA, status: "sent", studentName: "Bhavna", retryLockUntil: past },
      // Terminal Failed (2)
      { _id: "fee-3", centerId: centerA, status: "failed", studentName: "Chetan", retryLockUntil: null },
      { _id: "fee-4", centerId: centerA, status: "failed", studentName: "Deepak", retryLockUntil: past },
      // Protected: Active / In-Flight / Locked (4)
      { _id: "fee-5", centerId: centerA, status: "attempted", studentName: "Esha", retryLockUntil: null },
      { _id: "fee-6", centerId: centerA, status: "provider_accepted", studentName: "Farhan", retryLockUntil: null },
      { _id: "fee-7", centerId: centerA, status: "dispatch_uncertain", studentName: "Gaurav", retryLockUntil: null },
      { _id: "fee-8", centerId: centerA, status: "failed", studentName: "Hitesh", retryLockUntil: future }, // locked!
      // Center B: Should NEVER be touched (2)
      { _id: "fee-b1", centerId: centerB, status: "delivered", studentName: "Center B Student 1" },
      { _id: "fee-b2", centerId: centerB, status: "failed", studentName: "Center B Student 2" },
    ];

    // Center A Admission Welcome Jobs
    mockAdmissionJobs = [
      // Terminal Successful (2)
      { _id: "adm-1", centerId: centerA, status: "sent", studentName: "Ishaan", lockExpiresAt: null },
      { _id: "adm-2", centerId: centerA, status: "simulated", studentName: "Juhi", lockExpiresAt: past },
      // Terminal Failed (3) - note adm-8 has historical nextRetryAt in future but NO active lock, so it's eligible!
      { _id: "adm-3", centerId: centerA, status: "failed", studentName: "Karan", lockExpiresAt: null, nextRetryAt: past },
      { _id: "adm-4", centerId: centerA, status: "skipped", studentName: "Lata", lockExpiresAt: null, nextRetryAt: null },
      { _id: "adm-8", centerId: centerA, status: "failed", studentName: "Pooja", lockExpiresAt: null, nextRetryAt: future },
      // Protected: Active / In-Flight / Locked (4)
      { _id: "adm-5", centerId: centerA, status: "pending", studentName: "Manish", lockExpiresAt: null },
      { _id: "adm-6", centerId: centerA, status: "processing", studentName: "Neha", lockExpiresAt: null },
      { _id: "adm-7", centerId: centerA, status: "ambiguous", studentName: "Omkar", lockExpiresAt: null },
      { _id: "adm-9", centerId: centerA, status: "failed", studentName: "Rakesh", lockExpiresAt: future }, // active worker lock!
      // Center B (1)
      { _id: "adm-b1", centerId: centerB, status: "sent", studentName: "Center B Student 3" },
    ];

    // Center A Campaigns
    mockCampaigns = [
      // Terminal Completed Campaign with 2 messages (1 sent, 1 failed)
      {
        _id: "camp-1",
        centerId: centerA,
        status: "completed",
        title: "Diwali Notice",
        messages: [
          { phone: "9876543210", status: "sent" },
          { phone: "9876543211", status: "failed" },
        ],
      },
      // Terminal Cancelled Campaign
      {
        _id: "camp-2",
        centerId: centerA,
        status: "cancelled",
        title: "Cancelled Event",
        messages: [{ phone: "9876543212", status: "skipped" }],
      },
      // Terminal failed_partial Campaign with 11 failed messages (replicates exact user scenario)
      {
        _id: "camp-fp",
        centerId: centerA,
        status: "failed_partial",
        title: "Fee Reminder Broadcast",
        messages: Array.from({ length: 11 }, (_, idx) => ({
          phone: `98765432${idx.toString().padStart(2, "0")}`,
          status: "failed",
        })),
      },
      // Protected Active Campaigns (4)
      {
        _id: "camp-3",
        centerId: centerA,
        status: "in_progress",
        title: "Exam Schedule",
        messages: [{ phone: "9876543213", status: "pending" }],
      },
      {
        _id: "camp-4",
        centerId: centerA,
        status: "paused",
        title: "Paused Campaign",
        messages: [{ phone: "9876543214", status: "pending" }],
      },
      {
        _id: "camp-5",
        centerId: centerA,
        status: "approved",
        title: "Approved Campaign",
        messages: [{ phone: "9876543215", status: "pending" }],
      },
      {
        _id: "camp-6",
        centerId: centerA,
        status: "pending",
        title: "Pending Campaign",
        messages: [{ phone: "9876543216", status: "pending" }],
      },
      // Center B Campaign
      {
        _id: "camp-b1",
        centerId: centerB,
        status: "completed",
        title: "Center B Notice",
        messages: [{ phone: "9876543214", status: "sent" }],
      },
    ];
  }

  await t.test("1. Status allowlists strictly match specification", async () => {
    assert.deepEqual(
      [...TERMINAL_FEE_SUCCESS_STATUSES].sort(),
      ["delivered", "sent"].sort()
    );
    assert.deepEqual(
      [...TERMINAL_FEE_FAILED_STATUSES].sort(),
      ["failed"].sort()
    );
    assert.ok(PROTECTED_FEE_STATUSES.includes("attempted"));
    assert.ok(PROTECTED_FEE_STATUSES.includes("provider_accepted"));
    assert.ok(PROTECTED_FEE_STATUSES.includes("dispatch_uncertain"));

    assert.ok(TERMINAL_ADMISSION_SUCCESS_STATUSES.includes("sent"));
    assert.ok(TERMINAL_ADMISSION_SUCCESS_STATUSES.includes("simulated"));
    assert.ok(TERMINAL_ADMISSION_FAILED_STATUSES.includes("failed"));
    assert.ok(TERMINAL_ADMISSION_FAILED_STATUSES.includes("skipped"));
    assert.ok(PROTECTED_ADMISSION_STATUSES.includes("pending"));
    assert.ok(PROTECTED_ADMISSION_STATUSES.includes("processing"));
    assert.ok(PROTECTED_ADMISSION_STATUSES.includes("ambiguous"));

    assert.ok(TERMINAL_CAMPAIGN_STATUSES.includes("completed"));
    assert.ok(TERMINAL_CAMPAIGN_STATUSES.includes("cancelled"));
    assert.ok(TERMINAL_CAMPAIGN_STATUSES.includes("failed_partial"));

    assert.ok(PROTECTED_CAMPAIGN_STATUSES.includes("pending"));
    assert.ok(PROTECTED_CAMPAIGN_STATUSES.includes("approved"));
    assert.ok(PROTECTED_CAMPAIGN_STATUSES.includes("in_progress"));
    assert.ok(PROTECTED_CAMPAIGN_STATUSES.includes("paused"));
  });

  await t.test("2. Unauthenticated request receives HTTP 401 Unauthorized", async () => {
    const req = createMockRequest({ token: null });
    const res = await cleanupGetRoute(req);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /Authentication required/i);
  });

  await t.test("3. Teacher role receives HTTP 403 Forbidden (Owner isolation)", async () => {
    const getReq = createMockRequest({ token: teacherToken, method: "GET" });
    const getRes = await cleanupGetRoute(getReq);
    assert.equal(getRes.status, 403);
    const getJson = await getRes.json();
    assert.equal(getJson.success, false);
    assert.match(getJson.error, /Owner role required/i);

    const postReq = createMockRequest({
      token: teacherToken,
      method: "POST",
      body: { confirm: true },
    });
    const postRes = await cleanupPostRoute(postReq);
    assert.equal(postRes.status, 403);
  });

  await t.test("4. Parent role receives HTTP 403 Forbidden", async () => {
    const postReq = createMockRequest({
      token: parentToken,
      method: "POST",
      body: { confirm: true },
    });
    const postRes = await cleanupPostRoute(postReq);
    assert.equal(postRes.status, 403);
  });

  await t.test("5. GET /api/whatsapp/logs/cleanup returns read-only preview with accurate counts", async () => {
    seedTestData();
    const req = createMockRequest({ token: ownerToken, method: "GET" });
    const res = await cleanupGetRoute(req);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.success, true);
    // Fee Reminders: 2 success + 2 failed = 4 eligible, 3 protected statuses
    assert.equal(data.breakdown.feeReminders.successful, 2);
    assert.equal(data.breakdown.feeReminders.failed, 2);
    assert.equal(data.breakdown.feeReminders.totalEligible, 4);
    assert.equal(data.breakdown.feeReminders.protected, 3);

    // Admission Jobs: 2 success + 3 failed (including adm-8 with historical nextRetryAt) = 5 eligible, 3 protected statuses
    assert.equal(data.breakdown.admissionWelcome.successful, 2);
    assert.equal(data.breakdown.admissionWelcome.failed, 3);
    assert.equal(data.breakdown.admissionWelcome.totalEligible, 5);
    assert.equal(data.breakdown.admissionWelcome.protected, 3);

    // Campaigns: 3 terminal campaigns (camp-1: 1 sent, 1 failed; camp-2: 1 skipped; camp-fp: 11 failed) = 14 messages
    assert.equal(data.breakdown.campaigns.successful, 1);
    assert.equal(data.breakdown.campaigns.failed, 13);
    assert.equal(data.breakdown.campaigns.totalEligible, 14);
    assert.equal(data.breakdown.campaigns.protected, 4);

    // Totals
    assert.equal(data.successfulCount, 5); // 2 + 2 + 1
    assert.equal(data.failedCount, 18);    // 2 + 3 + 13
    assert.equal(data.eligibleTotal, 23);
    assert.equal(data.protectedCount, 10); // 3 + 3 + 4

    // Zero records were mutated or deleted during preview
    assert.equal(mockFeeLogs.length, 10);
    assert.equal(mockAdmissionJobs.length, 10);
    assert.equal(mockCampaigns.length, 8);
  });

  await t.test("6. POST without explicit confirm: true returns HTTP 400 Bad Request", async () => {
    seedTestData();
    const req = createMockRequest({
      token: ownerToken,
      method: "POST",
      body: {}, // missing confirm: true
    });
    const res = await cleanupPostRoute(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /explicit confirmation/i);

    // Verify zero records deleted
    assert.equal(mockFeeLogs.length, 10);
  });

  await t.test("7. POST with confirm: true hard deletes ONLY terminal records and preserves protected records", async () => {
    seedTestData();
    const req = createMockRequest({
      token: ownerToken,
      method: "POST",
      body: { confirm: true, scope: "all" },
    });
    const res = await cleanupPostRoute(req);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.deletedCount, 23); // 4 fee + 5 admission + 14 campaign messages

    // Center A Fee Reminders remaining: exactly the 4 protected ones
    const remainingCenterAFee = mockFeeLogs.filter((i) => i.centerId === centerA);
    assert.equal(remainingCenterAFee.length, 4);
    assert.ok(remainingCenterAFee.some((i) => i.status === "attempted"));
    assert.ok(remainingCenterAFee.some((i) => i.status === "provider_accepted"));
    assert.ok(remainingCenterAFee.some((i) => i.status === "dispatch_uncertain"));
    assert.ok(remainingCenterAFee.some((i) => i.status === "failed" && i._id === "fee-8")); // future lock!

    // Center A Admission Jobs remaining: exactly the 4 protected ones
    const remainingCenterAAdm = mockAdmissionJobs.filter((i) => i.centerId === centerA);
    assert.equal(remainingCenterAAdm.length, 4);
    assert.ok(remainingCenterAAdm.some((i) => i.status === "pending"));
    assert.ok(remainingCenterAAdm.some((i) => i.status === "processing"));
    assert.ok(remainingCenterAAdm.some((i) => i.status === "ambiguous"));
    assert.ok(remainingCenterAAdm.some((i) => i.status === "failed" && i._id === "adm-9")); // active worker lock!

    // Center A Campaigns remaining: exactly the 4 protected campaigns
    const remainingCenterACamp = mockCampaigns.filter((i) => i.centerId === centerA);
    assert.equal(remainingCenterACamp.length, 4);
    assert.ok(remainingCenterACamp.some((i) => i._id === "camp-3" && i.status === "in_progress"));
    assert.ok(remainingCenterACamp.some((i) => i._id === "camp-4" && i.status === "paused"));
    assert.ok(remainingCenterACamp.some((i) => i._id === "camp-5" && i.status === "approved"));
    assert.ok(remainingCenterACamp.some((i) => i._id === "camp-6" && i.status === "pending"));
  });

  await t.test("8. Strict Center Isolation: Center B records are never deleted", async () => {
    seedTestData();
    const req = createMockRequest({
      token: ownerToken, // Owner of Center A
      method: "POST",
      body: { confirm: true },
    });
    await cleanupPostRoute(req);

    // Check Center B data in all 3 models
    const centerBFee = mockFeeLogs.filter((i) => i.centerId === centerB);
    assert.equal(centerBFee.length, 2);
    assert.ok(centerBFee.some((i) => i._id === "fee-b1"));
    assert.ok(centerBFee.some((i) => i._id === "fee-b2"));

    const centerBAdm = mockAdmissionJobs.filter((i) => i.centerId === centerB);
    assert.equal(centerBAdm.length, 1);
    assert.ok(centerBAdm.some((i) => i._id === "adm-b1"));

    const centerBCamp = mockCampaigns.filter((i) => i.centerId === centerB);
    assert.equal(centerBCamp.length, 1);
    assert.ok(centerBCamp.some((i) => i._id === "camp-b1"));
  });

  await t.test("9. Selective Scope: scope: 'successful' removes only terminal successful records", async () => {
    seedTestData();
    const req = createMockRequest({
      token: ownerToken,
      method: "POST",
      body: { confirm: true, scope: "successful" },
    });
    const res = await cleanupPostRoute(req);
    assert.equal(res.status, 200);

    const remainingCenterAFee = mockFeeLogs.filter((i) => i.centerId === centerA);
    // 2 failed terminal remained + 4 protected remained = 6
    assert.equal(remainingCenterAFee.length, 6);
    assert.ok(remainingCenterAFee.some((i) => i._id === "fee-3" && i.status === "failed"));
    assert.ok(remainingCenterAFee.some((i) => i._id === "fee-4" && i.status === "failed"));
    // successful ones were deleted
    assert.ok(!remainingCenterAFee.some((i) => i._id === "fee-1"));
    assert.ok(!remainingCenterAFee.some((i) => i._id === "fee-2"));
  });

  await t.test("10. Selective Scope: scope: 'failed' removes only terminal failed records", async () => {
    seedTestData();
    const req = createMockRequest({
      token: ownerToken,
      method: "POST",
      body: { confirm: true, scope: "failed" },
    });
    const res = await cleanupPostRoute(req);
    assert.equal(res.status, 200);

    const remainingCenterAFee = mockFeeLogs.filter((i) => i.centerId === centerA);
    // 2 successful terminal remained + 4 protected remained = 6
    assert.equal(remainingCenterAFee.length, 6);
    assert.ok(remainingCenterAFee.some((i) => i._id === "fee-1" && i.status === "delivered"));
    assert.ok(remainingCenterAFee.some((i) => i._id === "fee-2" && i.status === "sent"));
    // failed ones were deleted (except fee-8 which has a future retryLock)
    assert.ok(!remainingCenterAFee.some((i) => i._id === "fee-3"));
    assert.ok(!remainingCenterAFee.some((i) => i._id === "fee-4"));
    assert.ok(remainingCenterAFee.some((i) => i._id === "fee-8"));
  });

  await t.test("11. Re-running cleanup when zero records are eligible is safe and returns deletedCount: 0", async () => {
    // Run cleanup twice
    const req1 = createMockRequest({
      token: ownerToken,
      method: "POST",
      body: { confirm: true, scope: "all" },
    });
    await cleanupPostRoute(req1);

    const req2 = createMockRequest({
      token: ownerToken,
      method: "POST",
      body: { confirm: true, scope: "all" },
    });
    const res2 = await cleanupPostRoute(req2);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.success, true);
    assert.equal(data2.deletedCount, 0);
  });

  await t.test("12. Interaction Flow: Clear Logs button click lifecycle & re-entrancy prevention", async () => {
    seedTestData();

    // 1. Initial State: Button is active and not disabled by loading
    let state = {
      loading: false,
      executingCleanup: false,
      showCleanupModal: false,
      cleanupConfirmed: false,
      cleanupPreview: null,
      eligibleLogCount: 23,
      previewError: null,
      cleanupError: null,
    };

    // Button disabled condition: only executingCleanup should disable clicking
    const isButtonDisabled = state.executingCleanup;
    assert.equal(isButtonDisabled, false, "Clear Logs button must NOT be disabled when idle");

    // 2. User clicks Clear Logs
    const handleOpenCleanupModal = async () => {
      if (state.executingCleanup) return;
      state.cleanupConfirmed = false;
      state.previewError = null;
      state.cleanupError = null;
      state.showCleanupModal = true;

      // Simulate fetchCleanupPreview
      const req = createMockRequest({ token: ownerToken, method: "GET" });
      const res = await cleanupGetRoute(req);
      const data = await res.json();
      if (data?.success) {
        state.cleanupPreview = data;
        state.eligibleLogCount = Number(data.eligibleTotal) || 0;
      }
    };

    await handleOpenCleanupModal();
    assert.equal(state.showCleanupModal, true, "Modal must be opened on click");
    assert.ok(state.cleanupPreview !== null, "Preview data must be populated");
    assert.equal(state.cleanupPreview.eligibleTotal, 23);
    assert.equal(state.cleanupConfirmed, false, "Confirmation must be unchecked initially");

    // Confirm button condition in modal
    let canSubmit =
      state.cleanupConfirmed &&
      !state.executingCleanup &&
      state.cleanupPreview?.eligibleTotal !== 0;
    assert.equal(canSubmit, false, "Confirm button must be disabled before checking confirmation");

    // 3. User checks confirmation checkbox
    state.cleanupConfirmed = true;
    canSubmit =
      state.cleanupConfirmed &&
      !state.executingCleanup &&
      state.cleanupPreview?.eligibleTotal !== 0;
    assert.equal(canSubmit, true, "Confirm button must be enabled once checkbox is checked");

    // 4. User clicks Confirm & Clear Logs
    let postCallCount = 0;
    const handleConfirmCleanup = async () => {
      if (!state.cleanupConfirmed || state.executingCleanup) return;
      state.executingCleanup = true;
      postCallCount++;

      const req = createMockRequest({
        token: ownerToken,
        method: "POST",
        body: { confirm: true, scope: "all" },
      });
      const res = await cleanupPostRoute(req);
      const data = await res.json();
      if (data?.success) {
        state.showCleanupModal = false;
        state.cleanupConfirmed = false;
        state.eligibleLogCount = 0;
        state.cleanupPreview = null;
      }
      state.executingCleanup = false;
    };

    // Simulate concurrent double click to test re-entrancy prevention
    const p1 = handleConfirmCleanup();
    const p2 = handleConfirmCleanup(); // second click should be ignored
    await Promise.all([p1, p2]);

    assert.equal(postCallCount, 1, "Re-entrancy guard must prevent duplicate deletion calls");
    assert.equal(state.showCleanupModal, false, "Modal must be closed on successful cleanup");
    assert.equal(state.cleanupConfirmed, false, "Checkbox must reset");
    assert.equal(state.eligibleLogCount, 0, "Eligible count must reset");
  });

  await t.test("13. Error Resilience: Preview service failure captures visible error message", async () => {
    let state = {
      loadingCleanupPreview: false,
      previewError: null,
      cleanupPreview: null,
    };

    // Simulate preview failure (e.g. unauthenticated)
    const handleFailedPreview = async () => {
      state.loadingCleanupPreview = true;
      state.previewError = null;

      const req = createMockRequest({ token: null }); // Missing token
      const res = await cleanupGetRoute(req);
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        state.previewError = data?.error || `HTTP ${res.status}`;
      }
      state.loadingCleanupPreview = false;
    };

    await handleFailedPreview();
    assert.equal(state.loadingCleanupPreview, false);
    assert.ok(state.previewError !== null, "Error message must be populated on failure");
    assert.match(state.previewError, /Authentication required/i);
  });

  await t.test("14. Phase 8.4 Root Cause 1: MessageCampaign status: 'failed_partial' is eligible and cleared", async () => {
    // Specifically test the exact 11 failed messages campaign scenario
    mockCampaigns = [
      {
        _id: "camp-failed-partial-11",
        centerId: centerA,
        status: "failed_partial",
        title: "Test 11 Failed Campaign",
        messages: Array.from({ length: 11 }, (_, i) => ({
          phone: `910000000${i}`,
          status: "failed",
        })),
      },
    ];
    mockFeeLogs = [];
    mockAdmissionJobs = [];

    const preview = await previewWhatsAppLogCleanup(centerA);
    assert.equal(preview.success, true);
    assert.equal(preview.eligibleTotal, 11);
    assert.equal(preview.failedCount, 11);
    assert.equal(preview.breakdown.campaigns.failed, 11);
    assert.equal(preview.breakdown.campaigns.totalEligible, 11);

    const exec = await executeWhatsAppLogCleanup({ centerId: centerA, scope: "all" });
    assert.equal(exec.success, true);
    assert.equal(exec.deletedCount, 11);
    assert.equal(exec.breakdown.failed, 11);
    assert.equal(exec.breakdown.byModel.campaigns, 11);
    assert.equal(mockCampaigns.length, 0, "Campaign must be deleted from database");
  });

  await t.test("15. Phase 8.4 Root Cause 2: AdmissionWelcomeJob status: 'failed' with historical nextRetryAt is eligible", async () => {
    const future = new Date(Date.now() + 86400000);
    mockAdmissionJobs = [
      {
        _id: "adm-failed-with-future-retry",
        centerId: centerA,
        status: "failed",
        studentName: "Failed Student",
        lockExpiresAt: null,
        nextRetryAt: future, // historical backoff timestamp from when max attempts was reached
      },
      {
        _id: "adm-actively-locked",
        centerId: centerA,
        status: "failed",
        studentName: "Active Worker Lease",
        lockExpiresAt: future, // actively locked by a background worker lease!
      },
    ];
    mockFeeLogs = [];
    mockCampaigns = [];

    const preview = await previewWhatsAppLogCleanup(centerA);
    assert.equal(preview.eligibleTotal, 1);
    assert.equal(preview.failedCount, 1);
    assert.equal(preview.breakdown.admissionWelcome.failed, 1);

    const exec = await executeWhatsAppLogCleanup({ centerId: centerA, scope: "all" });
    assert.equal(exec.deletedCount, 1);
    assert.equal(mockAdmissionJobs.length, 1);
    assert.equal(mockAdmissionJobs[0]._id, "adm-actively-locked", "Actively locked lease must be preserved");
  });

  await t.test("16. Phase 8.4 Root Cause Safeguard: Active campaigns (pending, approved, in_progress, paused) are never deleted", async () => {
    mockCampaigns = [
      { _id: "c-pending", centerId: centerA, status: "pending", messages: [{ phone: "111", status: "pending" }] },
      { _id: "c-approved", centerId: centerA, status: "approved", messages: [{ phone: "222", status: "pending" }] },
      { _id: "c-in-progress", centerId: centerA, status: "in_progress", messages: [{ phone: "333", status: "pending" }] },
      { _id: "c-paused", centerId: centerA, status: "paused", messages: [{ phone: "444", status: "pending" }] },
    ];
    mockFeeLogs = [];
    mockAdmissionJobs = [];

    const preview = await previewWhatsAppLogCleanup(centerA);
    assert.equal(preview.eligibleTotal, 0);
    assert.equal(preview.protectedCount, 4);
    assert.equal(preview.breakdown.campaigns.protected, 4);

    const exec = await executeWhatsAppLogCleanup({ centerId: centerA, scope: "all" });
    assert.equal(exec.deletedCount, 0);
    assert.equal(mockCampaigns.length, 4, "All active campaigns must be preserved");
  });
});
