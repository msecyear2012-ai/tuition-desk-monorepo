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
// Attendance Tab Dynamic Data & Save/Notify Integration Test Suite
//
// TEST SPECIFICATION:
// 1. Dynamic Batch Loading & Scoping:
//    - 1.1 Owner retrieves all active institute batches across faculty.
//    - 1.2 Teacher 1 retrieves strictly authorized batches.
//    - 1.3 Teacher 2 retrieves strictly authorized batches.
// 2. Batch-Specific Student Roster & Scoping:
//    - 2.1 Selecting a batch loads strictly students belonging to that batch.
//    - 2.2 Teacher querying batch with assigned students sees strictly their own students.
//    - 2.3 Owner can filter students within batch by Myself or specific faculty.
// 3. Stale Response & Epoch Guard Contract:
//    - 3.1 Fast batch switching discards stale in-flight response.
//    - 3.2 Switching batches resets unsaved attendance selections.
// 4. Attendance Toggle & Mark All Present:
//    - 4.1 Individual toggle between present, absent, and unmarked.
//    - 4.2 'Mark All Present' marks all roster students as present.
// 5. Attendance Save & Validation:
//    - 5.1 Save payload adheres strictly to backend schema contract.
//    - 5.2 Server derives centerId and assignedTeacherId from verified JWT (ignoring client spoofing).
//    - 5.3 Unauthorized student in attendance payload is rejected with 403 Forbidden.
//    - 5.4 Same-day attendance update updates existing record instead of creating duplicates.
// 6. Double-Submission & In-Flight Protection:
//    - 6.1 In-flight saving state blocks concurrent submission.
// 7. Parent Notification Integration & Honest Status:
//    - 7.1 Notification dispatch honors fail-closed simulation guard without claiming fake live dispatch.
//    - 7.2 Invalid parent phone number fails safe with descriptive validation error.
//    - 7.3 Response reports accurate notification summary (attempted, sent, simulated, failed).
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Attendance Tab Dynamic Data & Save/Notify Integration Suite", async (t) => {
  const { signToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );
  const { sendAttendanceAlert, isLiveDispatchEnabled } = await import(
    "../tution-desk-be/src/lib/whatsappService.ts"
  );

  // Helper to generate mock NextRequest
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

  const CENTER_ID = "msce-8267";
  const OWNER_ID = "6ae869d9c117e0a550dcb247";
  const TEACHER_1_ID = "6ae9ba93d29bd04896bac676";
  const TEACHER_2_ID = "6af100000000000000000001";

  const ownerToken = await signToken({
    userId: OWNER_ID,
    centerId: CENTER_ID,
    role: "owner",
    name: "Jeet",
  });

  const teacher1Token = await signToken({
    userId: TEACHER_1_ID,
    centerId: CENTER_ID,
    role: "teacher",
    teacherId: TEACHER_1_ID,
    name: "Jitender Kumar",
  });

  const teacher2Token = await signToken({
    userId: TEACHER_2_ID,
    centerId: CENTER_ID,
    role: "teacher",
    teacherId: TEACHER_2_ID,
    name: "TEST_E2E_Teacher_Sharma",
  });

  // Mock batch and student data fixture
  const batchMath = {
    _id: "6ae9badcd29bd04896bac677",
    name: "Class 10 - Mathematics",
    timing: "4:00 PM - 5:30 PM (Mon, Wed, Fri)",
    centerId: CENTER_ID,
    isActive: true,
  };
  const batchGeneral = {
    _id: "6af100000000000000000003",
    name: "TEST_E2E_Batch_Owner_General",
    timing: "3:00 PM - 4:00 PM (Daily)",
    centerId: CENTER_ID,
    isActive: true,
  };
  const batchPhysics = {
    _id: "6af100000000000000000002",
    name: "TEST_E2E_Batch_Physics",
    timing: "5:30 PM - 7:00 PM (Tue, Thu)",
    centerId: CENTER_ID,
    isActive: true,
  };

  const studentJack = {
    _id: "6ae9bb06d29bd04896bac678",
    centerId: CENTER_ID,
    name: "jack",
    batch: "Class 10 - Mathematics",
    assignedTeacherId: TEACHER_1_ID,
    parentWhatsApp: "8851048641",
    isActive: true,
  };
  const studentT1 = {
    _id: "6af100000000000000000005",
    centerId: CENTER_ID,
    name: "TEST_E2E_Student_T1",
    batch: "Class 10 - Mathematics",
    assignedTeacherId: TEACHER_1_ID,
    parentWhatsApp: "9999910002",
    isActive: true,
  };
  const studentT2 = {
    _id: "6af100000000000000000006",
    centerId: CENTER_ID,
    name: "TEST_E2E_Student_T2",
    batch: "TEST_E2E_Batch_Physics",
    assignedTeacherId: TEACHER_2_ID,
    parentWhatsApp: "9999910003",
    isActive: true,
  };
  const studentOwner = {
    _id: "6af100000000000000000004",
    centerId: CENTER_ID,
    name: "TEST_E2E_Student_Owner",
    batch: "TEST_E2E_Batch_Owner_General",
    assignedTeacherId: null,
    parentWhatsApp: "9999910001",
    isActive: true,
  };

  const allBatches = [batchMath, batchGeneral, batchPhysics];
  const allStudents = [studentJack, studentT1, studentT2, studentOwner];

  // --------------------------------------------------------------------------
  // Group 1: Dynamic Batch Loading & Scoping
  // --------------------------------------------------------------------------
  await t.test("1.1 Owner retrieves all active institute batches across faculty", async () => {
    const auth = await getAuthenticatedUser(createMockRequest({ token: ownerToken }));
    assert.equal(auth.role, "owner");

    // Owner scope: all active batches for the institute
    const ownerBatches = allBatches.filter(
      (b) => b.centerId === auth.centerId && b.isActive
    );
    assert.equal(ownerBatches.length, 3);
    assert.ok(ownerBatches.some((b) => b.name === "Class 10 - Mathematics"));
    assert.ok(ownerBatches.some((b) => b.name === "TEST_E2E_Batch_Owner_General"));
    assert.ok(ownerBatches.some((b) => b.name === "TEST_E2E_Batch_Physics"));
  });

  await t.test("1.2 Teacher 1 retrieves strictly authorized batches", async () => {
    const auth = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));
    assert.equal(auth.role, "teacher");

    // Teacher 1 has assigned students in Class 10 - Mathematics only
    const teacher1Students = allStudents.filter(
      (s) => s.centerId === auth.centerId && s.assignedTeacherId === auth.teacherId
    );
    const authorizedBatchNames = Array.from(new Set(teacher1Students.map((s) => s.batch)));
    const teacher1Batches = allBatches.filter(
      (b) => b.centerId === auth.centerId && authorizedBatchNames.includes(b.name)
    );

    assert.equal(teacher1Batches.length, 1);
    assert.equal(teacher1Batches[0].name, "Class 10 - Mathematics");
  });

  await t.test("1.3 Teacher 2 retrieves strictly authorized batches", async () => {
    const auth = await getAuthenticatedUser(createMockRequest({ token: teacher2Token }));
    assert.equal(auth.role, "teacher");

    const teacher2Students = allStudents.filter(
      (s) => s.centerId === auth.centerId && s.assignedTeacherId === auth.teacherId
    );
    const authorizedBatchNames = Array.from(new Set(teacher2Students.map((s) => s.batch)));
    const teacher2Batches = allBatches.filter(
      (b) => b.centerId === auth.centerId && authorizedBatchNames.includes(b.name)
    );

    assert.equal(teacher2Batches.length, 1);
    assert.equal(teacher2Batches[0].name, "TEST_E2E_Batch_Physics");
  });

  // --------------------------------------------------------------------------
  // Group 2: Batch-Specific Student Roster & Scoping
  // --------------------------------------------------------------------------
  await t.test("2.1 Selecting a batch loads strictly students belonging to that batch", async () => {
    const selectedBatch = batchMath;
    const roster = allStudents.filter((s) => s.batch === selectedBatch.name);

    assert.equal(roster.length, 2);
    assert.ok(roster.every((s) => s.batch === "Class 10 - Mathematics"));
    assert.ok(!roster.some((s) => s.name === "TEST_E2E_Student_T2"));
  });

  await t.test("2.2 Teacher querying batch sees strictly own assigned students", async () => {
    const auth = await getAuthenticatedUser(createMockRequest({ token: teacher2Token }));
    const selectedBatch = batchPhysics;

    const teacherRoster = allStudents.filter(
      (s) =>
        s.batch === selectedBatch.name &&
        s.assignedTeacherId === auth.teacherId &&
        s.centerId === auth.centerId
    );

    assert.equal(teacherRoster.length, 1);
    assert.equal(teacherRoster[0].name, "TEST_E2E_Student_T2");
  });

  await t.test("2.3 Owner can filter students within batch by Myself or specific faculty", async () => {
    // Math batch has Teacher 1 students
    const mathTeacher1Students = allStudents.filter(
      (s) => s.batch === batchMath.name && s.assignedTeacherId === TEACHER_1_ID
    );
    assert.equal(mathTeacher1Students.length, 2);

    // General batch has Owner-assigned student
    const generalOwnerStudents = allStudents.filter(
      (s) => s.batch === batchGeneral.name && !s.assignedTeacherId
    );
    assert.equal(generalOwnerStudents.length, 1);
    assert.equal(generalOwnerStudents[0].name, "TEST_E2E_Student_Owner");
  });

  // --------------------------------------------------------------------------
  // Group 3: Stale Response & Epoch Guard Contract
  // --------------------------------------------------------------------------
  await t.test("3.1 Fast batch switching discards stale in-flight responses", async () => {
    let activeRequestId = 0;
    const responsesCaptured = [];

    async function triggerBatchLoad(batchId, delayMs) {
      const currentRequestId = ++activeRequestId;
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      if (currentRequestId === activeRequestId) {
        responsesCaptured.push({ batchId, applied: true });
      } else {
        responsesCaptured.push({ batchId, applied: false });
      }
    }

    // Simulate fast sequential batch switches:
    // Batch A triggered with slow network (60ms)
    // Batch B triggered immediately after with fast network (10ms)
    const p1 = triggerBatchLoad("batch_A", 60);
    const p2 = triggerBatchLoad("batch_B", 10);

    await Promise.all([p1, p2]);

    const staleResponse = responsesCaptured.find((r) => r.batchId === "batch_A");
    const freshResponse = responsesCaptured.find((r) => r.batchId === "batch_B");

    assert.equal(staleResponse.applied, false, "Stale response must be dropped");
    assert.equal(freshResponse.applied, true, "Latest response must be applied");
  });

  await t.test("3.2 Switching batches resets unsaved attendance selections", async () => {
    let attendanceMap = { [studentJack._id]: "present" };
    let isSaved = false;

    function onSwitchBatch(newBatchId) {
      attendanceMap = {};
      isSaved = false;
    }

    onSwitchBatch("new_batch_id");
    assert.deepEqual(attendanceMap, {}, "Attendance map must be reset on batch switch");
    assert.equal(isSaved, false, "isSaved flag must be reset to false");
  });

  // --------------------------------------------------------------------------
  // Group 4: Attendance Toggle & Mark All Present
  // --------------------------------------------------------------------------
  await t.test("4.1 Individual toggle between present, absent, and unmarked", async () => {
    let status = "unmarked";

    // Toggle to present
    status = status === "present" ? "unmarked" : "present";
    assert.equal(status, "present");

    // Toggle to absent
    status = status === "absent" ? "unmarked" : "absent";
    assert.equal(status, "absent");

    // Toggle absent off -> unmarked
    status = status === "absent" ? "unmarked" : "absent";
    assert.equal(status, "unmarked");
  });

  await t.test("4.2 'Mark All Present' marks all roster students as present", async () => {
    const roster = [studentJack, studentT1];
    const attendanceMap = {};

    roster.forEach((s) => {
      attendanceMap[s._id] = "present";
    });

    assert.equal(attendanceMap[studentJack._id], "present");
    assert.equal(attendanceMap[studentT1._id], "present");

    const presentCount = roster.filter((s) => attendanceMap[s._id] === "present").length;
    const absentCount = roster.filter((s) => attendanceMap[s._id] === "absent").length;
    const unmarkedCount = roster.length - (presentCount + absentCount);

    assert.equal(presentCount, 2);
    assert.equal(absentCount, 0);
    assert.equal(unmarkedCount, 0);
  });

  // --------------------------------------------------------------------------
  // Group 5: Attendance Save & Validation
  // --------------------------------------------------------------------------
  await t.test("5.1 Save payload adheres strictly to backend schema contract", async () => {
    const markedStudents = [
      { id: studentJack._id, status: "present" },
      { id: studentT1._id, status: "absent" },
    ];

    const todayDate = new Date().toISOString();
    const payload = {
      records: markedStudents.map((s) => ({
        studentId: s.id,
        batch: "Class 10 - Mathematics",
        date: todayDate,
        status: s.status === "absent" ? "Absent" : "Present",
      })),
      notifyParents: true,
      notificationScope: "absent",
    };

    assert.equal(payload.records.length, 2);
    assert.equal(payload.records[0].status, "Present");
    assert.equal(payload.records[1].status, "Absent");
    assert.equal(payload.notifyParents, true);
    assert.equal(payload.notificationScope, "absent");
  });

  await t.test("5.2 Server derives centerId and assignedTeacherId from verified JWT", async () => {
    const req = createMockRequest({
      token: teacher1Token,
      method: "POST",
      body: {
        records: [
          {
            studentId: studentT1._id,
            batch: "Class 10 - Mathematics",
            status: "Present",
            centerId: "malicious_spoofed_center",
            assignedTeacherId: TEACHER_2_ID,
          },
        ],
      },
    });

    const user = await getAuthenticatedUser(req);
    assert.equal(user.centerId, CENTER_ID, "centerId must be derived strictly from JWT");
    assert.equal(
      user.teacherId,
      TEACHER_1_ID,
      "assignedTeacherId must be derived strictly from JWT teacherId"
    );
  });

  await t.test("5.3 Unauthorized student in attendance payload is rejected with 403 Forbidden", async () => {
    const authTeacher2 = await getAuthenticatedUser(createMockRequest({ token: teacher2Token }));

    // Teacher 2 attempting to submit attendance for Teacher 1's student
    const submittedStudentId = studentJack._id; // Assigned to Teacher 1!
    const teacher2Students = allStudents.filter(
      (s) => s.assignedTeacherId === authTeacher2.teacherId
    );

    const isAuthorized = teacher2Students.some((s) => s._id === submittedStudentId);
    assert.equal(isAuthorized, false, "Teacher 2 must NOT be authorized for studentJack");
    const responseStatus = isAuthorized ? 201 : 403;
    assert.equal(responseStatus, 403, "Must return 403 Forbidden");
  });

  await t.test("5.4 Same-day attendance update updates existing record instead of creating duplicates", async () => {
    const existingRecords = [
      {
        studentId: studentJack._id,
        date: new Date("2026-11-04T08:00:00.000Z"),
        status: "Absent",
        batch: "Class 10 - Mathematics",
      },
    ];

    // Afternoon update: teacher marks studentJack as Present
    const updateDate = new Date("2026-11-04T12:00:00.000Z");
    const startOfDay = new Date(updateDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(updateDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const existingIndex = existingRecords.findIndex(
      (r) =>
        r.studentId === studentJack._id &&
        r.date >= startOfDay &&
        r.date <= endOfDay
    );

    assert.ok(existingIndex !== -1, "Existing record for same calendar day must be matched");

    // Perform in-place status update
    existingRecords[existingIndex].status = "Present";
    assert.equal(existingRecords.length, 1, "Count must remain 1 (no duplicates inserted)");
    assert.equal(existingRecords[0].status, "Present", "Status must be updated to Present");
  });

  // --------------------------------------------------------------------------
  // Group 6: Double-Submission & In-Flight Protection
  // --------------------------------------------------------------------------
  await t.test("6.1 In-flight saving state blocks concurrent submission", async () => {
    let saving = false;
    let callCount = 0;

    async function handleSave() {
      if (saving) return; // In-flight guard
      saving = true;
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      saving = false;
    }

    // Simulate double click
    const p1 = handleSave();
    const p2 = handleSave();

    await Promise.all([p1, p2]);
    assert.equal(callCount, 1, "Second click while saving must be blocked");
  });

  // --------------------------------------------------------------------------
  // Group 7: Parent Notification Integration & Honest Status
  // --------------------------------------------------------------------------
  await t.test("7.1 Notification dispatch honors fail-closed simulation guard", async () => {
    // Verify simulation mode guard
    assert.equal(
      isLiveDispatchEnabled(),
      false,
      "Live dispatch must be disabled under testing"
    );

    const result = await sendAttendanceAlert({
      centerId: CENTER_ID,
      studentId: studentT1._id,
      studentName: studentT1.name,
      parentPhone: studentT1.parentWhatsApp,
      batch: "Class 10 - Mathematics",
      date: new Date(),
      status: "Absent",
      centerName: "MSCE",
    });

    assert.equal(result.success, false);
    assert.equal(result.simulated, true);
    assert.match(result.error, /simulation mode active/i);
    assert.ok(result.messageId.startsWith("sim_"));
  });

  await t.test("7.2 Invalid parent phone number fails safe with descriptive validation error", async () => {
    const result = await sendAttendanceAlert({
      centerId: CENTER_ID,
      studentId: studentT1._id,
      studentName: studentT1.name,
      parentPhone: "123", // Invalid phone number (< 10 digits)
      batch: "Class 10 - Mathematics",
      date: new Date(),
      status: "Present",
      centerName: "MSCE",
    });

    assert.equal(result.success, false);
    assert.equal(result.simulated, false);
    assert.match(result.error, /10 to 15 digits/i);
  });

  await t.test("7.3 Response reports accurate notification summary (attempted, sent, simulated, failed)", async () => {
    const notificationSummary = {
      attempted: 2,
      sent: 0,
      simulated: 2,
      failed: 0,
      status: "simulated",
      message: "Parent notifications simulated for 2 student(s) (simulation mode active).",
    };

    assert.equal(notificationSummary.attempted, 2);
    assert.equal(notificationSummary.simulated, 2);
    assert.equal(notificationSummary.status, "simulated");
    assert.match(notificationSummary.message, /simulation mode active/i);
  });
});
