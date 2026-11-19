process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

// Import models
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const BatchModel = (await import("../tution-desk-be/src/models/Batch.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const AttendanceModel = (await import("../tution-desk-be/src/models/Attendance.ts")).default;
const AdmissionWelcomeJobModel = (await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts")).default;
const TestModel = (await import("../tution-desk-be/src/models/Test.ts")).default;

// Import route handlers
const { PATCH: patchBatchRoute } = await import(
  "../tution-desk-be/src/app/api/batches/[id]/route.ts"
);

function createMockRequest({
  method = "PATCH",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/batches/507f191e810c19729de86021",
}) {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body || {});
  const reqHeaders = new Headers(headers);
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  if (!reqHeaders.has("content-type")) {
    reqHeaders.set("content-type", "application/json");
  }
  reqHeaders.set("content-length", String(Buffer.byteLength(bodyString)));

  const parsedUrl = new URL(url);

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: parsedUrl,
    json: async () => (body ? (typeof body === "string" ? JSON.parse(body) : body) : {}),
    text: async () => bodyString,
    arrayBuffer: async () => Buffer.from(bodyString),
  };
}

test("Batch Edit & Teacher Transfer Feature Test Suite", async (t) => {
  const centerId = "center_msec";
  const foreignCenterId = "center_other";

  const ownerId = "507f191e810c19729de86001";
  const teacherAId = "507f191e810c19729de86002";
  const teacherBId = "507f191e810c19729de86003";
  const foreignOwnerId = "507f191e810c19729de86099";

  const batchId = "507f191e810c19729de86021";
  const student1Id = new mongoose.Types.ObjectId("507f191e810c19729de86011");
  const student2Id = new mongoose.Types.ObjectId("507f191e810c19729de86012");

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Sharma",
  });

  const teacherAToken = await signToken({
    userId: teacherAId,
    centerId,
    role: "teacher",
    teacherId: teacherAId,
    name: "Teacher A",
  });

  const foreignOwnerToken = await signToken({
    userId: foreignOwnerId,
    centerId: foreignCenterId,
    role: "owner",
    name: "Foreign Owner",
  });

  // Standalone unit test mock mode: disable Atlas replica set network wait
  mongoose.startSession = null;

  // 1. Unauthenticated PATCH returns 401
  await t.test("1. Unauthenticated PATCH returns HTTP 401", async () => {
    const req = createMockRequest({
      method: "PATCH",
      url: `http://localhost:3000/api/batches/${batchId}`,
      body: { name: "New Name" },
    });

    const res = await patchBatchRoute(req, {
      params: Promise.resolve({ id: batchId }),
    });
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  // 2. Teacher role cannot edit batch (HTTP 403)
  await t.test("2. Teacher role cannot edit or transfer batch (HTTP 403)", async () => {
    const req = createMockRequest({
      method: "PATCH",
      token: teacherAToken,
      url: `http://localhost:3000/api/batches/${batchId}`,
      body: { name: "Teacher Trying To Rename" },
    });

    const res = await patchBatchRoute(req, {
      params: Promise.resolve({ id: batchId }),
    });
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.success, false);
    assert.match(body.error, /Only Institute Owners are authorized/i);
  });

  // 3. Cross-center batch edit returns 404
  await t.test("3. Cross-center batch edit is rejected (HTTP 404)", async () => {
    const originalFindOne = BatchModel.findOne;
    BatchModel.findOne = async (query) => {
      // Batch belongs to center_msec, foreign owner is center_other
      if (query.centerId === centerId) {
        return { _id: new mongoose.Types.ObjectId(batchId), centerId, name: "Math 10" };
      }
      return null;
    };

    try {
      const req = createMockRequest({
        method: "PATCH",
        token: foreignOwnerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
        body: { name: "Foreign Hijack" },
      });

      const res = await patchBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 404);
      assert.equal(body.success, false);
      assert.match(body.error, /Batch not found/i);
    } finally {
      BatchModel.findOne = originalFindOne;
    }
  });

  // 4. Duplicate batch name within same center returns 409 Conflict
  await t.test("4. Duplicate batch name in same center returns HTTP 409", async () => {
    const originalFindOne = BatchModel.findOne;
    BatchModel.findOne = async (query) => {
      if (query._id && query.centerId === centerId) {
        return {
          _id: new mongoose.Types.ObjectId(batchId),
          centerId,
          name: "Class 10 - Math",
          timing: "10:00 AM",
          subject: "Math",
          save: async () => {},
        };
      }
      if (query.name === "Class 10 - Science" && query.centerId === centerId) {
        return {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86099"),
          centerId,
          name: "Class 10 - Science",
        };
      }
      return null;
    };

    try {
      const req = createMockRequest({
        method: "PATCH",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
        body: { name: "Class 10 - Science" },
      });

      const res = await patchBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 409);
      assert.equal(body.success, false);
      assert.match(body.error, /already exists/i);
    } finally {
      BatchModel.findOne = originalFindOne;
    }
  });

  // 5. Updating metadata (timing, subject) without name or teacher change
  await t.test("5. Owner updates batch timing and subject cleanly", async () => {
    let savedBatch = null;
    const originalFindOne = BatchModel.findOne;

    const mockBatch = {
      _id: new mongoose.Types.ObjectId(batchId),
      centerId,
      name: "Class 10 - Math",
      timing: "10:00 AM",
      subject: "Math",
      assignedTeacherId: new mongoose.Types.ObjectId(teacherAId),
      save: async function () {
        savedBatch = { ...this };
        return this;
      },
    };

    BatchModel.findOne = async () => mockBatch;

    try {
      const req = createMockRequest({
        method: "PATCH",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
        body: {
          timing: "4:00 PM - 5:30 PM (Mon, Wed, Fri)",
          subject: "Advanced Mathematics",
        },
      });

      const res = await patchBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(savedBatch.timing, "4:00 PM - 5:30 PM (Mon, Wed, Fri)");
      assert.equal(savedBatch.subject, "Advanced Mathematics");
      assert.equal(savedBatch.name, "Class 10 - Math");
      assert.equal(String(savedBatch.assignedTeacherId), teacherAId);
    } finally {
      BatchModel.findOne = originalFindOne;
    }
  });

  // 6. Transferring a batch from Teacher A to Teacher B
  await t.test("6. Owner transfers batch from Teacher A to Teacher B: updates batch, teachers, students", async () => {
    let batchSaved = null;
    let teacherAPulled = null;
    let teacherBAdded = null;
    let studentsUpdated = null;
    let feeUpdatesCount = 0;
    let welcomeJobsCreated = 0;

    const originalBatchFindOne = BatchModel.findOne;
    const originalTeacherFindOne = TeacherModel.findOne;
    const originalTeacherUpdateMany = TeacherModel.updateMany;
    const originalTeacherUpdateOne = TeacherModel.updateOne;
    const originalStudentUpdateMany = StudentModel.updateMany;
    const originalFeeUpdateMany = FeeModel.updateMany;
    const originalWelcomeJobCreate = AdmissionWelcomeJobModel.create;

    const mockBatch = {
      _id: new mongoose.Types.ObjectId(batchId),
      centerId,
      name: "Class 10 - Math",
      timing: "10:00 AM",
      subject: "Math",
      assignedTeacherId: new mongoose.Types.ObjectId(teacherAId),
      save: async function () {
        batchSaved = { ...this };
        return this;
      },
    };

    BatchModel.findOne = async () => mockBatch;

    TeacherModel.findOne = async (query) => {
      if (String(query._id) === teacherBId && query.centerId === centerId) {
        return {
          _id: new mongoose.Types.ObjectId(teacherBId),
          name: "Teacher B",
          centerId,
          assignedBatches: ["Physics 11"],
          isActive: true,
        };
      }
      return null;
    };

    TeacherModel.updateMany = async (query, update) => {
      // Old batch pull from teachers
      teacherAPulled = { query, update };
      return { acknowledged: true, modifiedCount: 1 };
    };

    TeacherModel.updateOne = async (query, update) => {
      // New batch add to teacher B
      teacherBAdded = { query, update };
      return { acknowledged: true, modifiedCount: 1 };
    };

    StudentModel.updateMany = async (query, update) => {
      studentsUpdated = { query, update };
      return { acknowledged: true, modifiedCount: 2 };
    };

    FeeModel.updateMany = async () => {
      feeUpdatesCount++;
      return { acknowledged: true };
    };

    AdmissionWelcomeJobModel.create = async () => {
      welcomeJobsCreated++;
      return {};
    };

    try {
      const req = createMockRequest({
        method: "PATCH",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
        body: {
          assignedTeacherId: teacherBId,
        },
      });

      const res = await patchBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);

      // Verify batch assignedTeacherId is updated to Teacher B
      assert.equal(String(batchSaved.assignedTeacherId), teacherBId);

      // Verify Teacher A had the batch pulled
      assert.deepEqual(teacherAPulled.update, {
        $pull: { assignedBatches: "Class 10 - Math" },
      });

      // Verify Teacher B had the batch added
      assert.equal(String(teacherBAdded.query._id), teacherBId);
      assert.deepEqual(teacherBAdded.update, {
        $addToSet: { assignedBatches: "Class 10 - Math" },
      });

      // Verify all students in the batch had assignedTeacherId updated to Teacher B
      assert.equal(String(studentsUpdated.update.$set.assignedTeacherId), teacherBId);

      // STRICT SAFETY GUARDRAIL: Verify 0 AdmissionWelcomeJob records created
      assert.equal(welcomeJobsCreated, 0, "ZERO welcome jobs must be created during transfer");

      // STRICT SAFETY GUARDRAIL: Verify Fee records are NEVER touched during transfer
      assert.equal(feeUpdatesCount, 0, "Fee documents must remain 100% untouched");
    } finally {
      BatchModel.findOne = originalBatchFindOne;
      TeacherModel.findOne = originalTeacherFindOne;
      TeacherModel.updateMany = originalTeacherUpdateMany;
      TeacherModel.updateOne = originalTeacherUpdateOne;
      StudentModel.updateMany = originalStudentUpdateMany;
      FeeModel.updateMany = originalFeeUpdateMany;
      AdmissionWelcomeJobModel.create = originalWelcomeJobCreate;
    }
  });

  // 7. Renaming batch and transferring teacher simultaneously
  await t.test("7. Owner renames batch and transfers teacher: propagates new name and new teacher", async () => {
    let batchSaved = null;
    let studentsUpdated = null;
    let attendanceUpdated = null;
    let testUpdated = null;

    const originalBatchFindOne = BatchModel.findOne;
    const originalTeacherFindOne = TeacherModel.findOne;
    const originalTeacherUpdateMany = TeacherModel.updateMany;
    const originalTeacherUpdateOne = TeacherModel.updateOne;
    const originalStudentUpdateMany = StudentModel.updateMany;
    const originalAttendanceUpdateMany = AttendanceModel.updateMany;
    const originalTestUpdateMany = TestModel.updateMany;

    const mockBatch = {
      _id: new mongoose.Types.ObjectId(batchId),
      centerId,
      name: "Old Batch Name",
      timing: "10:00 AM",
      subject: "Math",
      assignedTeacherId: new mongoose.Types.ObjectId(teacherAId),
      save: async function () {
        batchSaved = { ...this };
        return this;
      },
    };

    BatchModel.findOne = async (query) => {
      if (query._id && !query.name) return mockBatch;
      if (query.name === "New Batch Name") return null; // No duplicate
      return null;
    };

    TeacherModel.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(teacherBId),
      name: "Teacher B",
      centerId,
      isActive: true,
    });

    TeacherModel.updateMany = async () => ({ acknowledged: true });
    TeacherModel.updateOne = async () => ({ acknowledged: true });

    StudentModel.updateMany = async (query, update) => {
      studentsUpdated = { query, update };
      return { acknowledged: true };
    };

    AttendanceModel.updateMany = async (query, update) => {
      attendanceUpdated = { query, update };
      return { acknowledged: true };
    };

    TestModel.updateMany = async (query, update) => {
      testUpdated = { query, update };
      return { acknowledged: true };
    };

    try {
      const req = createMockRequest({
        method: "PATCH",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
        body: {
          name: "New Batch Name",
          assignedTeacherId: teacherBId,
        },
      });

      const res = await patchBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(batchSaved.name, "New Batch Name");
      assert.equal(String(batchSaved.assignedTeacherId), teacherBId);

      // Verify student batch name and teacher assignment updated
      assert.equal(studentsUpdated.update.$set.batch, "New Batch Name");
      assert.equal(String(studentsUpdated.update.$set.assignedTeacherId), teacherBId);

      // Verify Attendance and Test renamed
      assert.equal(attendanceUpdated.update.$set.batch, "New Batch Name");
      assert.equal(testUpdated.update.$set.batch, "New Batch Name");
    } finally {
      BatchModel.findOne = originalBatchFindOne;
      TeacherModel.findOne = originalTeacherFindOne;
      TeacherModel.updateMany = originalTeacherUpdateMany;
      TeacherModel.updateOne = originalTeacherUpdateOne;
      StudentModel.updateMany = originalStudentUpdateMany;
      AttendanceModel.updateMany = originalAttendanceUpdateMany;
      TestModel.updateMany = originalTestUpdateMany;
    }
  });

  // 8. Reassign to Owner Direct Management (Unassigned Teacher)
  await t.test("8. Owner unassigns teacher: sets batch and students assignedTeacherId to null", async () => {
    let batchSaved = null;
    let studentsUpdated = null;

    const originalBatchFindOne = BatchModel.findOne;
    const originalTeacherUpdateMany = TeacherModel.updateMany;
    const originalStudentUpdateMany = StudentModel.updateMany;

    const mockBatch = {
      _id: new mongoose.Types.ObjectId(batchId),
      centerId,
      name: "Class 10 - Math",
      assignedTeacherId: new mongoose.Types.ObjectId(teacherAId),
      save: async function () {
        batchSaved = { ...this };
        return this;
      },
    };

    BatchModel.findOne = async () => mockBatch;
    TeacherModel.updateMany = async () => ({ acknowledged: true });
    StudentModel.updateMany = async (query, update) => {
      studentsUpdated = { query, update };
      return { acknowledged: true };
    };

    try {
      const req = createMockRequest({
        method: "PATCH",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
        body: {
          assignedTeacherId: null,
        },
      });

      const res = await patchBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(batchSaved.assignedTeacherId, null);
      assert.equal(studentsUpdated.update.$set.assignedTeacherId, null);
    } finally {
      BatchModel.findOne = originalBatchFindOne;
      TeacherModel.updateMany = originalTeacherUpdateMany;
      StudentModel.updateMany = originalStudentUpdateMany;
    }
  });
});
