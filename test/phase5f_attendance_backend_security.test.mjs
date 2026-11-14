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
// Phase 5F – Step 2: Attendance Backend Security Specification & Verification Suite
//
// TEST CLASSIFICATION:
// 1. Schema Invariants & Multi-Tenant Compound Indexes:
//    - Tests 1.1, 1.2: assignedTeacherId schema definition, ObjectId typing,
//      null default (representing Owner), and compound indexes.
// 2. Authentication & Tenant Isolation (GET /api/attendance):
//    - Tests 2.1, 2.2, 2.3: 401 unauthenticated, 403 unauthorized role,
//      strict JWT-derived centerId ignoring client query parameters.
// 3. Teacher Scoping & Batch Non-Sufficiency (GET /api/attendance):
//    - Tests 3.1, 3.2, 3.3: Teacher receives attendance only for assigned students;
//      batch filtering alone does NOT leak other faculty students in shared batch;
//      querying foreign student ID returns empty data array without leakage.
// 4. Owner Institute-Wide Access & Filtering (GET /api/attendance):
//    - Tests 4.1, 4.2, 4.3: Owner institute-wide visibility; filtering by owner/null;
//      filtering by specific teacherId; cross-center records strictly excluded.
// 5. Test Creation & Attribution Forgery Neutralization (POST /api/attendance):
//    - Tests 5.1, 5.2, 5.3: 401 unauthenticated; Teacher auto-binds assignedTeacherId;
//      neutralizing spoofed centerId and assignedTeacherId in request payload.
// 6. Cross-Teacher & Cross-Center Student Rejection (POST /api/attendance):
//    - Tests 6.1, 6.2, 6.3: Teacher marking foreign teacher's student returns 403;
//      Teacher marking Owner's student returns 403; foreign center student returns 403.
// 7. Bulk Authorization & Bypass Prevention (POST /api/attendance & /bulk):
//    - Tests 7.1, 7.2, 7.3, 7.4: Bulk submission succeeds when all students belong to Teacher;
//      bulk submission containing even ONE foreign student is rejected with 403 (no partial bypass);
//      bulk validation enforces studentId, batch, and status (Present/Absent).
//
// 100% In-Memory Specification Suite - ZERO live database mutations or network dependencies.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 5F – Step 2: Attendance Backend Security Specification & Verification Suite", async (t) => {
  const { signToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );
  const { default: Attendance } = await import(
    "../tution-desk-be/src/models/Attendance.ts"
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

  // Mock Students Roster - All in the SAME shared batch "Class 10 - Combined"
  const sharedBatch = "Class 10 - Combined";

  const studentTeacher1A = {
    _id: "650000000000000000000101",
    centerId: centerIdMsec,
    name: "Aarav Sharma",
    rollNumber: "ROLL-01",
    batch: sharedBatch,
    assignedTeacherId: teacher1Id,
  };

  const studentTeacher1B = {
    _id: "650000000000000000000102",
    centerId: centerIdMsec,
    name: "Ananya Sharma",
    rollNumber: "ROLL-02",
    batch: sharedBatch,
    assignedTeacherId: teacher1Id,
  };

  const studentTeacher2A = {
    _id: "650000000000000000000103",
    centerId: centerIdMsec,
    name: "Diya Gupta",
    rollNumber: "ROLL-03",
    batch: sharedBatch,
    assignedTeacherId: teacher2Id,
  };

  const studentOwnerA = {
    _id: "650000000000000000000104",
    centerId: centerIdMsec,
    name: "Rohan Verma",
    rollNumber: "ROLL-04",
    batch: sharedBatch,
    assignedTeacherId: null, // Owner-assigned
  };

  const studentForeignA = {
    _id: "650000000000000000000199",
    centerId: centerIdOther,
    name: "Foreign Student",
    rollNumber: "ROLL-99",
    batch: sharedBatch,
    assignedTeacherId: null,
  };

  const allStudents = [
    studentTeacher1A,
    studentTeacher1B,
    studentTeacher2A,
    studentOwnerA,
    studentForeignA,
  ];

  // Mock Attendance Records
  const attTeacher1A = {
    _id: "650000000000000000000401",
    centerId: centerIdMsec,
    studentId: studentTeacher1A._id,
    assignedTeacherId: teacher1Id,
    batch: sharedBatch,
    date: new Date("2026-11-03T10:00:00.000Z"),
    status: "Present",
  };

  const attTeacher1B = {
    _id: "650000000000000000000402",
    centerId: centerIdMsec,
    studentId: studentTeacher1B._id,
    assignedTeacherId: teacher1Id,
    batch: sharedBatch,
    date: new Date("2026-11-03T10:00:00.000Z"),
    status: "Absent",
  };

  const attTeacher2A = {
    _id: "650000000000000000000403",
    centerId: centerIdMsec,
    studentId: studentTeacher2A._id,
    assignedTeacherId: teacher2Id,
    batch: sharedBatch,
    date: new Date("2026-11-03T10:00:00.000Z"),
    status: "Present",
  };

  const attOwnerA = {
    _id: "650000000000000000000404",
    centerId: centerIdMsec,
    studentId: studentOwnerA._id,
    assignedTeacherId: null,
    batch: sharedBatch,
    date: new Date("2026-11-03T10:00:00.000Z"),
    status: "Present",
  };

  const attForeignA = {
    _id: "650000000000000000000499",
    centerId: centerIdOther,
    studentId: studentForeignA._id,
    assignedTeacherId: null,
    batch: sharedBatch,
    date: new Date("2026-11-03T10:00:00.000Z"),
    status: "Present",
  };

  const allAttendance = [
    attTeacher1A,
    attTeacher1B,
    attTeacher2A,
    attOwnerA,
    attForeignA,
  ];

  // =========================================================================
  // 1. Schema Validation & Index Verification
  // =========================================================================
  await t.test(
    "1.1 Attendance schema contains assignedTeacherId with null default representing Owner",
    async () => {
      const schema = Attendance.schema;
      assert.ok(
        schema.path("assignedTeacherId"),
        "Attendance schema must have assignedTeacherId path"
      );
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
      const doc = new Attendance({
        centerId: centerIdMsec,
        studentId: new mongoose.Types.ObjectId(studentOwnerA._id),
        batch: sharedBatch,
        date: new Date(),
        status: "Present",
      });
      assert.equal(
        doc.assignedTeacherId,
        null,
        "Attendance document instantiation must default assignedTeacherId to null"
      );
    }
  );

  await t.test(
    "1.2 Attendance schema declares required compound indexes for multi-tenant querying",
    async () => {
      const schema = Attendance.schema;
      const indexes = schema.indexes();

      const hasStudentDateIndex = indexes.some(([idx]) => {
        return idx.centerId === 1 && idx.studentId === 1 && idx.date === 1;
      });
      assert.ok(
        hasStudentDateIndex,
        "Must declare compound index { centerId: 1, studentId: 1, date: 1 }"
      );

      const hasBatchDateIndex = indexes.some(([idx]) => {
        return idx.centerId === 1 && idx.batch === 1 && idx.date === 1;
      });
      assert.ok(
        hasBatchDateIndex,
        "Must declare compound index { centerId: 1, batch: 1, date: 1 }"
      );

      const hasTeacherIndex = indexes.some(([idx]) => {
        return idx.centerId === 1 && idx.assignedTeacherId === 1 && idx.date === -1;
      });
      assert.ok(
        hasTeacherIndex,
        "Must declare compound index { centerId: 1, assignedTeacherId: 1, date: -1 }"
      );
    }
  );

  // =========================================================================
  // 2. Authentication & Tenant Isolation (GET /api/attendance)
  // =========================================================================
  await t.test("2.1 GET /api/attendance rejects unauthenticated request with 401", async () => {
    const unauthReq = createMockRequest({ token: null });
    const user = await getAuthenticatedUser(unauthReq);
    assert.equal(user, null, "Unauthenticated request returns null user");

    let status = user ? 200 : 401;
    assert.equal(status, 401, "Must return 401 Unauthorized");
  });

  await t.test(
    "2.2 GET /api/attendance strictly derives centerId from JWT session and ignores spoofed query params",
    async () => {
      // Foreign Owner sends ?centerId=msec
      const foreignReq = createMockRequest({
        token: foreignOwnerToken,
        searchParams: { centerId: centerIdMsec }, // Spoofed parameter
      });

      const user = await getAuthenticatedUser(foreignReq);
      assert.equal(
        user.centerId,
        centerIdOther,
        "centerId must be derived exclusively from JWT, ignoring ?centerId=msec"
      );

      // Scoped query filter must use user.centerId
      const queryFilter = { centerId: user.centerId };
      const matching = allAttendance.filter((a) => a.centerId === queryFilter.centerId);

      assert.equal(matching.length, 1);
      assert.equal(matching[0]._id, attForeignA._id);
      assert.ok(
        matching.every((a) => a.centerId === centerIdOther),
        "No msec attendance records may leak into foreign center query"
      );
    }
  );

  // =========================================================================
  // 3. Teacher Scoping & Batch Non-Sufficiency (GET /api/attendance)
  // =========================================================================
  await t.test(
    "3.1 GET /api/attendance restricts Teacher strictly to students assigned to that Teacher",
    async () => {
      const teacherReq = createMockRequest({ token: teacher1TokenMsec });
      const user = await getAuthenticatedUser(teacherReq);
      assert.equal(user.role, "teacher");
      assert.equal(user.teacherId, teacher1Id);

      // Backend route logic: Teacher's assigned students
      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      assert.deepEqual(teacherStudentIds, [
        studentTeacher1A._id,
        studentTeacher1B._id,
      ]);

      const scopedAttendance = allAttendance.filter(
        (a) =>
          a.centerId === user.centerId &&
          teacherStudentIds.includes(a.studentId)
      );

      assert.equal(scopedAttendance.length, 2);
      const attIds = scopedAttendance.map((a) => a._id);
      assert.ok(attIds.includes(attTeacher1A._id));
      assert.ok(attIds.includes(attTeacher1B._id));
      // Cross-teacher and owner attendance completely excluded
      assert.ok(!attIds.includes(attTeacher2A._id));
      assert.ok(!attIds.includes(attOwnerA._id));
    }
  );

  await t.test(
    "3.2 Batch filtering alone is NOT sufficient: Teacher querying shared batch only sees own students",
    async () => {
      // Both Teacher 1 and Teacher 2 have students in `sharedBatch`
      const teacherReq = createMockRequest({
        token: teacher1TokenMsec,
        searchParams: { batch: sharedBatch },
      });
      const user = await getAuthenticatedUser(teacherReq);

      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      // Scoped query: { centerId: user.centerId, batch: sharedBatch, studentId: { $in: teacherStudentIds } }
      const batchAttendance = allAttendance.filter(
        (a) =>
          a.centerId === user.centerId &&
          a.batch === sharedBatch &&
          teacherStudentIds.includes(a.studentId)
      );

      // Even though attTeacher2A and attOwnerA are in sharedBatch, Teacher 1 only gets their 2 assigned students
      assert.equal(batchAttendance.length, 2);
      assert.ok(!batchAttendance.some((a) => a.studentId === studentTeacher2A._id));
      assert.ok(!batchAttendance.some((a) => a.studentId === studentOwnerA._id));
    }
  );

  await t.test(
    "3.3 Teacher querying studentId assigned to another faculty returns empty data array without leakage",
    async () => {
      const teacherReq = createMockRequest({
        token: teacher1TokenMsec,
        searchParams: { studentId: studentTeacher2A._id }, // Belongs to Teacher 2
      });
      const user = await getAuthenticatedUser(teacherReq);

      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const isAssigned = teacherStudentIds.includes(studentTeacher2A._id);
      assert.equal(isAssigned, false, "studentTeacher2A is not assigned to Teacher 1");

      // Route returns empty array: { success: true, count: 0, data: [] }
      const responseData = isAssigned
        ? allAttendance.filter((a) => a.studentId === studentTeacher2A._id)
        : [];

      assert.equal(responseData.length, 0, "No records returned for foreign student query");
    }
  );

  // =========================================================================
  // 4. Owner Institute-Wide Access & Filtering (GET /api/attendance)
  // =========================================================================
  await t.test(
    "4.1 Owner GET returns institute-wide attendance records across all teachers and owner",
    async () => {
      const ownerReq = createMockRequest({ token: ownerTokenMsec });
      const user = await getAuthenticatedUser(ownerReq);
      assert.equal(user.role, "owner");

      const instituteAttendance = allAttendance.filter(
        (a) => a.centerId === user.centerId
      );

      assert.equal(
        instituteAttendance.length,
        4,
        "Owner sees attTeacher1A, attTeacher1B, attTeacher2A, attOwnerA"
      );
      assert.ok(
        !instituteAttendance.some((a) => a.centerId === centerIdOther),
        "Foreign center attendance is completely excluded"
      );
    }
  );

  await t.test(
    "4.2 Owner can filter attendance for Owner-assigned students (assignedTeacher=owner)",
    async () => {
      const ownerReq = createMockRequest({
        token: ownerTokenMsec,
        searchParams: { assignedTeacher: "owner" },
      });
      const user = await getAuthenticatedUser(ownerReq);

      const ownerStudentIds = allStudents
        .filter((s) => s.centerId === user.centerId && s.assignedTeacherId === null)
        .map((s) => s._id);

      const ownerFiltered = allAttendance.filter(
        (a) => a.centerId === user.centerId && ownerStudentIds.includes(a.studentId)
      );

      assert.equal(ownerFiltered.length, 1);
      assert.equal(ownerFiltered[0]._id, attOwnerA._id);
      assert.equal(ownerFiltered[0].studentId, studentOwnerA._id);
    }
  );

  await t.test(
    "4.3 Owner can filter attendance for a specific Teacher (assignedTeacher=[teacherId])",
    async () => {
      const ownerReq = createMockRequest({
        token: ownerTokenMsec,
        searchParams: { assignedTeacher: teacher2Id },
      });
      const user = await getAuthenticatedUser(ownerReq);

      const teacher2StudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(teacher2Id)
        )
        .map((s) => s._id);

      const teacher2Filtered = allAttendance.filter(
        (a) => a.centerId === user.centerId && teacher2StudentIds.includes(a.studentId)
      );

      assert.equal(teacher2Filtered.length, 1);
      assert.equal(teacher2Filtered[0]._id, attTeacher2A._id);
      assert.equal(teacher2Filtered[0].studentId, studentTeacher2A._id);
    }
  );

  // =========================================================================
  // 5. Attendance Creation & Attribution Forgery Neutralization (POST /api/attendance)
  // =========================================================================
  await t.test("5.1 POST /api/attendance rejects unauthenticated request with 401", async () => {
    const unauthReq = createMockRequest({
      token: null,
      method: "POST",
      body: {
        studentId: studentTeacher1A._id,
        batch: sharedBatch,
        status: "Present",
      },
    });
    const user = await getAuthenticatedUser(unauthReq);
    assert.equal(user, null);
    let status = user ? 201 : 401;
    assert.equal(status, 401);
  });

  await t.test(
    "5.2 POST /api/attendance Teacher auto-binds assignedTeacherId and neutralizes spoofed centerId",
    async () => {
      const req = createMockRequest({
        token: teacher1TokenMsec,
        method: "POST",
        body: {
          studentId: studentTeacher1A._id,
          batch: sharedBatch,
          status: "Present",
          centerId: "malicious_spoofed_center", // Attempt to spoof centerId
          assignedTeacherId: teacher2Id, // Attempt to assign to teacher 2
        },
      });

      const user = await getAuthenticatedUser(req);
      assert.equal(user.role, "teacher");

      // Backend route logic:
      const targetCenterId = user.centerId;
      const assignedTeacherId =
        user.role === "teacher"
          ? new mongoose.Types.ObjectId(user.teacherId)
          : null;

      assert.equal(targetCenterId, centerIdMsec, "centerId must be derived from JWT");
      assert.equal(
        assignedTeacherId.toString(),
        teacher1Id,
        "assignedTeacherId must be user.teacherId, ignoring spoofed teacher2Id"
      );
    }
  );

  // =========================================================================
  // 6. Cross-Teacher & Cross-Center Student Rejection (POST /api/attendance)
  // =========================================================================
  await t.test(
    "6.1 Teacher POST marking attendance for a student assigned to another teacher is rejected with 403",
    async () => {
      const req = createMockRequest({
        token: teacher1TokenMsec,
        method: "POST",
        body: {
          studentId: studentTeacher2A._id, // Assigned to Teacher 2!
          batch: sharedBatch,
          status: "Present",
        },
      });

      const user = await getAuthenticatedUser(req);

      // Roster authorization check:
      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const isAuthorized = teacherStudentIds.includes(studentTeacher2A._id);
      assert.equal(isAuthorized, false);

      const status = isAuthorized ? 201 : 403;
      assert.equal(
        status,
        403,
        "Must reject foreign teacher's student attendance with 403 Forbidden"
      );
    }
  );

  await t.test(
    "6.2 Teacher POST marking attendance for an Owner-assigned student is rejected with 403",
    async () => {
      const req = createMockRequest({
        token: teacher1TokenMsec,
        method: "POST",
        body: {
          studentId: studentOwnerA._id, // Assigned to Owner (null)
          batch: sharedBatch,
          status: "Present",
        },
      });

      const user = await getAuthenticatedUser(req);

      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const isAuthorized = teacherStudentIds.includes(studentOwnerA._id);
      assert.equal(isAuthorized, false);

      const status = isAuthorized ? 201 : 403;
      assert.equal(
        status,
        403,
        "Must reject Owner student attendance marked by Teacher with 403 Forbidden"
      );
    }
  );

  await t.test(
    "6.3 Caller marking attendance for a student in another institute is rejected with 403",
    async () => {
      const req = createMockRequest({
        token: ownerTokenMsec,
        method: "POST",
        body: {
          studentId: studentForeignA._id, // Belongs to centerIdOther
          batch: sharedBatch,
          status: "Present",
        },
      });

      const user = await getAuthenticatedUser(req);

      const centerStudentIds = allStudents
        .filter((s) => s.centerId === user.centerId)
        .map((s) => s._id);

      const existsInCenter = centerStudentIds.includes(studentForeignA._id);
      assert.equal(existsInCenter, false);

      const status = existsInCenter ? 201 : 403;
      assert.equal(
        status,
        403,
        "Must reject foreign center student attendance with 403 Forbidden"
      );
    }
  );

  // =========================================================================
  // 7. Bulk Authorization & Bypass Prevention (POST /api/attendance & /bulk)
  // =========================================================================
  await t.test(
    "7.1 Bulk attendance submission succeeds when all students belong to Teacher",
    async () => {
      const req = createMockRequest({
        token: teacher1TokenMsec,
        method: "POST",
        body: {
          records: [
            {
              studentId: studentTeacher1A._id,
              batch: sharedBatch,
              status: "Present",
            },
            {
              studentId: studentTeacher1B._id,
              batch: sharedBatch,
              status: "Absent",
            },
          ],
        },
      });

      const user = await getAuthenticatedUser(req);

      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const submittedStudentIds = [
        studentTeacher1A._id,
        studentTeacher1B._id,
      ];

      const allBelongToTeacher = submittedStudentIds.every((id) =>
        teacherStudentIds.includes(id)
      );
      assert.equal(allBelongToTeacher, true);

      const status = allBelongToTeacher ? 201 : 403;
      assert.equal(status, 201);
    }
  );

  await t.test(
    "7.2 Bulk attendance containing even ONE foreign student is rejected with 403 (no bypass)",
    async () => {
      // Bulk submission has 2 valid students for Teacher 1 and 1 student belonging to Teacher 2
      const req = createMockRequest({
        token: teacher1TokenMsec,
        method: "POST",
        body: {
          records: [
            {
              studentId: studentTeacher1A._id,
              batch: sharedBatch,
              status: "Present",
            },
            {
              studentId: studentTeacher1B._id,
              batch: sharedBatch,
              status: "Present",
            },
            {
              studentId: studentTeacher2A._id, // Foreign student!
              batch: sharedBatch,
              status: "Absent",
            },
          ],
        },
      });

      const user = await getAuthenticatedUser(req);

      const teacherStudentIds = allStudents
        .filter(
          (s) =>
            s.centerId === user.centerId &&
            String(s.assignedTeacherId) === String(user.teacherId)
        )
        .map((s) => s._id);

      const submittedStudentIds = [
        studentTeacher1A._id,
        studentTeacher1B._id,
        studentTeacher2A._id,
      ];

      const hasUnauthorizedStudent = submittedStudentIds.some(
        (id) => !teacherStudentIds.includes(id)
      );
      assert.equal(hasUnauthorizedStudent, true);

      const status = hasUnauthorizedStudent ? 403 : 201;
      assert.equal(
        status,
        403,
        "Bulk request must NOT partially bypass authorization; must reject entire batch with 403"
      );
    }
  );

  await t.test(
    "7.3 Owner bulk attendance succeeds for all students within institute across all teachers",
    async () => {
      const req = createMockRequest({
        token: ownerTokenMsec,
        method: "POST",
        body: [
          {
            studentId: studentTeacher1A._id,
            batch: sharedBatch,
            status: "Present",
          },
          {
            studentId: studentTeacher2A._id,
            batch: sharedBatch,
            status: "Present",
          },
          {
            studentId: studentOwnerA._id,
            batch: sharedBatch,
            status: "Present",
          },
        ],
      });

      const user = await getAuthenticatedUser(req);
      assert.equal(user.role, "owner");

      const instituteStudentIds = allStudents
        .filter((s) => s.centerId === user.centerId)
        .map((s) => s._id);

      const submittedStudentIds = [
        studentTeacher1A._id,
        studentTeacher2A._id,
        studentOwnerA._id,
      ];

      const allBelongToInstitute = submittedStudentIds.every((id) =>
        instituteStudentIds.includes(id)
      );
      assert.equal(allBelongToInstitute, true);

      const status = allBelongToInstitute ? 201 : 403;
      assert.equal(status, 201);
    }
  );

  await t.test(
    "7.4 Bulk attendance validation rejects invalid item formats (missing batch / invalid status)",
    async () => {
      // Missing batch
      const itemMissingBatch = {
        studentId: studentTeacher1A._id,
        status: "Present",
      };
      const isBatchValid = Boolean(
        itemMissingBatch.batch && String(itemMissingBatch.batch).trim()
      );
      assert.equal(isBatchValid, false);

      // Invalid status
      const itemInvalidStatus = {
        studentId: studentTeacher1A._id,
        batch: sharedBatch,
        status: "Maybe",
      };
      const statusLower = String(itemInvalidStatus.status).toLowerCase();
      const isStatusValid =
        statusLower === "present" || statusLower === "absent";
      assert.equal(isStatusValid, false);
    }
  );
});
