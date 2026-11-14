import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// Prevent connectDB from attempting live database connections during test runs
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };
process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.TOKEN_ENCRYPTION_SECRET = "test-token-encryption-secret-32chars!";

test("MSEC Parent Portal Link Activation & Provisioning Regression Suite", async (t) => {
  const {
    generatePortalToken,
    hashPortalToken,
    getOrCreateParentAccess,
    regenerateParentAccess,
    revokeParentAccess,
    resolvePortalToken,
    validateParentSession,
    getRecoverableInvitationToken,
    resolvePortalInvitationUrl,
    portalSecurityHeaders,
  } = await import("../tution-desk-be/src/lib/parentAccessService.ts");

  const { signToken, verifyToken } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );

  const { encryptToken, decryptToken } = await import(
    "../tution-desk-be/src/lib/tokenCipher.ts"
  );

  const {
    buildPortalActivationUrl,
    getPortalAppBaseUrl,
  } = await import("../tution-desk-be/src/lib/portalLinks.ts");

  const {
    formatAdmissionWelcomeMessage,
    formatTemplate,
    buildMagicLink,
    buildMagicLinkForStudent,
  } = await import("../tution-desk-be/src/lib/whatsappService.ts");

  const { ParentAccess } = await import(
    "../tution-desk-be/src/models/ParentAccess.ts"
  );

  const { ParentAccessLock } = await import(
    "../tution-desk-be/src/models/ParentAccessLock.ts"
  );

  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
  const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
  const AttendanceModel = (await import("../tution-desk-be/src/models/Attendance.ts")).default;
  const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
  const TestModel = (await import("../tution-desk-be/src/models/Test.ts")).default;

  const { POST: exchangeRoute } = await import(
    "../tution-desk-be/src/app/api/parent/portal/exchange/route.ts"
  );

  const { GET: portalGetRoute } = await import(
    "../tution-desk-be/src/app/api/parent/portal/[token]/route.ts"
  );

  const centerId = "center_msec_test";
  const student1Id = new mongoose.Types.ObjectId("6af100000000000000000001");
  const student2Id = new mongoose.Types.ObjectId("6af100000000000000000002");

  // In-memory mock store
  const mockParentAccessStore = new Map();
  const mockLockStore = new Map();

  // Mock ParentAccessLock
  if (!ParentAccessLock.collection) {
    ParentAccessLock.collection = {};
  }
  ParentAccessLock.collection.indexes = async () => [
    { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
    { key: { expiresAt: 1 }, expireAfterSeconds: 600, name: "expiresAt_1" },
  ];

  ParentAccessLock.create = async (doc) => {
    if (mockLockStore.has(doc.lockKey)) {
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      throw err;
    }
    const record = { ...doc, _id: new mongoose.Types.ObjectId() };
    mockLockStore.set(doc.lockKey, record);
    return record;
  };

  ParentAccessLock.findOne = async (query) => {
    return mockLockStore.get(query.lockKey) || null;
  };

  ParentAccessLock.findOneAndUpdate = async (query, update) => {
    const existing = mockLockStore.get(query.lockKey);
    if (!existing) return null;
    if (update.$set) Object.assign(existing, update.$set);
    return existing;
  };

  ParentAccessLock.deleteOne = async (query) => {
    const existing = mockLockStore.get(query.lockKey);
    if (existing && (!query.holderId || existing.holderId === query.holderId)) {
      mockLockStore.delete(query.lockKey);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  ParentAccessLock.updateOne = async () => ({ modifiedCount: 1 });

  // Mock Student
  const mockStudents = new Map([
    [
      String(student1Id),
      {
        _id: student1Id,
        centerId,
        name: "Aarav Sharma",
        batch: "Class 10 - Mathematics",
        parentWhatsApp: "919876543210",
        isActive: true,
        monthlyFee: 2500,
        billingCycleDate: 5,
        joiningDate: new Date("2026-11-01"),
      },
    ],
    [
      String(student2Id),
      {
        _id: student2Id,
        centerId,
        name: "Priya Sharma",
        batch: "Class 8 - Foundation",
        parentWhatsApp: "919876543210",
        isActive: true,
        monthlyFee: 2000,
        billingCycleDate: 5,
        joiningDate: new Date("2026-11-01"),
      },
    ],
  ]);

  StudentModel.findOne = function (query) {
    const sId = String(query._id);
    const student = mockStudents.get(sId);
    return {
      lean: async () => (student && student.centerId === query.centerId ? student : null),
      exec: async () => (student && student.centerId === query.centerId ? student : null),
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  StudentModel.find = function (query) {
    let list = Array.from(mockStudents.values());
    if (query && query._id && query._id.$in) {
      const ids = query._id.$in.map(String);
      list = list.filter((s) => ids.includes(String(s._id)));
    }
    if (query && query.centerId) {
      list = list.filter((s) => s.centerId === query.centerId);
    }
    return {
      sort: function () {
        return this;
      },
      lean: async () => list,
      exec: async () => list,
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  // Mock Center
  CenterModel.findOne = function () {
    const center = {
      name: "MSEC Learning Academy",
      ownerName: "Center Director",
      phone: "9876543210",
      upiId: "msec@upi",
    };
    return {
      select: () => ({
        lean: async () => center,
        exec: async () => center,
        then: function (r, j) {
          return Promise.resolve(center).then(r, j);
        },
      }),
      lean: async () => center,
      exec: async () => center,
      then: function (r, j) {
        return Promise.resolve(center).then(r, j);
      },
    };
  };

  // Mock Attendance, Fee, Test
  AttendanceModel.find = () => ({
    sort: () => ({
      lean: async () => [],
      exec: async () => [],
      then: function (r, j) {
        return Promise.resolve([]).then(r, j);
      },
    }),
  });
  FeeModel.find = () => ({
    sort: () => ({
      lean: async () => [],
      exec: async () => [],
      then: function (r, j) {
        return Promise.resolve([]).then(r, j);
      },
    }),
  });
  TestModel.find = () => ({
    sort: () => ({
      lean: async () => [],
      exec: async () => [],
      then: function (r, j) {
        return Promise.resolve([]).then(r, j);
      },
    }),
  });

  // Mock ParentAccess
  ParentAccess.create = async function (doc) {
    const newDoc = {
      _id: new mongoose.Types.ObjectId(),
      centerId: doc.centerId,
      parentPhone: doc.parentPhone,
      parentName: doc.parentName || "",
      linkedStudentIds: doc.linkedStudentIds || [],
      tokenHash: doc.tokenHash,
      tokenPrefix: doc.tokenPrefix,
      invitationTokenCipher: doc.invitationTokenCipher || null,
      status: doc.status || "active",
      isPasswordProtected: Boolean(doc.isPasswordProtected),
      passwordHash: doc.passwordHash || null,
      failedPasswordAttempts: 0,
      lockoutUntil: null,
      lastAccessedAt: null,
      revokedAt: null,
      save: async function () {
        mockParentAccessStore.set(String(this._id), this);
        return this;
      },
      toObject: function () {
        return { ...this };
      },
    };
    mockParentAccessStore.set(String(newDoc._id), newDoc);
    return newDoc;
  };

  ParentAccess.findOne = function (query) {
    return {
      populate: function () {
        return this;
      },
      exec: async function () {
        for (const doc of mockParentAccessStore.values()) {
          let match = true;
          if (query._id && String(doc._id) !== String(query._id)) match = false;
          if (query.centerId && doc.centerId !== query.centerId) match = false;
          if (query.tokenHash && doc.tokenHash !== query.tokenHash) match = false;
          if (query.status && doc.status !== query.status) match = false;
          if (query.linkedStudentIds) {
            const targetId = String(query.linkedStudentIds);
            const hasStudent = doc.linkedStudentIds.some((id) => String(id) === targetId);
            if (!hasStudent) match = false;
          }
          if (match) {
            return {
              ...doc,
              save: async function () {
                mockParentAccessStore.set(String(this._id), this);
                return this;
              },
            };
          }
        }
        return null;
      },
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  function createMockRequest({
    method = "POST",
    url = "http://localhost:3000/api/parent/portal/exchange",
    body = {},
    headers = {},
    cookies = {},
  } = {}) {
    const headersMap = new Map();
    headersMap.set("content-type", "application/json");
    headersMap.set("origin", "http://localhost:3000");

    for (const [k, v] of Object.entries(headers)) {
      headersMap.set(k.toLowerCase(), v);
    }

    return {
      method,
      nextUrl: new URL(url),
      headers: {
        get: (k) => headersMap.get(k.toLowerCase()) || null,
      },
      cookies: {
        get: (name) => (cookies[name] ? { name, value: cookies[name] } : undefined),
      },
      json: async () => body,
    };
  }

  // ==========================================================================
  // SCENARIO 1: Newly bulk-imported student (first-time activation)
  // ==========================================================================
  let bulkImportRawToken = "";
  let bulkImportSessionToken = "";

  await t.test(
    "Scenario 1A: Bulk import provisions ParentAccess with high-entropy token, deterministic hash, and encrypted cipher",
    async () => {
      const res = await getOrCreateParentAccess(centerId, student1Id, {
        parentPhone: "919876543210",
        parentName: "Aarav Sharma",
      });

      assert.strictEqual(res.created, true, "Should create fresh ParentAccess record");
      assert.ok(res.rawToken, "Must return one-time rawToken");
      assert.ok(res.rawToken.startsWith("pt_"), "Raw token must start with pt_");
      assert.ok(res.rawToken.length >= 40, "Raw token must have high entropy");
      bulkImportRawToken = res.rawToken;

      // Verify stored document
      assert.strictEqual(
        res.parentAccess.tokenHash,
        hashPortalToken(bulkImportRawToken),
        "Stored tokenHash must match SHA-256 of raw token"
      );
      assert.strictEqual(
        (res.parentAccess).rawToken,
        undefined,
        "Raw token must NEVER be stored in plaintext"
      );

      // Verify encrypted cipher recovery
      const recoveredToken = getRecoverableInvitationToken(res.parentAccess);
      assert.strictEqual(
        recoveredToken,
        bulkImportRawToken,
        "Encrypted cipher must decrypt to the exact raw token"
      );

      // Verify portal URL construction
      const portalUrl = buildPortalActivationUrl(bulkImportRawToken);
      assert.ok(
        portalUrl.includes("/portal#token=pt_"),
        `Portal URL must use canonical hash fragment: ${portalUrl}`
      );
      assert.strictEqual(
        portalUrl.includes("/p/"),
        false,
        "Portal activation link must NEVER emit unauthenticated /p/ path"
      );
    }
  );

  await t.test(
    "Scenario 1B: First-time parent activates portal via POST /api/parent/portal/exchange with token",
    async () => {
      const req = createMockRequest({
        body: { token: bulkImportRawToken },
      });

      const res = await exchangeRoute(req);
      const json = await res.json();

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(json)}`);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.student.name, "Aarav Sharma");
      assert.ok(json.sessionToken, "Must return signed sessionToken");
      bulkImportSessionToken = json.sessionToken;

      // Verify HttpOnly cookie header
      const cookieHeader = res.headers.get("set-cookie") || "";
      assert.ok(
        cookieHeader.includes("parent_portal_session="),
        "Must set parent_portal_session cookie"
      );
      assert.ok(cookieHeader.includes("HttpOnly"), "Session cookie must be HttpOnly");
    }
  );

  // ==========================================================================
  // SCENARIO 2: Newly added individual student (single add workflow)
  // ==========================================================================
  let singleAddRawToken = "";

  await t.test(
    "Scenario 2A: Single student add generates valid portal link and formats welcome message",
    async () => {
      const res = await getOrCreateParentAccess(centerId, student2Id, {
        parentPhone: "919876543210",
        parentName: "Priya Sharma",
      });

      assert.strictEqual(res.created, true);
      assert.ok(res.rawToken);
      singleAddRawToken = res.rawToken;

      const portalUrl = buildPortalActivationUrl(singleAddRawToken);
      const welcomeMsg = formatAdmissionWelcomeMessage({
        studentName: "Priya Sharma",
        instituteName: "MSEC Learning Academy",
        batchName: "Class 8 - Foundation",
        portalUrl,
        isExistingActivePortal: false,
      });

      assert.ok(welcomeMsg.includes("Priya Sharma"));
      assert.ok(welcomeMsg.includes("Class 8 - Foundation"));
      assert.ok(
        welcomeMsg.includes(portalUrl),
        "Welcome message must embed full activation link with #token=..."
      );
      assert.ok(
        !welcomeMsg.includes("/p/"),
        "Welcome message must not embed clean /p/ link without credential"
      );
    }
  );

  await t.test(
    "Scenario 2B: Single student add activation succeeds via exchange endpoint",
    async () => {
      const req = createMockRequest({
        body: { token: singleAddRawToken },
      });

      const res = await exchangeRoute(req);
      const json = await res.json();

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(json)}`);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.student.name, "Priya Sharma");
    }
  );

  // ==========================================================================
  // SCENARIO 3: Existing active parent accounts
  // ==========================================================================
  await t.test(
    "Scenario 3: Existing active parent receives /portal without token regeneration",
    async () => {
      // Calling getOrCreateParentAccess for an already-provisioned student
      const res = await getOrCreateParentAccess(centerId, student1Id, {
        parentPhone: "919876543210",
      });

      assert.strictEqual(res.created, false, "Must not recreate active record");
      assert.strictEqual(res.rawToken, null, "Raw token must not be regenerated blindly");

      // Verify existing token hash remains unchanged
      const foundDoc = await ParentAccess.findOne({ centerId, linkedStudentIds: student1Id });
      assert.strictEqual(
        foundDoc.tokenHash,
        hashPortalToken(bulkImportRawToken),
        "Original tokenHash must remain strictly intact"
      );

      // Existing active portal link format
      const welcomeMsgExisting = formatAdmissionWelcomeMessage({
        studentName: "Aarav Sharma",
        instituteName: "MSEC Learning Academy",
        batchName: "Class 10 - Mathematics",
        portalUrl: null,
        isExistingActivePortal: true,
      });

      assert.ok(
        welcomeMsgExisting.includes("Your Parent Portal account is already active"),
        "Must acknowledge existing active status"
      );
      assert.ok(
        welcomeMsgExisting.includes("/portal"),
        "Must direct parent to /portal without leaking tokens"
      );
      assert.ok(
        !welcomeMsgExisting.includes("#token="),
        "Must not generate a new token"
      );
    }
  );

  // ==========================================================================
  // SCENARIO 4: Expired or invalid token rejection
  // ==========================================================================
  await t.test(
    "Scenario 4A: Non-existent or invalid token returns HTTP 404",
    async () => {
      const req = createMockRequest({
        body: { token: "pt_completely_invalid_random_token_99999" },
      });

      const res = await exchangeRoute(req);
      const json = await res.json();

      assert.strictEqual(res.status, 404);
      assert.strictEqual(json.success, false);
      assert.match(json.error, /invalid or unrecognized/i);
    }
  );

  await t.test(
    "Scenario 4B: Revoked portal link returns HTTP 403 Forbidden",
    async () => {
      const activeDoc = await ParentAccess.findOne({ centerId, linkedStudentIds: student2Id });
      await revokeParentAccess(centerId, activeDoc._id, "Security test revocation");

      const req = createMockRequest({
        body: { token: singleAddRawToken },
      });

      const res = await exchangeRoute(req);
      const json = await res.json();

      assert.strictEqual(res.status, 403);
      assert.strictEqual(json.success, false);
      assert.strictEqual(json.revoked, true);
      assert.match(json.error, /revoked/i);
    }
  );

  // ==========================================================================
  // SCENARIO 5: Already-activated link (session persistence)
  // ==========================================================================
  await t.test(
    "Scenario 5A: Valid active session cookie restores portal on /portal without token",
    async () => {
      const req = createMockRequest({
        body: {}, // No token in body
        cookies: {
          parent_portal_session: bulkImportSessionToken,
        },
      });

      const res = await exchangeRoute(req);
      const json = await res.json();

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(json)}`);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.student.name, "Aarav Sharma");
    }
  );

  await t.test(
    "Scenario 5B: Valid session via Authorization: Bearer header restores portal (cross-origin safeguard)",
    async () => {
      const req = createMockRequest({
        body: {},
        headers: {
          authorization: `Bearer ${bulkImportSessionToken}`,
        },
      });

      const res = await exchangeRoute(req);
      const json = await res.json();

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(json)}`);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.student.name, "Aarav Sharma");
    }
  );

  await t.test(
    "Scenario 5C: Clean-URL route GET /api/parent/portal/[studentId] succeeds with active session",
    async () => {
      const req = createMockRequest({
        method: "GET",
        url: `http://localhost:3000/api/parent/portal/${student1Id}`,
        headers: {
          authorization: `Bearer ${bulkImportSessionToken}`,
        },
      });

      const res = await portalGetRoute(req, {
        params: Promise.resolve({ token: String(student1Id) }),
      });
      const json = await res.json();

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(json)}`);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.student.name, "Aarav Sharma");
    }
  );

  await t.test(
    "Scenario 5D: Clean-URL route GET /api/parent/portal/[studentId] rejects unauthenticated access with 401",
    async () => {
      const req = createMockRequest({
        method: "GET",
        url: `http://localhost:3000/api/parent/portal/${student1Id}`,
        // Zero cookie, zero Authorization header
      });

      const res = await portalGetRoute(req, {
        params: Promise.resolve({ token: String(student1Id) }),
      });
      const json = await res.json();

      assert.strictEqual(res.status, 401);
      assert.strictEqual(json.success, false);
      assert.match(json.error, /Authentication required/i);
    }
  );
});
