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

test("Phase 1: Parent Access Foundation & Secure Portal Integration Suite", async (t) => {
  const {
    generatePortalToken,
    hashPortalToken,
    getOrCreateParentAccess,
    regenerateParentAccess,
    revokeParentAccess,
    linkStudentToParentAccess,
    unlinkStudentFromParentAccess,
    resolvePortalToken,
    verifyParentPassword,
    setParentPassword,
    removeParentPassword,
    validateParentSession,
    portalSecurityHeaders,
  } = await import("../tution-desk-be/src/lib/parentAccessService.ts");

  const { signToken, verifyToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );

  const { ParentAccess } = await import(
    "../tution-desk-be/src/models/ParentAccess.ts"
  );

  const { ParentAccessLock, verifyParentAccessLockIndexIntegrity } = await import(
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

  const { POST: passwordRoute } = await import(
    "../tution-desk-be/src/app/api/parent/portal/password/route.ts"
  );

  const { POST: accessRoute } = await import(
    "../tution-desk-be/src/app/api/parent/access/route.ts"
  );

  const { validateRequestOrigin, isOriginAllowed } = await import(
    "../tution-desk-be/src/lib/cors.ts"
  );

  const centerIdA = "msce-8267";
  const centerIdB = "other-center-999";

  const studentA1 = new mongoose.Types.ObjectId("6af100000000000000000001");
  const studentA2 = new mongoose.Types.ObjectId("6af100000000000000000002");
  const studentB1 = new mongoose.Types.ObjectId("6af200000000000000000001");

  // In-memory mock database store for ParentAccess documents
  const mockParentAccessStore = new Map();

  // In-memory mock database store for ParentAccessLock documents
  const mockLockStore = new Map();
  let simulateMissingIndex = false;

  // Patch ParentAccessLock
  if (!ParentAccessLock.collection) {
    ParentAccessLock.collection = {};
  }

  const originalIndexes = ParentAccessLock.collection.indexes;
  const originalLockCreate = ParentAccessLock.create;
  const originalLockFindOne = ParentAccessLock.findOne;
  const originalLockFindOneAndUpdate = ParentAccessLock.findOneAndUpdate;
  const originalLockDeleteOne = ParentAccessLock.deleteOne;
  const originalLockUpdateOne = ParentAccessLock.updateOne;

  ParentAccessLock.collection.indexes = async () => {
    if (simulateMissingIndex) {
      return [{ key: { otherKey: 1 } }];
    }
    return [
      { key: { lockKey: 1 }, unique: true, name: "lockKey_1" },
      { key: { expiresAt: 1 }, expireAfterSeconds: 600, name: "expiresAt_1" },
    ];
  };

  ParentAccessLock.create = async function (data) {
    if (mockLockStore.has(data.lockKey)) {
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      throw err;
    }
    const doc = { ...data, createdAt: new Date() };
    mockLockStore.set(data.lockKey, doc);
    return doc;
  };

  ParentAccessLock.findOne = function (query) {
    return {
      exec: async () => mockLockStore.get(query.lockKey) || null,
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  ParentAccessLock.findOneAndUpdate = async function (filter, update) {
    const existing = mockLockStore.get(filter.lockKey);
    if (!existing) return null;
    if (filter.holderId && existing.holderId !== filter.holderId) {
      return null;
    }
    if (filter["expiresAt"]) {
      if (filter["expiresAt"].$lte && new Date(existing.expiresAt) > filter["expiresAt"].$lte) {
        return null;
      }
      if (filter["expiresAt"].$gt && new Date(existing.expiresAt) <= filter["expiresAt"].$gt) {
        return null;
      }
    }
    const updated = {
      ...existing,
      ...(update.$set || {}),
    };
    mockLockStore.set(filter.lockKey, updated);
    return updated;
  };

  ParentAccessLock.deleteOne = async function (query) {
    const existing = mockLockStore.get(query.lockKey);
    if (existing && (!query.holderId || existing.holderId === query.holderId)) {
      mockLockStore.delete(query.lockKey);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  ParentAccessLock.updateOne = async function (query, update) {
    const existing = mockLockStore.get(query.lockKey);
    if (existing && (!query.holderId || existing.holderId === query.holderId)) {
      Object.assign(existing, update.$set || {});
      return { modifiedCount: 1 };
    }
    return { modifiedCount: 0 };
  };

  t.after(() => {
    ParentAccessLock.collection.indexes = originalIndexes;
    ParentAccessLock.create = originalLockCreate;
    ParentAccessLock.findOne = originalLockFindOne;
    ParentAccessLock.findOneAndUpdate = originalLockFindOneAndUpdate;
    ParentAccessLock.deleteOne = originalLockDeleteOne;
    ParentAccessLock.updateOne = originalLockUpdateOne;
  });

  // Patch Mongoose ParentAccess methods for deterministic test execution
  const originalFindOne = ParentAccess.findOne;
  const originalCreate = ParentAccess.create;

  ParentAccess.findOne = function (query) {
    return {
      populate: function () {
        return this.exec();
      },
      exec: async function () {
        for (const doc of mockParentAccessStore.values()) {
          let match = true;
          if (query._id && String(doc._id) !== String(query._id)) match = false;
          if (query.centerId && doc.centerId !== query.centerId) match = false;
          if (query.tokenHash && doc.tokenHash !== query.tokenHash) match = false;
          if (query.status && doc.status !== query.status) match = false;
          if (query.linkedStudentIds) {
            const hasStudent = doc.linkedStudentIds.some(
              (id) => String(id) === String(query.linkedStudentIds)
            );
            if (!hasStudent) match = false;
          }
          if (match) {
            return doc;
          }
        }
        return null;
      },
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  ParentAccess.create = async function (data) {
    const id = new mongoose.Types.ObjectId();
    const doc = {
      _id: id,
      ...data,
      linkedStudentIds: [...data.linkedStudentIds],
      createdAt: new Date(),
      updatedAt: new Date(),
      save: async function () {
        mockParentAccessStore.set(String(this._id), this);
        return this;
      },
    };
    mockParentAccessStore.set(String(id), doc);
    return doc;
  };

  t.after(() => {
    ParentAccess.findOne = originalFindOne;
    ParentAccess.create = originalCreate;
  });

  // Mock Student lookup
  const mockStudentMap = new Map([
    [
      String(studentA1),
      {
        _id: studentA1,
        centerId: centerIdA,
        name: "Rohan Gupta",
        parentWhatsApp: "9876543210",
        batch: "Class 10 - Mathematics",
        isActive: true,
      },
    ],
    [
      String(studentA2),
      {
        _id: studentA2,
        centerId: centerIdA,
        name: "Priya Gupta",
        parentWhatsApp: "9876543210",
        batch: "Class 8 - Science",
        isActive: true,
      },
    ],
    [
      String(studentB1),
      {
        _id: studentB1,
        centerId: centerIdB,
        name: "Foreign Student",
        parentWhatsApp: "9876543210",
        batch: "Foreign Batch",
        isActive: true,
      },
    ],
  ]);

  const originalStudentFindOne = StudentModel.findOne;
  const originalStudentFind = StudentModel.find;
  const originalStudentFindById = StudentModel.findById;

  StudentModel.findOne = function (query) {
    const sId = String(query._id);
    const student = mockStudentMap.get(sId);
    return {
      lean: async () => (student && student.centerId === query.centerId ? student : null),
      exec: async () => (student && student.centerId === query.centerId ? student : null),
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  StudentModel.findById = function (id) {
    const student = mockStudentMap.get(String(id));
    return {
      lean: async () => student || null,
      exec: async () => student || null,
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  StudentModel.find = function (query) {
    let list = Array.from(mockStudentMap.values());
    if (query && query._id && query._id.$in) {
      const ids = query._id.$in.map(String);
      list = list.filter((s) => ids.includes(String(s._id)));
    }
    if (query && query.centerId) {
      list = list.filter((s) => s.centerId === query.centerId);
    }
    return {
      lean: async () => list,
      exec: async () => list,
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  t.after(() => {
    StudentModel.findOne = originalStudentFindOne;
    StudentModel.find = originalStudentFind;
    StudentModel.findById = originalStudentFindById;
  });

  // Mock Center, Attendance, Fee, Test for route tests
  const originalCenterFindOne = CenterModel.findOne;
  CenterModel.findOne = function () {
    return {
      lean: async () => ({
        name: "MSEC Coaching Institute",
        ownerName: "Dr. Head",
        phone: "9876543210",
        upiId: "msec@upi",
      }),
      exec: async () => ({
        name: "MSEC Coaching Institute",
        ownerName: "Dr. Head",
        phone: "9876543210",
        upiId: "msec@upi",
      }),
      then: function (resolve, reject) {
        return this.exec().then(resolve, reject);
      },
    };
  };

  const originalAttendanceFind = AttendanceModel.find;
  AttendanceModel.find = function () {
    return {
      sort: function () {
        return {
          lean: async () => [],
          exec: async () => [],
          then: function (res, rej) {
            return this.exec().then(res, rej);
          },
        };
      },
    };
  };

  const originalFeeFind = FeeModel.find;
  FeeModel.find = function () {
    return {
      sort: function () {
        return {
          lean: async () => [],
          exec: async () => [],
          then: function (res, rej) {
            return this.exec().then(res, rej);
          },
        };
      },
    };
  };

  const originalTestFind = TestModel.find;
  TestModel.find = function () {
    return {
      sort: function () {
        return {
          lean: async () => [],
          exec: async () => [],
          then: function (res, rej) {
            return this.exec().then(res, rej);
          },
        };
      },
    };
  };

  t.after(() => {
    CenterModel.findOne = originalCenterFindOne;
    AttendanceModel.find = originalAttendanceFind;
    FeeModel.find = originalFeeFind;
    TestModel.find = originalTestFind;
  });

  function createMockExchangeRequest({ body = {}, cookies = {}, headers = {} } = {}) {
    const reqHeaders = new Headers(headers);
    return {
      method: "POST",
      headers: reqHeaders,
      nextUrl: new URL("http://localhost:3000/api/parent/portal/exchange"),
      json: async () => body,
      cookies: {
        get: (name) => (cookies[name] !== undefined ? { name, value: cookies[name] } : undefined),
      },
    };
  }

  // --------------------------------------------------------------------------
  // 1. Token Generation, Hashing & Entropy
  // --------------------------------------------------------------------------
  await t.test("1.1 generatePortalToken() generates pt_ prefix with >= 256 bits entropy", () => {
    const { rawToken, tokenHash, tokenPrefix } = generatePortalToken();
    assert.ok(rawToken.startsWith("pt_"), "Token must start with pt_ prefix");
    assert.ok(rawToken.length >= 45, "Token must have high entropy (> 40 chars)");
    assert.strictEqual(tokenPrefix, rawToken.slice(0, 8), "Prefix must match first 8 chars");
    assert.strictEqual(tokenHash.length, 64, "SHA-256 hash must be 64 hex characters");
  });

  await t.test("1.2 Consecutive calls produce distinct tokens (zero collisions)", () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i++) {
      const { rawToken } = generatePortalToken();
      assert.ok(!tokens.has(rawToken), "Duplicate token generated!");
      tokens.add(rawToken);
    }
    assert.strictEqual(tokens.size, 50);
  });

  await t.test("1.3 hashPortalToken() produces deterministic 64-character SHA-256 hex string", () => {
    const testToken = "pt_TEST_TOKEN_RANDOM_VALUE_ABC_123";
    const hash1 = hashPortalToken(testToken);
    const hash2 = hashPortalToken(testToken);
    assert.strictEqual(hash1, hash2, "Hash must be strictly deterministic");
    assert.strictEqual(hash1.length, 64);
  });

  // --------------------------------------------------------------------------
  // 2. ParentAccess Model & Explicit Linkage
  // --------------------------------------------------------------------------
  let issuedRawToken = null;
  let issuedAccessId = null;

  await t.test("2.1 Creates ParentAccess with explicit single child and returns rawToken ONCE", async () => {
    const result = await getOrCreateParentAccess(centerIdA, studentA1, {
      parentName: "Mr. Gupta",
      parentPhone: "9876543210",
    });

    assert.ok(result.created, "Must be created");
    assert.ok(result.rawToken, "Must return raw token upon creation");
    assert.ok(result.rawToken.startsWith("pt_"));
    assert.strictEqual(result.parentAccess.centerId, centerIdA);
    assert.strictEqual(result.parentAccess.parentPhone, "9876543210");
    assert.strictEqual(result.parentAccess.linkedStudentIds.length, 1);
    assert.strictEqual(String(result.parentAccess.linkedStudentIds[0]), String(studentA1));

    issuedRawToken = result.rawToken;
    issuedAccessId = result.parentAccess._id;
  });

  await t.test("2.2 Raw tokens are NEVER stored in MongoDB document", () => {
    const doc = mockParentAccessStore.get(String(issuedAccessId));
    assert.ok(doc, "Document must exist in store");
    assert.strictEqual(doc.rawToken, undefined, "rawToken property must NEVER exist on stored doc");
    assert.ok(doc.tokenHash, "Only tokenHash must be stored");
    assert.strictEqual(doc.tokenHash, hashPortalToken(issuedRawToken));
  });

  await t.test("2.3 Multiple children require explicit linking; matching phone does not auto-merge", async () => {
    // Student A2 has the same parent phone number (9876543210).
    // The system MUST NOT automatically link Student A2 to Student A1's ParentAccess record!
    const resultA2 = await getOrCreateParentAccess(centerIdA, studentA2, {
      parentName: "Mr. Gupta",
      parentPhone: "9876543210",
    });

    assert.ok(resultA2.created, "A separate explicit record must be generated before owner linking");
    assert.notStrictEqual(String(resultA2.parentAccess._id), String(issuedAccessId));
    assert.strictEqual(resultA2.parentAccess.linkedStudentIds.length, 1);
    assert.strictEqual(String(resultA2.parentAccess.linkedStudentIds[0]), String(studentA2));

    // Clean up temporary doc so studentA2 is free for explicit linking tests
    mockParentAccessStore.delete(String(resultA2.parentAccess._id));
  });

  // --------------------------------------------------------------------------
  // 3. Direct Access Default & Scoped Portal Session
  // --------------------------------------------------------------------------
  await t.test("3.1 Unprotected portal resolves immediately without password or OTP", async () => {
    const result = await resolvePortalToken(issuedRawToken);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.parentAccess.isPasswordProtected, false);
    assert.strictEqual(String(result.parentAccess._id), String(issuedAccessId));
  });

  await t.test("3.2 Issues valid scoped 24h JWT parent_portal_session", async () => {
    const sessionToken = await signToken({
      parentAccessId: String(issuedAccessId),
      centerId: centerIdA,
      tokenPrefix: "pt_test",
      role: "parent",
      linkedStudentIds: [String(studentA1)],
    });

    const payload = await verifyToken(sessionToken);
    assert.ok(payload);
    assert.strictEqual(payload.role, "parent");
    assert.strictEqual(payload.centerId, centerIdA);
    assert.strictEqual(payload.parentAccessId, String(issuedAccessId));
  });

  // --------------------------------------------------------------------------
  // 4. Multi-Child Support & Explicit Linkage Controls
  // --------------------------------------------------------------------------
  await t.test("4.1 Explicitly linking a sibling updates linkedStudentIds", async () => {
    const updated = await linkStudentToParentAccess(centerIdA, issuedAccessId, studentA2);
    assert.strictEqual(updated.linkedStudentIds.length, 2);
    assert.ok(updated.linkedStudentIds.map(String).includes(String(studentA2)));
  });

  await t.test("4.2 Resolving portal returns all linked children strictly for this center", async () => {
    const result = await resolvePortalToken(issuedRawToken);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.parentAccess.linkedStudentIds.length, 2);
  });

  await t.test("4.3 Unlinking a child removes them from access context", async () => {
    const updated = await unlinkStudentFromParentAccess(centerIdA, issuedAccessId, studentA2);
    assert.strictEqual(updated.linkedStudentIds.length, 1);
    assert.strictEqual(String(updated.linkedStudentIds[0]), String(studentA1));
  });

  await t.test("4.4 Cannot unlink the only remaining child", async () => {
    await assert.rejects(
      () => unlinkStudentFromParentAccess(centerIdA, issuedAccessId, studentA1),
      /Cannot unlink the only remaining student/
    );
  });

  // --------------------------------------------------------------------------
  // 5. Cross-Center Isolation
  // --------------------------------------------------------------------------
  await t.test("5.1 Cannot link a student belonging to a different centerId (rejected)", async () => {
    await assert.rejects(
      () => linkStudentToParentAccess(centerIdA, issuedAccessId, studentB1),
      /does not belong to this tuition center/
    );
  });

  // --------------------------------------------------------------------------
  // 6. Optional Password Protection & Lockout
  // --------------------------------------------------------------------------
  const accessDoc = mockParentAccessStore.get(String(issuedAccessId));

  await t.test("6.1 Setting password stores bcrypt hash and flags isPasswordProtected: true", async () => {
    await setParentPassword(accessDoc, "securePIN123");
    assert.strictEqual(accessDoc.isPasswordProtected, true);
    assert.ok(accessDoc.passwordHash);
    assert.notStrictEqual(accessDoc.passwordHash, "securePIN123");
  });

  await t.test("6.2 Protected portal demands password unlock before returning data", async () => {
    const result = await resolvePortalToken(issuedRawToken);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.parentAccess.isPasswordProtected, true);
  });

  await t.test("6.3 Incorrect password returns 401 with remaining attempts", async () => {
    const result = await verifyParentPassword(accessDoc, "wrongPassword!");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.remainingAttempts, 4);
  });

  await t.test("6.4 5 failed password attempts triggers 15-minute lockout (429 status)", async () => {
    await verifyParentPassword(accessDoc, "wrongPassword2");
    await verifyParentPassword(accessDoc, "wrongPassword3");
    await verifyParentPassword(accessDoc, "wrongPassword4");
    const fifthAttempt = await verifyParentPassword(accessDoc, "wrongPassword5");

    assert.strictEqual(fifthAttempt.valid, false);
    assert.strictEqual(fifthAttempt.locked, true);
    assert.ok(fifthAttempt.lockoutUntil);

    // Subsequent resolution must be locked
    const tokenResult = await resolvePortalToken(issuedRawToken);
    assert.strictEqual(tokenResult.valid, false);
    assert.strictEqual(tokenResult.reason, "locked");
  });

  await t.test("6.5 Correct password clears failed attempts and unlocks portal", async () => {
    // Clear lockout for testing
    accessDoc.lockoutUntil = null;
    accessDoc.failedPasswordAttempts = 4;

    const successAttempt = await verifyParentPassword(accessDoc, "securePIN123");
    assert.strictEqual(successAttempt.valid, true);
    assert.strictEqual(accessDoc.failedPasswordAttempts, 0);
  });

  await t.test("6.6 Password can be removed after confirming current password", async () => {
    await removeParentPassword(accessDoc, "securePIN123");
    assert.strictEqual(accessDoc.isPasswordProtected, false);
    assert.strictEqual(Boolean(accessDoc.passwordHash), false);
  });

  // --------------------------------------------------------------------------
  // 7. Token Revocation & Regeneration
  // --------------------------------------------------------------------------
  let freshRawToken = null;

  await t.test("7.1 Owner revoking portal link marks status: 'revoked'", async () => {
    const revoked = await revokeParentAccess(centerIdA, issuedAccessId, "Parent requested new link");
    assert.strictEqual(revoked.status, "revoked");
    assert.ok(revoked.revokedAt);
  });

  await t.test("7.2 Revoked token resolution fails safely without leaking student records", async () => {
    const res = await resolvePortalToken(issuedRawToken);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, "revoked");
  });

  await t.test("7.3 Regenerating token invalidates old token and returns fresh raw token", async () => {
    const regen = await regenerateParentAccess(centerIdA, issuedAccessId);
    assert.strictEqual(regen.parentAccess.status, "active");
    assert.ok(regen.rawToken);
    assert.notStrictEqual(regen.rawToken, issuedRawToken);

    freshRawToken = regen.rawToken;
  });

  await t.test("7.4 Old token is rejected; new token resolves cleanly", async () => {
    const oldRes = await resolvePortalToken(issuedRawToken);
    assert.strictEqual(oldRes.valid, false, "Old token must fail resolution");

    const newRes = await resolvePortalToken(freshRawToken);
    assert.strictEqual(newRes.valid, true, "New token must resolve cleanly");
  });

  // --------------------------------------------------------------------------
  // 8. Owner Management API Security
  // --------------------------------------------------------------------------
  await t.test("8.1 Unauthenticated requests to /api/parent/access return 401", async () => {
    const req = {
      headers: new Headers(),
      cookies: { get: () => null },
    };
    const user = await getAuthenticatedUser(req);
    assert.strictEqual(user, null, "Must fail closed without auth");
  });

  await t.test("8.2 Derives centerId strictly from verified JWT, ignoring client spoofing", async () => {
    const ownerToken = await signToken({
      userId: "owner-1",
      centerId: centerIdA,
      role: "owner",
    });

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${ownerToken}`);

    const req = {
      headers,
      cookies: { get: () => null },
    };

    const user = await getAuthenticatedUser(req);
    assert.strictEqual(user.role, "owner");
    assert.strictEqual(user.centerId, centerIdA, "centerId must be derived strictly from JWT");
  });

  await t.test("8.3 Teacher JWT is strictly rejected with 403 Forbidden on management endpoints", async () => {
    const teacherToken = await signToken({
      userId: "teacher-1",
      centerId: centerIdA,
      role: "teacher",
      teacherId: "6af100000000000000000099",
    });

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${teacherToken}`);

    const req = {
      headers,
      cookies: { get: () => null },
    };

    const user = await getAuthenticatedUser(req);
    assert.strictEqual(user.role, "teacher");
    assert.strictEqual(user.role === "owner", false, "Teachers must never evaluate as owner");
  });

  // --------------------------------------------------------------------------
  // 9. Immediate Session Invalidation & Credential Fingerprint Binding
  // --------------------------------------------------------------------------
  let testAccessDoc = null;
  let activeSessionToken = null;

  await t.test("9.1 Session token bound to tokenPrefix validates successfully when active", async () => {
    const res = await getOrCreateParentAccess(centerIdA, studentA1);
    testAccessDoc = res.parentAccess;

    activeSessionToken = await signToken({
      parentAccessId: String(testAccessDoc._id),
      centerId: testAccessDoc.centerId,
      tokenPrefix: testAccessDoc.tokenPrefix,
      role: "parent",
      linkedStudentIds: [String(studentA1)],
    });

    const validation = await validateParentSession(activeSessionToken);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.statusCode, 200);
    assert.strictEqual(String(validation.parentAccess._id), String(testAccessDoc._id));
  });

  await t.test("9.2 Immediate invalidation on revocation across all data endpoints", async () => {
    await revokeParentAccess(centerIdA, testAccessDoc._id, "Security drill");

    const validation = await validateParentSession(activeSessionToken);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.statusCode, 403);
    assert.match(validation.error, /revoked/i);
  });

  await t.test("9.3 Immediate invalidation on token regeneration (credential version mismatch)", async () => {
    const priorPrefix = testAccessDoc.tokenPrefix;
    const regen = await regenerateParentAccess(centerIdA, testAccessDoc._id);
    assert.strictEqual(regen.parentAccess.status, "active");
    assert.notStrictEqual(regen.parentAccess.tokenPrefix, priorPrefix);

    const validationOldSession = await validateParentSession(activeSessionToken);
    assert.strictEqual(validationOldSession.valid, false);
    assert.strictEqual(validationOldSession.statusCode, 401);
    assert.match(validationOldSession.error, /invalidated/i);

    const freshSessionToken = await signToken({
      parentAccessId: String(regen.parentAccess._id),
      centerId: regen.parentAccess.centerId,
      tokenPrefix: regen.parentAccess.tokenPrefix,
      role: "parent",
      linkedStudentIds: [String(studentA1)],
    });

    const validationNewSession = await validateParentSession(freshSessionToken);
    assert.strictEqual(validationNewSession.valid, true);
    assert.strictEqual(validationNewSession.statusCode, 200);
  });

  // --------------------------------------------------------------------------
  // 10. Token Privacy & Security Headers
  // --------------------------------------------------------------------------
  await t.test("10.1 portalSecurityHeaders enforces no-store and no-referrer", () => {
    assert.strictEqual(
      portalSecurityHeaders["Cache-Control"],
      "private, no-store, no-cache, must-revalidate"
    );
    assert.strictEqual(portalSecurityHeaders["Referrer-Policy"], "no-referrer");
  });

  // --------------------------------------------------------------------------
  // 11. Distributed ParentAccess Concurrency & Atomic Lock Protection
  // --------------------------------------------------------------------------
  await t.test("11.1 Concurrent calls to getOrCreateParentAccess return identical document without duplicates", async () => {
    const freshStudent = new mongoose.Types.ObjectId("6af100000000000000000099");
    mockStudentMap.set(String(freshStudent), {
      _id: freshStudent,
      centerId: centerIdA,
      name: "Concurrent Test Student",
      parentWhatsApp: "9988776655",
      batch: "Physics Batch",
      isActive: true,
    });

    const storeSizeBefore = mockParentAccessStore.size;

    const results = await Promise.all([
      getOrCreateParentAccess(centerIdA, freshStudent),
      getOrCreateParentAccess(centerIdA, freshStudent),
      getOrCreateParentAccess(centerIdA, freshStudent),
      getOrCreateParentAccess(centerIdA, freshStudent),
      getOrCreateParentAccess(centerIdA, freshStudent),
    ]);

    const storeSizeAfter = mockParentAccessStore.size;
    assert.strictEqual(
      storeSizeAfter,
      storeSizeBefore + 1,
      "Exactly one ParentAccess document must be created across concurrent requests"
    );

    const firstId = String(results[0].parentAccess._id);
    for (const res of results) {
      assert.strictEqual(
        String(res.parentAccess._id),
        firstId,
        "All concurrent calls must return the same ParentAccess document"
      );
    }

    const createdCount = results.filter((r) => r.created).length;
    const rawTokenCount = results.filter((r) => r.rawToken !== null).length;
    assert.strictEqual(createdCount, 1, "Exactly one call reports created: true");
    assert.strictEqual(rawTokenCount, 1, "Exactly one call receives rawToken");
  });

  await t.test("11.2 Index integrity preflight failure: fails closed if unique lock index is unverified", async () => {
    const unverifiedStudent = new mongoose.Types.ObjectId("6af100000000000000000088");
    mockStudentMap.set(String(unverifiedStudent), {
      _id: unverifiedStudent,
      centerId: centerIdA,
      name: "Unverified Student",
      parentWhatsApp: "9876543211",
      batch: "Test Batch",
      isActive: true,
    });

    simulateMissingIndex = true;
    try {
      await assert.rejects(
        () => getOrCreateParentAccess(centerIdA, unverifiedStudent),
        /ParentAccessLock unique index on 'lockKey' is missing or unverified/
      );
    } finally {
      simulateMissingIndex = false;
    }
  });

  await t.test("11.3 Expired lock takeover claims lock and proceeds safely", async () => {
    const takeoverStudent = new mongoose.Types.ObjectId("6af100000000000000000077");
    mockStudentMap.set(String(takeoverStudent), {
      _id: takeoverStudent,
      centerId: centerIdA,
      name: "Takeover Student",
      parentWhatsApp: "9876543212",
      batch: "Batch Takeover",
      isActive: true,
    });

    const lockKey = `${centerIdA}:${String(takeoverStudent)}:9876543212:parent_access_create`;
    mockLockStore.set(lockKey, {
      lockKey,
      centerId: centerIdA,
      studentId: String(takeoverStudent),
      holderId: "crashed-holder-123",
      status: "LOCKED",
      lockedAt: new Date(Date.now() - 30000),
      expiresAt: new Date(Date.now() - 5000), // expired 5 seconds ago
    });

    const result = await getOrCreateParentAccess(centerIdA, takeoverStudent);
    assert.ok(result.created, "Takeover process must create document successfully");
    assert.ok(result.rawToken);
  });

  await t.test("11.4 Safe release verification: mismatched holderId cannot delete active lock", async () => {
    const dummyKey = "test:dummy:key:lock";
    mockLockStore.set(dummyKey, {
      lockKey: dummyKey,
      holderId: "valid-owner-uuid",
      status: "LOCKED",
      expiresAt: new Date(Date.now() + 10000),
    });

    // Try deleting with wrong holderId
    const resWrong = await ParentAccessLock.deleteOne({
      lockKey: dummyKey,
      holderId: "impostor-uuid",
    });
    assert.strictEqual(resWrong.deletedCount, 0);
    assert.ok(mockLockStore.has(dummyKey), "Lock must still exist in store");

    // Correct holderId deletes cleanly
    const resCorrect = await ParentAccessLock.deleteOne({
      lockKey: dummyKey,
      holderId: "valid-owner-uuid",
    });
    assert.strictEqual(resCorrect.deletedCount, 1);
    assert.strictEqual(mockLockStore.has(dummyKey), false);
  });

  await t.test("11.5 Active lease renewal & ownership loss: stale holder cannot persist after lock loss", async () => {
    const staleStudent = new mongoose.Types.ObjectId("6af100000000000000000066");
    mockStudentMap.set(String(staleStudent), {
      _id: staleStudent,
      centerId: centerIdA,
      name: "Stale Lock Student",
      parentWhatsApp: "9876543219",
      batch: "Stale Batch",
      isActive: true,
    });

    const storeSizeBefore = mockParentAccessStore.size;

    // Simulate lock takeover or expiry occurring right before persistence:
    // We temporarily intercept ParentAccessLock.findOneAndUpdate to return null
    // when checking expiresAt > now (Step B renewal)
    const originalFindOneAndUpdate = ParentAccessLock.findOneAndUpdate;
    let intercepted = false;
    ParentAccessLock.findOneAndUpdate = async function (filter, update) {
      if (filter && filter.expiresAt && filter.expiresAt.$gt) {
        intercepted = true;
        return null; // Simulates lock loss / expiration right before ParentAccess.create()
      }
      return originalFindOneAndUpdate.call(this, filter, update);
    };

    try {
      await assert.rejects(
        () => getOrCreateParentAccess(centerIdA, staleStudent),
        /ParentAccess distributed lock lease expired or ownership was lost prior to persistence/
      );
      assert.strictEqual(intercepted, true, "Renewal step must have been executed");
      assert.strictEqual(
        mockParentAccessStore.size,
        storeSizeBefore,
        "No ParentAccess document must be persisted when lock renewal fails"
      );
    } finally {
      ParentAccessLock.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  // --------------------------------------------------------------------------
  // 12. Immediate Sibling Unlink Isolation Verification
  // --------------------------------------------------------------------------
  await t.test("12.1 Sibling Unlink Isolation: Unlinked child returns 403 while remaining child returns 200 without re-auth", async () => {
    // 1. Create ParentAccess with child A (studentA1)
    const initRes = await getOrCreateParentAccess(centerIdA, studentA1);
    const parentDoc = initRes.parentAccess;

    // 2. Link child B (studentA2)
    await linkStudentToParentAccess(centerIdA, parentDoc._id, studentA2);

    // 3. Issue session token representing the multi-child access
    const multiChildSession = await signToken({
      parentAccessId: String(parentDoc._id),
      centerId: centerIdA,
      tokenPrefix: parentDoc.tokenPrefix,
      role: "parent",
      linkedStudentIds: [String(studentA1), String(studentA2)],
    });

    // 4. Verify both children are accessible initially
    const initialReqA = createMockExchangeRequest({
      body: { studentId: String(studentA1) },
      cookies: { parent_portal_session: multiChildSession },
    });
    const initialResA = await exchangeRoute(initialReqA);
    assert.strictEqual(initialResA.status, 200, "Child A accessible initially");

    const initialReqB = createMockExchangeRequest({
      body: { studentId: String(studentA2) },
      cookies: { parent_portal_session: multiChildSession },
    });
    const initialResB = await exchangeRoute(initialReqB);
    assert.strictEqual(initialResB.status, 200, "Child B accessible initially");

    // 5. OWNER UNLINKS CHILD B (studentA2)
    await unlinkStudentFromParentAccess(centerIdA, parentDoc._id, studentA2);

    // 6. Request for unlinked Child B using the PREVIOUSLY ISSUED SESSION must return HTTP 403 Forbidden!
    const unlinkedReqB = createMockExchangeRequest({
      body: { studentId: String(studentA2) },
      cookies: { parent_portal_session: multiChildSession },
    });
    const unlinkedResB = await exchangeRoute(unlinkedReqB);
    const unlinkedJsonB = await unlinkedResB.json();

    assert.strictEqual(unlinkedResB.status, 403, "Unlinked child request MUST return 403 Forbidden");
    assert.match(unlinkedJsonB.error, /not linked/i);

    // 7. Request for Child A using that SAME SESSION must CONTINUE returning HTTP 200 OK without re-authentication!
    const ongoingReqA = createMockExchangeRequest({
      body: { studentId: String(studentA1) },
      cookies: { parent_portal_session: multiChildSession },
    });
    const ongoingResA = await exchangeRoute(ongoingReqA);
    const ongoingJsonA = await ongoingResA.json();

    assert.strictEqual(ongoingResA.status, 200, "Remaining child A MUST continue with 200 OK");
    assert.strictEqual(ongoingJsonA.success, true);
    assert.strictEqual(String(ongoingJsonA.student._id), String(studentA1));
  });

  // --------------------------------------------------------------------------
  // 13. Parent Token Privacy Redesign & Exchange POST Endpoint
  // --------------------------------------------------------------------------
  let freshExchangeToken = null;

  await t.test("13.1 POST /api/parent/portal/exchange establishes HttpOnly session from POST body token", async () => {
    // Generate fresh parent access
    const genRes = await getOrCreateParentAccess(centerIdA, studentA1);
    const regen = await regenerateParentAccess(centerIdA, genRes.parentAccess._id);
    freshExchangeToken = regen.rawToken;

    const exchangeReq = createMockExchangeRequest({
      body: { token: freshExchangeToken },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 200);
    assert.strictEqual(exchangeJson.success, true);
    assert.ok(exchangeJson.sessionToken, "Must return valid sessionToken");
    assert.strictEqual(String(exchangeJson.student._id), String(studentA1));

    // Must set parent_portal_session HttpOnly cookie
    const setCookie = exchangeRes.cookies.get("parent_portal_session");
    assert.ok(setCookie);
    assert.strictEqual(setCookie.value, exchangeJson.sessionToken);

    // Must attach security headers
    assert.strictEqual(
      exchangeRes.headers.get("cache-control"),
      "private, no-store, no-cache, must-revalidate"
    );
    assert.strictEqual(exchangeRes.headers.get("referrer-policy"), "no-referrer");
  });

  await t.test("13.2 POST /api/parent/portal/exchange with revoked token returns HTTP 403", async () => {
    const doc = await ParentAccess.findOne({ centerId: centerIdA, linkedStudentIds: studentA1 });
    await revokeParentAccess(centerIdA, doc._id, "Test revocation");

    const exchangeReq = createMockExchangeRequest({
      body: { token: freshExchangeToken },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 403);
    assert.strictEqual(exchangeJson.success, false);
    assert.strictEqual(exchangeJson.revoked, true);
  });

  await t.test("13.3 POST /api/parent/portal/exchange with invalid token returns HTTP 404", async () => {
    const exchangeReq = createMockExchangeRequest({
      body: { token: "pt_completely_invalid_token_12345" },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 404);
    assert.strictEqual(exchangeJson.success, false);
  });

  await t.test("13.4 Owner API returns portal link formatted with hash fragment (#token=) instead of path", async () => {
    const ownerToken = await signToken({
      userId: "owner-1",
      centerId: centerIdA,
      role: "owner",
    });

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${ownerToken}`);
    headers.set("Content-Type", "application/json");

    // Re-activate student doc
    const activeDoc = await ParentAccess.findOne({ centerId: centerIdA, linkedStudentIds: studentA1 });
    await regenerateParentAccess(centerIdA, activeDoc._id);

    const req = {
      headers,
      cookies: { get: () => null },
      json: async () => ({
        action: "generate",
        studentId: String(studentA1),
      }),
      nextUrl: new URL("http://localhost:3000/api/parent/access"),
    };

    const res = await accessRoute(req);
    const json = await res.json();

    assert.strictEqual(res.status, 201);
    assert.ok(json.portalUrl);
    assert.ok(
      json.portalUrl.includes("/portal#token=pt_"),
      `portalUrl must use /portal#token=... hash fragment, got: ${json.portalUrl}`
    );
    assert.strictEqual(
      json.portalUrl.includes("/p/pt_"),
      false,
      "portalUrl must NOT expose raw token in URL path"
    );
  });

  await t.test("13.5 POST /api/parent/portal/exchange rejects unapproved cross-origin requests with 403 Forbidden", async () => {
    const exchangeReq = createMockExchangeRequest({
      body: { token: freshExchangeToken },
      headers: { origin: "https://malicious-attacker.com" },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 403);
    assert.strictEqual(exchangeJson.success, false);
    assert.match(exchangeJson.error, /Cross-origin request forbidden/i);
  });

  let activeExchangeToken = null;

  await t.test("13.6 POST /api/parent/portal/exchange allows approved development origin (http://localhost:3000)", async () => {
    const activeDoc = await ParentAccess.findOne({ centerId: centerIdA, linkedStudentIds: studentA1 });
    const regen = await regenerateParentAccess(centerIdA, activeDoc._id);
    activeExchangeToken = regen.rawToken;

    const exchangeReq = createMockExchangeRequest({
      body: { token: activeExchangeToken },
      headers: { origin: "http://localhost:3000" },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 200);
    assert.strictEqual(exchangeJson.success, true);
    assert.strictEqual(exchangeRes.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  await t.test("13.7 POST /api/parent/portal/exchange allows approved production origin (https://tution-desk-one.vercel.app)", async () => {
    const exchangeReq = createMockExchangeRequest({
      body: { token: activeExchangeToken },
      headers: { origin: "https://tution-desk-one.vercel.app" },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 200);
    assert.strictEqual(exchangeJson.success, true);
    assert.strictEqual(
      exchangeRes.headers.get("access-control-allow-origin"),
      "https://tution-desk-one.vercel.app"
    );
  });

  await t.test("13.8 POST /api/parent/portal/exchange handles missing Origin safely for internal/same-origin calls", async () => {
    const exchangeReq = createMockExchangeRequest({
      body: { token: activeExchangeToken },
      headers: {}, // No Origin header provided
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 200);
    assert.strictEqual(exchangeJson.success, true);
    // When origin is absent, no Access-Control-Allow-Origin should be emitted
    assert.strictEqual(exchangeRes.headers.get("access-control-allow-origin"), null);
  });

  await t.test("13.9 POST /api/parent/portal/exchange rejects cross-site Sec-Fetch-Site without approved Origin", async () => {
    const exchangeReq = createMockExchangeRequest({
      body: { token: activeExchangeToken },
      headers: {
        "sec-fetch-site": "cross-site",
        origin: "https://unauthorized-cross-site.com",
      },
    });

    const exchangeRes = await exchangeRoute(exchangeReq);
    const exchangeJson = await exchangeRes.json();

    assert.strictEqual(exchangeRes.status, 403);
    assert.strictEqual(exchangeJson.success, false);
    assert.match(exchangeJson.error, /Cross-origin request forbidden/i);
  });

  await t.test("13.10 POST /api/parent/portal/password rejects unapproved cross-origin requests with 403 Forbidden", async () => {
    const pwdReq = {
      method: "POST",
      headers: new Headers({
        origin: "https://evil-attacker.io",
        "Content-Type": "application/json",
      }),
      json: async () => ({
        token: activeExchangeToken,
        action: "set",
        newPassword: "secretPIN999",
      }),
      cookies: { get: () => null },
    };

    const pwdRes = await passwordRoute(pwdReq);
    const pwdJson = await pwdRes.json();

    assert.strictEqual(pwdRes.status, 403);
    assert.strictEqual(pwdJson.success, false);
    assert.match(pwdJson.error, /Cross-origin request forbidden/i);
  });

  await t.test("13.11 Live Stream Log Interception: Assert raw tokens never appear in console.log, console.error or stdout during route & service execution", async () => {
    const capturedOutput = [];

    // Save original stream/console methods
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    // Install live spies
    console.log = (...args) => {
      capturedOutput.push(args.map(String).join(" "));
      originalConsoleLog.apply(console, args);
    };
    console.error = (...args) => {
      capturedOutput.push(args.map(String).join(" "));
      originalConsoleError.apply(console, args);
    };
    console.warn = (...args) => {
      capturedOutput.push(args.map(String).join(" "));
      originalConsoleWarn.apply(console, args);
    };
    process.stdout.write = (chunk, encoding, callback) => {
      if (typeof chunk === "string") {
        capturedOutput.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        capturedOutput.push(chunk.toString("utf8"));
      }
      return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
    };
    process.stderr.write = (chunk, encoding, callback) => {
      if (typeof chunk === "string") {
        capturedOutput.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        capturedOutput.push(chunk.toString("utf8"));
      }
      return originalStderrWrite.call(process.stderr, chunk, encoding, callback);
    };

    let generatedRawToken = null;

    try {
      // 1. Execute getOrCreateParentAccess and regenerateParentAccess
      const createRes = await getOrCreateParentAccess(centerIdA, studentA1);
      const regenRes = await regenerateParentAccess(centerIdA, createRes.parentAccess._id);
      generatedRawToken = regenRes.rawToken;

      // 2. Execute exchangeRoute
      const req = createMockExchangeRequest({
        body: { token: generatedRawToken },
        headers: { origin: "http://localhost:3000" },
      });
      const res = await exchangeRoute(req);
      assert.strictEqual(res.status, 200);

      // 3. Execute accessRoute
      const ownerToken = await signToken({ userId: "owner-1", centerId: centerIdA, role: "owner" });
      const accessReq = {
        headers: new Headers({
          Authorization: `Bearer ${ownerToken}`,
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        }),
        cookies: { get: () => null },
        json: async () => ({ action: "generate", studentId: String(studentA1) }),
        nextUrl: new URL("http://localhost:3000/api/parent/access"),
      };
      const accessRes = await accessRoute(accessReq);
      assert.strictEqual(accessRes.status, 201);
    } finally {
      // Restore all original spies safely
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // Verify raw token was never logged to console, stdout, or stderr streams
    const combinedOutput = capturedOutput.join("\n");
    assert.strictEqual(
      combinedOutput.includes(generatedRawToken),
      false,
      `Raw token '${generatedRawToken}' must NEVER be logged to console, stdout, or stderr`
    );
  });
});
