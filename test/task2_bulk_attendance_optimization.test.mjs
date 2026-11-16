process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: bulkAttendanceRoute } = await import(
  "../tution-desk-be/src/app/api/attendance/bulk/route.ts"
);

const AttendanceModel = (await import("../tution-desk-be/src/models/Attendance.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
const MessageCampaignModel = (await import("../tution-desk-be/src/models/MessageCampaign.ts")).default;
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  token,
  body = {},
}) {
  const reqHeaders = new Headers();
  reqHeaders.set("content-type", "application/json");
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }

  return {
    method: "POST",
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    json: async () => body,
  };
}

test("Task 2: Bulk Attendance API (F-01) Optimization & Security Suite", async (t) => {
  const centerAlpha = "center_task2_alpha";
  const centerBeta = "center_task2_beta";
  const ownerId = "507f191e810c19729de87001";
  const teacher1Id = "507f191e810c19729de87002";
  const teacher2Id = "507f191e810c19729de87003";

  const studentA = {
    _id: new mongoose.Types.ObjectId("507f191e810c19729de87101"),
    centerId: centerAlpha,
    assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
    batch: "Batch Physics",
    name: "Student Alpha One",
    parentWhatsApp: "9876543201",
  };

  const studentB = {
    _id: new mongoose.Types.ObjectId("507f191e810c19729de87102"),
    centerId: centerAlpha,
    assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
    batch: "Batch Physics",
    name: "Student Alpha Two",
    parentWhatsApp: "9876543202",
  };

  const studentTeacher2 = {
    _id: new mongoose.Types.ObjectId("507f191e810c19729de87103"),
    centerId: centerAlpha,
    assignedTeacherId: new mongoose.Types.ObjectId(teacher2Id),
    batch: "Batch Chemistry",
    name: "Student Alpha Three",
    parentWhatsApp: "9876543203",
  };

  const foreignStudentBeta = {
    _id: new mongoose.Types.ObjectId("507f191e810c19729de87201"),
    centerId: centerBeta,
    assignedTeacherId: null,
    batch: "Batch Beta",
    name: "Student Beta One",
    parentWhatsApp: "9876543204",
  };

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerAlpha,
    role: "owner",
    name: "Owner Director",
  });

  const teacher1Token = await signToken({
    userId: teacher1Id,
    teacherId: teacher1Id,
    centerId: centerAlpha,
    role: "teacher",
    name: "Teacher One",
  });

  const setupStudentMocks = (students) => {
    StudentModel.find = (query) => {
      const filtered = students.filter((s) => {
        if (query.centerId && s.centerId !== query.centerId) return false;
        if (query.assignedTeacherId && String(s.assignedTeacherId) !== String(query.assignedTeacherId)) return false;
        if (query._id?.$in) {
          const idStrings = query._id.$in.map((id) => String(id));
          return idStrings.includes(String(s._id));
        }
        return true;
      });
      return {
        select: async () => filtered,
      };
    };
  };

  await t.test("1. Create New Attendance: Fresh batch of students executes 1 find and 1 bulkWrite", async () => {
    setupStudentMocks([studentA, studentB]);

    let findCalls = 0;
    let bulkWriteOps = null;

    AttendanceModel.find = (query) => {
      findCalls++;
      assert.equal(query.centerId, centerAlpha);
      return []; // No existing records
    };

    AttendanceModel.bulkWrite = async (ops, opts) => {
      bulkWriteOps = ops;
      assert.equal(opts.ordered, true);
      return { insertedCount: ops.length, modifiedCount: 0 };
    };

    const req = createMockRequest({
      token: ownerToken,
      body: [
        { studentId: studentA._id.toString(), batch: "Batch Physics", status: "Present" },
        { studentId: studentB._id.toString(), batch: "Batch Physics", status: "Absent" },
      ],
    });

    const res = await bulkAttendanceRoute(req);
    assert.equal(res.status, 201);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.count, 2);
    assert.equal(findCalls, 1, "Exactly 1 Attendance.find must be called for the entire batch");
    assert.ok(bulkWriteOps, "Attendance.bulkWrite must be called");
    assert.equal(bulkWriteOps.length, 2);
    assert.ok(bulkWriteOps[0].insertOne, "First record must be insertOne");
    assert.equal(bulkWriteOps[0].insertOne.document.status, "Present");
    assert.ok(bulkWriteOps[1].insertOne, "Second record must be insertOne");
    assert.equal(bulkWriteOps[1].insertOne.document.status, "Absent");
  });

  await t.test("2. Update Existing Attendance: Same student on same day generates updateOne bulk operation", async () => {
    setupStudentMocks([studentA]);

    const existingId = new mongoose.Types.ObjectId();
    const existingDoc = {
      _id: existingId,
      centerId: centerAlpha,
      studentId: studentA._id,
      date: new Date(),
      batch: "Batch Physics",
      status: "Present",
      assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
    };

    AttendanceModel.find = () => [existingDoc];

    let bulkWriteOps = null;
    AttendanceModel.bulkWrite = async (ops) => {
      bulkWriteOps = ops;
      return { insertedCount: 0, modifiedCount: 1 };
    };

    const req = createMockRequest({
      token: ownerToken,
      body: [
        { studentId: studentA._id.toString(), batch: "Batch Physics - Updated", status: "Absent" },
      ],
    });

    const res = await bulkAttendanceRoute(req);
    assert.equal(res.status, 201);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.count, 1);
    assert.equal(data.data[0].status, "Absent");
    assert.equal(data.data[0].batch, "Batch Physics - Updated");

    assert.ok(bulkWriteOps);
    assert.equal(bulkWriteOps.length, 1);
    assert.ok(bulkWriteOps[0].updateOne);
    assert.equal(bulkWriteOps[0].updateOne.filter._id.toString(), existingId.toString());
    assert.equal(bulkWriteOps[0].updateOne.update.$set.status, "Absent");
    assert.equal(bulkWriteOps[0].updateOne.update.$set.batch, "Batch Physics - Updated");
  });

  await t.test("3. Duplicate Student in Same Payload: Updates in-memory to latest status without creating duplicates", async () => {
    setupStudentMocks([studentA]);

    AttendanceModel.find = () => []; // No pre-existing record

    let bulkWriteOps = null;
    AttendanceModel.bulkWrite = async (ops) => {
      bulkWriteOps = ops;
      return { insertedCount: 1, modifiedCount: 1 };
    };

    // Payload passes Student A as "Present", then later in the array updates to "Absent"
    const req = createMockRequest({
      token: ownerToken,
      body: [
        { studentId: studentA._id.toString(), batch: "Batch Physics", status: "Present" },
        { studentId: studentA._id.toString(), batch: "Batch Physics", status: "Absent" },
      ],
    });

    const res = await bulkAttendanceRoute(req);
    assert.equal(res.status, 201);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.count, 2);

    // bulkWrite ops: 1 insertOne for the initial entry, 1 updateOne targeting that exact _id for the subsequent update
    assert.ok(bulkWriteOps);
    assert.equal(bulkWriteOps.length, 2);
    assert.ok(bulkWriteOps[0].insertOne);
    assert.ok(bulkWriteOps[1].updateOne);

    const insertedId = bulkWriteOps[0].insertOne.document._id;
    assert.equal(bulkWriteOps[1].updateOne.filter._id.toString(), insertedId.toString());
    assert.equal(bulkWriteOps[1].updateOne.update.$set.status, "Absent");
  });

  await t.test("4. Input Validation: Rejects empty payload, invalid IDs, missing batch, and invalid status", async () => {
    // 4.1 Empty payload
    const reqEmpty = createMockRequest({ token: ownerToken, body: [] });
    const resEmpty = await bulkAttendanceRoute(reqEmpty);
    assert.equal(resEmpty.status, 400);
    const dataEmpty = await resEmpty.json();
    assert.equal(dataEmpty.error, "Attendance records are required");

    // 4.2 Invalid studentId
    const reqInvalidId = createMockRequest({
      token: ownerToken,
      body: [{ studentId: "not-a-valid-id", batch: "Batch A", status: "Present" }],
    });
    const resInvalidId = await bulkAttendanceRoute(reqInvalidId);
    assert.equal(resInvalidId.status, 400);
    const dataInvalidId = await resInvalidId.json();
    assert.ok(dataInvalidId.error.includes("Invalid studentId"));

    // 4.3 Missing batch
    const reqMissingBatch = createMockRequest({
      token: ownerToken,
      body: [{ studentId: studentA._id.toString(), batch: "", status: "Present" }],
    });
    const resMissingBatch = await bulkAttendanceRoute(reqMissingBatch);
    assert.equal(resMissingBatch.status, 400);
    const dataMissingBatch = await resMissingBatch.json();
    assert.ok(dataMissingBatch.error.includes("Batch is required"));

    // 4.4 Invalid status
    const reqInvalidStatus = createMockRequest({
      token: ownerToken,
      body: [{ studentId: studentA._id.toString(), batch: "Batch A", status: "Late" }],
    });
    const resInvalidStatus = await bulkAttendanceRoute(reqInvalidStatus);
    assert.equal(resInvalidStatus.status, 400);
    const dataInvalidStatus = await resInvalidStatus.json();
    assert.ok(dataInvalidStatus.error.includes("Status must be Present or Absent"));
  });

  await t.test("5. Multi-Tenant Authorization: Cross-center student in bulk request rejected with 403", async () => {
    // Mock students in centerAlpha; foreign student belongs to centerBeta
    setupStudentMocks([studentA, studentB]);

    const req = createMockRequest({
      token: ownerToken, // Owner of Center Alpha
      body: [
        { studentId: studentA._id.toString(), batch: "Batch Physics", status: "Present" },
        { studentId: foreignStudentBeta._id.toString(), batch: "Batch Beta", status: "Present" }, // Center Beta student!
      ],
    });

    const res = await bulkAttendanceRoute(req);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes("One or more student records do not exist in this institute"));
  });

  await t.test("6. Teacher Role Scoping: Teacher cannot mark attendance for student assigned to another teacher", async () => {
    // Student A belongs to Teacher 1; Student Teacher 2 belongs to Teacher 2
    setupStudentMocks([studentA, studentB, studentTeacher2]);

    const req = createMockRequest({
      token: teacher1Token, // Teacher 1
      body: [
        { studentId: studentA._id.toString(), batch: "Batch Physics", status: "Present" },
        { studentId: studentTeacher2._id.toString(), batch: "Batch Chemistry", status: "Present" }, // Teacher 2 student!
      ],
    });

    const res = await bulkAttendanceRoute(req);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes("Cannot record attendance for students not assigned to your account"));
  });
});
