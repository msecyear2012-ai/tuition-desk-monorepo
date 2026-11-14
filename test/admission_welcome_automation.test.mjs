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

// Save environment
const originalEnv = { ...process.env };
function resetEnv() {
  process.env = { ...originalEnv };
}

test("Automatic Admission Welcome WhatsApp Automation Suite", async (t) => {
  t.afterEach(resetEnv);

  const {
    encryptToken,
    decryptToken,
  } = await import("../tution-desk-be/src/lib/tokenCipher.ts");

  const {
    enqueueAdmissionWelcomeJob,
    bulkEnqueueAdmissionWelcomeJobs,
    processPendingAdmissionWelcomeJobs,
    buildAdmissionWelcomeIdempotencyKey,
  } = await import("../tution-desk-be/src/lib/admissionWelcomeQueue.ts");

  const {
    isAdmissionWelcomeLiveDispatchEnabled,
    formatAdmissionWelcomeMessage,
    sendAdmissionWelcomeMessage,
    isLiveDispatchEnabled,
  } = await import("../tution-desk-be/src/lib/whatsappService.ts");

  const {
    AdmissionWelcomeJob,
    verifyAdmissionWelcomeJobIndexIntegrity,
  } = await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts");
  const { ParentAccess } = await import(
    "../tution-desk-be/src/models/ParentAccess.ts"
  );
  const {
    ParentAccessLock,
    verifyParentAccessLockIndexIntegrity,
  } = await import("../tution-desk-be/src/models/ParentAccessLock.ts");
  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts"))
    .default;
  const CenterModel = (await import("../tution-desk-be/src/models/Center.ts"))
    .default;
  const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts"))
    .default;

  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { POST: studentRoute } = await import(
    "../tution-desk-be/src/app/api/students/route.ts"
  );
  const { POST: cronProcessRoute } = await import(
    "../tution-desk-be/src/app/api/cron/process-admission-welcome/route.ts"
  );

  // Default in-memory stubs to prevent un-connected Mongoose query buffering delays
  ParentAccess.findOne = async () => null;
  ParentAccess.create = async () => null;
  ParentAccessLock.hasUniqueLockIndex = async () => false;
  StudentModel.findOne = async (q) => ({ _id: q?._id || new mongoose.Types.ObjectId() });
  AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
  AdmissionWelcomeJob.findOneAndUpdate = async () => null;
  AdmissionWelcomeJob.hasUniqueIdempotencyIndex = async () => true;
  CenterModel.findOne = () => ({
    select: async () => ({ name: "MSEC Tuition Academy" }),
  });

  // ---------------------------------------------------------------------------
  // 1. Token Encryption & Cipher Protection Tests (Requirement C)
  // ---------------------------------------------------------------------------
  await t.test(
    "1. Token Protection: AES-256-GCM encryption secures raw invitation tokens",
    () => {
      const rawToken = "pt_random_high_entropy_secret_123456789";
      const encrypted = encryptToken(rawToken);

      assert.ok(encrypted.iv, "IV must be generated");
      assert.ok(encrypted.authTag, "Auth tag must be generated");
      assert.ok(encrypted.ciphertext, "Ciphertext must be generated");
      assert.notEqual(
        encrypted.ciphertext,
        rawToken,
        "Ciphertext must not match raw token"
      );
      assert.equal(
        encrypted.ciphertext.includes("pt_"),
        false,
        "Ciphertext must never contain plaintext token prefix"
      );

      const decrypted = decryptToken(encrypted);
      assert.equal(
        decrypted,
        rawToken,
        "Decrypted token must exactly match original raw token"
      );

      // Decryption fails closed on corrupted/tampered payload
      const tampered = { ...encrypted, ciphertext: "bad_ciphertext_value" };
      assert.equal(decryptToken(tampered), null);
      assert.equal(decryptToken(null), null);
    }
  );

  // ---------------------------------------------------------------------------
  // 2. WhatsApp Independent Security & Safeguards (Requirement 5 & F)
  // ---------------------------------------------------------------------------
  await t.test(
    "2. WhatsApp Security: Admission welcome has dedicated default-OFF dispatch guard",
    async () => {
      delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
      delete process.env.WHATSAPP_MODE;
      delete process.env.ENABLE_LIVE_WHATSAPP;
      delete process.env.ALLOW_TEST_WHATSAPP_DISPATCH;

      // 2.1 Default OFF check
      assert.equal(
        isAdmissionWelcomeLiveDispatchEnabled(),
        false,
        "Must default to false when unset"
      );

      // 2.2 Global live guard is NOT enabled
      assert.equal(isLiveDispatchEnabled(), false);

      // 2.3 Setting ALLOW_TEST_WHATSAPP_DISPATCH does NOT enable admission welcome
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      assert.equal(
        isAdmissionWelcomeLiveDispatchEnabled(),
        false,
        "Test ping flag must NOT enable business admission welcome"
      );

      // 2.4 Setting ENABLE_ADMISSION_WELCOME_WHATSAPP='true' enables only admission welcome
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      assert.equal(isAdmissionWelcomeLiveDispatchEnabled(), true);
      assert.equal(
        isLiveDispatchEnabled(),
        false,
        "Global live guard must remain false"
      );

      // 2.5 Simulation fallback: zero outbound network requests
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "false";
      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("Should not be called");
      };

      try {
        const res = await sendAdmissionWelcomeMessage({
          centerId: "center_1",
          phone: "9876543210",
          studentName: "Aarav Sharma",
          instituteName: "MSEC Academy",
          batchName: "Class 10 Science",
        });

        assert.equal(res.success, true);
        assert.equal(res.simulated, true);
        assert.equal(res.accepted, false);
        assert.equal(res.delivered, false);
        assert.equal(fetchCalled, false, "Must make zero network calls in simulation mode");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 3. Message Template & Sensitive Data Formatting (Requirement 6)
  // ---------------------------------------------------------------------------
  await t.test(
    "3. Message Content: Professional template preserves privacy and link safety",
    () => {
      // 3.1 First admission with one-time portal URL
      const firstMsg = formatAdmissionWelcomeMessage({
        studentName: "Pooja Patel",
        instituteName: "MSEC Institute",
        batchName: "Class 12 Physics",
        portalUrl: "http://localhost:3000/portal#token=pt_test123",
      });

      assert.match(firstMsg, /Namaste! Welcome to MSEC Institute/);
      assert.match(firstMsg, /Pooja Patel/);
      assert.match(firstMsg, /Class 12 Physics/);
      assert.match(firstMsg, /Access your secure Parent Portal here:/);
      assert.match(firstMsg, /#token=pt_test123/);
      assert.doesNotMatch(firstMsg, /monthlyFee|password|dob/i);

      // 3.2 Existing active access directs to general portal login
      const existingMsg = formatAdmissionWelcomeMessage({
        studentName: "Rohan Patel",
        instituteName: "MSEC Institute",
        batchName: "Class 12 Physics",
        isExistingActivePortal: true,
      });

      assert.match(existingMsg, /Your Parent Portal account is already active/);
      assert.match(existingMsg, /\/portal/);
      assert.doesNotMatch(existingMsg, /#token=/);

      // 3.3 Link omitted when ParentAccess is blocked/pending
      const pendingMsg = formatAdmissionWelcomeMessage({
        studentName: "Aditi Rao",
        instituteName: "MSEC Institute",
        batchName: "Class 9 Maths",
      });

      assert.match(pendingMsg, /We are pleased to confirm the admission of Aditi Rao/);
      assert.doesNotMatch(pendingMsg, /Parent Portal/);
    }
  );

  // ---------------------------------------------------------------------------
  // 4. Duplicate Protection & Durable Idempotency (Requirement 3)
  // ---------------------------------------------------------------------------
  await t.test(
    "4. Duplicate Protection: Idempotency key prevents duplicate queue jobs",
    async () => {
      const centerId = "center_idempotency_test";
      const studentId = new mongoose.Types.ObjectId();
      const parentPhone = "9876543210";

      const originalFindOne = AdmissionWelcomeJob.findOne;
      const originalCreate = AdmissionWelcomeJob.create;
      const originalStudentFindOne = StudentModel.findOne;
      ParentAccessLock.hasUniqueLockIndex = async () => false;

      StudentModel.findOne = async () => ({
        _id: studentId,
        centerId,
        parentWhatsApp: parentPhone,
      });

      const jobsMap = new Map();

      AdmissionWelcomeJob.findOne = async (query) => {
        if (query.idempotencyKey) {
          return jobsMap.get(query.idempotencyKey) || null;
        }
        return null;
      };

      AdmissionWelcomeJob.create = async (doc) => {
        if (jobsMap.has(doc.idempotencyKey)) {
          const err = new Error("Duplicate key");
          err.code = 11000;
          throw err;
        }
        const createdDoc = {
          _id: new mongoose.Types.ObjectId(),
          ...doc,
        };
        jobsMap.set(doc.idempotencyKey, createdDoc);
        return createdDoc;
      };

      try {
        // Enqueue 1
        const res1 = await enqueueAdmissionWelcomeJob({
          centerId,
          studentId,
          parentPhone,
          studentName: "Test Student",
          batchName: "Batch A",
        });
        assert.equal(res1.enqueued, true);

        // Enqueue 2 (Repeated request)
        const res2 = await enqueueAdmissionWelcomeJob({
          centerId,
          studentId,
          parentPhone,
          studentName: "Test Student",
          batchName: "Batch A",
        });
        assert.equal(res2.enqueued, false, "Must detect existing job and not duplicate");
        assert.equal(res1.jobId, res2.jobId, "Must return the same existing jobId");
      } finally {
        AdmissionWelcomeJob.findOne = originalFindOne;
        AdmissionWelcomeJob.create = originalCreate;
        StudentModel.findOne = originalStudentFindOne;
        delete ParentAccessLock.hasUniqueLockIndex;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 5. ParentAccess Coordination & Missing Index Blocker (Requirement 5 & D)
  // ---------------------------------------------------------------------------
  await t.test(
    "5. Blocker Protection: Missing ParentAccessLock index holds job fail-closed",
    async () => {
      const centerId = "center_blocker_test";
      const studentId = new mongoose.Types.ObjectId();

      const originalFindOne = AdmissionWelcomeJob.findOne;
      const originalCreate = AdmissionWelcomeJob.create;
      const originalStudentFindOne = StudentModel.findOne;
      const originalParentAccessFindOne = ParentAccess.findOne;

      // Mock index to be missing so verifyParentAccessLockIndexIntegrity returns false instantly
      ParentAccessLock.hasUniqueLockIndex = async () => false;

      StudentModel.findOne = async () => ({
        _id: studentId,
        centerId,
        parentWhatsApp: "9876543210",
      });

      ParentAccess.findOne = async () => null;

      let createdJob = null;
      AdmissionWelcomeJob.findOne = async () => null;
      AdmissionWelcomeJob.create = async (doc) => {
        createdJob = { _id: new mongoose.Types.ObjectId(), ...doc };
        return createdJob;
      };

      try {
        const res = await enqueueAdmissionWelcomeJob({
          centerId,
          studentId,
          parentPhone: "9876543210",
          studentName: "Test Blocked Student",
          batchName: "Batch X",
        });

        assert.equal(res.enqueued, true);
        assert.equal(res.status, "pending");
        // Because ParentAccessLock unique index is missing in tests / production,
        // it must report blocked_index and hold without crashing or corrupting
        assert.equal(res.parentAccessStatus, "blocked_index");
        assert.equal(createdJob.encryptedInvitationToken, null);
      } finally {
        AdmissionWelcomeJob.findOne = originalFindOne;
        AdmissionWelcomeJob.create = originalCreate;
        StudentModel.findOne = originalStudentFindOne;
        ParentAccess.findOne = originalParentAccessFindOne;
        delete ParentAccessLock.hasUniqueLockIndex;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 6. Single Student Admission API: Owner & Teacher Access (Requirement 1 & 4)
  // ---------------------------------------------------------------------------
  await t.test(
    "6. Single Admission API: Both Owner and Teacher admissions trigger queueing",
    async () => {
      const originalStudentCreate = StudentModel.create;
      const originalStudentFindOne = StudentModel.findOne;
      const originalTeacherFindOne = TeacherModel.findOne;
      const originalJobFindOne = AdmissionWelcomeJob.findOne;
      const originalJobCreate = AdmissionWelcomeJob.create;
      const originalJobUpdateMany = AdmissionWelcomeJob.updateMany;
      const originalJobFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;
      ParentAccessLock.hasUniqueLockIndex = async () => false;

      let studentDocCreated = null;
      let jobCreated = null;

      StudentModel.create = async (data) => {
        studentDocCreated = {
          _id: new mongoose.Types.ObjectId(),
          ...data,
        };
        return studentDocCreated;
      };

      StudentModel.findOne = async (query) => {
        if (studentDocCreated && String(query._id) === String(studentDocCreated._id)) {
          return studentDocCreated;
        }
        return null;
      };

      AdmissionWelcomeJob.findOne = async () => null;
      AdmissionWelcomeJob.create = async (data) => {
        jobCreated = {
          _id: new mongoose.Types.ObjectId(),
          ...data,
        };
        return jobCreated;
      };
      AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
      AdmissionWelcomeJob.findOneAndUpdate = async () => null;

      try {
        // 6.1 Owner Admission
        const ownerToken = await signToken({
          userId: "owner_1",
          centerId: "center_msec",
          role: "owner",
        });

        const ownerReq = createMockRequest({
          method: "POST",
          url: "http://localhost:3000/api/students",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ownerToken}`,
          },
          body: {
            name: "Rahul Verma",
            batch: "Class 10 - Maths",
            parentWhatsApp: "9876543210",
          },
        });

        const ownerRes = await studentRoute(ownerReq);
        assert.equal(ownerRes.status, 201);
        const ownerData = await ownerRes.json();
        assert.equal(ownerData.success, true);
        assert.equal(studentDocCreated.name, "Rahul Verma");
        assert.ok(jobCreated, "Admission welcome job must be created");
        assert.equal(jobCreated.studentName, "Rahul Verma");
        assert.equal(jobCreated.centerId, "center_msec");

        // 6.2 Teacher Admission (Scoped to Teacher's Institute)
        const teacherId = new mongoose.Types.ObjectId();
        const teacherToken = await signToken({
          userId: "teacher_user_1",
          centerId: "center_msec",
          role: "teacher",
          teacherId: String(teacherId),
        });

        jobCreated = null;
        studentDocCreated = null;

        const teacherReq = createMockRequest({
          method: "POST",
          url: "http://localhost:3000/api/students",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${teacherToken}`,
          },
          body: {
            name: "Ananya Roy",
            batch: "Class 10 - Science",
            parentWhatsApp: "9876543211",
          },
        });

        const teacherRes = await studentRoute(teacherReq);
        assert.equal(teacherRes.status, 201);
        const teacherData = await teacherRes.json();
        assert.equal(teacherData.success, true);
        assert.equal(studentDocCreated.name, "Ananya Roy");
        assert.equal(
          String(studentDocCreated.assignedTeacherId),
          String(teacherId),
          "Teacher must automatically be assigned to self"
        );
        assert.ok(jobCreated, "Teacher admission must trigger welcome job");
        assert.equal(jobCreated.studentName, "Ananya Roy");
      } finally {
        await new Promise((resolve) => setImmediate(resolve));
        StudentModel.create = originalStudentCreate;
        StudentModel.findOne = originalStudentFindOne;
        TeacherModel.findOne = originalTeacherFindOne;
        AdmissionWelcomeJob.findOne = originalJobFindOne;
        AdmissionWelcomeJob.create = originalJobCreate;
        AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
        AdmissionWelcomeJob.findOneAndUpdate = async () => null;
        ParentAccessLock.hasUniqueLockIndex = async () => false;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 7. Bulk Import Queueing & Partial Success Handling (Requirement 2 & 8)
  // ---------------------------------------------------------------------------
  await t.test(
    "7. Bulk Import Integration: Enqueues one job per successful student",
    async () => {
      const centerId = "center_bulk_test";
      const students = [
        {
          _id: new mongoose.Types.ObjectId(),
          name: "Bulk Student 1",
          batch: "Batch A",
          parentWhatsApp: "9876543210",
        },
        {
          _id: new mongoose.Types.ObjectId(),
          name: "Bulk Student 2",
          batch: "Batch A",
          parentWhatsApp: "9876543211",
        },
      ];

      const originalFindOne = AdmissionWelcomeJob.findOne;
      const originalCreate = AdmissionWelcomeJob.create;
      const originalParentAccessFindOne = ParentAccess.findOne;
      ParentAccessLock.hasUniqueLockIndex = async () => false;
      ParentAccess.findOne = async () => null;

      const createdJobs = [];
      AdmissionWelcomeJob.findOne = async () => null;
      AdmissionWelcomeJob.create = async (doc) => {
        const j = { _id: new mongoose.Types.ObjectId(), ...doc };
        createdJobs.push(j);
        return j;
      };

      try {
        const result = await bulkEnqueueAdmissionWelcomeJobs(centerId, students);
        assert.equal(result.enqueuedCount, 2);
        assert.equal(result.skippedCount, 0);
        assert.equal(createdJobs.length, 2);
        assert.equal(createdJobs[0].studentName, "Bulk Student 1");
        assert.equal(createdJobs[1].studentName, "Bulk Student 2");

        // Partial success test: student missing _id is safely skipped
        const partialList = [
          { name: "No ID Student", batch: "Batch A", parentWhatsApp: "9876543210" },
        ];
        const partialResult = await bulkEnqueueAdmissionWelcomeJobs(
          centerId,
          partialList
        );
        assert.equal(partialResult.skippedCount, 1);
        assert.equal(partialResult.enqueuedCount, 0);
      } finally {
        AdmissionWelcomeJob.findOne = originalFindOne;
        AdmissionWelcomeJob.create = originalCreate;
        ParentAccess.findOne = originalParentAccessFindOne;
        ParentAccessLock.hasUniqueLockIndex = async () => false;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 8. Durable Worker Claiming, Retry & Lease Recovery (Requirement B & 7)
  // ---------------------------------------------------------------------------
  await t.test(
    "8. Worker Engine: Atomic claiming, lease recovery, and sequential processing",
    async () => {
      const originalUpdateMany = AdmissionWelcomeJob.updateMany;
      const originalFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;
      const originalUpdateOne = AdmissionWelcomeJob.updateOne;
      const originalCenterFindOne = CenterModel.findOne;

      let leaseRecovered = false;
      AdmissionWelcomeJob.updateMany = async (filter) => {
        if (filter.status === "processing") {
          leaseRecovered = true;
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };

      CenterModel.findOne = () => ({
        select: async () => ({ name: "MSEC Tuition Academy" }),
      });

      // Mock queue with 1 ready job (provisioned with encrypted token)
      const rawSecret = "pt_worker_test_token_secret_123456";
      const encrypted = encryptToken(rawSecret);

      const mockJob = {
        _id: new mongoose.Types.ObjectId(),
        centerId: "center_worker_test",
        studentId: new mongoose.Types.ObjectId(),
        parentAccessId: new mongoose.Types.ObjectId(),
        studentName: "Kavya Reddy",
        batchName: "Class 11 Chemistry",
        parentPhone: "9876543210",
        status: "processing",
        parentAccessStatus: "provisioned",
        encryptedInvitationToken: encrypted,
        attempts: 1,
        maxAttempts: 3,
      };

      let claimed = false;
      AdmissionWelcomeJob.findOneAndUpdate = async () => {
        if (!claimed) {
          claimed = true;
          return mockJob;
        }
        return null; // queue empty on next pull
      };

      let updatedDoc = null;
      let unsetFields = null;
      AdmissionWelcomeJob.updateOne = async (filter, update) => {
        if (update.$set) {
          updatedDoc = update.$set;
        }
        if (update.$unset) {
          unsetFields = update.$unset;
        }
        return { modifiedCount: 1 };
      };

      try {
        const summary = await processPendingAdmissionWelcomeJobs(
          "center_worker_test",
          5
        );
        assert.equal(leaseRecovered, true, "Worker must run lease recovery sweep first");
        assert.equal(summary.processed, 1);
        assert.equal(summary.simulated, 1);
        assert.equal(updatedDoc.status, "simulated", "Simulation must set status to simulated");
        assert.notEqual(updatedDoc.status, "sent", "Simulation must never mark job as genuinely sent");
        assert.equal(unsetFields, null, "Simulation must never scrub encryptedInvitationToken");
      } finally {
        AdmissionWelcomeJob.updateMany = originalUpdateMany;
        AdmissionWelcomeJob.findOneAndUpdate = originalFindOneAndUpdate;
        AdmissionWelcomeJob.updateOne = originalUpdateOne;
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 9. Scheduled Cron Polling Route Authorization (Requirement B & 5)
  // ---------------------------------------------------------------------------
  await t.test(
    "9. Cron Worker Route: Strictly protected by CRON_SECRET",
    async () => {
      const originalUpdateMany = AdmissionWelcomeJob.updateMany;
      const originalFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;

      AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
      AdmissionWelcomeJob.findOneAndUpdate = async () => null;

      try {
        // 9.1 Missing secret -> 401
        const unauthReq = createMockRequest({
          method: "POST",
          url: "http://localhost:3000/api/cron/process-admission-welcome",
          headers: { "Content-Type": "application/json" },
        });
        const unauthRes = await cronProcessRoute(unauthReq);
        assert.equal(unauthRes.status, 401);

        // 9.2 Invalid secret -> 401
        const badReq = createMockRequest({
          method: "POST",
          url: "http://localhost:3000/api/cron/process-admission-welcome",
          headers: {
            "Content-Type": "application/json",
            "x-cron-secret": "wrong-secret",
          },
        });
        const badRes = await cronProcessRoute(badReq);
        assert.equal(badRes.status, 401);

        // 9.3 Valid secret -> 200
        const validReq = createMockRequest({
          method: "POST",
          url: "http://localhost:3000/api/cron/process-admission-welcome",
          headers: {
            "Content-Type": "application/json",
            "x-cron-secret": process.env.CRON_SECRET,
          },
          body: { limit: 1 },
        });
        const validRes = await cronProcessRoute(validReq);
        assert.equal(validRes.status, 200);
        const data = await validRes.json();
        assert.equal(data.success, true);
        assert.ok(data.summary);
      } finally {
        AdmissionWelcomeJob.updateMany = originalUpdateMany;
        AdmissionWelcomeJob.findOneAndUpdate = originalFindOneAndUpdate;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 10. Actual Microservice Acceptance: Permits Token Scrubbing (Requirement 1)
  // ---------------------------------------------------------------------------
  await t.test(
    "10. Live Microservice Acceptance: Permits token scrubbing and genuinely sent status",
    async () => {
      const originalFetch = globalThis.fetch;
      const originalUpdateMany = AdmissionWelcomeJob.updateMany;
      const originalFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;
      const originalUpdateOne = AdmissionWelcomeJob.updateOne;
      const originalCenterFindOne = CenterModel.findOne;

      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      process.env.WHATSAPP_INTERNAL_SECRET = "test-secret-123";

      const rawSecret = "pt_live_test_token_secret_abcdef";
      const encrypted = encryptToken(rawSecret);

      const liveJob = {
        _id: new mongoose.Types.ObjectId(),
        centerId: "center_live_test",
        studentId: new mongoose.Types.ObjectId(),
        parentAccessId: new mongoose.Types.ObjectId(),
        studentName: "Dev Patel",
        batchName: "Class 12 Physics",
        parentPhone: "9876543210",
        status: "processing",
        parentAccessStatus: "provisioned",
        encryptedInvitationToken: encrypted,
        attempts: 1,
        maxAttempts: 3,
      };

      let claimed = false;
      AdmissionWelcomeJob.findOneAndUpdate = async () => {
        if (!claimed) {
          claimed = true;
          return liveJob;
        }
        return null;
      };

      AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
      CenterModel.findOne = () => ({
        select: async () => ({ name: "MSEC Tuition Academy" }),
      });

      let updatedDoc = null;
      let unsetFields = null;
      AdmissionWelcomeJob.updateOne = async (filter, update) => {
        if (update.$set) updatedDoc = update.$set;
        if (update.$unset) unsetFields = update.$unset;
        return { modifiedCount: 1 };
      };

      let fetchCalled = false;
      let outboundBody = null;
      globalThis.fetch = async (url, options) => {
        fetchCalled = true;
        outboundBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            accepted: true,
            messageId: "msg_live_accepted_999",
          }),
        };
      };

      try {
        const summary = await processPendingAdmissionWelcomeJobs("center_live_test", 1);
        assert.equal(fetchCalled, true, "Must call microservice when dedicated flag enabled");
        assert.match(outboundBody.message, /#token=pt_live_test_token_secret_abcdef/);
        assert.equal(summary.sent, 1);
        assert.equal(summary.simulated, 0);
        assert.equal(updatedDoc.status, "sent");
        assert.equal(updatedDoc.simulated, false);
        assert.equal(updatedDoc.messageId, "msg_live_accepted_999");
        assert.ok(unsetFields, "Must invoke $unset on successful acceptance");
        assert.equal(unsetFields.encryptedInvitationToken, 1, "Must permanently scrub encrypted token");
      } finally {
        delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
        delete process.env.WHATSAPP_INTERNAL_SECRET;
        globalThis.fetch = originalFetch;
        AdmissionWelcomeJob.updateMany = originalUpdateMany;
        AdmissionWelcomeJob.findOneAndUpdate = originalFindOneAndUpdate;
        AdmissionWelcomeJob.updateOne = originalUpdateOne;
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 11. Timeout & Ambiguous Delivery: Preserves Token & Halts Blind Retry (Requirement 1)
  // ---------------------------------------------------------------------------
  await t.test(
    "11. Timeout & Ambiguous Delivery: Preserves encrypted token and halts blind retry",
    async () => {
      const originalFetch = globalThis.fetch;
      const originalUpdateMany = AdmissionWelcomeJob.updateMany;
      const originalFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;
      const originalUpdateOne = AdmissionWelcomeJob.updateOne;
      const originalCenterFindOne = CenterModel.findOne;

      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      process.env.WHATSAPP_INTERNAL_SECRET = "test-secret-123";

      const rawSecret = "pt_timeout_test_token_123";
      const encrypted = encryptToken(rawSecret);

      const timeoutJob = {
        _id: new mongoose.Types.ObjectId(),
        centerId: "center_timeout_test",
        studentId: new mongoose.Types.ObjectId(),
        parentAccessId: new mongoose.Types.ObjectId(),
        studentName: "Aditya Kumar",
        batchName: "Class 10 Maths",
        parentPhone: "9876543210",
        status: "processing",
        parentAccessStatus: "provisioned",
        encryptedInvitationToken: encrypted,
        attempts: 1,
        maxAttempts: 3,
      };

      let claimed = false;
      AdmissionWelcomeJob.findOneAndUpdate = async () => {
        if (!claimed) {
          claimed = true;
          return timeoutJob;
        }
        return null;
      };

      AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
      CenterModel.findOne = () => ({
        select: async () => ({ name: "MSEC Tuition Academy" }),
      });

      let updatedDoc = null;
      let unsetFields = null;
      AdmissionWelcomeJob.updateOne = async (filter, update) => {
        if (update.$set) updatedDoc = update.$set;
        if (update.$unset) unsetFields = update.$unset;
        return { modifiedCount: 1 };
      };

      globalThis.fetch = async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      };

      try {
        const summary = await processPendingAdmissionWelcomeJobs("center_timeout_test", 1);
        assert.equal(summary.ambiguous, 1, "Must classify timeout as ambiguous");
        assert.equal(updatedDoc.status, "ambiguous");
        assert.equal(
          updatedDoc.nextRetryAt,
          null,
          "Must clear nextRetryAt to halt blind retry and prevent duplicate WhatsApp message"
        );
        assert.match(updatedDoc.failureReason, /ambiguous state/i);
        assert.equal(unsetFields, null, "Must NOT scrub token when acceptance is uncertain");
      } finally {
        delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
        delete process.env.WHATSAPP_INTERNAL_SECRET;
        globalThis.fetch = originalFetch;
        AdmissionWelcomeJob.updateMany = originalUpdateMany;
        AdmissionWelcomeJob.findOneAndUpdate = originalFindOneAndUpdate;
        AdmissionWelcomeJob.updateOne = originalUpdateOne;
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 12. Existing ParentAccess URL: Unauthenticated /portal is Held (Requirement 2)
  // ---------------------------------------------------------------------------
  await t.test(
    "12. Existing ParentAccess URL: Unauthenticated /portal is held, zero regeneration",
    async () => {
      const originalFetch = globalThis.fetch;
      const originalUpdateMany = AdmissionWelcomeJob.updateMany;
      const originalFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;
      const originalUpdateOne = AdmissionWelcomeJob.updateOne;
      const originalCenterFindOne = CenterModel.findOne;

      // Existing active ParentAccess job (only tokenHash was saved in past, no raw token)
      const existingJob = {
        _id: new mongoose.Types.ObjectId(),
        centerId: "center_existing_test",
        studentId: new mongoose.Types.ObjectId(),
        parentAccessId: new mongoose.Types.ObjectId(),
        studentName: "Neha Gupta",
        batchName: "Class 9 Science",
        parentPhone: "9876543210",
        status: "processing",
        parentAccessStatus: "existing_active",
        encryptedInvitationToken: null,
        attempts: 1,
        maxAttempts: 3,
      };

      let claimed = false;
      AdmissionWelcomeJob.findOneAndUpdate = async () => {
        if (!claimed) {
          claimed = true;
          return existingJob;
        }
        return null;
      };

      AdmissionWelcomeJob.updateMany = async () => ({ modifiedCount: 0 });
      CenterModel.findOne = () => ({
        select: async () => ({ name: "MSEC Tuition Academy" }),
      });

      let updatedDoc = null;
      AdmissionWelcomeJob.updateOne = async (filter, update) => {
        if (update.$set) updatedDoc = update.$set;
        return { modifiedCount: 1 };
      };

      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({}) };
      };

      try {
        const summary = await processPendingAdmissionWelcomeJobs("center_existing_test", 1);
        assert.equal(summary.heldForAccess, 1, "Must hold job when invitation cannot be safely generated");
        assert.equal(updatedDoc.status, "held_for_access");
        assert.equal(updatedDoc.nextRetryAt, null);
        assert.match(updatedDoc.failureReason, /Existing active ParentAccess record is one-way hashed/);
        assert.equal(fetchCalled, false, "Must never dispatch message with unauthenticated portal link");
      } finally {
        globalThis.fetch = originalFetch;
        AdmissionWelcomeJob.updateMany = originalUpdateMany;
        AdmissionWelcomeJob.findOneAndUpdate = originalFindOneAndUpdate;
        AdmissionWelcomeJob.updateOne = originalUpdateOne;
        CenterModel.findOne = originalCenterFindOne;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 13. Unique Idempotency Index Blocker: Missing Index Fails Closed (Requirement 3)
  // ---------------------------------------------------------------------------
  await t.test(
    "13. Unique Idempotency Index Blocker: Missing index fails closed for enqueue & dispatch",
    async () => {
      // Temporarily mock unique index as missing
      AdmissionWelcomeJob.hasUniqueIdempotencyIndex = async () => false;

      try {
        // 13.1 Enqueue check fails closed
        const enqueueRes = await enqueueAdmissionWelcomeJob({
          centerId: "center_test",
          studentId: new mongoose.Types.ObjectId(),
          parentPhone: "9876543210",
          studentName: "Unsafe Student",
          batchName: "Batch Z",
        });

        assert.equal(enqueueRes.enqueued, false);
        assert.equal(enqueueRes.status, "blocked_index");
        assert.match(enqueueRes.error, /unique index on 'idempotencyKey' is missing or unverified/);

        // 13.2 Worker claim loop check fails closed
        const workerRes = await processPendingAdmissionWelcomeJobs("center_test", 5);
        assert.match(workerRes.error, /Worker processing halted fail-closed/);
      } finally {
        AdmissionWelcomeJob.hasUniqueIdempotencyIndex = async () => true;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 14. System-Wide Workflows: Other WhatsApp Workflows Unaffected (Requirement 5 & F)
  // ---------------------------------------------------------------------------
  await t.test(
    "14. System-Wide Workflows: Other WhatsApp workflows remain strictly isolated and unaffected",
    async () => {
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";

      try {
        // 14.1 Global guard is unaffected
        assert.equal(
          isLiveDispatchEnabled(),
          false,
          "ENABLE_ADMISSION_WELCOME_WHATSAPP must not enable global isLiveDispatchEnabled"
        );

        // 14.2 Other dispatches remain simulated
        const { sendFeeReminder, sendCustomWhatsAppMessage } = await import(
          "../tution-desk-be/src/lib/whatsappService.ts"
        );

        const feeRes = await sendFeeReminder(
          "center_1",
          "9876543210",
          "Test Child",
          1500,
          "2026-12-01"
        );
        assert.equal(feeRes.simulated, true);
        assert.equal(feeRes.accepted, false);
        assert.equal(feeRes.delivered, false);

        const customRes = await sendCustomWhatsAppMessage(
          "center_1",
          "9876543210",
          "General alert"
        );
        assert.equal(customRes.simulated, true);
        assert.equal(customRes.accepted, false);
        assert.equal(customRes.delivered, false);
      } finally {
        delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 15. Compound Index False Positive Defense (Exact Key Pattern Verification)
  // ---------------------------------------------------------------------------
  await t.test(
    "15. Compound Index Defense: Strict single-key verification rejects compound indexes",
    async () => {
      // 15.1 ParentAccessLock checks
      // Case A: Compound index { lockKey: 1, centerId: 1 } must be REJECTED
      const mockModelCompoundLock = {
        collection: {
          indexes: async () => [
            { key: { lockKey: 1, centerId: 1 }, unique: true, name: "lockKey_1_centerId_1" },
          ],
        },
      };
      assert.equal(
        await verifyParentAccessLockIndexIntegrity(mockModelCompoundLock),
        false,
        "Must reject compound index with lockKey"
      );

      // Case B: Reversed order { lockKey: -1 } must be REJECTED
      const mockModelDescLock = {
        collection: {
          indexes: async () => [
            { key: { lockKey: -1 }, unique: true, name: "lockKey_-1" },
          ],
        },
      };
      assert.equal(
        await verifyParentAccessLockIndexIntegrity(mockModelDescLock),
        false,
        "Must reject descending order index"
      );

      // Case C: Non-unique { lockKey: 1 } must be REJECTED
      const mockModelNonUniqueLock = {
        collection: {
          indexes: async () => [
            { key: { lockKey: 1 }, unique: false, name: "lockKey_1" },
          ],
        },
      };
      assert.equal(
        await verifyParentAccessLockIndexIntegrity(mockModelNonUniqueLock),
        false,
        "Must reject non-unique index"
      );

      // Case D: Exact single key { lockKey: 1 } unique: true must be ACCEPTED
      const mockModelValidLock = {
        collection: {
          indexes: async () => [
            { key: { _id: 1 }, name: "_id_" },
            { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
          ],
        },
      };
      assert.equal(
        await verifyParentAccessLockIndexIntegrity(mockModelValidLock),
        true,
        "Must accept exact single key { lockKey: 1 } unique index"
      );

      // 15.2 AdmissionWelcomeJob checks
      // Case A: Compound index { idempotencyKey: 1, createdAt: 1 } must be REJECTED
      const mockModelCompoundJob = {
        collection: {
          indexes: async () => [
            { key: { idempotencyKey: 1, createdAt: 1 }, unique: true, name: "idempotencyKey_1_createdAt_1" },
          ],
        },
      };
      assert.equal(
        await verifyAdmissionWelcomeJobIndexIntegrity(mockModelCompoundJob),
        false,
        "Must reject compound index with idempotencyKey"
      );

      // Case B: Non-unique { idempotencyKey: 1 } must be REJECTED
      const mockModelNonUniqueJob = {
        collection: {
          indexes: async () => [
            { key: { idempotencyKey: 1 }, unique: false, name: "idempotencyKey_1" },
          ],
        },
      };
      assert.equal(
        await verifyAdmissionWelcomeJobIndexIntegrity(mockModelNonUniqueJob),
        false,
        "Must reject non-unique index"
      );

      // Case C: Exact single key { idempotencyKey: 1 } unique: true must be ACCEPTED
      const mockModelValidJob = {
        collection: {
          indexes: async () => [
            { key: { _id: 1 }, name: "_id_" },
            { key: { idempotencyKey: 1 }, unique: true, name: "idempotencyKey_1" },
          ],
        },
      };
      assert.equal(
        await verifyAdmissionWelcomeJobIndexIntegrity(mockModelValidJob),
        true,
        "Must accept exact single key { idempotencyKey: 1 } unique index"
      );
    }
  );

  // ---------------------------------------------------------------------------
  // 16. Upstream Acceptance Contract: Rejects HTTP 200 Lacking Explicit accepted: true
  // ---------------------------------------------------------------------------
  await t.test(
    "16. Upstream Acceptance Contract: Rejects HTTP 200 lacking explicit accepted: true",
    async () => {
      const originalFetch = globalThis.fetch;
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      process.env.WHATSAPP_INTERNAL_SECRET = "test-secret-123";

      // Mock microservice returning HTTP 200 + success: true, but OMITTING accepted: true
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          messageId: "msg_missing_accepted_flag",
          // Note: accepted field is deliberately missing!
        }),
      });

      try {
        const res = await sendAdmissionWelcomeMessage({
          centerId: "center_contract_test",
          phone: "9876543210",
          studentName: "Contract Child",
          instituteName: "MSEC Academy",
          batchName: "Class 10",
        });

        // Must NOT infer acceptance from HTTP 200 alone!
        assert.equal(res.success, false, "Must fail when accepted: true is omitted");
        assert.equal(res.accepted, false, "Must not mark accepted: true without upstream confirmation");
        assert.match(res.error, /omitted explicit 'accepted: true' confirmation/);
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
        delete process.env.WHATSAPP_INTERNAL_SECRET;
      }
    }
  );
});
