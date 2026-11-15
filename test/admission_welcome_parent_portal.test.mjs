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
process.env.INTERNAL_API_SECRET = "test-internal-secret-1234567890";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-1234567890";

// Helper to create mock requests compatible with NextRequest contracts
function createMockRequest({
  method = "GET",
  url = "http://localhost:3000/api",
  headers = {},
  body = null,
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: {
      get: (k) => headerMap.get(k.toLowerCase()) || null,
    },
    cookies: {
      get: () => null,
    },
    json: async () => body || {},
  };
}

const originalEnv = { ...process.env };
function resetEnv() {
  process.env = { ...originalEnv };
}

test("Admission Welcome + Parent Portal Integration Suite", async (t) => {
  t.afterEach(resetEnv);

  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { encryptToken, decryptToken } = await import(
    "../tution-desk-be/src/lib/tokenCipher.ts"
  );
  const {
    getOrCreateParentAccess,
    getRecoverableInvitationToken,
    regenerateParentAccess,
    hashPortalToken,
  } = await import("../tution-desk-be/src/lib/parentAccessService.ts");
  const {
    sendAdmissionWelcomeMessage,
    formatAdmissionWelcomeMessage,
    isAdmissionWelcomeLiveDispatchEnabled,
  } = await import("../tution-desk-be/src/lib/whatsappService.ts");
  const {
    AdmissionWelcomeJob,
  } = await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts");
  const { ParentAccess } = await import(
    "../tution-desk-be/src/models/ParentAccess.ts"
  );
  const { ParentAccessLock } = await import(
    "../tution-desk-be/src/models/ParentAccessLock.ts"
  );
  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
  const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
  const UserPushSubscription = (await import("../tution-desk-be/src/models/UserPushSubscription.ts")).default;
  const StaffNotification = (await import("../tution-desk-be/src/models/StaffNotification.ts")).default;

  const { POST: studentRoute } = await import(
    "../tution-desk-be/src/app/api/students/route.ts"
  );
  const { GET: parentAccessGet, POST: parentAccessPost } = await import(
    "../tution-desk-be/src/app/api/parent/access/route.ts"
  );
  const { processPendingAdmissionWelcomeJobs } = await import(
    "../tution-desk-be/src/lib/admissionWelcomeQueue.ts"
  );

  // Global Mongoose model stubs to prevent un-connected buffering timeouts
  global.mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };
  mongoose.Model.prototype.save = async function () { return this; };
  StaffNotification.create = async () => null;
  StaffNotification.findOne = async () => null;
  UserPushSubscription.find = () => ({ lean: async () => [] });
  UserPushSubscription.create = async () => null;
  StudentModel.findOne = async (q) => ({
    _id: q?._id || new mongoose.Types.ObjectId(),
    name: "Karan Patel",
    parentWhatsApp: "9876543210",
  });
  ParentAccessLock.findOne = async () => null;
  ParentAccessLock.create = async () => null;
  ParentAccessLock.findOneAndUpdate = async (q, u) => ({ ...q, ...u?.$set, holderId: q?.holderId || "test_holder" });
  ParentAccessLock.deleteOne = async () => null;

  // ---------------------------------------------------------------------------
  // 1. Admission Welcome Live Flag & Guard Configuration
  // ---------------------------------------------------------------------------
  await t.test("1. Production live dispatch requires explicit ENABLE_ADMISSION_WELCOME_WHATSAPP opt-in", () => {
    // When flag is unset -> simulation
    delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
    assert.equal(isAdmissionWelcomeLiveDispatchEnabled("919876543210"), false);

    // When flag is false -> simulation
    process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "false";
    assert.equal(isAdmissionWelcomeLiveDispatchEnabled("919876543210"), false);

    // When flag is true -> live enabled
    process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
    assert.equal(isAdmissionWelcomeLiveDispatchEnabled("919876543210"), true);
  });

  // ---------------------------------------------------------------------------
  // 2. Message Formatting Includes Secure Portal Activation Link
  // ---------------------------------------------------------------------------
  await t.test("2. Admission welcome message formats working portal activation link", () => {
    const rawToken = "pt_secure_random_token_123456789";
    const portalUrl = `https://tuition-desk-monorepo.vercel.app/portal#token=${rawToken}`;

    const formatted = formatAdmissionWelcomeMessage({
      studentName: "Aarav Sharma",
      instituteName: "MSEC Academy",
      batchName: "Class 10 Math",
      portalUrl,
      isExistingActivePortal: false,
    });

    assert.ok(formatted.includes("Aarav Sharma"), "Must include student name");
    assert.ok(formatted.includes("MSEC Academy"), "Must include institute name");
    assert.ok(formatted.includes("Class 10 Math"), "Must include batch name");
    assert.ok(formatted.includes(portalUrl), "Must embed the exact portal activation URL");
    assert.ok(formatted.includes("keep this private to your family"), "Must include security advisory");
  });

  // ---------------------------------------------------------------------------
  // 3. First-Time Student Admission Generates Portal Link & Welcome Message
  // ---------------------------------------------------------------------------
  await t.test("3. First-time student admission creates ParentAccess, builds portal link, and dispatches welcome", async () => {
    const ownerToken = await signToken({
      userId: "owner_1",
      centerId: "center_msec",
      role: "owner",
    });

    const studentId = new mongoose.Types.ObjectId();
    const parentAccessId = new mongoose.Types.ObjectId();
    const rawGeneratedToken = "pt_test_fresh_token_abc123456789";

    const originalStudentCreate = StudentModel.create;
    const originalCenterFindOne = CenterModel.findOne;
    const originalJobFindOne = AdmissionWelcomeJob.findOne;
    const originalJobCreate = AdmissionWelcomeJob.create;
    const originalParentAccessFindOne = ParentAccess.findOne;
    const originalParentAccessCreate = ParentAccess.create;
    const originalFetch = globalThis.fetch;

    let studentDocCreated = null;
    let jobCreated = null;
    let parentAccessCreated = null;
    let whatsappPayloadDispatched = null;

    try {
      ParentAccessLock.hasUniqueLockIndex = async () => true;

      StudentModel.create = async (doc) => {
        studentDocCreated = { ...doc, _id: studentId };
        return studentDocCreated;
      };
      StudentModel.findOne = async () => ({
        _id: studentId,
        name: "Karan Patel",
        parentWhatsApp: "9876543210",
        centerId: "center_msec",
      });

      CenterModel.findOne = () => ({
        select: async () => ({ name: "MSEC Coaching Institute" }),
      });

      AdmissionWelcomeJob.findOne = async () => null;
      AdmissionWelcomeJob.create = async (doc) => {
        jobCreated = { ...doc, _id: new mongoose.Types.ObjectId() };
        return jobCreated;
      };

      ParentAccess.findOne = async () => null; // Fresh admission -> no existing record
      ParentAccess.create = async (doc) => {
        parentAccessCreated = {
          ...doc,
          _id: parentAccessId,
          tokenPrefix: rawGeneratedToken.slice(0, 8),
          invitationTokenCipher: encryptToken(rawGeneratedToken),
        };
        return parentAccessCreated;
      };

      // Mock live WhatsApp service HTTP response
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      process.env.WHATSAPP_SERVICE_URL = "http://127.0.0.1:3005";
      globalThis.fetch = async (url, opts) => {
        if (url.includes("/send-message")) {
          whatsappPayloadDispatched = JSON.parse(opts.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              accepted: true,
              delivered: false,
              messageId: "msg_live_admission_101",
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      const req = createMockRequest({
        method: "POST",
        url: "http://localhost:3000/api/students",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: {
          name: "Karan Patel",
          batch: "Class 12 Physics",
          parentWhatsApp: "9876543210",
        },
      });

      const res = await studentRoute(req);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);

      // Verify student created
      assert.equal(studentDocCreated.name, "Karan Patel");
      assert.equal(studentDocCreated.centerId, "center_msec");

      // Verify WhatsApp payload contains portal link
      assert.ok(whatsappPayloadDispatched, "WhatsApp message must be dispatched");
      assert.ok(
        whatsappPayloadDispatched.message.includes("/portal#token="),
        "WhatsApp message must contain portal activation token link"
      );
      assert.ok(
        whatsappPayloadDispatched.message.includes("Karan Patel"),
        "WhatsApp message must address the student"
      );

      // Verify AdmissionWelcomeJob status is 'sent' with token scrubbed on live acceptance
      assert.ok(jobCreated, "Welcome job must be recorded");
      assert.equal(jobCreated.status, "sent");
      assert.equal(jobCreated.encryptedInvitationToken, null, "Raw token must be scrubbed after live acceptance");
      assert.equal(jobCreated.messageId, "msg_live_admission_101");
    } finally {
      StudentModel.create = originalStudentCreate;
      CenterModel.findOne = originalCenterFindOne;
      AdmissionWelcomeJob.findOne = originalJobFindOne;
      AdmissionWelcomeJob.create = originalJobCreate;
      ParentAccess.findOne = originalParentAccessFindOne;
      ParentAccess.create = originalParentAccessCreate;
      globalThis.fetch = originalFetch;
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Temporary WhatsApp Outage Preserves Job for Automatic Retry
  // ---------------------------------------------------------------------------
  await t.test("4. Temporary WhatsApp microservice failure preserves job as PENDING with retry schedule", async () => {
    const ownerToken = await signToken({
      userId: "owner_1",
      centerId: "center_msec",
      role: "owner",
    });

    const studentId = new mongoose.Types.ObjectId();
    const parentAccessId = new mongoose.Types.ObjectId();
    const rawGeneratedToken = "pt_test_retry_token_xyz987654321";

    const originalStudentCreate = StudentModel.create;
    const originalCenterFindOne = CenterModel.findOne;
    const originalJobFindOne = AdmissionWelcomeJob.findOne;
    const originalJobCreate = AdmissionWelcomeJob.create;
    const originalParentAccessFindOne = ParentAccess.findOne;
    const originalParentAccessCreate = ParentAccess.create;
    const originalFetch = globalThis.fetch;

    let jobCreated = null;

    try {
      ParentAccessLock.hasUniqueLockIndex = async () => true;

      StudentModel.create = async (doc) => ({ ...doc, _id: studentId });
      StudentModel.findOne = async () => ({
        _id: studentId,
        name: "Siddharth Jain",
        parentWhatsApp: "9876543211",
        centerId: "center_msec",
      });
      CenterModel.findOne = () => ({ select: async () => ({ name: "MSEC Academy" }) });
      AdmissionWelcomeJob.findOne = async () => null;

      AdmissionWelcomeJob.create = async (doc) => {
        jobCreated = { ...doc, _id: new mongoose.Types.ObjectId() };
        return jobCreated;
      };

      ParentAccess.findOne = async () => null;
      ParentAccess.create = async (doc) => ({
        ...doc,
        _id: parentAccessId,
        tokenPrefix: rawGeneratedToken.slice(0, 8),
        invitationTokenCipher: encryptToken(rawGeneratedToken),
      });

      // Simulate WhatsApp microservice temporary outage (HTTP 503 Service Unavailable)
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      process.env.WHATSAPP_SERVICE_URL = "http://127.0.0.1:3005";
      globalThis.fetch = async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3005");
      };

      const req = createMockRequest({
        method: "POST",
        url: "http://localhost:3000/api/students",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: {
          name: "Siddharth Jain",
          batch: "Class 11 Chemistry",
          parentWhatsApp: "9876543211",
        },
      });

      const res = await studentRoute(req);
      assert.equal(res.status, 201, "Student creation must succeed even if WhatsApp is temporarily down");

      // Verify job was preserved in 'pending' status with future retry scheduled
      assert.ok(jobCreated, "Job must be persisted in database");
      assert.equal(jobCreated.status, "pending", "Status must be PENDING (not dead 'failed')");
      assert.ok(jobCreated.nextRetryAt instanceof Date, "Must schedule nextRetryAt");
      assert.ok(jobCreated.nextRetryAt > new Date(), "nextRetryAt must be in future");
      assert.equal(jobCreated.attempts, 1);
      assert.ok(jobCreated.encryptedInvitationToken, "Encrypted token must be preserved for retry worker");
      assert.ok(jobCreated.failureReason.includes("ECONNREFUSED"), "Must record diagnostic failure reason");
    } finally {
      StudentModel.create = originalStudentCreate;
      CenterModel.findOne = originalCenterFindOne;
      AdmissionWelcomeJob.findOne = originalJobFindOne;
      AdmissionWelcomeJob.create = originalJobCreate;
      ParentAccess.findOne = originalParentAccessFindOne;
      ParentAccess.create = originalParentAccessCreate;
      globalThis.fetch = originalFetch;
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Idempotency on Student Admission Retries
  // ---------------------------------------------------------------------------
  await t.test("5. Admission retries do NOT create duplicate welcome jobs or rotate parent access tokens", async () => {
    const ownerToken = await signToken({
      userId: "owner_1",
      centerId: "center_msec",
      role: "owner",
    });

    const studentId = new mongoose.Types.ObjectId();
    const existingJobId = new mongoose.Types.ObjectId();

    const originalStudentCreate = StudentModel.create;
    const originalCenterFindOne = CenterModel.findOne;
    const originalJobFindOne = AdmissionWelcomeJob.findOne;
    const originalJobCreate = AdmissionWelcomeJob.create;
    const originalParentAccessFindOne = ParentAccess.findOne;
    const originalParentAccessCreate = ParentAccess.create;

    let createJobCalled = false;
    let createParentAccessCalled = false;

    try {
      ParentAccessLock.hasUniqueLockIndex = async () => true;

      StudentModel.create = async (doc) => ({ ...doc, _id: studentId });
      StudentModel.findOne = async () => ({
        _id: studentId,
        name: "Siddharth Jain",
        parentWhatsApp: "9876543211",
        centerId: "center_msec",
      });
      CenterModel.findOne = () => ({ select: async () => ({ name: "MSEC Academy" }) });

      // Existing job already recorded for this admission idempotency key
      AdmissionWelcomeJob.findOne = async () => ({
        _id: existingJobId,
        status: "sent",
        studentName: "Duplicate Test Student",
      });

      AdmissionWelcomeJob.create = async () => {
        createJobCalled = true;
        throw new Error("SHOULD_NOT_BE_CALLED");
      };

      // Existing ParentAccess record already linked
      ParentAccess.findOne = async () => ({
        _id: new mongoose.Types.ObjectId(),
        centerId: "center_msec",
        parentPhone: "919876543210",
        linkedStudentIds: [studentId],
        tokenPrefix: "pt_exist8",
        invitationTokenCipher: encryptToken("pt_exist8_full_token_abcdef12345"),
        status: "active",
      });

      ParentAccess.create = async () => {
        createParentAccessCalled = true;
        throw new Error("SHOULD_NOT_CREATE_NEW_PARENT_ACCESS");
      };

      const req = createMockRequest({
        method: "POST",
        url: "http://localhost:3000/api/students",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: {
          name: "Duplicate Test Student",
          batch: "Class 10 Math",
          parentWhatsApp: "9876543210",
        },
      });

      const res = await studentRoute(req);
      assert.equal(res.status, 201);
      assert.equal(createJobCalled, false, "Must not create duplicate welcome job on retry");
      assert.equal(createParentAccessCalled, false, "Must not create duplicate ParentAccess on retry");
    } finally {
      StudentModel.create = originalStudentCreate;
      CenterModel.findOne = originalCenterFindOne;
      AdmissionWelcomeJob.findOne = originalJobFindOne;
      AdmissionWelcomeJob.create = originalJobCreate;
      ParentAccess.findOne = originalParentAccessFindOne;
      ParentAccess.create = originalParentAccessCreate;
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Owner Manual Portal Link Recovery & Management Controls
  // ---------------------------------------------------------------------------
  await t.test("6. Owner manual portal link retrieval recovers working link non-destructively", async () => {
    const ownerToken = await signToken({
      userId: "owner_1",
      centerId: "center_msec",
      role: "owner",
    });

    const studentId = new mongoose.Types.ObjectId();
    const rawSavedToken = "pt_recoverable_owner_token_99999999";

    const originalParentAccessFindOne = ParentAccess.findOne;

    try {
      // Mock ParentAccess document with encrypted recoverable token
      ParentAccess.findOne = () => ({
        populate: async () => ({
          _id: new mongoose.Types.ObjectId(),
          centerId: "center_msec",
          parentPhone: "919876543210",
          parentName: "Sunita Roy",
          tokenPrefix: rawSavedToken.slice(0, 8),
          tokenHash: hashPortalToken(rawSavedToken),
          invitationTokenCipher: encryptToken(rawSavedToken),
          status: "active",
          isPasswordProtected: false,
          linkedStudentIds: [{ _id: studentId, name: "Ananya Roy", batch: "Batch A" }],
          createdAt: new Date(),
        }),
      });

      const req = createMockRequest({
        method: "GET",
        url: `http://localhost:3000/api/parent/access?studentId=${studentId}`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
        },
      });

      const res = await parentAccessGet(req);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.exists, true);
      assert.ok(data.portalUrl, "Must return recovered portal URL");
      assert.ok(
        data.portalUrl.includes(rawSavedToken),
        "Recovered URL must contain the same raw token without rotation"
      );
    } finally {
      ParentAccess.findOne = originalParentAccessFindOne;
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Strict Tenant Isolation
  // ---------------------------------------------------------------------------
  await t.test("7. Tenant isolation: Owner of Center A cannot query or recover Center B parent access", async () => {
    const ownerCenterAToken = await signToken({
      userId: "owner_a",
      centerId: "center_alpha",
      role: "owner",
    });

    const studentCenterBId = new mongoose.Types.ObjectId();

    const originalParentAccessFindOne = ParentAccess.findOne;
    let queryUsed = null;

    try {
      ParentAccess.findOne = (q) => {
        queryUsed = q;
        return {
          populate: async () => null, // Center mismatch returns null
        };
      };

      const req = createMockRequest({
        method: "GET",
        url: `http://localhost:3000/api/parent/access?studentId=${studentCenterBId}`,
        headers: {
          Authorization: `Bearer ${ownerCenterAToken}`,
        },
      });

      const res = await parentAccessGet(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.exists, false, "Must not find access document belonging to another center");
      assert.equal(queryUsed.centerId, "center_alpha", "Query must strictly be scoped to authenticated centerId");
    } finally {
      ParentAccess.findOne = originalParentAccessFindOne;
    }
  });
});
