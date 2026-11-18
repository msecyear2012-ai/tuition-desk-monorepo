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
const FeeCreationLockModel = (await import("../tution-desk-be/src/models/FeeCreationLock.ts")).default;
const FeeReminderLogModel = (await import("../tution-desk-be/src/models/FeeReminderLog.ts")).default;
const PaymentProofModel = (await import("../tution-desk-be/src/models/PaymentProof.ts")).default;
const AttendanceModel = (await import("../tution-desk-be/src/models/Attendance.ts")).default;
const AdmissionWelcomeJobModel = (await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts")).default;
const MessageCampaignModel = (await import("../tution-desk-be/src/models/MessageCampaign.ts")).default;
const ParentAccessModel = (await import("../tution-desk-be/src/models/ParentAccess.ts")).default;
const ParentAccessLockModel = (await import("../tution-desk-be/src/models/ParentAccessLock.ts")).default;
const StudentBatchRequestModel = (await import("../tution-desk-be/src/models/StudentBatchRequest.ts")).default;
const TestModel = (await import("../tution-desk-be/src/models/Test.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const StaffNotificationModel = (await import("../tution-desk-be/src/models/StaffNotification.ts")).default;

// Import route handlers
const { GET: getBatchRoute, DELETE: deleteBatchRoute } = await import(
  "../tution-desk-be/src/app/api/batches/[id]/route.ts"
);

function createMockRequest({
  method = "GET",
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

function createMockQuery(data = []) {
  const query = {
    sort: () => query,
    populate: () => query,
    select: () => query,
    then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
    catch: (reject) => Promise.resolve(data).catch(reject),
    [Symbol.asyncIterator]: () => data[Symbol.asyncIterator](),
  };
  return query;
}

test("Batch Cascade Deletion & Multi-Tenant Isolation Suite", async (t) => {
  const centerId = "center_msec";
  const foreignCenterId = "center_other";

  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";
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

  const teacherToken = await signToken({
    userId: teacherId,
    centerId,
    role: "teacher",
    teacherId,
    name: "Teacher Verma",
  });

  const foreignOwnerToken = await signToken({
    userId: foreignOwnerId,
    centerId: foreignCenterId,
    role: "owner",
    name: "Foreign Owner",
  });

  const sampleBatch = {
    _id: new mongoose.Types.ObjectId(batchId),
    centerId,
    name: "10th Grade Math",
    timing: "10:00 AM",
    subject: "Mathematics",
    isActive: true,
  };

  const originalStartSession = mongoose.startSession;
  mongoose.startSession = null; // Default to non-transactional standalone mode for isolated unit testing

  // 1. Unauthenticated DELETE returns 401
  await t.test("1. Unauthenticated DELETE returns HTTP 401", async () => {
    const req = createMockRequest({
      method: "DELETE",
      url: `http://localhost:3000/api/batches/${batchId}`,
    });

    const res = await deleteBatchRoute(req, {
      params: Promise.resolve({ id: batchId }),
    });
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  // 2. Teacher role DELETE returns 403
  await t.test("2. Teacher role cannot delete batch (HTTP 403)", async () => {
    const req = createMockRequest({
      method: "DELETE",
      token: teacherToken,
      url: `http://localhost:3000/api/batches/${batchId}`,
    });

    const res = await deleteBatchRoute(req, {
      params: Promise.resolve({ id: batchId }),
    });
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.success, false);
    assert.match(body.error, /Only Institute Owners/i);
  });

  // 3. Foreign owner cannot delete batch of another center (HTTP 404 - isolation)
  await t.test("3. Multi-tenant isolation: Foreign center owner cannot delete batch (HTTP 404)", async () => {
    const originalFindOne = BatchModel.findOne;
    BatchModel.findOne = async (query) => {
      if (query._id.toString() === batchId && query.centerId === centerId) {
        return sampleBatch;
      }
      return null;
    };

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: foreignOwnerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });

      const res = await deleteBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 404);
      assert.equal(body.success, false);
      assert.equal(body.error, "Batch not found");
    } finally {
      BatchModel.findOne = originalFindOne;
    }
  });

  // 4. Invalid batch ID returns 400
  await t.test("4. Invalid batch ID returns HTTP 400", async () => {
    const req = createMockRequest({
      method: "DELETE",
      token: ownerToken,
      url: "http://localhost:3000/api/batches/invalid-object-id",
    });

    const res = await deleteBatchRoute(req, {
      params: Promise.resolve({ id: "invalid-object-id" }),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.success, false);
    assert.match(body.error, /Valid Batch ID is required/i);
  });

  // 5. Full Cascade Deletion with Active Students
  await t.test("5. Owner cascades batch deletion across all student and batch collections", async () => {
    const deletedRecords = {
      fees: null,
      feeLocks: null,
      feeReminderLogs: null,
      paymentProofs: null,
      parentAccessLocks: null,
      parentAccessPull: null,
      parentAccessDeleted: null,
      campaignsPulled: null,
      campaignsCancelled: null,
      students: null,
      attendance: null,
      welcomeJobs: null,
      batchRequests: null,
      tests: null,
      teacherBatches: null,
      notifications: null,
      batch: null,
    };

    const originalBatchFindOne = BatchModel.findOne;
    const originalBatchDeleteOne = BatchModel.deleteOne;
    const originalStudentFind = StudentModel.find;
    const originalStudentDeleteMany = StudentModel.deleteMany;
    const originalFeeDeleteMany = FeeModel.deleteMany;
    const originalFeeLockDeleteMany = FeeCreationLockModel.deleteMany;
    const originalFeeReminderDeleteMany = FeeReminderLogModel.deleteMany;
    const originalPaymentProofDeleteMany = PaymentProofModel.deleteMany;
    const originalParentAccessUpdateMany = ParentAccessModel.updateMany;
    const originalParentAccessDeleteMany = ParentAccessModel.deleteMany;
    const originalParentAccessLockDeleteMany = ParentAccessLockModel.deleteMany;
    const originalCampaignUpdateMany = MessageCampaignModel.updateMany;
    const originalAttendanceDeleteMany = AttendanceModel.deleteMany;
    const originalWelcomeJobDeleteMany = AdmissionWelcomeJobModel.deleteMany;
    const originalBatchRequestDeleteMany = StudentBatchRequestModel.deleteMany;
    const originalTestDeleteMany = TestModel.deleteMany;
    const originalTeacherUpdateMany = TeacherModel.updateMany;
    const originalNotificationDeleteMany = StaffNotificationModel.deleteMany;

    BatchModel.findOne = async () => sampleBatch;
    BatchModel.deleteOne = async (query, opts) => {
      deletedRecords.batch = { query, opts };
      return { acknowledged: true, deletedCount: 1 };
    };

    StudentModel.find = () =>
      createMockQuery([
        { _id: student1Id },
        { _id: student2Id },
      ]);

    StudentModel.deleteMany = async (query, opts) => {
      deletedRecords.students = { query, opts };
      return { acknowledged: true, deletedCount: 2 };
    };

    FeeModel.deleteMany = async (query, opts) => {
      deletedRecords.fees = { query, opts };
      return { acknowledged: true, deletedCount: 5 };
    };

    FeeCreationLockModel.deleteMany = async (query, opts) => {
      deletedRecords.feeLocks = { query, opts };
      return { acknowledged: true, deletedCount: 2 };
    };

    FeeReminderLogModel.deleteMany = async (query, opts) => {
      deletedRecords.feeReminderLogs = { query, opts };
      return { acknowledged: true, deletedCount: 3 };
    };

    PaymentProofModel.deleteMany = async (query, opts) => {
      deletedRecords.paymentProofs = { query, opts };
      return { acknowledged: true, deletedCount: 1 };
    };

    ParentAccessModel.updateMany = async (query, update, opts) => {
      deletedRecords.parentAccessPull = { query, update, opts };
      return { acknowledged: true, modifiedCount: 2 };
    };

    ParentAccessModel.deleteMany = async (query, opts) => {
      deletedRecords.parentAccessDeleted = { query, opts };
      return { acknowledged: true, deletedCount: 1 };
    };

    ParentAccessLockModel.deleteMany = async (query, opts) => {
      deletedRecords.parentAccessLocks = { query, opts };
      return { acknowledged: true, deletedCount: 2 };
    };

    let campaignCalls = 0;
    MessageCampaignModel.updateMany = async (query, update, opts) => {
      campaignCalls++;
      if (campaignCalls === 1) {
        deletedRecords.campaignsPulled = { query, update, opts };
      } else {
        deletedRecords.campaignsCancelled = { query, update, opts };
      }
      return { acknowledged: true, modifiedCount: 1 };
    };

    AttendanceModel.deleteMany = async (query, opts) => {
      deletedRecords.attendance = { query, opts };
      return { acknowledged: true, deletedCount: 10 };
    };

    AdmissionWelcomeJobModel.deleteMany = async (query, opts) => {
      deletedRecords.welcomeJobs = { query, opts };
      return { acknowledged: true, deletedCount: 2 };
    };

    StudentBatchRequestModel.deleteMany = async (query, opts) => {
      deletedRecords.batchRequests = { query, opts };
      return { acknowledged: true, deletedCount: 1 };
    };

    TestModel.deleteMany = async (query, opts) => {
      deletedRecords.tests = { query, opts };
      return { acknowledged: true, deletedCount: 4 };
    };

    TeacherModel.updateMany = async (query, update, opts) => {
      deletedRecords.teacherBatches = { query, update, opts };
      return { acknowledged: true, modifiedCount: 1 };
    };

    StaffNotificationModel.deleteMany = async (query, opts) => {
      deletedRecords.notifications = { query, opts };
      return { acknowledged: true, deletedCount: 6 };
    };

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });

      const res = await deleteBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.deletedBatchId, batchId);
      assert.equal(body.data.deletedBatchName, "10th Grade Math");
      assert.equal(body.data.deletedStudentsCount, 2);

      // Verify Fee deletion
      assert.deepEqual(deletedRecords.fees.query.studentId, {
        $in: [student1Id, student2Id],
      });
      assert.equal(deletedRecords.fees.query.centerId, centerId);

      // Verify FeeCreationLock deletion
      assert.deepEqual(deletedRecords.feeLocks.query.studentId, {
        $in: [student1Id.toString(), student2Id.toString()],
      });

      // Verify Student deletion
      assert.deepEqual(deletedRecords.students.query._id, {
        $in: [student1Id, student2Id],
      });

      // Verify ParentAccess update & cleanup
      assert.deepEqual(deletedRecords.parentAccessPull.query.linkedStudentIds, {
        $in: [student1Id, student2Id],
      });
      assert.deepEqual(deletedRecords.parentAccessDeleted.query.linkedStudentIds, {
        $size: 0,
      });

      // Verify Campaign message pulling
      assert.deepEqual(deletedRecords.campaignsPulled.query["messages.studentId"], {
        $in: [student1Id, student2Id],
      });

      // Verify Attendance batch & student deletion
      assert.equal(deletedRecords.attendance.query.centerId, centerId);
      assert.deepEqual(deletedRecords.attendance.query.$or, [
        { batch: "10th Grade Math" },
        { studentId: { $in: [student1Id, student2Id] } },
      ]);

      // Verify AdmissionWelcomeJob deletion
      assert.deepEqual(deletedRecords.welcomeJobs.query.$or, [
        { batchName: "10th Grade Math" },
        { studentId: { $in: [student1Id, student2Id] } },
      ]);

      // Verify StudentBatchRequest deletion
      assert.deepEqual(deletedRecords.batchRequests.query.$or, [
        { batchName: "10th Grade Math" },
        { batchId: sampleBatch._id },
        { studentId: { $in: [student1Id, student2Id] } },
      ]);

      // Verify Teacher assignedBatches update
      assert.equal(deletedRecords.teacherBatches.query.assignedBatches, "10th Grade Math");
      assert.deepEqual(deletedRecords.teacherBatches.update, {
        $pull: { assignedBatches: "10th Grade Math" },
      });

      // Verify Batch deletion
      assert.deepEqual(deletedRecords.batch.query, {
        _id: sampleBatch._id,
        centerId,
      });
    } finally {
      BatchModel.findOne = originalBatchFindOne;
      BatchModel.deleteOne = originalBatchDeleteOne;
      StudentModel.find = originalStudentFind;
      StudentModel.deleteMany = originalStudentDeleteMany;
      FeeModel.deleteMany = originalFeeDeleteMany;
      FeeCreationLockModel.deleteMany = originalFeeLockDeleteMany;
      FeeReminderLogModel.deleteMany = originalFeeReminderDeleteMany;
      PaymentProofModel.deleteMany = originalPaymentProofDeleteMany;
      ParentAccessModel.updateMany = originalParentAccessUpdateMany;
      ParentAccessModel.deleteMany = originalParentAccessDeleteMany;
      ParentAccessLockModel.deleteMany = originalParentAccessLockDeleteMany;
      MessageCampaignModel.updateMany = originalCampaignUpdateMany;
      AttendanceModel.deleteMany = originalAttendanceDeleteMany;
      AdmissionWelcomeJobModel.deleteMany = originalWelcomeJobDeleteMany;
      StudentBatchRequestModel.deleteMany = originalBatchRequestDeleteMany;
      TestModel.deleteMany = originalTestDeleteMany;
      TeacherModel.updateMany = originalTeacherUpdateMany;
      StaffNotificationModel.deleteMany = originalNotificationDeleteMany;
    }
  });

  // 6. Cascade Deletion on Empty Batch (0 students)
  await t.test("6. Deleting an empty batch succeeds without touching student records", async () => {
    let studentDeleteCalled = false;
    let feeDeleteCalled = false;
    let batchDeleted = false;

    const originalBatchFindOne = BatchModel.findOne;
    const originalBatchDeleteOne = BatchModel.deleteOne;
    const originalStudentFind = StudentModel.find;
    const originalStudentDeleteMany = StudentModel.deleteMany;
    const originalFeeDeleteMany = FeeModel.deleteMany;
    const originalAttendanceDeleteMany = AttendanceModel.deleteMany;
    const originalWelcomeJobDeleteMany = AdmissionWelcomeJobModel.deleteMany;
    const originalBatchRequestDeleteMany = StudentBatchRequestModel.deleteMany;
    const originalTestDeleteMany = TestModel.deleteMany;
    const originalTeacherUpdateMany = TeacherModel.updateMany;
    const originalNotificationDeleteMany = StaffNotificationModel.deleteMany;

    BatchModel.findOne = async () => sampleBatch;
    StudentModel.find = () => createMockQuery([]); // 0 students

    StudentModel.deleteMany = async () => {
      studentDeleteCalled = true;
      return { acknowledged: true, deletedCount: 0 };
    };

    FeeModel.deleteMany = async () => {
      feeDeleteCalled = true;
      return { acknowledged: true, deletedCount: 0 };
    };

    AttendanceModel.deleteMany = async () => ({ acknowledged: true, deletedCount: 0 });
    AdmissionWelcomeJobModel.deleteMany = async () => ({ acknowledged: true, deletedCount: 0 });
    StudentBatchRequestModel.deleteMany = async () => ({ acknowledged: true, deletedCount: 0 });
    TestModel.deleteMany = async () => ({ acknowledged: true, deletedCount: 0 });
    TeacherModel.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    StaffNotificationModel.deleteMany = async () => ({ acknowledged: true, deletedCount: 0 });

    BatchModel.deleteOne = async () => {
      batchDeleted = true;
      return { acknowledged: true, deletedCount: 1 };
    };

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });

      const res = await deleteBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.deletedStudentsCount, 0);
      assert.equal(studentDeleteCalled, false);
      assert.equal(feeDeleteCalled, false);
      assert.equal(batchDeleted, true);
    } finally {
      BatchModel.findOne = originalBatchFindOne;
      BatchModel.deleteOne = originalBatchDeleteOne;
      StudentModel.find = originalStudentFind;
      StudentModel.deleteMany = originalStudentDeleteMany;
      FeeModel.deleteMany = originalFeeDeleteMany;
      AttendanceModel.deleteMany = originalAttendanceDeleteMany;
      AdmissionWelcomeJobModel.deleteMany = originalWelcomeJobDeleteMany;
      StudentBatchRequestModel.deleteMany = originalBatchRequestDeleteMany;
      TestModel.deleteMany = originalTestDeleteMany;
      TeacherModel.updateMany = originalTeacherUpdateMany;
      StaffNotificationModel.deleteMany = originalNotificationDeleteMany;
    }
  });

  // 7. Multi-Document Transaction Support & Rollback Handling
  await t.test("7. Transaction coordinates commit on success and rollback on failure", async () => {
    let transactionStarted = false;
    let transactionCommitted = false;
    let transactionAborted = false;
    let sessionEnded = false;

    const mockSession = {
      startTransaction() {
        transactionStarted = true;
      },
      async commitTransaction() {
        transactionCommitted = true;
      },
      async abortTransaction() {
        transactionAborted = true;
      },
      async endSession() {
        sessionEnded = true;
      },
    };

    const originalStartSession = mongoose.startSession;
    const originalBatchFindOne = BatchModel.findOne;
    const originalBatchDeleteOne = BatchModel.deleteOne;
    const originalStudentFind = StudentModel.find;
    const originalAttendanceDeleteMany = AttendanceModel.deleteMany;
    const originalWelcomeJobDeleteMany = AdmissionWelcomeJobModel.deleteMany;
    const originalBatchRequestDeleteMany = StudentBatchRequestModel.deleteMany;
    const originalTestDeleteMany = TestModel.deleteMany;
    const originalTeacherUpdateMany = TeacherModel.updateMany;
    const originalNotificationDeleteMany = StaffNotificationModel.deleteMany;

    mongoose.startSession = async () => mockSession;
    BatchModel.findOne = async () => sampleBatch;
    StudentModel.find = () => createMockQuery([]);
    AttendanceModel.deleteMany = async () => ({ acknowledged: true });
    AdmissionWelcomeJobModel.deleteMany = async () => ({ acknowledged: true });
    StudentBatchRequestModel.deleteMany = async () => ({ acknowledged: true });
    TestModel.deleteMany = async () => ({ acknowledged: true });
    TeacherModel.updateMany = async () => ({ acknowledged: true });
    StaffNotificationModel.deleteMany = async () => ({ acknowledged: true });
    BatchModel.deleteOne = async () => ({ acknowledged: true, deletedCount: 1 });

    try {
      // 7a. Normal commit
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });

      const res = await deleteBatchRoute(req, {
        params: Promise.resolve({ id: batchId }),
      });
      assert.equal(res.status, 200);
      assert.equal(transactionStarted, true);
      assert.equal(transactionCommitted, true);
      assert.equal(transactionAborted, false);
      assert.equal(sessionEnded, true);

      // 7b. Abort on unexpected database failure
      transactionStarted = false;
      transactionCommitted = false;
      transactionAborted = false;
      sessionEnded = false;

      BatchModel.deleteOne = async () => {
        throw new Error("DB_WRITE_CONFLICT");
      };

      const failReq = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });

      const failRes = await deleteBatchRoute(failReq, {
        params: Promise.resolve({ id: batchId }),
      });
      const failBody = await failRes.json();

      assert.equal(failRes.status, 500);
      assert.equal(failBody.success, false);
      assert.equal(failBody.error, "DB_WRITE_CONFLICT");
      assert.equal(transactionStarted, true);
      assert.equal(transactionCommitted, false);
      assert.equal(transactionAborted, true);
      assert.equal(sessionEnded, true);
    } finally {
      mongoose.startSession = originalStartSession;
      BatchModel.findOne = originalBatchFindOne;
      BatchModel.deleteOne = originalBatchDeleteOne;
      StudentModel.find = originalStudentFind;
      AttendanceModel.deleteMany = originalAttendanceDeleteMany;
      AdmissionWelcomeJobModel.deleteMany = originalWelcomeJobDeleteMany;
      StudentBatchRequestModel.deleteMany = originalBatchRequestDeleteMany;
      TestModel.deleteMany = originalTestDeleteMany;
      TeacherModel.updateMany = originalTeacherUpdateMany;
      StaffNotificationModel.deleteMany = originalNotificationDeleteMany;
    }
  });

  // 8. GET Batch Details & Access Control Verification
  await t.test("8. GET /api/batches/[id] enforces authentication, center isolation and teacher scoping", async () => {
    const originalBatchFindOne = BatchModel.findOne;
    const originalStudentFind = StudentModel.find;
    const originalTeacherFindOne = TeacherModel.findOne;

    BatchModel.findOne = async (query) => {
      if (query._id.toString() === batchId && query.centerId === centerId) {
        return sampleBatch;
      }
      return null;
    };

    StudentModel.find = () => createMockQuery([]);
    TeacherModel.findOne = () =>
      createMockQuery({
        _id: new mongoose.Types.ObjectId(teacherId),
        assignedBatches: ["10th Grade Math"],
      });

    try {
      // 8a. Unauthenticated GET returns 401
      const unauthReq = createMockRequest({
        method: "GET",
        url: `http://localhost:3000/api/batches/${batchId}`,
      });
      const unauthRes = await getBatchRoute(unauthReq, {
        params: Promise.resolve({ id: batchId }),
      });
      assert.equal(unauthRes.status, 401);

      // 8b. Owner GET returns 200
      const ownerReq = createMockRequest({
        method: "GET",
        token: ownerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });
      const ownerRes = await getBatchRoute(ownerReq, {
        params: Promise.resolve({ id: batchId }),
      });
      const ownerBody = await ownerRes.json();
      assert.equal(ownerRes.status, 200);
      assert.equal(ownerBody.data.name, "10th Grade Math");

      // 8c. Assigned Teacher GET returns 200
      const teacherReq = createMockRequest({
        method: "GET",
        token: teacherToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });
      const teacherRes = await getBatchRoute(teacherReq, {
        params: Promise.resolve({ id: batchId }),
      });
      const teacherBody = await teacherRes.json();
      assert.equal(teacherRes.status, 200);
      assert.equal(teacherBody.data.name, "10th Grade Math");

      // 8d. Unassigned Teacher GET returns 403
      TeacherModel.findOne = () =>
        createMockQuery({
          _id: new mongoose.Types.ObjectId(teacherId),
          assignedBatches: ["Different Batch"],
        });
      const unassignedTeacherRes = await getBatchRoute(teacherReq, {
        params: Promise.resolve({ id: batchId }),
      });
      assert.equal(unassignedTeacherRes.status, 403);

      // 8e. Foreign Owner GET returns 404
      const foreignReq = createMockRequest({
        method: "GET",
        token: foreignOwnerToken,
        url: `http://localhost:3000/api/batches/${batchId}`,
      });
      const foreignRes = await getBatchRoute(foreignReq, {
        params: Promise.resolve({ id: batchId }),
      });
      assert.equal(foreignRes.status, 404);
    } finally {
      BatchModel.findOne = originalBatchFindOne;
      StudentModel.find = originalStudentFind;
      TeacherModel.findOne = originalTeacherFindOne;
    }
  });
});
