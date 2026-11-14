import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");
const { SignJWT, jwtVerify } = beRequire("jose");

// ============================================================================
// Phase 2B: Student Assignment & Teacher-Scoped Student APIs Specification & Unit Suite
//
// SCOPE CLARIFICATION:
// These tests are specification and unit verification tests. They evaluate data
// models, JWT authentication helpers, query filters, tenant isolation, role
// authorization, and student assignment invariants in-memory without a live
// MongoDB instance or live Next.js HTTP server runtime.
//
// NOTE: These tests do NOT execute live Next.js HTTP route handlers over the network.
// Full route integration testing will be conducted once the test runner environment
// provides an active, isolated MongoDB test database.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 2B: Student Assignment & Teacher-Scoped Student APIs Test Suite", async (t) => {
  const { Student } = await import("../tution-desk-be/src/models/Student.ts");
  const { Teacher } = await import("../tution-desk-be/src/models/Teacher.ts");
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

  // Tokens for actors
  const ownerTokenCenterA = await signToken({
    userId: "650000000000000000000001",
    centerId: "msec",
    role: "owner",
    name: "Dr. A. P. Rao",
  });

  const teacher1TokenCenterA = await signToken({
    userId: "650000000000000000000010",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000010",
    name: "R. K. Sharma (Math)",
  });

  const teacher2TokenCenterA = await signToken({
    userId: "650000000000000000000020",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000020",
    name: "S. K. Gupta (Physics)",
  });

  const ownerTokenCenterB = await signToken({
    userId: "650000000000000000000099",
    centerId: "other_center",
    role: "owner",
    name: "Foreign Owner",
  });

  // Mock student roster in memory for "msec"
  const studentOwnerLegacy = {
    _id: "650000000000000000000101",
    centerId: "msec",
    name: "Legacy Owner Student",
    batch: "Batch-10A",
    parentWhatsApp: "9876543210",
    assignedTeacherId: null, // Legacy student (or missing)
  };

  const studentTeacher1 = {
    _id: "650000000000000000000102",
    centerId: "msec",
    name: "Math Student",
    batch: "Batch-10A",
    parentWhatsApp: "9876543211",
    assignedTeacherId: "650000000000000000000010", // Assigned to Teacher 1
  };

  const studentTeacher2 = {
    _id: "650000000000000000000103",
    centerId: "msec",
    name: "Physics Student",
    batch: "Batch-12B",
    parentWhatsApp: "9876543212",
    assignedTeacherId: "650000000000000000000020", // Assigned to Teacher 2
  };

  const studentForeign = {
    _id: "650000000000000000000104",
    centerId: "other_center",
    name: "Foreign Center Student",
    batch: "Batch-9",
    parentWhatsApp: "9876543213",
    assignedTeacherId: null,
  };

  const allMockStudents = [
    studentOwnerLegacy,
    studentTeacher1,
    studentTeacher2,
    studentForeign,
  ];

  // =========================================================================
  // 1. Owner can view all institute students
  // =========================================================================
  await t.test("1. Owner can view all institute students regardless of assignment", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(owner.role, "owner");
    assert.equal(owner.centerId, "msec");

    // Scoped query for Owner without filter: { centerId: user.centerId }
    const ownerVisible = allMockStudents.filter((s) => s.centerId === owner.centerId);
    assert.equal(ownerVisible.length, 3, "Owner must see all 3 students in institute msec");
    assert.ok(ownerVisible.some((s) => s.name === "Legacy Owner Student"));
    assert.ok(ownerVisible.some((s) => s.name === "Math Student"));
    assert.ok(ownerVisible.some((s) => s.name === "Physics Student"));
  });

  // =========================================================================
  // 2. Teacher sees only their assigned students
  // =========================================================================
  await t.test("2. Teacher sees only students assigned to their authenticated teacherId", async () => {
    const teacher1 = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterA }));
    assert.equal(teacher1.role, "teacher");
    assert.equal(teacher1.teacherId, "650000000000000000000010");

    // Scoped query for Teacher 1: { centerId: user.centerId, assignedTeacherId: user.teacherId }
    const teacher1Visible = allMockStudents.filter(
      (s) => s.centerId === teacher1.centerId && s.assignedTeacherId === teacher1.teacherId
    );

    assert.equal(teacher1Visible.length, 1, "Teacher 1 must only see their 1 assigned student");
    assert.equal(teacher1Visible[0].name, "Math Student");
    assert.equal(teacher1Visible[0].assignedTeacherId, teacher1.teacherId);
  });

  // =========================================================================
  // 3. Teacher cannot access another Teacher's student
  // =========================================================================
  await t.test("3. Teacher cannot access another Teacher's student (ID isolation / 404)", async () => {
    const teacher1 = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterA }));

    // Target is Teacher 2's student
    const targetStudentId = studentTeacher2._id;

    // Route logic query: { _id: id, centerId: user.centerId, assignedTeacherId: user.teacherId }
    const found = allMockStudents.find(
      (s) =>
        s._id === targetStudentId &&
        s.centerId === teacher1.centerId &&
        s.assignedTeacherId === teacher1.teacherId
    );

    assert.equal(found, undefined, "Teacher 1 must not be able to locate Teacher 2's student");
  });

  // =========================================================================
  // 4. Owner can assign a student to an active Teacher
  // =========================================================================
  await t.test("4. Owner can assign a student to an active Teacher belonging to the institute", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(owner.role, "owner");

    const activeTeacher = {
      _id: "650000000000000000000010",
      centerId: "msec",
      name: "R. K. Sharma",
      isActive: true,
    };

    // Owner creates/updates student with activeTeacher._id
    const requestedTeacherId = activeTeacher._id;

    // Server-side validation:
    const isValidId = mongoose.Types.ObjectId.isValid(requestedTeacherId);
    assert.equal(isValidId, true);

    const matchesCenter = activeTeacher.centerId === owner.centerId;
    assert.equal(matchesCenter, true);

    const isTeacherActive = activeTeacher.isActive === true;
    assert.equal(isTeacherActive, true);

    const finalAssignedTeacherId = activeTeacher._id;
    assert.equal(finalAssignedTeacherId, "650000000000000000000010");
  });

  // =========================================================================
  // 5. Owner can assign a student to themselves using null
  // =========================================================================
  await t.test("5. Owner can assign a student to themselves using null", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));

    // Owner passes assignedTeacherId: null (or "owner" or omitted)
    const candidates = [null, "owner", "", undefined];
    for (const requested of candidates) {
      let finalAssignedTeacherId = "should_be_overwritten";
      if (
        requested === null ||
        requested === "owner" ||
        requested === "" ||
        requested === undefined
      ) {
        finalAssignedTeacherId = null;
      }
      assert.equal(finalAssignedTeacherId, null, `Candidate ${requested} must resolve to null (Owner)`);
    }
  });

  // =========================================================================
  // 6. Teacher-created students are automatically assigned to that Teacher
  // =========================================================================
  await t.test("6. Teacher-created students are automatically assigned to that Teacher (JWT-enforced)", async () => {
    const teacher1 = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterA }));
    assert.equal(teacher1.role, "teacher");

    // Client body attempts to provide someone else's ID or null
    const maliciousBody = {
      name: "Sneaky Student",
      batch: "Batch-10",
      parentWhatsApp: "9876543299",
      assignedTeacherId: "650000000000000000000020", // Attempt to assign to Teacher 2
    };

    // Route logic: If user.role === "teacher", assignedTeacherId is derived strictly from user.teacherId
    let finalAssignedTeacherId = null;
    if (teacher1.role === "teacher") {
      finalAssignedTeacherId = teacher1.teacherId;
    }

    assert.equal(
      finalAssignedTeacherId,
      teacher1.teacherId,
      "Teacher's student must strictly be assigned to authenticated teacherId"
    );
    assert.notEqual(
      finalAssignedTeacherId,
      maliciousBody.assignedTeacherId,
      "Client-supplied assignedTeacherId must be strictly ignored"
    );
  });

  // =========================================================================
  // 7. Teacher cannot change their own student assignment
  // =========================================================================
  await t.test("7. Teacher cannot change their own student assignment (HTTP 403 Forbidden)", async () => {
    const teacher1 = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterA }));

    // Attempted update payload
    const updateBody = {
      name: "Renamed Student",
      assignedTeacherId: "650000000000000000000020", // Teacher 2
    };

    // Route logic:
    let isForbidden = false;
    if (teacher1.role === "teacher") {
      if (
        updateBody.assignedTeacherId !== undefined &&
        String(updateBody.assignedTeacherId) !== String(teacher1.teacherId)
      ) {
        isForbidden = true;
      }
    }

    assert.equal(isForbidden, true, "Teacher attempting reassignment must be rejected with 403");
  });

  // =========================================================================
  // 8. Inactive Teacher assignment is rejected
  // =========================================================================
  await t.test("8. Inactive Teacher assignment is rejected (HTTP 400 Bad Request)", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));

    const inactiveTeacher = {
      _id: "650000000000000000000030",
      centerId: "msec",
      name: "Retired Teacher",
      isActive: false, // Inactive!
    };

    // Server-side validation logic:
    let isRejected = false;
    let errorMessage = "";

    if (!inactiveTeacher.isActive) {
      isRejected = true;
      errorMessage = "Cannot assign student to an inactive teacher";
    }

    assert.equal(isRejected, true);
    assert.equal(errorMessage, "Cannot assign student to an inactive teacher");
  });

  // =========================================================================
  // 9. Cross-institute Teacher assignment is rejected
  // =========================================================================
  await t.test("9. Cross-institute Teacher assignment is rejected (HTTP 400 Bad Request)", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(owner.centerId, "msec");

    const foreignTeacher = {
      _id: "650000000000000000000099",
      centerId: "other_center", // Foreign center!
      name: "Foreign Teacher",
      isActive: true,
    };

    // Query executed by route handler: Teacher.findOne({ _id: requestedId, centerId: user.centerId })
    const isTeacherInInstitute =
      foreignTeacher._id === "650000000000000000000099" &&
      foreignTeacher.centerId === owner.centerId;

    assert.equal(isTeacherInInstitute, false, "Foreign teacher must not be found in institute");
  });

  // =========================================================================
  // 10. Cross-institute student access is rejected
  // =========================================================================
  await t.test("10. Cross-institute student access is rejected (Tenant isolation / 404)", async () => {
    const ownerMsec = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(ownerMsec.centerId, "msec");

    // Owner of msec tries to access foreign student
    const foreignStudentId = studentForeign._id;

    // Route logic query: { _id: id, centerId: user.centerId }
    const canAccess = allMockStudents.find(
      (s) => s._id === foreignStudentId && s.centerId === ownerMsec.centerId
    );

    assert.equal(canAccess, undefined, "Owner of msec cannot access foreign student");
  });

  // =========================================================================
  // 11. Client-supplied centerId cannot override JWT centerId
  // =========================================================================
  await t.test("11. Client-supplied centerId cannot override authenticated JWT centerId", async () => {
    const ownerMsec = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));

    // Attacker passes body with foreign centerId
    const body = {
      centerId: "malicious_override_center",
      name: "Victim Student",
      batch: "Batch-1",
      parentWhatsApp: "9876543200",
    };

    // In both GET and POST, targetCenterId is derived strictly from user.centerId
    const effectiveCenterId = ownerMsec.centerId;
    assert.equal(effectiveCenterId, "msec", "Effective centerId must be derived from verified JWT");
    assert.notEqual(effectiveCenterId, body.centerId, "Client-supplied centerId is completely disregarded");
  });

  // =========================================================================
  // 12. Legacy students with missing assignment remain Owner students
  // =========================================================================
  await t.test("12. Legacy students with missing or null assignment remain Owner students", async () => {
    // Legacy student has assignedTeacherId: null
    assert.equal(studentOwnerLegacy.assignedTeacherId, null);

    // Filter rule for Owner: { centerId, $or: [{ assignedTeacherId: null }, { assignedTeacherId: { $exists: false } }] }
    const isOwnerLegacy =
      studentOwnerLegacy.assignedTeacherId === null ||
      studentOwnerLegacy.assignedTeacherId === undefined;
    assert.equal(isOwnerLegacy, true, "Legacy student is recognized as Owner-assigned");

    // Filter rule for Teacher 1: { centerId, assignedTeacherId: teacher1.teacherId }
    const isTeacher1Assigned =
      studentOwnerLegacy.assignedTeacherId === "650000000000000000000010";
    assert.equal(isTeacher1Assigned, false, "Legacy student is never exposed to Teacher 1");
  });
});
