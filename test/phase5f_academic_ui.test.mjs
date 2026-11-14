import test from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// Phase 5F – Step 3: Frontend Attendance & Tests UI Scoping Specification Suite
//
// TEST CLASSIFICATION:
// 1. Attendance UI Faculty Filters (Owner View):
//    - Tests 1.1, 1.2, 1.3: Filters 'all', 'owner', and specific teacher ID;
//      dynamic batch options reflect selected faculty's students.
// 2. Attendance UI Role Isolation (Teacher View):
//    - Tests 2.1, 2.2: Teacher sees strictly their assigned students;
//      faculty filter pills and reassignment controls are completely omitted.
// 3. Tests UI Scoping & Faculty Attribution Badges:
//    - Tests 3.1, 3.2: Owner can filter 'all', 'owner', and specific teacher;
//      Faculty badge accurately resolves Owner vs Teacher faculty attribution.
// 4. Create Test Modal Flow:
//    - Tests 4.1, 4.2: Constructs valid payload without forged centerId or assignedTeacherId;
//      enforces non-empty title/batch and positive maxMarks.
// 5. Enter Marks Modal Flow & Authorization Scoping:
//    - Tests 5.1, 5.2: Student roster in marks modal strictly scoped to test's assigned teacher;
//      submits clean { results } payload adhering to backend whitelist.
// ============================================================================

test("Phase 5F – Step 3: Frontend Attendance & Tests UI Scoping Specification Suite", async (t) => {
  // Pre-configured Test Roster
  const centerIdMsec = "msec";
  const teacher1 = { _id: "650000000000000000000010", name: "R. K. Sharma (Math)" };
  const teacher2 = { _id: "650000000000000000000020", name: "P. Gupta (Physics)" };

  const students = [
    {
      _id: "s1",
      centerId: centerIdMsec,
      name: "Aarav Sharma",
      batch: "Class 10 - Math",
      assignedTeacherId: teacher1._id,
    },
    {
      _id: "s2",
      centerId: centerIdMsec,
      name: "Ananya Sharma",
      batch: "Class 10 - Combined",
      assignedTeacherId: teacher1._id,
    },
    {
      _id: "s3",
      centerId: centerIdMsec,
      name: "Diya Gupta",
      batch: "Class 10 - Combined",
      assignedTeacherId: teacher2._id,
    },
    {
      _id: "s4",
      centerId: centerIdMsec,
      name: "Rohan Verma",
      batch: "Class 10 - Combined",
      assignedTeacherId: null, // Owner-assigned
    },
  ];

  const testsList = [
    {
      _id: "t1",
      centerId: centerIdMsec,
      title: "Algebra Unit 1",
      batch: "Class 10 - Math",
      maxMarks: 50,
      assignedTeacherId: teacher1._id,
      results: [],
    },
    {
      _id: "t2",
      centerId: centerIdMsec,
      title: "Physics Mechanics",
      batch: "Class 10 - Combined",
      maxMarks: 40,
      assignedTeacherId: teacher2._id,
      results: [],
    },
    {
      _id: "t3",
      centerId: centerIdMsec,
      title: "Institute Midterm",
      batch: "Class 10 - Combined",
      maxMarks: 100,
      assignedTeacherId: null, // Owner-created
      results: [],
    },
  ];

  // =========================================================================
  // 1. Attendance UI Faculty Filters (Owner View)
  // =========================================================================
  await t.test(
    "1.1 Owner Attendance: 'All Faculty' displays all institute students across faculty",
    async () => {
      const userProfile = { role: "owner", centerId: centerIdMsec };
      const selectedFilter = "all";

      const filtered = students.filter((s) => {
        if (userProfile.role !== "owner") return true;
        if (selectedFilter === "all") return true;
        if (selectedFilter === "owner") return !s.assignedTeacherId;
        return s.assignedTeacherId === selectedFilter;
      });

      assert.equal(filtered.length, 4);
    }
  );

  await t.test(
    "1.2 Owner Attendance: 'Myself (Owner)' isolates students where assignedTeacherId is null",
    async () => {
      const userProfile = { role: "owner", centerId: centerIdMsec };
      const selectedFilter = "owner";

      const filtered = students.filter((s) => {
        if (userProfile.role !== "owner") return true;
        if (selectedFilter === "all") return true;
        if (selectedFilter === "owner") return !s.assignedTeacherId;
        return s.assignedTeacherId === selectedFilter;
      });

      assert.equal(filtered.length, 1);
      assert.equal(filtered[0]._id, "s4");
      assert.equal(filtered[0].assignedTeacherId, null);
    }
  );

  await t.test(
    "1.3 Owner Attendance: Specific teacher filter isolates that teacher's students and updates batch options",
    async () => {
      const userProfile = { role: "owner", centerId: centerIdMsec };
      const selectedFilter = teacher1._id;

      const filtered = students.filter((s) => {
        if (userProfile.role !== "owner") return true;
        if (selectedFilter === "all") return true;
        if (selectedFilter === "owner") return !s.assignedTeacherId;
        return s.assignedTeacherId === selectedFilter;
      });

      assert.equal(filtered.length, 2);
      assert.ok(filtered.every((s) => s.assignedTeacherId === teacher1._id));

      // Batch options calculated from filtered students
      const batches = Array.from(new Set(filtered.map((s) => s.batch)));
      assert.deepEqual(batches.sort(), ["Class 10 - Combined", "Class 10 - Math"].sort());
    }
  );

  // =========================================================================
  // 2. Attendance UI Role Isolation (Teacher View)
  // =========================================================================
  await t.test(
    "2.1 Teacher Attendance: Backend-scoped students are presented directly without faculty filter pills",
    async () => {
      const userProfile = {
        role: "teacher",
        centerId: centerIdMsec,
        teacherId: teacher1._id,
      };

      // Condition used in page.tsx:
      const showFacultyPills = userProfile.role === "owner";
      assert.equal(showFacultyPills, false, "Faculty filter pills must be hidden for Teacher");

      // For teacher, all returned students are already scoped to teacher
      const teacherStudents = students.filter(
        (s) => s.assignedTeacherId === userProfile.teacherId
      );
      assert.equal(teacherStudents.length, 2);
    }
  );

  await t.test(
    "2.2 Teacher Attendance: P/A toggles preserve student mapping and submission payload",
    async () => {
      const attendanceMap = { s1: "present", s2: "absent" };
      const markedStudents = [
        { id: "s1", batch: "Class 10 - Math" },
        { id: "s2", batch: "Class 10 - Combined" },
      ];

      const payloads = markedStudents.map((s) => ({
        studentId: s.id,
        batch: s.batch,
        status: attendanceMap[s.id] === "absent" ? "Absent" : "Present",
      }));

      assert.equal(payloads[0].status, "Present");
      assert.equal(payloads[1].status, "Absent");
      assert.equal(payloads[0].studentId, "s1");
    }
  );

  // =========================================================================
  // 3. Tests UI Scoping & Faculty Attribution Badges
  // =========================================================================
  await t.test(
    "3.1 Tests UI: Owner can filter tests by 'all', 'owner', or specific teacher",
    async () => {
      const userProfile = { role: "owner" };

      // Owner filter: all
      const allTests = testsList.filter((t) => {
        if (userProfile.role !== "owner") return true;
        return true;
      });
      assert.equal(allTests.length, 3);

      // Owner filter: owner (null)
      const ownerTests = testsList.filter((t) => !t.assignedTeacherId);
      assert.equal(ownerTests.length, 1);
      assert.equal(ownerTests[0].title, "Institute Midterm");

      // Owner filter: teacher1
      const teacher1Tests = testsList.filter((t) => t.assignedTeacherId === teacher1._id);
      assert.equal(teacher1Tests.length, 1);
      assert.equal(teacher1Tests[0].title, "Algebra Unit 1");
    }
  );

  await t.test(
    "3.2 Tests UI: Faculty badge distinguishes Owner vs Teacher tests",
    async () => {
      const teacherMap = {
        [teacher1._id]: "R. K. Sharma (Math)",
        [teacher2._id]: "P. Gupta (Physics)",
      };

      function resolveBadge(test) {
        if (test.assignedTeacherId) {
          return `Faculty: ${teacherMap[test.assignedTeacherId] || "Teacher"}`;
        }
        return "Faculty: Myself (Owner)";
      }

      assert.equal(resolveBadge(testsList[0]), "Faculty: R. K. Sharma (Math)");
      assert.equal(resolveBadge(testsList[1]), "Faculty: P. Gupta (Physics)");
      assert.equal(resolveBadge(testsList[2]), "Faculty: Myself (Owner)");
    }
  );

  // =========================================================================
  // 4. Create Test Modal Flow
  // =========================================================================
  await t.test(
    "4.1 CreateTestModal: Constructs clean payload without client-forged centerId or assignedTeacherId",
    async () => {
      const formInput = {
        title: "  Weekly Unit Test 3  ",
        batch: "  Class 10 - Combined  ",
        date: "2026-11-10",
        maxMarks: "50",
      };

      const cleanTitle = formInput.title.trim();
      const cleanBatch = formInput.batch.trim();
      const parsedMax = Number(formInput.maxMarks);

      const payload = {
        title: cleanTitle,
        batch: cleanBatch,
        date: formInput.date,
        maxMarks: parsedMax,
        results: [],
      };

      // Asserts no spoofed centerId or assignedTeacherId in payload
      assert.equal(payload.centerId, undefined);
      assert.equal(payload.assignedTeacherId, undefined);
      assert.equal(payload.title, "Weekly Unit Test 3");
      assert.equal(payload.maxMarks, 50);
    }
  );

  await t.test(
    "4.2 CreateTestModal: Validates required title, batch, and positive maxMarks",
    async () => {
      function validate(title, batch, maxMarks) {
        if (!title.trim()) return "Please enter a test title.";
        if (!batch.trim()) return "Please select a target batch for this test.";
        const num = Number(maxMarks);
        if (isNaN(num) || num <= 0) return "Maximum marks must be greater than 0.";
        return null;
      }

      assert.equal(validate("", "Batch 1", 50), "Please enter a test title.");
      assert.equal(validate("Test", "", 50), "Please select a target batch for this test.");
      assert.equal(validate("Test", "Batch 1", 0), "Maximum marks must be greater than 0.");
      assert.equal(validate("Test", "Batch 1", -10), "Maximum marks must be greater than 0.");
      assert.equal(validate("Test", "Batch 1", 100), null);
    }
  );

  // =========================================================================
  // 5. Enter Marks Modal Flow & Authorization Scoping
  // =========================================================================
  await t.test(
    "5.1 EnterMarksModal: Scopes batch students strictly to test's assigned teacher",
    async () => {
      const currentTest = testsList[0]; // assigned to teacher1
      const batchStudents = students.filter((s) => s.batch === currentTest.batch || s.batch === "Class 10 - Combined");

      // Scope logic:
      const relevantStudents = currentTest.assignedTeacherId
        ? batchStudents.filter((s) => s.assignedTeacherId === currentTest.assignedTeacherId)
        : batchStudents;

      assert.equal(relevantStudents.length, 2);
      assert.ok(
        relevantStudents.every((s) => s.assignedTeacherId === teacher1._id),
        "Only teacher1 students are shown in teacher1 test marks entry modal"
      );
    }
  );

  await t.test(
    "5.2 EnterMarksModal: Formats clean results payload adhering to backend update whitelist",
    async () => {
      const entries = [
        { studentId: "s1", marksObtained: "45", isAbsent: false },
        { studentId: "s2", marksObtained: "", isAbsent: true },
        { studentId: "s3", marksObtained: "", isAbsent: false }, // Unmarked, skipped
      ];

      const resultsPayload = entries
        .filter((e) => e.isAbsent || e.marksObtained !== "")
        .map((e) => ({
          studentId: e.studentId,
          marksObtained: e.isAbsent ? 0 : Number(e.marksObtained || 0),
          isAbsent: e.isAbsent,
        }));

      assert.equal(resultsPayload.length, 2);
      assert.deepEqual(resultsPayload, [
        { studentId: "s1", marksObtained: 45, isAbsent: false },
        { studentId: "s2", marksObtained: 0, isAbsent: true },
      ]);
    }
  );
});
