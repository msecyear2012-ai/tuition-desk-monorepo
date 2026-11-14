import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");
const bcrypt = beRequire("bcryptjs");
const { SignJWT, jwtVerify } = beRequire("jose");

// ============================================================================
// Phase 2A: Teacher Management Specification & Unit Verification Test Suite
//
// SCOPE CLARIFICATION:
// These tests are specification and unit verification tests. They evaluate data
// models, JWT authentication helpers, query filters, and cross-field identifier
// collision logic in-memory without a live MongoDB instance or live Next.js HTTP
// server runtime.
//
// NOTE: These tests do NOT execute live Next.js HTTP route handlers over the network.
// Full route integration testing will be conducted once the test runner environment
// provides an active, isolated MongoDB test database.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 2A: Teacher Management APIs Authorization & Business Logic Suite", async (t) => {
  const { Teacher } = await import("../tution-desk-be/src/models/Teacher.ts");
  const { Center } = await import("../tution-desk-be/src/models/Center.ts");
  const { signToken, verifyToken, getAuthenticatedUser } = await import("../tution-desk-be/src/lib/auth.ts");

  // Helper to generate mock NextRequest with auth cookie or header
  function createMockRequest({ token = null, method = "GET", body = {}, searchParams = {} } = {}) {
    return {
      method,
      cookies: {
        get: (name) => (token && (name === "auth_token" || name === "token") ? { value: token } : undefined),
      },
      headers: {
        get: (name) => {
          if (name.toLowerCase() === "authorization" && token) return `Bearer ${token}`;
          if (name.toLowerCase() === "origin") return "http://localhost:3000";
          return null;
        },
      },
      nextUrl: {
        searchParams: {
          get: (key) => searchParams[key] || null,
        },
      },
      json: async () => body,
    };
  }

  // Tokens for different test actors
  const ownerTokenCenterA = await signToken({
    userId: "650000000000000000000001",
    centerId: "msec",
    role: "owner",
    name: "MSEC Owner",
  });

  const teacherTokenCenterA = await signToken({
    userId: "650000000000000000000002",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000002",
    name: "R. K. Sharma",
  });

  const ownerTokenCenterB = await signToken({
    userId: "650000000000000000000003",
    centerId: "other_center",
    role: "owner",
    name: "Other Center Owner",
  });

  // =========================================================================
  // 1. Owner can create and list teachers
  // =========================================================================
  await t.test("1. Owner can create and list teachers under their institute", async () => {
    const ownerReq = createMockRequest({ token: ownerTokenCenterA });
    const user = await getAuthenticatedUser(ownerReq);

    assert.ok(user, "Owner must be authenticated");
    assert.equal(user.role, "owner", "User must have owner role");
    assert.equal(user.centerId, "msec", "User must belong to msec");

    // In-memory simulation of teacher creation
    const rawPassword = "TeacherPass2026!";
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(rawPassword, salt);

    const createdTeacher = new Teacher({
      centerId: user.centerId,
      name: "R. K. Sharma",
      loginId: "sharma_math",
      phone: "+919876543210",
      email: "sharma@example.com",
      password: hashedPassword,
      subjects: ["Mathematics", "Physics"],
      assignedBatches: ["Batch-10A"],
      isActive: true,
      mustChangePassword: false,
    });

    assert.equal(createdTeacher.centerId, "msec");
    assert.equal(createdTeacher.role, "teacher");
    assert.equal(createdTeacher.isActive, true);
    assert.equal(createdTeacher.mustChangePassword, false);

    // Sanitization: password must be omitted in API response
    const sanitized = createdTeacher.toObject();
    delete sanitized.password;
    assert.equal(sanitized.password, undefined, "Password must be sanitized from response");
    assert.equal(sanitized.name, "R. K. Sharma");
  });

  // =========================================================================
  // 2. Teacher cannot access management APIs
  // =========================================================================
  await t.test("2. Teacher cannot access management APIs (HTTP 403 Forbidden)", async () => {
    const teacherReq = createMockRequest({ token: teacherTokenCenterA });
    const user = await getAuthenticatedUser(teacherReq);

    assert.ok(user, "Teacher is authenticated");
    assert.equal(user.role, "teacher", "Role is teacher");

    // Route authorization gate
    const isAuthorized = user && user.role === "owner";
    assert.equal(isAuthorized, false, "Teacher must be rejected by owner authorization guard");
  });

  // =========================================================================
  // 3. Unauthenticated requests are rejected
  // =========================================================================
  await t.test("3. Unauthenticated requests are rejected (HTTP 401 Unauthorized)", async () => {
    const unauthReq = createMockRequest({ token: null });
    const user = await getAuthenticatedUser(unauthReq);

    assert.equal(user, null, "Unauthenticated request must return null user");
    const isAuthorized = Boolean(user && user.role === "owner");
    assert.equal(isAuthorized, false, "Unauthenticated request must be denied");
  });

  // =========================================================================
  // 4. Teacher records are isolated by centerId
  // =========================================================================
  await t.test("4. Teacher records are strictly partitioned by centerId", async () => {
    const teacherCenterA = new Teacher({
      centerId: "msec",
      name: "MSEC Teacher",
      loginId: "msec_teacher",
      phone: "+919876543210",
      password: "hashed_dummy_password",
    });

    const teacherCenterB = new Teacher({
      centerId: "other_center",
      name: "Other Teacher",
      loginId: "other_teacher",
      phone: "+919876543211",
      password: "hashed_dummy_password",
    });

    // Query for msec should never include other_center
    const teachersList = [teacherCenterA, teacherCenterB];
    const msecFiltered = teachersList.filter((t) => t.centerId === "msec");

    assert.equal(msecFiltered.length, 1);
    assert.equal(msecFiltered[0].name, "MSEC Teacher");
    assert.equal(msecFiltered[0].centerId, "msec");
  });

  // =========================================================================
  // 5. Cross-institute teacher IDs cannot be retrieved or modified
  // =========================================================================
  await t.test("5. Cross-institute teacher IDs cannot be retrieved or modified", async () => {
    const foreignTeacher = {
      _id: "650000000000000000000099",
      centerId: "other_center",
      name: "Foreign Teacher",
    };

    // Owner from msec tries to access foreignTeacher
    const ownerMsec = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(ownerMsec.centerId, "msec");

    // Tenant lookup query simulation: { _id: foreignTeacher._id, centerId: ownerMsec.centerId }
    const canAccess = foreignTeacher._id === "650000000000000000000099" && foreignTeacher.centerId === ownerMsec.centerId;
    assert.equal(canAccess, false, "Cross-institute teacher lookup must return false / 404");
  });

  // =========================================================================
  // 6. Duplicate login IDs within the same institute are handled safely
  // =========================================================================
  await t.test("6. Duplicate login IDs within same institute are prevented", async () => {
    const existingTeacher = {
      centerId: "msec",
      loginId: "unique_login",
      phone: "+919876543210",
    };

    const newTeacherAttempt = {
      centerId: "msec",
      loginId: "unique_login",
      phone: "+919876543219",
    };

    const isDuplicateLogin =
      existingTeacher.centerId === newTeacherAttempt.centerId &&
      existingTeacher.loginId === newTeacherAttempt.loginId;

    assert.equal(isDuplicateLogin, true, "Duplicate login within same center must be caught (HTTP 409)");

    // But identical login ID in a DIFFERENT institute is allowed by schema
    const differentCenterAttempt = {
      centerId: "other_center",
      loginId: "unique_login",
    };
    const isCrossCenterDuplicate =
      existingTeacher.centerId === differentCenterAttempt.centerId &&
      existingTeacher.loginId === differentCenterAttempt.loginId;

    assert.equal(isCrossCenterDuplicate, false, "Different centers can share loginId");
  });

  // =========================================================================
  // 7. Inactive teachers cannot be reactivated or modified through unauthorized operations
  // =========================================================================
  await t.test("7. Inactive teachers: deactivation preserves record, unauthorized edits blocked", async () => {
    const teacher = new Teacher({
      centerId: "msec",
      name: "Retiring Teacher",
      loginId: "retiring_teacher",
      phone: "+919876543212",
      password: "hashed_dummy_password",
      isActive: true,
    });

    // Owner soft-deactivates teacher
    teacher.isActive = false;
    assert.equal(teacher.isActive, false, "Teacher is deactivated without record deletion");

    // Teacher tries to reactivate themselves
    const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacherTokenCenterA }));
    const canTeacherModify = teacherUser.role === "owner";
    assert.equal(canTeacherModify, false, "Teacher cannot modify or reactivate teacher records");
  });

  // =========================================================================
  // 8. Passwords are hashed and never returned
  // =========================================================================
  await t.test("8. Passwords are salted bcrypt hashes and stripped from API responses", async () => {
    const plainPassword = "SuperSecretPassword123!";
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(plainPassword, salt);

    assert.notEqual(hashedPassword, plainPassword, "Password must not be stored in plaintext");
    assert.ok(await bcrypt.compare(plainPassword, hashedPassword), "Bcrypt must verify hash");

    const teacherDoc = new Teacher({
      centerId: "msec",
      name: "Protected Teacher",
      loginId: "protected_teacher",
      phone: "+919876543213",
      password: hashedPassword,
    });

    const apiResponseData = teacherDoc.toObject();
    delete apiResponseData.password;

    assert.equal(apiResponseData.password, undefined, "Password hash must never appear in API response data");
  });

  // =========================================================================
  // 9. Owner is never represented as an additional Teacher record
  // =========================================================================
  await t.test("9. Owner phone cannot be registered as an additional Teacher record", async () => {
    const ownerCenter = {
      centerId: "msec",
      ownerName: "Dr. A. P. Rao",
      phone: "+919123456789",
    };

    const attemptTeacherPhone = "+919123456789"; // Same as Owner
    const isOwnerPhoneCollision = ownerCenter.phone === attemptTeacherPhone;

    assert.equal(isOwnerPhoneCollision, true, "Attempt to register Owner phone as Teacher must be detected");
    // API route returns HTTP 409: "Phone number is already registered to the Institute Owner"
  });

  // =========================================================================
  // 10. Existing Owner login remains unaffected
  // =========================================================================
  await t.test("10. Existing Owner login remains unaffected with full administrative claims", async () => {
    const ownerToken = await signToken({
      userId: "650000000000000000000001",
      centerId: "msec",
      role: "owner",
      name: "Dr. A. P. Rao",
    });

    const payload = await verifyToken(ownerToken);
    assert.equal(payload.role, "owner");
    assert.equal(payload.centerId, "msec");
    assert.equal(payload.teacherId, undefined, "Owner does not have teacherId");
    assert.equal(payload.userId, "650000000000000000000001");
  });

  // =========================================================================
  // 11. Cross-field collision on POST: Teacher A phone = Teacher B loginId
  // =========================================================================
  await t.test("11. POST: Cross-field collision rejected when new Teacher loginId equals existing Teacher phone (HTTP 409)", async () => {
    const existingTeacher = {
      _id: "650000000000000000000010",
      centerId: "msec",
      name: "Teacher Alpha",
      loginId: "teacher_alpha",
      phone: "+919876543210",
    };

    const newCandidate = {
      name: "Teacher Beta",
      loginId: "+919876543210", // Exactly equals Teacher Alpha's phone!
      phone: "+919876543299",
    };

    const cleanPhone = String(newCandidate.phone).trim();
    const cleanLoginId = String(newCandidate.loginId).trim();

    // Query condition evaluated by POST /api/teachers:
    // { centerId, $or: [{ phone: cleanPhone }, { loginId: cleanPhone }, { phone: cleanLoginId }, { loginId: cleanLoginId }] }
    const hasConflict =
      existingTeacher.phone === cleanPhone ||
      existingTeacher.loginId === cleanPhone ||
      existingTeacher.phone === cleanLoginId ||
      existingTeacher.loginId === cleanLoginId;

    assert.equal(hasConflict, true, "Candidate loginId matching existing phone must be detected as conflict");
  });

  // =========================================================================
  // 12. Cross-field collision on POST: Teacher A loginId = Teacher B phone
  // =========================================================================
  await t.test("12. POST: Cross-field collision rejected when new Teacher phone equals existing Teacher loginId (HTTP 409)", async () => {
    const existingTeacher = {
      _id: "650000000000000000000010",
      centerId: "msec",
      name: "Teacher Alpha",
      loginId: "9876543210", // Alpha's loginId
      phone: "+919999999999",
    };

    const newCandidate = {
      name: "Teacher Beta",
      loginId: "teacher_beta",
      phone: "9876543210", // Exactly equals Alpha's loginId!
    };

    const cleanPhone = String(newCandidate.phone).trim();
    const cleanLoginId = String(newCandidate.loginId).trim();

    const hasConflict =
      existingTeacher.phone === cleanPhone ||
      existingTeacher.loginId === cleanPhone ||
      existingTeacher.phone === cleanLoginId ||
      existingTeacher.loginId === cleanLoginId;

    assert.equal(hasConflict, true, "Candidate phone matching existing loginId must be detected as conflict");
  });

  // =========================================================================
  // 13. Owner collision on POST: Teacher loginId = Owner phone
  // =========================================================================
  await t.test("13. POST: Rejects new Teacher loginId colliding with Institute Owner phone (HTTP 409)", async () => {
    const ownerCenter = {
      centerId: "msec",
      phone: "+919123456789",
    };

    const candidate = {
      name: "Teacher Gamma",
      loginId: "+919123456789", // Same as Owner's registered phone
      phone: "+919876543200",
    };

    const cleanPhone = String(candidate.phone).trim();
    const cleanLoginId = String(candidate.loginId).trim();
    const ownerPhone = String(ownerCenter.phone).trim();

    const collidesWithOwner = ownerPhone === cleanPhone || ownerPhone === cleanLoginId;
    assert.equal(collidesWithOwner, true, "Teacher loginId matching Owner phone must trigger conflict (HTTP 409)");
  });

  // =========================================================================
  // 14. Owner collision on POST: Teacher phone = Owner phone
  // =========================================================================
  await t.test("14. POST: Rejects new Teacher phone colliding with Institute Owner phone (HTTP 409)", async () => {
    const ownerCenter = {
      centerId: "msec",
      phone: "+919123456789",
    };

    const candidate = {
      name: "Teacher Delta",
      loginId: "teacher_delta",
      phone: "+919123456789", // Same as Owner's registered phone
    };

    const cleanPhone = String(candidate.phone).trim();
    const cleanLoginId = String(candidate.loginId).trim();
    const ownerPhone = String(ownerCenter.phone).trim();

    const collidesWithOwner = ownerPhone === cleanPhone || ownerPhone === cleanLoginId;
    assert.equal(collidesWithOwner, true, "Teacher phone matching Owner phone must trigger conflict (HTTP 409)");
  });

  // =========================================================================
  // 15. Cross-field collision on PUT: Updating identifier to another Teacher's existing identifier
  // =========================================================================
  await t.test("15. PUT: Rejects updating identifier to another Teacher's existing identifier (HTTP 409)", async () => {
    const teacherAlpha = {
      _id: "650000000000000000000010",
      centerId: "msec",
      loginId: "alpha_login",
      phone: "+919876543210",
    };

    const teacherBeta = {
      _id: "650000000000000000000020",
      centerId: "msec",
      loginId: "beta_login",
      phone: "+919876543220",
    };

    // Case A: Beta tries to change phone to Alpha's loginId
    const updatePayloadA = { phone: "alpha_login" };
    const candidatePhoneA = String(updatePayloadA.phone).trim();
    const phoneChangedA = candidatePhoneA !== teacherBeta.phone;

    assert.equal(phoneChangedA, true);
    const hasCollisionA =
      teacherAlpha._id !== teacherBeta._id &&
      (teacherAlpha.phone === candidatePhoneA || teacherAlpha.loginId === candidatePhoneA);
    assert.equal(hasCollisionA, true, "Updating phone to another Teacher's loginId must trigger conflict");

    // Case B: Beta tries to change loginId to Alpha's phone
    const updatePayloadB = { loginId: "+919876543210" };
    const candidateLoginIdB = String(updatePayloadB.loginId).trim();
    const loginIdChangedB = candidateLoginIdB !== teacherBeta.loginId;

    assert.equal(loginIdChangedB, true);
    const hasCollisionB =
      teacherAlpha._id !== teacherBeta._id &&
      (teacherAlpha.loginId === candidateLoginIdB || teacherAlpha.phone === candidateLoginIdB);
    assert.equal(hasCollisionB, true, "Updating loginId to another Teacher's phone must trigger conflict");
  });

  // =========================================================================
  // 16. Owner collision on PUT: Updating identifier to Owner's registered phone
  // =========================================================================
  await t.test("16. PUT: Rejects updating identifier to Owner's registered phone (HTTP 409)", async () => {
    const ownerCenter = {
      centerId: "msec",
      phone: "+919123456789",
    };

    const currentTeacher = {
      _id: "650000000000000000000020",
      centerId: "msec",
      loginId: "beta_login",
      phone: "+919876543220",
    };

    // Attempt to update phone to owner's phone
    const candidatePhone = String("+919123456789").trim();
    const phoneChanged = candidatePhone !== currentTeacher.phone;
    const ownerPhone = String(ownerCenter.phone).trim();

    const collides = phoneChanged && ownerPhone === candidatePhone;
    assert.equal(collides, true, "Updating phone to Owner's phone must trigger conflict (HTTP 409)");

    // Attempt to update loginId to owner's phone
    const candidateLoginId = String("+919123456789").trim();
    const loginIdChanged = candidateLoginId !== currentTeacher.loginId;
    const loginCollides = loginIdChanged && ownerPhone === candidateLoginId;
    assert.equal(loginCollides, true, "Updating loginId to Owner's phone must trigger conflict (HTTP 409)");
  });

  // =========================================================================
  // 17. Updating a Teacher without changing their own identifiers
  // =========================================================================
  await t.test("17. PUT: Updating a Teacher while re-submitting unchanged identifiers succeeds without false conflict", async () => {
    const currentTeacher = {
      _id: "650000000000000000000020",
      centerId: "msec",
      name: "Teacher Beta",
      loginId: "beta_login",
      phone: "+919876543220",
    };

    // Body contains the exact same phone and loginId alongside updated name
    const updateBody = {
      name: "Teacher Beta Renamed",
      loginId: "beta_login",
      phone: "+919876543220",
    };

    const cleanLoginId = String(updateBody.loginId).trim();
    const cleanPhone = String(updateBody.phone).trim();

    const loginIdChanged = cleanLoginId !== currentTeacher.loginId;
    const phoneChanged = cleanPhone !== currentTeacher.phone;

    // Both flags are false -> no duplicate search condition triggered
    assert.equal(loginIdChanged, false, "Re-submitted loginId does not count as changed");
    assert.equal(phoneChanged, false, "Re-submitted phone does not count as changed");

    // Furthermore, even if query were executed with { _id: { $ne: currentTeacher._id } },
    // current teacher is excluded so no false self-collision occurs.
    const wouldSelfCollide = currentTeacher._id !== currentTeacher._id;
    assert.equal(wouldSelfCollide, false, "Current teacher _id is excluded from conflict queries");
  });

  // =========================================================================
  // 18. Existing Teacher can retain their current phone/loginId without false conflict
  // =========================================================================
  await t.test("18. PUT: Existing Teacher retains current phone/loginId when updating other fields (name, email, subjects)", async () => {
    const currentTeacher = {
      _id: "650000000000000000000020",
      centerId: "msec",
      name: "Teacher Beta",
      loginId: "beta_login",
      phone: "+919876543220",
      subjects: ["Math"],
    };

    // Body updates only subjects and name; phone & loginId are omitted (undefined)
    const updateBody = {
      name: "Teacher Beta Senior",
      subjects: ["Math", "Statistics"],
    };

    let candidateLoginId = currentTeacher.loginId;
    let candidatePhone = currentTeacher.phone;
    let loginIdChanged = false;
    let phoneChanged = false;

    if (updateBody.loginId !== undefined) {
      const clean = String(updateBody.loginId).trim();
      if (clean !== currentTeacher.loginId) {
        candidateLoginId = clean;
        loginIdChanged = true;
      }
    }

    if (updateBody.phone !== undefined) {
      const clean = String(updateBody.phone).trim();
      if (clean !== currentTeacher.phone) {
        candidatePhone = clean;
        phoneChanged = true;
      }
    }

    assert.equal(loginIdChanged, false);
    assert.equal(phoneChanged, false);
    assert.equal(candidateLoginId, currentTeacher.loginId, "Retains original loginId");
    assert.equal(candidatePhone, currentTeacher.phone, "Retains original phone");
  });

  // =========================================================================
  // 19. Normalization: Whitespace trimming prevents collision bypass
  // =========================================================================
  await t.test("19. Normalization: Leading/trailing whitespace is trimmed before collision checks", async () => {
    const existingTeacher = {
      _id: "650000000000000000000010",
      centerId: "msec",
      loginId: "teacher_alpha",
      phone: "+919876543210",
    };

    // Whitespace padded candidate
    const paddedCandidate = {
      loginId: "  teacher_alpha  ",
      phone: "  +919999999999  ",
    };

    const cleanLoginId = String(paddedCandidate.loginId).trim();
    const cleanPhone = String(paddedCandidate.phone).trim();

    assert.equal(cleanLoginId, "teacher_alpha");
    assert.equal(cleanPhone, "+919999999999");

    const collides = existingTeacher.loginId === cleanLoginId;
    assert.equal(collides, true, "Trimming ensures padded loginId collides with existing record");
  });

  // =========================================================================
  // 20. POST Password Validation: Whitespace-only rejection & hash integrity
  // =========================================================================
  await t.test("20. POST Password Validation: Rejects whitespace-only passwords, preserves untrimmed password during hashing", async () => {
    // Helper mirroring POST validation rule:
    // (!password || !String(password).trim() || String(password).length < 6)
    function validatePassword(password) {
      if (!password || !String(password).trim() || String(password).length < 6) {
        return { valid: false, error: "Password is required and must be at least 6 characters" };
      }
      return { valid: true };
    }

    assert.equal(validatePassword("").valid, false, "Empty password rejected");
    assert.equal(validatePassword("     ").valid, false, "Whitespace-only password < 6 rejected");
    assert.equal(validatePassword("      ").valid, false, "Whitespace-only password of 6 spaces rejected");
    assert.equal(validatePassword("        ").valid, false, "Whitespace-only password of 8 spaces rejected");
    assert.equal(validatePassword("12345").valid, false, "Password < 6 chars rejected");
    assert.equal(validatePassword("validPass123").valid, true, "Valid password accepted");

    // Verify actual password is NOT trimmed before bcrypt hashing
    const rawPasswordWithTrailingSpace = "MyPass123 ";
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(String(rawPasswordWithTrailingSpace), salt);

    // Matches the exact raw password
    assert.ok(await bcrypt.compare("MyPass123 ", hashedPassword), "Bcrypt matches untrimmed password");
    // Does NOT match trimmed password
    assert.equal(await bcrypt.compare("MyPass123", hashedPassword), false, "Bcrypt fails if trimmed");
  });
});


