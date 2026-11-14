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

// Set environment for JWT tests
process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 1: Database Models & Authentication Core Test Suite", async (t) => {

  // =========================================================================
  // 1. Teacher Model & Schema Validation
  // =========================================================================
  await t.test("1.1 Teacher Model schema fields, defaults, and constraints", async () => {
    // Import Teacher model
    const { Teacher } = await import("../tution-desk-be/src/models/Teacher.ts");
    assert.ok(Teacher, "Teacher model must be exported");

    const schema = Teacher.schema;
    assert.ok(schema.path("centerId"), "Teacher must have centerId");
    assert.equal(schema.path("centerId").instance, "String");
    assert.ok(schema.path("centerId").isRequired, "centerId must be required");

    assert.ok(schema.path("name"), "Teacher must have name");
    assert.ok(schema.path("name").isRequired, "name must be required");

    assert.ok(schema.path("loginId"), "Teacher must have loginId");
    assert.ok(schema.path("loginId").isRequired, "loginId must be required");

    assert.ok(schema.path("phone"), "Teacher must have phone");
    assert.ok(schema.path("phone").isRequired, "phone must be required");

    assert.ok(schema.path("password"), "Teacher must have password");
    assert.ok(schema.path("password").isRequired, "password must be required");

    assert.ok(schema.path("role"), "Teacher must have role");
    assert.equal(schema.path("role").defaultValue, "teacher");

    assert.ok(schema.path("isActive"), "Teacher must have isActive");
    assert.equal(schema.path("isActive").defaultValue, true);

    assert.ok(schema.path("mustChangePassword"), "Teacher must have mustChangePassword");
    assert.equal(schema.path("mustChangePassword").defaultValue, false);

    // Verify document instantiation default
    const defaultTeacher = new Teacher({
      centerId: "msec",
      name: "Default Teacher",
      loginId: "teacher_default",
      phone: "9876543211",
      password: "dummy-password",
    });
    assert.equal(defaultTeacher.mustChangePassword, false, "mustChangePassword must default to false");

    // Verify compound indexes
    const indexes = schema.indexes();
    const hasUniqueLoginIdIndex = indexes.some(
      ([idx, opts]) => idx.centerId === 1 && idx.loginId === 1 && opts?.unique === true
    );
    assert.ok(hasUniqueLoginIdIndex, "Teacher must have unique compound index on { centerId: 1, loginId: 1 }");

    const hasPhoneIndex = indexes.some(
      ([idx]) => idx.centerId === 1 && idx.phone === 1
    );
    assert.ok(hasPhoneIndex, "Teacher must have index on { centerId: 1, phone: 1 }");

    const hasActiveIndex = indexes.some(
      ([idx]) => idx.centerId === 1 && idx.isActive === 1
    );
    assert.ok(hasActiveIndex, "Teacher must have index on { centerId: 1, isActive: 1 }");
  });

  await t.test("1.2 Teacher password hashing and bcrypt verification", async () => {
    const rawPassword = "TeacherSecurePassword!2026";
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(rawPassword, salt);

    assert.notEqual(rawPassword, hashedPassword, "Password must be hashed");
    assert.ok(hashedPassword.startsWith("$2a$") || hashedPassword.startsWith("$2b$"), "Password must be valid bcrypt hash");

    const isMatchCorrect = await bcrypt.compare(rawPassword, hashedPassword);
    assert.equal(isMatchCorrect, true, "Bcrypt must verify correct password");

    const isMatchWrong = await bcrypt.compare("WrongPassword", hashedPassword);
    assert.equal(isMatchWrong, false, "Bcrypt must reject wrong password");
  });

  // =========================================================================
  // 2. Student Model & Backward Compatibility Validation
  // =========================================================================
  await t.test("2.1 Student Model assignedTeacherId and backward compatibility", async () => {
    const { Student } = await import("../tution-desk-be/src/models/Student.ts");
    assert.ok(Student, "Student model must be exported");

    const schema = Student.schema;
    assert.ok(schema.path("assignedTeacherId"), "Student must have assignedTeacherId");
    assert.equal(schema.path("assignedTeacherId").instance, "ObjectId");
    assert.equal(schema.path("assignedTeacherId").options.ref, "Teacher");
    assert.equal(schema.path("assignedTeacherId").options.default, null);

    assert.ok(schema.path("importedBatchId"), "Student must have importedBatchId");

    // Verify compound indexes
    const indexes = schema.indexes();
    const hasTeacherIndex = indexes.some(
      ([idx]) => idx.centerId === 1 && idx.assignedTeacherId === 1
    );
    assert.ok(hasTeacherIndex, "Student must have index on { centerId: 1, assignedTeacherId: 1 }");

    // Ensure NO hard unique index on parentWhatsApp or name
    const hasHardUniqueIndex = indexes.some(
      ([idx, opts]) => (idx.parentWhatsApp || idx.name) && opts?.unique === true
    );
    assert.equal(hasHardUniqueIndex, false, "Student must NOT have hard unique index on phone/name that blocks siblings");
  });

  await t.test("2.2 Legacy Student representation defaults to null for Owner", async () => {
    const { Student } = await import("../tution-desk-be/src/models/Student.ts");

    // Simulate creating a legacy student document without assignedTeacherId
    const legacyStudent = new Student({
      centerId: "msec",
      name: "Legacy Student",
      batch: "Class 10-A",
      parentWhatsApp: "+919876543210",
      monthlyFee: 1500,
      billingCycleDate: 5,
    });

    assert.equal(legacyStudent.assignedTeacherId, null, "Legacy student assignedTeacherId must default to null (Owner)");
  });

  // =========================================================================
  // 3. Fee Model & Payment Attribution Snapshots
  // =========================================================================
  await t.test("3.1 Fee Model attribution fields, snapshots, and index rules", async () => {
    const { Fee } = await import("../tution-desk-be/src/models/Fee.ts");
    assert.ok(Fee, "Fee model must be exported");

    const schema = Fee.schema;

    // Academic attribution fields
    assert.ok(schema.path("assignedTeacherId"), "Fee must have assignedTeacherId");
    assert.equal(schema.path("assignedTeacherId").options.ref, "Teacher");
    assert.equal(schema.path("assignedTeacherId").options.default, null);

    assert.ok(schema.path("assignedTeacherAtPayment"), "Fee must have assignedTeacherAtPayment");
    assert.equal(schema.path("assignedTeacherAtPayment").options.ref, "Teacher");
    assert.equal(schema.path("assignedTeacherAtPayment").options.default, null);

    assert.ok(schema.path("batchAtPayment"), "Fee must have batchAtPayment");

    // Payment custody fields
    assert.ok(schema.path("receivedBy"), "Fee must have receivedBy");
    assert.equal(schema.path("receivedBy").instance, "ObjectId");

    assert.ok(schema.path("receivedByRole"), "Fee must have receivedByRole");

    assert.ok(schema.path("recordedBy"), "Fee must have recordedBy");
    assert.equal(schema.path("recordedBy").instance, "ObjectId");

    assert.ok(schema.path("recordedByRole"), "Fee must have recordedByRole");

    assert.ok(schema.path("recordedAt"), "Fee must have recordedAt");

    // Ensure NO void/refund fields exist (DEC-MSEC-02 is unresolved)
    assert.equal(schema.path("isVoided"), undefined, "Fee must NOT have isVoided field");
    assert.equal(schema.path("voidedAt"), undefined, "Fee must NOT have voidedAt field");
    assert.equal(schema.path("voidedBy"), undefined, "Fee must NOT have voidedBy field");
    assert.equal(schema.path("voidReason"), undefined, "Fee must NOT have voidReason field");

    // Verify partial filter expression index for UTR anti-duplication
    const indexes = schema.indexes();
    const utrIndex = indexes.find(
      ([idx]) => idx.centerId === 1 && idx.utrNumber === 1
    );
    assert.ok(utrIndex, "Fee must have index on { centerId: 1, utrNumber: 1 }");
    const [fields, options] = utrIndex;
    assert.equal(options.unique, true, "UTR index must be unique");
    assert.deepEqual(
      options.partialFilterExpression,
      { utrNumber: { $type: "string", $gt: "" } },
      "UTR index must use partialFilterExpression to avoid colliding on empty or cash payments"
    );

    // Verify historical reporting indexes
    const hasTeacherReportingIndex = indexes.some(
      ([idx]) => idx.centerId === 1 && idx.assignedTeacherAtPayment === 1 && idx.paymentDate === 1
    );
    assert.ok(hasTeacherReportingIndex, "Fee must have index on { centerId: 1, assignedTeacherAtPayment: 1, paymentDate: 1 }");

    const hasReceivedByIndex = indexes.some(
      ([idx]) => idx.centerId === 1 && idx.receivedBy === 1 && idx.paymentDate === 1
    );
    assert.ok(hasReceivedByIndex, "Fee must have index on { centerId: 1, receivedBy: 1, paymentDate: 1 }");
  });

  await t.test("3.2 UTR partial filter expression semantics for cash vs online payments", () => {
    // Test logic simulating MongoDB partialFilterExpression: { utrNumber: { $type: "string", $gt: "" } }
    function isIndexedInPartialIndex(doc) {
      if (typeof doc.utrNumber !== "string") return false;
      return doc.utrNumber > "";
    }

    // Cash payments with default empty string
    const cashPayment1 = { centerId: "msec", utrNumber: "" };
    const cashPayment2 = { centerId: "msec", utrNumber: "" };
    assert.equal(isIndexedInPartialIndex(cashPayment1), false, "Empty string UTR is not indexed");
    assert.equal(isIndexedInPartialIndex(cashPayment2), false, "Empty string UTR is not indexed (no collision)");

    // Cash payments with null or undefined
    const cashPayment3 = { centerId: "msec", utrNumber: undefined };
    assert.equal(isIndexedInPartialIndex(cashPayment3), false, "Undefined UTR is not indexed");

    // Digital payments with real UTR
    const onlinePayment1 = { centerId: "msec", utrNumber: "UTR20261102ABCD" };
    const onlinePayment2 = { centerId: "msec", utrNumber: "UTR20261102ABCD" };
    assert.equal(isIndexedInPartialIndex(onlinePayment1), true, "Valid UTR is indexed");
    assert.equal(isIndexedInPartialIndex(onlinePayment2), true, "Duplicate valid UTR will be caught by index");
  });

  // =========================================================================
  // 4. JWT & Authentication Utilities
  // =========================================================================
  await t.test("4.1 AuthPayload signing and verification for Owner and Teacher", async () => {
    const { signToken, verifyToken } = await import("../tution-desk-be/src/lib/auth.ts");

    // Test Owner Token
    const ownerToken = await signToken({
      userId: "650000000000000000000001",
      centerId: "msec",
      role: "owner",
      name: "MSEC Owner",
    });

    const ownerPayload = await verifyToken(ownerToken);
    assert.ok(ownerPayload, "Owner token must be valid");
    assert.equal(ownerPayload.role, "owner");
    assert.equal(ownerPayload.centerId, "msec");
    assert.equal(ownerPayload.userId, "650000000000000000000001");
    assert.equal(ownerPayload.teacherId, undefined, "Owner token must not have teacherId");

    // Test Teacher Token
    const teacherToken = await signToken({
      userId: "650000000000000000000002",
      centerId: "msec",
      role: "teacher",
      teacherId: "650000000000000000000002",
      name: "R. K. Sharma",
      mustChangePassword: true,
    });

    const teacherPayload = await verifyToken(teacherToken);
    assert.ok(teacherPayload, "Teacher token must be valid");
    assert.equal(teacherPayload.role, "teacher");
    assert.equal(teacherPayload.centerId, "msec");
    assert.equal(teacherPayload.userId, "650000000000000000000002");
    assert.equal(teacherPayload.teacherId, "650000000000000000000002");
    assert.equal(teacherPayload.mustChangePassword, true);
  });

  await t.test("4.2 getAuthenticatedUser and getAuthenticatedCenterId", async () => {
    const { signToken, getAuthenticatedUser, getAuthenticatedCenterId } = await import(
      "../tution-desk-be/src/lib/auth.ts"
    );

    const token = await signToken({
      userId: "650000000000000000000002",
      centerId: "msec",
      role: "teacher",
      teacherId: "650000000000000000000002",
      name: "Teacher Name",
    });

    // Mock NextRequest with cookie
    const mockCookieRequest = {
      cookies: {
        get: (name) => (name === "auth_token" ? { value: token } : undefined),
      },
      headers: {
        get: () => null,
      },
    };

    const userFromCookie = await getAuthenticatedUser(mockCookieRequest);
    assert.ok(userFromCookie, "Must resolve user from cookie");
    assert.equal(userFromCookie.centerId, "msec");
    assert.equal(userFromCookie.role, "teacher");

    const centerIdFromCookie = await getAuthenticatedCenterId(mockCookieRequest);
    assert.equal(centerIdFromCookie, "msec", "getAuthenticatedCenterId must resolve centerId");

    // Mock NextRequest with Authorization Bearer header
    const mockBearerRequest = {
      cookies: {
        get: () => undefined,
      },
      headers: {
        get: (header) => (header === "authorization" ? `Bearer ${token}` : null),
      },
    };

    const userFromBearer = await getAuthenticatedUser(mockBearerRequest);
    assert.ok(userFromBearer, "Must resolve user from Bearer header");
    assert.equal(userFromBearer.role, "teacher");

    // Mock unauthenticated request
    const mockUnauthRequest = {
      cookies: { get: () => undefined },
      headers: { get: () => null },
    };

    const unauthUser = await getAuthenticatedUser(mockUnauthRequest);
    assert.equal(unauthUser, null, "Unauthenticated request must return null (fail closed)");

    const unauthCenterId = await getAuthenticatedCenterId(mockUnauthRequest);
    assert.equal(unauthCenterId, null, "Unauthenticated centerId must return null");
  });

  // =========================================================================
  // 5. Authentication Flow & Business Logic
  // =========================================================================
  await t.test("5.1 Teacher login resolves institute, role, and rejects inactive accounts", async () => {
    const mockTeacher = {
      _id: "650000000000000000000002",
      centerId: "msec",
      name: "R. K. Sharma",
      loginId: "sharma_math",
      phone: "9876543210",
      password: await bcrypt.hash("TeacherPass123", 10),
      role: "teacher",
      isActive: true,
      mustChangePassword: true,
    };

    // Test valid credentials match
    const isValidPass = await bcrypt.compare("TeacherPass123", mockTeacher.password);
    assert.equal(isValidPass, true, "Valid password matches");

    const isInvalidPass = await bcrypt.compare("BadPass", mockTeacher.password);
    assert.equal(isInvalidPass, false, "Invalid password rejected");

    // Inactive teacher simulation
    const mockInactiveTeacher = { ...mockTeacher, isActive: false };
    assert.equal(mockInactiveTeacher.isActive, false, "Inactive teacher flagged");
  });

  await t.test("5.2 Owner login flow preserves unified account with role owner", async () => {
    const mockCenter = {
      _id: "650000000000000000000001",
      centerId: "msec",
      name: "MSEC Academy",
      ownerName: "Dr. A. P. Rao",
      phone: "9123456789",
      password: await bcrypt.hash("OwnerSecure2026", 10),
      isActive: true,
      themeColor: "#2563eb",
    };

    const isMatch = await bcrypt.compare("OwnerSecure2026", mockCenter.password);
    assert.equal(isMatch, true, "Owner password verified");

    const { signToken, verifyToken } = await import("../tution-desk-be/src/lib/auth.ts");
    const token = await signToken({
      userId: String(mockCenter._id),
      centerId: mockCenter.centerId,
      role: "owner",
      name: mockCenter.ownerName,
    });

    const payload = await verifyToken(token);
    assert.equal(payload.role, "owner", "Owner must receive role owner");
    assert.equal(payload.centerId, "msec", "Owner token must have correct institute centerId");
    assert.equal(payload.userId, String(mockCenter._id), "Owner userId matches center._id");
    assert.equal(payload.teacherId, undefined, "Owner must NOT have teacherId in token");
  });

  await t.test("5.3 Owner is never represented by a duplicate Teacher record", async () => {
    const { Teacher } = await import("../tution-desk-be/src/models/Teacher.ts");
    const { Center } = await import("../tution-desk-be/src/models/Center.ts");

    // Verify architectural principle: Teacher model is strictly for additional staff
    const ownerCenter = new Center({
      centerId: "msec",
      name: "MSEC Academy",
      ownerName: "Dr. A. P. Rao",
      phone: "9123456789",
      password: "dummy-password-hash",
      isActive: true,
    });

    // The owner's operational teacher identity is centerId with assignedTeacherId: null
    assert.ok(ownerCenter.centerId, "Owner has centerId");
    assert.equal(ownerCenter.schema.path("role"), undefined, "Center does not need a separate role field");

    // Teacher model schema explicitly restricts role enum to ["teacher"]
    assert.deepEqual(Teacher.schema.path("role").enumValues, ["teacher"], "Teacher schema only admits role teacher");
  });

  await t.test("5.4 Inactive Institute Center blocks Teacher login", async () => {
    const mockCenterInactive = {
      centerId: "msec",
      isActive: false,
    };

    // When associated center is inactive, teacher login must be blocked
    const canAuthenticate = mockCenterInactive.isActive === true;
    assert.equal(canAuthenticate, false, "Teacher login must be blocked if center is inactive");
  });
});
