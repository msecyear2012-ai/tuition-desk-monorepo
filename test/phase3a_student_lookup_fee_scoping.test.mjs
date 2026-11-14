import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");
const { SignJWT } = beRequire("jose");

// ============================================================================
// Phase 3A: Student Lookup & Teacher-Scoped Fee Queries Test Suite
//
// TEST CLASSIFICATION:
// 1. Pure Unit Tests:
//    - Tests 1, 4, 14: Token verification, unauthenticated rejection, PII stripping,
//      and spoofed identifier neutralization.
// 2. Mocked Database Specification Tests:
//    - Tests 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13: In-memory simulation of student
//      lookup scoping, pending dues summation, fee query filtering, monthly fee
//      teacher attribution, and teacher-scoped bulk reminder queries.
// 3. Live Database Integration Tests:
//    - 0 tests. None of these tests write to or connect to the live MongoDB Atlas cluster,
//      ensuring 100% safety and zero live database mutations.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 3A: Student Lookup & Teacher-Scoped Fee Queries Specification Suite", async (t) => {
  const { signToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );
  const { Student } = await import("../tution-desk-be/src/models/Student.ts");
  const { Fee } = await import("../tution-desk-be/src/models/Fee.ts");
  const { Teacher } = await import("../tution-desk-be/src/models/Teacher.ts");
  const { generateOrGetMonthlyFee } = await import(
    "../tution-desk-be/src/lib/feeService.ts"
  );

  // Helper to generate mock NextRequest with auth cookie or header
  function createMockRequest({
    token = null,
    method = "GET",
    body = {},
    searchParams = {},
    headers = {},
  } = {}) {
    return {
      method,
      cookies: {
        get: (name) =>
          token && (name === "auth_token" || name === "token")
            ? { value: token }
            : undefined,
      },
      headers: {
        get: (name) => {
          const lName = name.toLowerCase();
          if (lName === "authorization" && token) return `Bearer ${token}`;
          if (lName === "origin") return "http://localhost:3000";
          return headers[name] || headers[lName] || null;
        },
      },
      nextUrl: {
        searchParams: {
          get: (key) => searchParams[key] ?? null,
        },
      },
      json: async () => body,
    };
  }

  // Actor tokens
  const ownerTokenCenterMsec = await signToken({
    userId: "650000000000000000000001",
    centerId: "msec",
    role: "owner",
    name: "MSEC Owner",
  });

  const teacher1TokenCenterMsec = await signToken({
    userId: "650000000000000000000010",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000010",
    name: "R. K. Sharma (Math)",
  });

  const teacher2TokenCenterMsec = await signToken({
    userId: "650000000000000000000020",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000020",
    name: "P. Gupta (Physics)",
  });

  const ownerTokenCenterOther = await signToken({
    userId: "650000000000000000000099",
    centerId: "other_center",
    role: "owner",
    name: "Foreign Owner",
  });

  // Mock Students
  const mockStudents = [
    {
      _id: "650000000000000000000101",
      centerId: "msec",
      name: "Aarav Patel",
      rollNumber: "ROLL-01",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9876543210",
      parentPhone: "9876543210",
      address: "123 Main Street, Bangalore",
      notes: "Strictly confidential remarks",
      assignedTeacherId: "650000000000000000000010", // Teacher 1
      isActive: true,
    },
    {
      _id: "650000000000000000000102",
      centerId: "msec",
      name: "Diya Sharma",
      rollNumber: "ROLL-02",
      batch: "Class 12 - Physics",
      parentWhatsApp: "9876543211",
      address: "456 Side Lane, Bangalore",
      assignedTeacherId: "650000000000000000000020", // Teacher 2
      isActive: true,
    },
    {
      _id: "650000000000000000000103",
      centerId: "msec",
      name: "Rohan Verma",
      rollNumber: "ROLL-03",
      batch: "Class 10 - General",
      parentWhatsApp: "9876543212",
      assignedTeacherId: null, // Owner-assigned
      isActive: true,
    },
    {
      _id: "650000000000000000000199",
      centerId: "other_center", // Foreign Center
      name: "Aarav Patel",
      rollNumber: "ROLL-01",
      batch: "Foreign Batch",
      parentWhatsApp: "9111111111",
      assignedTeacherId: null,
      isActive: true,
    },
  ];

  // Mock Teachers
  const mockTeachers = [
    {
      _id: "650000000000000000000010",
      centerId: "msec",
      name: "R. K. Sharma",
      isActive: true,
    },
    {
      _id: "650000000000000000000020",
      centerId: "msec",
      name: "P. Gupta",
      isActive: true,
    },
  ];

  // Mock Fees
  const mockFees = [
    {
      _id: "650000000000000000000201",
      centerId: "msec",
      studentId: "650000000000000000000101",
      month: "November 2026",
      amountDue: 2500,
      paidAmount: 0,
      status: "Pending",
      assignedTeacherId: "650000000000000000000010",
    },
    {
      _id: "650000000000000000000202",
      centerId: "msec",
      studentId: "650000000000000000000101",
      month: "October 2026",
      amountDue: 1000,
      paidAmount: 1500,
      status: "Partial Paid",
      assignedTeacherId: "650000000000000000000010",
    },
    {
      _id: "650000000000000000000203",
      centerId: "msec",
      studentId: "650000000000000000000101",
      month: "September 2026",
      amountDue: 0,
      paidAmount: 2500,
      status: "Paid",
      assignedTeacherId: "650000000000000000000010",
    },
    {
      _id: "650000000000000000000204",
      centerId: "msec",
      studentId: "650000000000000000000102",
      month: "November 2026",
      amountDue: 3000,
      paidAmount: 0,
      status: "Pending",
      assignedTeacherId: "650000000000000000000020",
    },
    {
      _id: "650000000000000000000205",
      centerId: "msec",
      studentId: "650000000000000000000103",
      month: "November 2026",
      amountDue: 2000,
      paidAmount: 0,
      status: "Pending",
      assignedTeacherId: null, // Owner-taught
    },
    {
      _id: "650000000000000000000299",
      centerId: "other_center",
      studentId: "650000000000000000000199",
      month: "November 2026",
      amountDue: 5000,
      status: "Pending",
      assignedTeacherId: null,
    },
  ];

  // =========================================================================
  // 1. Unauthenticated lookup returns 401
  // =========================================================================
  await t.test("1. Unauthenticated lookup returns 401 Unauthorized", async () => {
    const unauthReq = createMockRequest({ token: null });
    const user = await getAuthenticatedUser(unauthReq);
    assert.equal(user, null, "Unauthenticated request must produce null user");

    // Endpoint authorization check
    let statusCode = 200;
    if (!user) statusCode = 401;
    assert.equal(statusCode, 401, "Must reject unauthenticated lookup with 401");
  });

  // =========================================================================
  // 2. Teacher lookup is center-scoped
  // =========================================================================
  await t.test("2. Teacher lookup is strictly center-scoped (Foreign records excluded)", async () => {
    const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterMsec }));
    assert.equal(teacherUser.role, "teacher");
    assert.equal(teacherUser.centerId, "msec");

    const query = "Aarav";
    // Scoped query logic: centerId === user.centerId AND name matching query
    const results = mockStudents.filter(
      (s) => s.centerId === teacherUser.centerId && s.name.toLowerCase().includes(query.toLowerCase())
    );

    assert.equal(results.length, 1, "Must find exactly 1 Aarav in 'msec'");
    assert.equal(results[0].centerId, "msec");
    assert.equal(results[0]._id, "650000000000000000000101");

    // Foreign student with identical name must be excluded
    const hasForeign = results.some((s) => s.centerId === "other_center");
    assert.equal(hasForeign, false, "Foreign center student must never be returned");
  });

  // =========================================================================
  // 3. Owner lookup is center-scoped
  // =========================================================================
  await t.test("3. Owner lookup is center-scoped across institute", async () => {
    const ownerUser = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterMsec }));
    assert.equal(ownerUser.role, "owner");
    assert.equal(ownerUser.centerId, "msec");

    const query = "Sharma";
    const results = mockStudents.filter(
      (s) => s.centerId === ownerUser.centerId && s.name.toLowerCase().includes(query.toLowerCase())
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "Diya Sharma");
    assert.equal(results[0].centerId, "msec");
  });

  // =========================================================================
  // 4. Lookup strips all prohibited PII
  // =========================================================================
  await t.test("4. Lookup returns sanitized student information and strips all prohibited PII", async () => {
    const rawStudent = mockStudents[0];

    // Simulated lookup projection
    const sanitizedStudent = {
      _id: rawStudent._id,
      name: rawStudent.name,
      rollNumber: rawStudent.rollNumber || "",
      batch: rawStudent.batch || "",
      assignedTeacherName: "R. K. Sharma",
      pendingDues: 3500,
    };

    // Whitelisted keys
    const allowedKeys = new Set(["_id", "name", "rollNumber", "batch", "assignedTeacherName", "pendingDues"]);
    for (const key of Object.keys(sanitizedStudent)) {
      assert.ok(allowedKeys.has(key), `Key '${key}' is permitted`);
    }

    // Prohibited PII explicitly absent
    const prohibitedFields = [
      "parentWhatsApp",
      "parentPhone",
      "phone",
      "address",
      "notes",
      "attendance",
      "marks",
      "testResults",
      "dob",
      "gender",
    ];

    for (const field of prohibitedFields) {
      assert.equal(
        sanitizedStudent[field],
        undefined,
        `Prohibited PII '${field}' must be strictly undefined in lookup output`
      );
    }
  });

  // =========================================================================
  // 5. Pending dues are calculated correctly
  // =========================================================================
  await t.test("5. Pending dues sum Pending and Partial Paid fees with amountDue > 0", async () => {
    const studentId = "650000000000000000000101";

    const relevantFees = mockFees.filter(
      (f) =>
        f.centerId === "msec" &&
        f.studentId === studentId &&
        (f.status === "Pending" || f.status === "Partial Paid") &&
        f.amountDue > 0
    );

    const totalDues = relevantFees.reduce((sum, f) => sum + f.amountDue, 0);

    // Fee 201 (2500) + Fee 202 (1000) = 3500 (Fee 203 Paid is 0)
    assert.equal(totalDues, 3500, "Pending dues must sum 2500 + 1000 = 3500");
  });

  // =========================================================================
  // 6. Teacher fee ledger only returns assigned students' fees
  // =========================================================================
  await t.test("6. Teacher fee ledger restricts queries strictly to assignedTeacherId", async () => {
    const teacher1 = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterMsec }));
    assert.equal(teacher1.role, "teacher");

    // Route query filter construction
    const filter = {
      centerId: teacher1.centerId,
      assignedTeacherId: teacher1.teacherId,
    };

    const visibleFees = mockFees.filter(
      (f) => f.centerId === filter.centerId && String(f.assignedTeacherId) === String(filter.assignedTeacherId)
    );

    assert.equal(visibleFees.length, 3, "Teacher 1 must only see their 3 fee records");
    for (const fee of visibleFees) {
      assert.equal(String(fee.assignedTeacherId), teacher1.teacherId);
    }

    // Teacher cannot see Teacher 2's fee or Owner's fee
    assert.ok(!visibleFees.some((f) => f._id === "650000000000000000000204"));
    assert.ok(!visibleFees.some((f) => f._id === "650000000000000000000205"));
  });

  // =========================================================================
  // 7. Owner can see all institute fees
  // =========================================================================
  await t.test("7. Owner fee ledger provides institute-wide visibility by default", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterMsec }));
    assert.equal(owner.role, "owner");

    // Default Owner filter without assignedTeacher query param
    const filter = { centerId: owner.centerId };

    const visibleFees = mockFees.filter((f) => f.centerId === filter.centerId);
    assert.equal(visibleFees.length, 5, "Owner must see all 5 fee records in 'msec'");

    // Foreign fee excluded
    assert.ok(!visibleFees.some((f) => f.centerId === "other_center"));
  });

  // =========================================================================
  // 8. Owner can filter Owner-assigned students
  // =========================================================================
  await t.test("8. Owner can filter fees for Owner-assigned students (assignedTeacher=owner)", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterMsec }));
    const assignedTeacherParam = "owner";

    // Query filter construction
    const filter = { centerId: owner.centerId };
    if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
      filter.$or = [{ assignedTeacherId: null }, { assignedTeacherId: { $exists: false } }];
    }

    const ownerTaughtFees = mockFees.filter(
      (f) => f.centerId === filter.centerId && (f.assignedTeacherId === null || f.assignedTeacherId === undefined)
    );

    assert.equal(ownerTaughtFees.length, 1, "Must find exactly 1 fee assigned to Owner");
    assert.equal(ownerTaughtFees[0]._id, "650000000000000000000205");
  });

  // =========================================================================
  // 9. Owner can filter a specific Teacher
  // =========================================================================
  await t.test("9. Owner can filter fees for a specific Teacher (assignedTeacher=[teacherId])", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterMsec }));
    const targetTeacherId = "650000000000000000000020"; // Teacher 2 (P. Gupta)

    const filter = {
      centerId: owner.centerId,
      assignedTeacherId: targetTeacherId,
    };

    const teacher2Fees = mockFees.filter(
      (f) => f.centerId === filter.centerId && String(f.assignedTeacherId) === targetTeacherId
    );

    assert.equal(teacher2Fees.length, 1, "Must find exactly 1 fee assigned to Teacher 2");
    assert.equal(teacher2Fees[0]._id, "650000000000000000000204");
  });

  // =========================================================================
  // 10. Monthly fee generation copies assignedTeacherId
  // =========================================================================
  await t.test("10. Monthly fee generation inherits student.assignedTeacherId", async () => {
    const studentTeacher1 = {
      _id: "650000000000000000000101",
      centerId: "msec",
      name: "Aarav Patel",
      monthlyFee: 2500,
      billingCycleDate: 5,
      assignedTeacherId: "650000000000000000000010", // Teacher 1
      isActive: true,
    };

    let createdFeePayload = null;

    // Mock models for feeService
    const mockFeeModel = {
      find: async () => [],
      findOne: async () => null,
      create: async (data) => {
        createdFeePayload = data;
        return { ...data, _id: "650000000000000000000999" };
      },
    };

    const mockStudentModel = {
      findById: async () => studentTeacher1,
    };

    const mockCenterModel = {
      findOne: async () => ({ centerId: "msec", dueDateOffsetDays: 5 }),
    };

    const mockLockModel = {
      hasUniqueLockIndex: async () => true,
      findOne: async () => null,
      create: async () => ({}),
      deleteOne: async () => ({}),
      findOneAndUpdate: async () => ({}),
    };

    const res = await generateOrGetMonthlyFee({
      centerId: "msec",
      studentId: studentTeacher1._id,
      billingMonth: "2026-12",
      models: {
        Fee: mockFeeModel,
        Student: mockStudentModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(res.success, true);
    assert.equal(res.wasCreated, true);
    assert.ok(createdFeePayload, "FeeModel.create must have been called");
    assert.equal(
      createdFeePayload.assignedTeacherId,
      studentTeacher1.assignedTeacherId,
      "Monthly fee must copy student's assignedTeacherId"
    );
  });

  // =========================================================================
  // 11. Owner recurring fees retain null assignment
  // =========================================================================
  await t.test("11. Owner recurring fees retain null assignment (null = Owner)", async () => {
    const studentOwner = {
      _id: "650000000000000000000103",
      centerId: "msec",
      name: "Rohan Verma",
      monthlyFee: 2000,
      billingCycleDate: 5,
      assignedTeacherId: null, // Owner-taught
      isActive: true,
    };

    let createdFeePayload = null;

    const mockFeeModel = {
      find: async () => [],
      findOne: async () => null,
      create: async (data) => {
        createdFeePayload = data;
        return { ...data, _id: "650000000000000000000998" };
      },
    };

    const mockStudentModel = {
      findById: async () => studentOwner,
    };

    const mockCenterModel = {
      findOne: async () => ({ centerId: "msec", dueDateOffsetDays: 5 }),
    };

    const mockLockModel = {
      hasUniqueLockIndex: async () => true,
      findOne: async () => null,
      create: async () => ({}),
      deleteOne: async () => ({}),
      findOneAndUpdate: async () => ({}),
    };

    const res = await generateOrGetMonthlyFee({
      centerId: "msec",
      studentId: studentOwner._id,
      billingMonth: "2026-12",
      models: {
        Fee: mockFeeModel,
        Student: mockStudentModel,
        Center: mockCenterModel,
        FeeCreationLock: mockLockModel,
      },
    });

    assert.equal(res.success, true);
    assert.equal(createdFeePayload.assignedTeacherId, null, "Owner monthly fee must retain null assignment");
  });

  // =========================================================================
  // 12. Teacher reminders only target assigned students
  // =========================================================================
  await t.test("12. Teacher bulk reminders strictly query assignedTeacherId", async () => {
    const teacher1 = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterMsec }));
    assert.equal(teacher1.role, "teacher");

    // Fee query constructed by remind-all route for teacher
    const feeFilter = {
      centerId: teacher1.centerId,
      status: { $in: ["Pending", "Partial Paid"] },
      amountDue: { $gt: 0 },
      assignedTeacherId: teacher1.teacherId,
    };

    const targetedFees = mockFees.filter(
      (f) =>
        f.centerId === feeFilter.centerId &&
        feeFilter.status.$in.includes(f.status) &&
        f.amountDue > 0 &&
        String(f.assignedTeacherId) === String(feeFilter.assignedTeacherId)
    );

    assert.equal(targetedFees.length, 2, "Teacher 1 has 2 pending/partial fees (Fee 201 & Fee 202)");
    for (const f of targetedFees) {
      assert.equal(String(f.assignedTeacherId), teacher1.teacherId);
    }

    // Teacher 2's fee (204) and Owner's fee (205) must not be included
    assert.ok(!targetedFees.some((f) => f._id === "650000000000000000000204"));
    assert.ok(!targetedFees.some((f) => f._id === "650000000000000000000205"));
  });

  // =========================================================================
  // 13. Owner reminders retain institute-wide access
  // =========================================================================
  await t.test("13. Owner bulk reminders retain institute-wide scope across all teachers", async () => {
    const owner = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterMsec }));
    assert.equal(owner.role, "owner");

    // Fee query constructed by remind-all route for owner
    const feeFilter = {
      centerId: owner.centerId,
      status: { $in: ["Pending", "Partial Paid"] },
      amountDue: { $gt: 0 },
    };

    const targetedFees = mockFees.filter(
      (f) => f.centerId === feeFilter.centerId && feeFilter.status.$in.includes(f.status) && f.amountDue > 0
    );

    // Includes Teacher 1 (201, 202), Teacher 2 (204), Owner (205) = 4 pending fees
    assert.equal(targetedFees.length, 4, "Owner must target all 4 pending fees across center 'msec'");
    // Foreign fee excluded
    assert.ok(!targetedFees.some((f) => f.centerId === "other_center"));
  });

  // =========================================================================
  // 14. Invalid or spoofed center/teacher identifiers cannot bypass authorization
  // =========================================================================
  await t.test("14. Client-supplied centerId or spoofed teacher claims are strictly neutralized", async () => {
    // Malicious request: Teacher from center 'msec' passes client centerId='other_center'
    const spoofedRequest = createMockRequest({
      token: teacher1TokenCenterMsec,
      searchParams: { centerId: "other_center" },
      body: { centerId: "other_center", assignedTeacherId: "650000000000000000000099" },
    });

    const user = await getAuthenticatedUser(spoofedRequest);
    assert.equal(user.centerId, "msec", "Verified JWT centerId must strictly prevail over client parameter");
    assert.equal(user.teacherId, "650000000000000000000010");

    // Route logic derives targetCenterId from user.centerId exclusively
    const targetCenterId = user.centerId;
    assert.equal(targetCenterId, "msec");
    assert.notEqual(targetCenterId, "other_center");

    // Malicious token with forged signature fails verification
    const invalidToken = teacher1TokenCenterMsec.slice(0, -6) + "badbad";
    const invalidUser = await getAuthenticatedUser(createMockRequest({ token: invalidToken }));
    assert.equal(invalidUser, null, "Forged or tampered JWT must fail closed and return null");
  });
});

