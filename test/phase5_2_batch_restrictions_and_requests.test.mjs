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

// Import backend models & routes
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const BatchModel = (await import("../tution-desk-be/src/models/Batch.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
const StudentBatchRequestModel = (
  await import("../tution-desk-be/src/models/StudentBatchRequest.ts")
).default;

const { POST: postBatchRoute } = await import(
  "../tution-desk-be/src/app/api/batches/route.ts"
);
const { PUT: putStudentRoute } = await import(
  "../tution-desk-be/src/app/api/students/[id]/route.ts"
);
const { GET: getBatchRequestsRoute, POST: postBatchRequestRoute } = await import(
  "../tution-desk-be/src/app/api/batch-requests/route.ts"
);
const { PUT: putApproveBatchRequestRoute } = await import(
  "../tution-desk-be/src/app/api/batch-requests/[id]/approve/route.ts"
);
const { PUT: putRejectBatchRequestRoute } = await import(
  "../tution-desk-be/src/app/api/batch-requests/[id]/reject/route.ts"
);

function createMockRequest({
  method = "GET",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/batch-requests",
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
    distinct: async () => data.map((item) => (item && item._id ? item._id : item)),
    then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
    catch: (reject) => Promise.resolve(data).catch(reject),
    [Symbol.asyncIterator]: () => data[Symbol.asyncIterator](),
  };
  return query;
}

test("Phase 5.2: Teacher Batch Restrictions & Student Assignment Request Workflow (REQ-01)", async (t) => {
  const centerId = "center_msec";
  const foreignCenterId = "center_other";

  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";
  const foreignOwnerId = "507f191e810c19729de86099";

  const studentAId = "507f191e810c19729de86011";
  const batch1Id = "507f191e810c19729de86021";
  const batch2Id = "507f191e810c19729de86022";
  const requestId = "507f191e810c19729de86031";

  const originalStartSession = mongoose.startSession;
  mongoose.startSession = null; // Default to non-transactional standalone mode for isolated unit testing

  // Auth tokens
  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Jitender Kumar (Owner)",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    centerId,
    role: "teacher",
    teacherId,
    name: "R. K. Sharma (Teacher)",
  });

  const foreignToken = await signToken({
    userId: foreignOwnerId,
    centerId: foreignCenterId,
    role: "owner",
    name: "Other Center Owner",
  });

  // Base mock documents
  const sampleStudent = {
    _id: new mongoose.Types.ObjectId(studentAId),
    centerId,
    name: "Aarav Sharma",
    batch: "Class 10 - Science",
    parentWhatsApp: "9876543210",
    assignedTeacherId: new mongoose.Types.ObjectId(teacherId),
    isActive: true,
    monthlyFee: 2500,
    billingCycleDate: 5,
    toObject() {
      return { ...this };
    },
  };

  const sampleBatch1 = {
    _id: new mongoose.Types.ObjectId(batch1Id),
    centerId,
    name: "Class 10 - Science",
    timing: "4:00 PM - 5:30 PM",
    isActive: true,
  };

  const sampleBatch2 = {
    _id: new mongoose.Types.ObjectId(batch2Id),
    centerId,
    name: "Class 10 - Mathematics",
    timing: "5:30 PM - 7:00 PM",
    isActive: true,
  };

  // Model setup
  CenterModel.findOne = () => ({
    select: () => ({
      _id: ownerId,
      name: "MSEC Institute",
      ownerName: "Jitender Kumar",
    }),
  });

  TeacherModel.findOne = () => ({
    select: () => ({
      _id: teacherId,
      name: "R. K. Sharma",
    }),
  });

  // =========================================================================
  // 1. TEACHER CANNOT CREATE BATCHES (POST /api/batches -> HTTP 403)
  // =========================================================================
  await t.test("1. Teacher cannot create batches (POST /api/batches strictly returns 403)", async () => {
    const req = createMockRequest({
      method: "POST",
      token: teacherToken,
      body: { name: "Unauthorized Batch 10B", timing: "6:00 PM" },
      url: "http://localhost:3000/api/batches",
    });

    const res = await postBatchRoute(req);
    assert.equal(res.status, 403, "Teacher batch creation must return HTTP 403 Forbidden");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /Only Institute Owners are authorized to create batches/i);
  });

  // =========================================================================
  // 2. OWNER CAN CREATE BATCHES (POST /api/batches -> HTTP 201)
  // =========================================================================
  await t.test("2. Owner can legitimately create batches (POST /api/batches returns 201)", async () => {
    BatchModel.findOne = async () => null; // No duplicate
    BatchModel.create = async (doc) => ({
      ...doc,
      _id: new mongoose.Types.ObjectId(),
    });

    const req = createMockRequest({
      method: "POST",
      token: ownerToken,
      body: { name: "Class 11 - Physics", timing: "9:00 AM" },
      url: "http://localhost:3000/api/batches",
    });

    const res = await postBatchRoute(req);
    assert.equal(res.status, 201, "Owner batch creation must succeed with HTTP 201");
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.name, "Class 11 - Physics");
  });

  // =========================================================================
  // 3. TEACHER CANNOT DIRECTLY REASSIGN STUDENT BATCH (PUT /api/students/[id] -> HTTP 403)
  // =========================================================================
  await t.test("3. Teacher cannot directly assign or change student batch (PUT /api/students/[id] returns 403)", async () => {
    StudentModel.findOne = async () => ({ ...sampleStudent });

    const req = createMockRequest({
      method: "PUT",
      token: teacherToken,
      body: { batch: "Class 10 - Mathematics" },
      url: `http://localhost:3000/api/students/${studentAId}`,
    });

    const res = await putStudentRoute(req, { params: Promise.resolve({ id: studentAId }) });
    assert.equal(res.status, 403, "Direct batch modification by Teacher must return HTTP 403");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /Teachers cannot directly reassign student batches/i);
  });

  // =========================================================================
  // 4. TEACHER SUBMITS VALID BATCH ASSIGNMENT REQUEST (POST /api/batch-requests -> HTTP 201)
  // =========================================================================
  await t.test("4. Teacher submits valid student batch assignment request (POST /api/batch-requests returns 201)", async () => {
    StudentModel.findOne = async (q) => {
      if (q._id?.toString() === studentAId && q.centerId === centerId) {
        return { ...sampleStudent };
      }
      return null;
    };

    BatchModel.findOne = async (q) => {
      if (q.name === "Class 10 - Mathematics" && q.centerId === centerId) {
        return { ...sampleBatch2 };
      }
      return null;
    };

    StudentBatchRequestModel.findOne = async () => null; // No pending duplicate

    let createdDoc = null;
    StudentBatchRequestModel.create = async (doc) => {
      createdDoc = {
        ...doc,
        _id: new mongoose.Types.ObjectId(requestId),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return createdDoc;
    };

    const req = createMockRequest({
      method: "POST",
      token: teacherToken,
      body: {
        studentId: studentAId,
        batchName: "Class 10 - Mathematics",
        requestNotes: "Student requested transfer to mathematics evening batch",
      },
      url: "http://localhost:3000/api/batch-requests",
    });

    const res = await postBatchRequestRoute(req);
    assert.equal(res.status, 201, "Batch assignment request creation must return HTTP 201");
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.status, "pending", "New request must be initialized in pending status");
    assert.equal(json.data.requesterRole, "teacher");
    assert.equal(json.data.currentBatch, "Class 10 - Science");
    assert.equal(json.data.batchName, "Class 10 - Mathematics");
  });

  // =========================================================================
  // 5. DUPLICATE ACTIVE REQUEST PREVENTION (POST /api/batch-requests -> HTTP 409)
  // =========================================================================
  await t.test("5. Duplicate active/pending request for same student is prevented with HTTP 409", async () => {
    StudentModel.findOne = async () => ({ ...sampleStudent });
    BatchModel.findOne = async () => ({ ...sampleBatch2 });

    // Existing pending request already in database
    StudentBatchRequestModel.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    });

    const req = createMockRequest({
      method: "POST",
      token: teacherToken,
      body: {
        studentId: studentAId,
        batchName: "Class 10 - Mathematics",
      },
      url: "http://localhost:3000/api/batch-requests",
    });

    const res = await postBatchRequestRoute(req);
    assert.equal(res.status, 409, "Duplicate pending request must return HTTP 409 Conflict");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /pending batch assignment request already exists/i);
  });

  // =========================================================================
  // 6. REDUNDANT BATCH ASSIGNMENT PREVENTION (POST /api/batch-requests -> HTTP 400)
  // =========================================================================
  await t.test("6. Requesting student's already assigned batch returns HTTP 400", async () => {
    StudentModel.findOne = async () => ({ ...sampleStudent }); // current batch: "Class 10 - Science"
    BatchModel.findOne = async () => ({ ...sampleBatch1 });

    const req = createMockRequest({
      method: "POST",
      token: teacherToken,
      body: {
        studentId: studentAId,
        batchName: "Class 10 - Science", // Same batch
      },
      url: "http://localhost:3000/api/batch-requests",
    });

    const res = await postBatchRequestRoute(req);
    assert.equal(res.status, 400, "Requesting identical batch must return HTTP 400 Bad Request");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /already assigned to batch/i);
  });

  // =========================================================================
  // 7. CROSS-CENTER REQUEST REJECTION (POST /api/batch-requests -> HTTP 404/403)
  // =========================================================================
  await t.test("7. Cross-center student or batch request is rejected with 404/403", async () => {
    // Foreign center token tries to request batch for student in center_msec
    StudentModel.findOne = async (q) => {
      // Scoped strictly to foreignCenterId, so center_msec student is NOT found
      if (q.centerId === foreignCenterId) return null;
      return { ...sampleStudent };
    };

    const req = createMockRequest({
      method: "POST",
      token: foreignToken,
      body: {
        studentId: studentAId,
        batchName: "Class 10 - Mathematics",
      },
      url: "http://localhost:3000/api/batch-requests",
    });

    const res = await postBatchRequestRoute(req);
    assert.equal(res.status, 404, "Cross-center student access must return HTTP 404 Not Found");
    const json = await res.json();
    assert.equal(json.success, false);
  });

  // =========================================================================
  // 8. OWNER APPROVAL PERFORMS ACTUAL STUDENT ASSIGNMENT (PUT .../approve -> HTTP 200)
  // =========================================================================
  await t.test("8. Owner approval updates request status and officially updates Student.batch", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    StudentModel.findOne = async () => ({ ...sampleStudent });
    BatchModel.findOne = async () => ({ ...sampleBatch2 });

    let requestUpdatedWith = null;
    StudentBatchRequestModel.findOneAndUpdate = async (filter, update) => {
      if (filter.status === "pending") {
        requestUpdatedWith = update.$set;
        return {
          ...existingPendingRequest,
          ...update.$set,
        };
      }
      return null;
    };

    let studentUpdatedWith = null;
    StudentModel.findOneAndUpdate = async (filter, update) => {
      studentUpdatedWith = update.$set;
      return {
        ...sampleStudent,
        ...update.$set,
      };
    };

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 200, "Owner approval must return HTTP 200 OK");
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(requestUpdatedWith.status, "approved");
    assert.equal(studentUpdatedWith.batch, "Class 10 - Mathematics", "Student batch must be officially updated upon approval");
  });

  // =========================================================================
  // 9. OWNER REJECTION REQUIRES REASON AND PRESERVES ASSIGNMENT (PUT .../reject -> HTTP 200)
  // =========================================================================
  await t.test("9. Owner rejection requires reason and preserves original student batch untouched", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });

    // 9.1 Rejection without reason fails
    const reqNoReason = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: {}, // Missing rejectionReason
      url: `http://localhost:3000/api/batch-requests/${requestId}/reject`,
    });

    const resNoReason = await putRejectBatchRequestRoute(reqNoReason, {
      params: Promise.resolve({ id: requestId }),
    });
    assert.equal(resNoReason.status, 400, "Rejection without reason must return HTTP 400 Bad Request");

    // 9.2 Rejection with reason succeeds
    let studentUpdated = false;
    StudentModel.findOneAndUpdate = async () => {
      studentUpdated = true;
    };

    let rejectedRequestUpdatedWith = null;
    StudentBatchRequestModel.findOneAndUpdate = async (filter, update) => {
      if (filter.status === "pending") {
        rejectedRequestUpdatedWith = update.$set;
        return {
          ...existingPendingRequest,
          ...update.$set,
        };
      }
      return null;
    };

    const reqWithReason = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: { rejectionReason: "Class 10 - Mathematics evening section has reached maximum capacity." },
      url: `http://localhost:3000/api/batch-requests/${requestId}/reject`,
    });

    const resWithReason = await putRejectBatchRequestRoute(reqWithReason, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(resWithReason.status, 200, "Owner rejection with reason must return HTTP 200 OK");
    const json = await resWithReason.json();
    assert.equal(json.success, true);
    assert.equal(rejectedRequestUpdatedWith.status, "rejected");
    assert.equal(rejectedRequestUpdatedWith.rejectionReason, "Class 10 - Mathematics evening section has reached maximum capacity.");
    assert.equal(studentUpdated, false, "Student batch must remain completely untouched on rejection");
  });

  // =========================================================================
  // 10. TEACHER CANNOT APPROVE OR REJECT (PUT .../approve and /reject -> HTTP 403)
  // =========================================================================
  await t.test("10. Teacher cannot approve or reject batch requests (strictly returns HTTP 403)", async () => {
    // Attempt Approve as Teacher
    const reqApprove = createMockRequest({
      method: "PUT",
      token: teacherToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });
    const resApprove = await putApproveBatchRequestRoute(reqApprove, {
      params: Promise.resolve({ id: requestId }),
    });
    assert.equal(resApprove.status, 403, "Teacher cannot approve batch request");

    // Attempt Reject as Teacher
    const reqReject = createMockRequest({
      method: "PUT",
      token: teacherToken,
      body: { rejectionReason: "Teacher attempting rejection" },
      url: `http://localhost:3000/api/batch-requests/${requestId}/reject`,
    });
    const resReject = await putRejectBatchRequestRoute(reqReject, {
      params: Promise.resolve({ id: requestId }),
    });
    assert.equal(resReject.status, 403, "Teacher cannot reject batch request");
  });

  // =========================================================================
  // 11. CONCURRENT APPROVAL PROTECTION (Atomic findOneAndUpdate -> HTTP 409)
  // =========================================================================
  await t.test("11. Concurrent approval race condition returns HTTP 409 Conflict", async () => {
    StudentBatchRequestModel.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    });

    StudentModel.findOne = async () => ({ ...sampleStudent });
    BatchModel.findOne = async () => ({ ...sampleBatch2 });

    // Simulate another worker approving first (findOneAndUpdate matching status: 'pending' returns null)
    StudentBatchRequestModel.findOneAndUpdate = async () => null;
    StudentModel.findOneAndUpdate = async () => ({ ...sampleStudent, batch: "Class 10 - Mathematics" });
    StudentModel.updateOne = async () => ({ acknowledged: true });

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 409, "Concurrent approval must fail-safe with HTTP 409 Conflict");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.match(json.error, /Concurrent modification/i);
  });

  // =========================================================================
  // 12. STALE REQUEST: MISSING STUDENT RECORD REJECTS WITH 409
  // =========================================================================
  await t.test("12. Stale request validation: Missing student rejects request safely without assignment mutation", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    // Student was deleted or moved out of center
    StudentModel.findOne = async () => null;

    let rejectedWith = null;
    StudentBatchRequestModel.updateOne = async (filter, update) => {
      rejectedWith = update.$set;
      return { acknowledged: true };
    };

    let studentAssignmentMutated = false;
    StudentModel.findOneAndUpdate = async () => {
      studentAssignmentMutated = true;
    };

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 409, "Missing student must return HTTP 409 Conflict");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.code, "STALE_REQUEST_STUDENT_NOT_FOUND");
    assert.equal(rejectedWith.status, "rejected");
    assert.match(rejectedWith.rejectionReason, /Student record no longer exists/i);
    assert.equal(studentAssignmentMutated, false, "Student assignment must not be mutated");
  });

  // =========================================================================
  // 13. STALE REQUEST: INACTIVE STUDENT REJECTS WITH 409
  // =========================================================================
  await t.test("13. Stale request validation: Inactive student rejects request safely", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    // Student marked inactive
    StudentModel.findOne = async () => ({ ...sampleStudent, isActive: false });

    let rejectedWith = null;
    StudentBatchRequestModel.updateOne = async (filter, update) => {
      rejectedWith = update.$set;
      return { acknowledged: true };
    };

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 409, "Inactive student must return HTTP 409 Conflict");
    const json = await res.json();
    assert.equal(json.code, "STALE_REQUEST_STUDENT_INACTIVE");
    assert.equal(rejectedWith.status, "rejected");
    assert.match(rejectedWith.rejectionReason, /Student is currently inactive/i);
  });

  // =========================================================================
  // 14. STALE REQUEST: STUDENT ALREADY ASSIGNED TO TARGET BATCH REJECTS WITH 409
  // =========================================================================
  await t.test("14. Stale request validation: Student already in target batch rejects safely", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    // Student was already assigned to "Class 10 - Mathematics" in the meantime
    StudentModel.findOne = async () => ({ ...sampleStudent, batch: "Class 10 - Mathematics" });

    let rejectedWith = null;
    StudentBatchRequestModel.updateOne = async (filter, update) => {
      rejectedWith = update.$set;
      return { acknowledged: true };
    };

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 409, "Already assigned student must return HTTP 409 Conflict");
    const json = await res.json();
    assert.equal(json.code, "STALE_REQUEST_ALREADY_ASSIGNED");
    assert.equal(rejectedWith.status, "rejected");
    assert.match(rejectedWith.rejectionReason, /already assigned to batch/i);
  });

  // =========================================================================
  // 15. STALE REQUEST: TARGET BATCH DEACTIVATED OR DELETED REJECTS WITH 409
  // =========================================================================
  await t.test("15. Stale request validation: Deactivated target batch rejects safely", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    StudentModel.findOne = async () => ({ ...sampleStudent, batch: "Class 10 - Science" });
    // Target batch no longer exists or inactive
    BatchModel.findOne = async () => null;

    let rejectedWith = null;
    StudentBatchRequestModel.updateOne = async (filter, update) => {
      rejectedWith = update.$set;
      return { acknowledged: true };
    };

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 409, "Deactivated batch must return HTTP 409 Conflict");
    const json = await res.json();
    assert.equal(json.code, "STALE_REQUEST_BATCH_UNAVAILABLE");
    assert.equal(rejectedWith.status, "rejected");
    assert.match(rejectedWith.rejectionReason, /inactive or no longer exists/i);
  });

  // =========================================================================
  // 16. ATOMIC APPROVAL: MULTI-DOCUMENT TRANSACTION SESSION PATH
  // =========================================================================
  await t.test("16. Atomic approval consistency: Multi-document transaction session commits atomically", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    StudentModel.findOne = async () => ({ ...sampleStudent });
    BatchModel.findOne = async () => ({ ...sampleBatch2 });

    let transactionStarted = false;
    let transactionCommitted = false;
    let sessionEnded = false;

    const mockSession = {
      startTransaction() {
        transactionStarted = true;
      },
      async commitTransaction() {
        transactionCommitted = true;
      },
      async abortTransaction() {},
      async endSession() {
        sessionEnded = true;
      },
    };

    const originalStartSession = mongoose.startSession;
    mongoose.startSession = async () => mockSession;

    try {
      StudentBatchRequestModel.findOneAndUpdate = async (filter, update, opts) => {
        assert.ok(opts?.session, "Session must be passed to request update");
        return { ...existingPendingRequest, status: "approved" };
      };

      StudentModel.findOneAndUpdate = async (filter, update, opts) => {
        assert.ok(opts?.session, "Session must be passed to student update");
        return { ...sampleStudent, batch: "Class 10 - Mathematics" };
      };

      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
      });

      const res = await putApproveBatchRequestRoute(req, {
        params: Promise.resolve({ id: requestId }),
      });

      assert.equal(res.status, 200, "Transaction approval must return HTTP 200");
      assert.equal(transactionStarted, true, "Transaction must have started");
      assert.equal(transactionCommitted, true, "Transaction must have committed");
      assert.equal(sessionEnded, true, "Session must have ended cleanly");
    } finally {
      mongoose.startSession = null;
    }
  });

  // =========================================================================
  // 17. ATOMIC APPROVAL: NON-TRANSACTIONAL FALLBACK PREVENTS INCONSISTENCY
  // =========================================================================
  await t.test("17. Atomic approval consistency: Request is never marked approved before assignment succeeds", async () => {
    const existingPendingRequest = {
      _id: new mongoose.Types.ObjectId(requestId),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentAId),
      batchName: "Class 10 - Mathematics",
      status: "pending",
    };

    StudentBatchRequestModel.findOne = async () => ({ ...existingPendingRequest });
    StudentModel.findOne = async () => ({ ...sampleStudent });
    BatchModel.findOne = async () => ({ ...sampleBatch2 });

    // Simulate student assignment failure in fallback path
    StudentModel.findOneAndUpdate = async () => null;

    let requestApproved = false;
    StudentBatchRequestModel.findOneAndUpdate = async (filter, update) => {
      if (update.$set?.status === "approved") {
        requestApproved = true;
      }
      return null;
    };

    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      url: `http://localhost:3000/api/batch-requests/${requestId}/approve`,
    });

    const res = await putApproveBatchRequestRoute(req, {
      params: Promise.resolve({ id: requestId }),
    });

    assert.equal(res.status, 500, "Student assignment failure must fail-safe with HTTP 500");
    assert.equal(requestApproved, false, "Request must NEVER be marked approved when student assignment fails");
  });

  mongoose.startSession = originalStartSession;
});
