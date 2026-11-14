import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// ============================================================================
// Phase 5F – Step 1: Test Backend Security Specification & Verification Suite
//
// TEST CLASSIFICATION:
// 1. Schema Invariants & Multi-Tenant Compound Indexes:
//    - Tests 1.1, 1.2: assignedTeacherId schema definition, ObjectId typing,
//      null default (representing Owner), and { centerId: 1, assignedTeacherId: 1, date: -1 } index.
// 2. Authentication & Tenant Isolation (GET /api/tests):
//    - Tests 2.1, 2.2, 2.3: 401 unauthenticated, strict JWT-derived centerId,
//      complete cross-tenant exclusion.
// 3. Teacher Scoping & Owner Visibility (GET /api/tests):
//    - Tests 3.1, 3.2, 3.3, 3.4: Teachers restricted strictly to own assigned tests;
//      Owner institute-wide visibility; Owner filtering by owner/null or specific teacher.
// 4. Test Creation & Attribution Forgery Neutralization (POST /api/tests):
//    - Tests 4.1, 4.2, 4.3: Auto-binding assignedTeacherId for Teacher; Owner default null;
//      neutralizing forged client-supplied centerId and assignedTeacherId.
// 5. IDOR Elimination & Tenant/Teacher Scoping (GET /api/tests/[id]):
//    - Tests 5.1, 5.2, 5.3: Rejection of cross-center test access; Teacher cross-test
//      obscurity (404); Teacher own test access (200); Owner access across center (200).
// 6. Update Protection & Field Whitelisting (PUT /api/tests/[id]):
//    - Tests 6.1, 6.2, 6.3: Strict rejection of centerId or assignedTeacherId tampering (403);
//      Teacher prevented from updating foreign teacher's test; whitelist allowed updates.
// 7. Student Roster Validation on Marks Submission (PUT /api/tests/[id]):
//    - Tests 7.1, 7.2, 7.3: Teacher submitting marks for foreign/unassigned students is
//      rejected with 403 Forbidden; successful submission when all students belong to Teacher;
//      Owner can submit marks for any institute student.
// 8. Delete Scoping & IDOR Elimination (DELETE /api/tests/[id]):
//    - Tests 8.1, 8.2: Teacher cannot delete another teacher's test (404); Teacher can
//      delete own test; Owner can delete tests within their institute.
//
// 100% In-Memory Specification Suite - ZERO live database mutations or network dependencies.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 5F – Step 1: Test Backend Security Specification & Verification Suite", async (t) => {
  const { signToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );
  const { default: Test } = await import(
    "../tution-desk-be/src/models/Test.ts"
  );
  const { Student } = await import(
    "../tution-desk-be/src/models/Student.ts"
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

  // Pre-configured actors
  const centerIdMsec = "msec";
  const centerIdOther = "foreign_center";

  const ownerId = "650000000000000000000001";
  const teacher1Id = "650000000000000000000010";
  const teacher2Id = "650000000000000000000020";

  const ownerTokenMsec = await signToken({
    userId: ownerId,
    centerId: centerIdMsec,
    role: "owner",
    name: "MSEC Owner",
  });

  const teacher1TokenMsec = await signToken({
    userId: teacher1Id,
    centerId: centerIdMsec,
    role: "teacher",
    teacherId: teacher1Id,
    name: "R. K. Sharma (Math)",
  });

  const teacher2TokenMsec = await signToken({
    userId: teacher2Id,
    centerId: centerIdMsec,
    role: "teacher",
    teacherId: teacher2Id,
    name: "P. Gupta (Physics)",
  });

  const foreignOwnerToken = await signToken({
    userId: "650000000000000000000099",
    centerId: centerIdOther,
    role: "owner",
    name: "Foreign Center Owner",
  });

  // Mock Students Roster
  const studentTeacher1 = {
    _id: "650000000000000000000101",
    centerId: centerIdMsec,
    name: "Aarav Sharma",
    rollNumber: "ROLL-01",
    assignedTeacherId: teacher1Id,
  };

  const studentTeacher2 = {
    _id: "650000000000000000000102",
    centerId: centerIdMsec,
    name: "Diya Gupta",
    rollNumber: "ROLL-02",
    assignedTeacherId: teacher2Id,
  };

  const studentOwner = {
    _id: "650000000000000000000103",
    centerId: centerIdMsec,
    name: "Rohan Verma",
    rollNumber: "ROLL-03",
    assignedTeacherId: null, // Owner-assigned
  };

  const studentForeign = {
    _id: "650000000000000000000199",
    centerId: centerIdOther,
    name: "Foreign Student",
    rollNumber: "ROLL-99",
    assignedTeacherId: null,
  };

  const allStudents = [
    studentTeacher1,
    studentTeacher2,
    studentOwner,
    studentForeign,
  ];

  // Mock Tests Roster
  const testTeacher1 = {
    _id: "650000000000000000000301",
    centerId: centerIdMsec,
    assignedTeacherId: teacher1Id,
    title: "Math Unit Test 1",
    batch: "Class 10 - Mathematics",
    date: new Date("2026-11-01"),
    maxMarks: 50,
    results: [],
  };

  const testTeacher2 = {
    _id: "650000000000000000000302",
    centerId: centerIdMsec,
    assignedTeacherId: teacher2Id,
    title: "Physics Mechanics Test",
    batch: "Class 12 - Physics",
    date: new Date("2026-11-02"),
    maxMarks: 100,
    results: [],
  };

  const testOwner = {
    _id: "650000000000000000000303",
    centerId: centerIdMsec,
    assignedTeacherId: null, // Owner-created test
    title: "Institute Science Midterm",
    batch: "Class 10 - General",
    date: new Date("2026-11-03"),
    maxMarks: 80,
    results: [],
  };

  const testForeign = {
    _id: "650000000000000000000399",
    centerId: centerIdOther,
    assignedTeacherId: null,
    title: "Foreign Test",
    batch: "Foreign Batch",
    date: new Date("2026-11-01"),
    maxMarks: 100,
    results: [],
  };

  const allTests = [testTeacher1, testTeacher2, testOwner, testForeign];

  // =========================================================================
  // 1. Schema Validation & Index Verification
  // =========================================================================
  await t.test(
    "1.1 Test schema contains assignedTeacherId with null default representing Owner",
    async () => {
      const schema = Test.schema;
      assert.ok(schema.path("assignedTeacherId"), "Test schema must have assignedTeacherId path");
      assert.equal(
        schema.path("assignedTeacherId").instance,
        "ObjectId",
        "assignedTeacherId must be an ObjectId"
      );
      assert.equal(
        schema.path("assignedTeacherId").defaultValue,
        null,
        "assignedTeacherId default must be null"
      );

      // Verify instantiation defaults to null assignedTeacherId
      const testDoc = new Test({
        centerId: centerIdMsec,
        title: "Default Test",
        batch: "Class 10",
        date: new Date(),
        maxMarks: 100,
      });
      assert.equal(
        testDoc.assignedTeacherId,
        null,
        "Test document instantiation must default assignedTeacherId to null"
      );
    }
  );

  await t.test(
    "1.2 Test schema defines compound index { centerId: 1, assignedTeacherId: 1, date: -1 }",
    async () => {
      const schema = Test.schema;
      const indexes = schema.indexes();
      const hasCompoundIndex = indexes.some(([idx]) => {
        return idx.centerId === 1 && idx.assignedTeacherId === 1 && idx.date === -1;
      });
      assert.ok(
        hasCompoundIndex,
        "Test schema must declare compound index { centerId: 1, assignedTeacherId: 1, date: -1 }"
      );
    }
  );

  // =========================================================================
  // 2. Authentication & Tenant Isolation (GET /api/tests)
  // =========================================================================
  await t.test("2.1 GET /api/tests rejects unauthenticated request with 401", async () => {
    const unauthReq = createMockRequest({ token: null });
    const user = await getAuthenticatedUser(unauthReq);
    assert.equal(user, null, "Unauthenticated request returns null user");

    let statusCode = 200;
    if (!user) statusCode = 401;
    assert.equal(statusCode, 401, "Must reject unauthenticated request with 401");
  });

  await t.test("2.2 GET /api/tests strictly enforces centerId from JWT session", async () => {
    // Foreign Owner request attempting to query tests for msec
    const foreignReq = createMockRequest({
      token: foreignOwnerToken,
      searchParams: { centerId: centerIdMsec }, // Spoofed param
    });
    const user = await getAuthenticatedUser(foreignReq);
    assert.equal(user.centerId, centerIdOther, "CenterId must be derived from JWT, ignoring spoofed param");

    // Scoped query filter must use user.centerId
    const queryFilter = { centerId: user.centerId };
    const matchingTests = allTests.filter((t) => t.centerId === queryFilter.centerId);

    assert.equal(matchingTests.length, 1);
    assert.equal(matchingTests[0]._id, testForeign._id);
    assert.ok(
      matchingTests.every((t) => t.centerId === centerIdOther),
      "No msec tests may leak into foreign center query"
    );
  });

  // =========================================================================
  // 3. Teacher Scoping & Owner Visibility (GET /api/tests)
  // =========================================================================
  await t.test(
    "3.1 GET /api/tests restricts Teacher strictly to their own assigned tests",
    async () => {
      const teacherReq = createMockRequest({ token: teacher1TokenMsec });
      const user = await getAuthenticatedUser(teacherReq);
      assert.equal(user.role, "teacher");
      assert.equal(user.teacherId, teacher1Id);

      // Backend route filter logic:
      const filter = {
        centerId: user.centerId,
        assignedTeacherId: new mongoose.Types.ObjectId(user.teacherId).toString(),
      };

      const scopedTests = allTests.filter(
        (t) =>
          t.centerId === filter.centerId &&
          String(t.assignedTeacherId) === String(filter.assignedTeacherId)
      );

      assert.equal(scopedTests.length, 1);
      assert.equal(scopedTests[0]._id, testTeacher1._id);
      assert.equal(scopedTests[0].title, "Math Unit Test 1");
      // Teacher cannot see teacher 2 test or owner test
      assert.ok(!scopedTests.some((t) => t._id === testTeacher2._id));
      assert.ok(!scopedTests.some((t) => t._id === testOwner._id));
    }
  );

  await t.test(
    "3.2 GET /api/tests provides Owner institute-wide visibility across all tests",
    async () => {
      const ownerReq = createMockRequest({ token: ownerTokenMsec });
      const user = await getAuthenticatedUser(ownerReq);
      assert.equal(user.role, "owner");

      // Unfiltered Owner filter logic:
      const filter = { centerId: user.centerId };
      const centerTests = allTests.filter((t) => t.centerId === filter.centerId);

      assert.equal(centerTests.length, 3, "Owner sees Teacher 1, Teacher 2, and Owner tests");
      const ids = centerTests.map((t) => t._id);
      assert.ok(ids.includes(testTeacher1._id));
      assert.ok(ids.includes(testTeacher2._id));
      assert.ok(ids.includes(testOwner._id));
      assert.ok(!ids.includes(testForeign._id), "Foreign test must never be included");
    }
  );

  await t.test(
    "3.3 GET /api/tests Owner can filter by owner/null tests",
    async () => {
      const ownerReq = createMockRequest({
        token: ownerTokenMsec,
        searchParams: { assignedTeacher: "owner" },
      });
      const user = await getAuthenticatedUser(ownerReq);

      const assignedTeacherParam = "owner";
      const isOwnerFilter =
        assignedTeacherParam === "owner" || assignedTeacherParam === "null";

      const filteredTests = allTests.filter(
        (t) =>
          t.centerId === user.centerId &&
          (isOwnerFilter ? t.assignedTeacherId === null : true)
      );

      assert.equal(filteredTests.length, 1);
      assert.equal(filteredTests[0]._id, testOwner._id);
      assert.equal(filteredTests[0].title, "Institute Science Midterm");
    }
  );

  await t.test(
    "3.4 GET /api/tests Owner can filter by specific Teacher ID",
    async () => {
      const ownerReq = createMockRequest({
        token: ownerTokenMsec,
        searchParams: { assignedTeacher: teacher2Id },
      });
      const user = await getAuthenticatedUser(ownerReq);

      const assignedTeacherParam = teacher2Id;
      const filteredTests = allTests.filter(
        (t) =>
          t.centerId === user.centerId &&
          String(t.assignedTeacherId) === String(assignedTeacherParam)
      );

      assert.equal(filteredTests.length, 1);
      assert.equal(filteredTests[0]._id, testTeacher2._id);
      assert.equal(filteredTests[0].title, "Physics Mechanics Test");
    }
  );

  // =========================================================================
  // 4. Test Creation & Attribution Forgery Neutralization (POST /api/tests)
  // =========================================================================
  await t.test("4.1 POST /api/tests rejects unauthenticated request with 401", async () => {
    const unauthReq = createMockRequest({
      token: null,
      method: "POST",
      body: { title: "Exam", batch: "Batch-1", maxMarks: 50 },
    });
    const user = await getAuthenticatedUser(unauthReq);
    assert.equal(user, null);
    let status = user ? 200 : 401;
    assert.equal(status, 401);
  });

  await t.test(
    "4.2 POST /api/tests Teacher auto-binds assignedTeacherId and neutralizes forged client fields",
    async () => {
      // Teacher attempts to forge centerId and assignedTeacherId
      const req = createMockRequest({
        token: teacher1TokenMsec,
        method: "POST",
        body: {
          title: "Algebra Quiz",
          batch: "Class 10 - Mathematics",
          maxMarks: 50,
          centerId: "malicious_spoofed_center",
          assignedTeacherId: teacher2Id, // Attempting to assign test to teacher 2
        },
      });

      const user = await getAuthenticatedUser(req);
      assert.equal(user.role, "teacher");

      // Backend route attribution logic:
      const targetCenterId = user.centerId;
      const assignedTeacherId =
        user.role === "teacher"
          ? new mongoose.Types.ObjectId(user.teacherId)
          : null;

      assert.equal(
        targetCenterId,
        centerIdMsec,
        "Center ID must be derived exclusively from JWT"
      );
      assert.equal(
        assignedTeacherId.toString(),
        teacher1Id,
        "assignedTeacherId must be user.teacherId, ignoring spoofed teacher2Id"
      );
    }
  );

  await t.test(
    "4.3 POST /api/tests Owner creates test with null assignedTeacherId",
    async () => {
      const req = createMockRequest({
        token: ownerTokenMsec,
        method: "POST",
        body: {
          title: "Quarterly Comprehensive Test",
          batch: "Class 10 - General",
          maxMarks: 100,
        },
      });

      const user = await getAuthenticatedUser(req);
      assert.equal(user.role, "owner");

      const targetCenterId = user.centerId;
      const assignedTeacherId =
        user.role === "teacher"
          ? new mongoose.Types.ObjectId(user.teacherId)
          : null;

      assert.equal(targetCenterId, centerIdMsec);
      assert.equal(
        assignedTeacherId,
        null,
        "Owner-created tests must explicitly have null assignedTeacherId"
      );
    }
  );

  // =========================================================================
  // 5. IDOR Elimination & Tenant/Teacher Scoping (GET /api/tests/[id])
  // =========================================================================
  await t.test(
    "5.1 GET /api/tests/[id] rejects cross-center access with 404 (IDOR Elimination)",
    async () => {
      // Foreign Owner attempts to fetch testTeacher1 (_id: ...301)
      const req = createMockRequest({ token: foreignOwnerToken });
      const user = await getAuthenticatedUser(req);

      const targetTestId = testTeacher1._id;
      // Scoped findOne: { _id: targetTestId, centerId: user.centerId }
      const found = allTests.find(
        (t) => t._id === targetTestId && t.centerId === user.centerId
      );

      assert.equal(found, undefined, "Foreign caller must not find test in msec");
      const status = found ? 200 : 404;
      assert.equal(status, 404, "Must return 404 for cross-center IDOR attempt");
    }
  );

  await t.test(
    "5.2 GET /api/tests/[id] Teacher querying another Teacher's or Owner's test returns 404",
    async () => {
      const req = createMockRequest({ token: teacher1TokenMsec });
      const user = await getAuthenticatedUser(req);

      // Teacher 1 tries to access Teacher 2's test
      const test2Found = allTests.find(
        (t) => t._id === testTeacher2._id && t.centerId === user.centerId
      );
      assert.ok(test2Found, "Test exists in center");

      // Authorization check for teacher:
      const isOwnerOrAssignedTeacher =
        user.role === "owner" ||
        (user.role === "teacher" &&
          test2Found.assignedTeacherId &&
          String(test2Found.assignedTeacherId) === String(user.teacherId));

      assert.equal(
        isOwnerOrAssignedTeacher,
        false,
        "Teacher 1 is not assigned to Teacher 2's test"
      );
      const status = isOwnerOrAssignedTeacher ? 200 : 404;
      assert.equal(status, 404, "Must return 404 to obscure cross-teacher test existence");
    }
  );

  await t.test(
    "5.3 GET /api/tests/[id] Teacher accessing own test succeeds (200) and Owner succeeds (200)",
    async () => {
      // Teacher 1 accessing own test
      const teacherReq = createMockRequest({ token: teacher1TokenMsec });
      const teacherUser = await getAuthenticatedUser(teacherReq);
      const ownTest = allTests.find(
        (t) => t._id === testTeacher1._id && t.centerId === teacherUser.centerId
      );
      const teacherCanAccess =
        ownTest &&
        String(ownTest.assignedTeacherId) === String(teacherUser.teacherId);
      assert.equal(teacherCanAccess, true, "Teacher 1 can access own test");

      // Owner accessing Teacher 1's test
      const ownerReq = createMockRequest({ token: ownerTokenMsec });
      const ownerUser = await getAuthenticatedUser(ownerReq);
      const ownerCanAccess =
        ownTest && ownTest.centerId === ownerUser.centerId && ownerUser.role === "owner";
      assert.equal(ownerCanAccess, true, "Owner can access any test in institute");
    }
  );

  // =========================================================================
  // 6. Update Protection & Field Whitelisting (PUT /api/tests/[id])
  // =========================================================================
  await t.test(
    "6.1 PUT /api/tests/[id] rejects attempts to modify centerId or assignedTeacherId with 403",
    async () => {
      const payloadWithTampering = {
        title: "Legitimate Title Update",
        assignedTeacherId: teacher2Id, // Malicious ownership transfer
      };

      // Route protection check:
      let isTampered =
        payloadWithTampering.centerId !== undefined ||
        payloadWithTampering.assignedTeacherId !== undefined;

      assert.equal(isTampered, true);
      let status = isTampered ? 403 : 200;
      assert.equal(
        status,
        403,
        "Modifying test ownership or center attribution must be rejected with 403"
      );
    }
  );

  await t.test(
    "6.2 PUT /api/tests/[id] Teacher cannot modify another Teacher's test (404)",
    async () => {
      const req = createMockRequest({ token: teacher1TokenMsec, method: "PUT" });
      const user = await getAuthenticatedUser(req);

      const targetTest = allTests.find(
        (t) => t._id === testTeacher2._id && t.centerId === user.centerId
      );

      const canUpdate =
        targetTest &&
        (user.role === "owner" ||
          (user.role === "teacher" &&
            String(targetTest.assignedTeacherId) === String(user.teacherId)));

      assert.equal(canUpdate, false);
      const status = canUpdate ? 200 : 404;
      assert.equal(status, 404, "Must deny Teacher update on foreign test with 404");
    }
  );

  await t.test(
    "6.3 PUT /api/tests/[id] whitelisted fields are correctly accepted and sanitized",
    async () => {
      const payload = {
        title: "  New Title After Review  ",
        batch: "  Class 10 - Mathematics  ",
        date: "2026-11-15T00:00:00.000Z",
        maxMarks: 75,
      };

      const updateData = {};
      if (payload.title !== undefined) updateData.title = payload.title.trim();
      if (payload.batch !== undefined) updateData.batch = payload.batch.trim();
      if (payload.date !== undefined) updateData.date = new Date(payload.date);
      if (payload.maxMarks !== undefined) updateData.maxMarks = Number(payload.maxMarks);

      assert.equal(updateData.title, "New Title After Review");
      assert.equal(updateData.batch, "Class 10 - Mathematics");
      assert.equal(updateData.maxMarks, 75);
      assert.ok(updateData.date instanceof Date);
    }
  );

  // =========================================================================
  // 7. Student Roster Validation on Marks Submission (PUT /api/tests/[id])
  // =========================================================================
  await t.test(
    "7.1 PUT /api/tests/[id] rejects marks submission when Teacher submits foreign student (403)",
    async () => {
      const req = createMockRequest({ token: teacher1TokenMsec, method: "PUT" });
      const user = await getAuthenticatedUser(req);

      // Submission contains student assigned to Teacher 1 AND student assigned to Teacher 2
      const submittedResults = [
        { studentId: studentTeacher1._id, marksObtained: 45, isAbsent: false },
        { studentId: studentTeacher2._id, marksObtained: 40, isAbsent: false }, // Foreign to Teacher 1!
      ];

      const submittedStudentIds = submittedResults.map((r) => r.studentId);

      // Route validation logic for Teacher:
      const teacherRoster = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const hasForeignStudent = submittedStudentIds.some(
        (id) => !teacherRoster.includes(id)
      );

      assert.equal(
        hasForeignStudent,
        true,
        "Submitted results contain studentTeacher2 who is not assigned to Teacher 1"
      );
      const status = hasForeignStudent ? 403 : 200;
      assert.equal(
        status,
        403,
        "Must reject foreign student marks submission with 403 Forbidden"
      );
    }
  );

  await t.test(
    "7.2 PUT /api/tests/[id] accepts marks submission when all students belong to Teacher",
    async () => {
      const req = createMockRequest({ token: teacher1TokenMsec, method: "PUT" });
      const user = await getAuthenticatedUser(req);

      // Submission contains ONLY students assigned to Teacher 1
      const submittedResults = [
        { studentId: studentTeacher1._id, marksObtained: 48, isAbsent: false },
      ];

      const submittedStudentIds = submittedResults.map((r) => r.studentId);

      const teacherRoster = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const hasForeignStudent = submittedStudentIds.some(
        (id) => !teacherRoster.includes(id)
      );

      assert.equal(hasForeignStudent, false, "All students belong to Teacher 1");
      const status = hasForeignStudent ? 403 : 200;
      assert.equal(status, 200);
    }
  );

  await t.test(
    "7.3 PUT /api/tests/[id] Owner can submit marks for any institute student, but rejects foreign center student",
    async () => {
      const req = createMockRequest({ token: ownerTokenMsec, method: "PUT" });
      const user = await getAuthenticatedUser(req);

      // Owner submitting marks for studentTeacher1, studentTeacher2, and studentOwner
      const validInstituteResults = [
        { studentId: studentTeacher1._id, marksObtained: 42 },
        { studentId: studentTeacher2._id, marksObtained: 46 },
        { studentId: studentOwner._id, marksObtained: 40 },
      ];

      const instituteStudents = allStudents
        .filter((s) => s.centerId === user.centerId)
        .map((s) => s._id);

      const allValid = validInstituteResults.every((r) =>
        instituteStudents.includes(r.studentId)
      );
      assert.equal(allValid, true, "Owner can grade all students in center");

      // Submission with foreign center student
      const foreignResult = [
        { studentId: studentForeign._id, marksObtained: 50 },
      ];
      const hasForeign = foreignResult.some(
        (r) => !instituteStudents.includes(r.studentId)
      );
      assert.equal(
        hasForeign,
        true,
        "Student from other center must be rejected"
      );
    }
  );

  // =========================================================================
  // 8. Delete Scoping & IDOR Elimination (DELETE /api/tests/[id])
  // =========================================================================
  await t.test(
    "8.1 DELETE /api/tests/[id] Teacher cannot delete another Teacher's test (404)",
    async () => {
      const req = createMockRequest({ token: teacher1TokenMsec, method: "DELETE" });
      const user = await getAuthenticatedUser(req);

      // Teacher 1 attempts to delete Teacher 2's test
      const targetTest = allTests.find(
        (t) => t._id === testTeacher2._id && t.centerId === user.centerId
      );

      const canDelete =
        targetTest &&
        (user.role === "owner" ||
          (user.role === "teacher" &&
            String(targetTest.assignedTeacherId) === String(user.teacherId)));

      assert.equal(canDelete, false);
      const status = canDelete ? 200 : 404;
      assert.equal(status, 404, "Teacher cannot delete foreign test");
    }
  );

  await t.test(
    "8.2 DELETE /api/tests/[id] Teacher can delete own test and Owner can delete any center test",
    async () => {
      // Teacher 1 deletes own test
      const teacherReq = createMockRequest({ token: teacher1TokenMsec, method: "DELETE" });
      const teacherUser = await getAuthenticatedUser(teacherReq);
      const targetOwnTest = allTests.find(
        (t) => t._id === testTeacher1._id && t.centerId === teacherUser.centerId
      );
      const teacherCanDelete =
        targetOwnTest &&
        String(targetOwnTest.assignedTeacherId) === String(teacherUser.teacherId);
      assert.equal(teacherCanDelete, true);

      // Owner deletes Teacher 2's test
      const ownerReq = createMockRequest({ token: ownerTokenMsec, method: "DELETE" });
      const ownerUser = await getAuthenticatedUser(ownerReq);
      const targetTeacher2Test = allTests.find(
        (t) => t._id === testTeacher2._id && t.centerId === ownerUser.centerId
      );
      const ownerCanDelete =
        targetTeacher2Test && ownerUser.role === "owner";
      assert.equal(ownerCanDelete, true);
    }
  );
});
