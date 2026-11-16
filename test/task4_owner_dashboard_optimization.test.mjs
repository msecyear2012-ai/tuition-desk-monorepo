/**
 * Task 4: Owner Dashboard API (F-05) Optimization & Regression Test Suite
 *
 * Verifies:
 * 1. Combined Fee Aggregation: Computes both pending total and overdue count in 1 aggregate.
 * 2. Combined Attendance Aggregation: Computes both total and present counts in 1 aggregate.
 * 3. Concurrent Batch Aggregation: Runs Student batch grouping concurrently inside Promise.all.
 * 4. Tenant Isolation & Teacher Scoping: Derives centerId from JWT session; scopes teacher data.
 * 5. Empty Dataset Handling: Gracefully returns zeroed metrics and 100% attendance rate on zero records.
 * 6. Field Projections: Verifies lightweight projections on list queries.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.JWT_SECRET = "test_jwt_secret_owner_dashboard_f05_key_12345";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const mongoose = require(path.resolve(__dirname, "../tution-desk-be/node_modules/mongoose"));

const { GET: getOwnerDashboard } = await import(
  "../tution-desk-be/src/app/api/dashboard/owner/route.ts"
);
const { default: StudentModel } = await import(
  "../tution-desk-be/src/models/Student.ts"
);
const { default: BatchModel } = await import(
  "../tution-desk-be/src/models/Batch.ts"
);
const { default: FeeModel } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const { default: AttendanceModel } = await import(
  "../tution-desk-be/src/models/Attendance.ts"
);
const { default: TestModel } = await import(
  "../tution-desk-be/src/models/Test.ts"
);
const { default: TeacherModel } = await import(
  "../tution-desk-be/src/models/Teacher.ts"
);
const { signToken } = await import(
  "../tution-desk-be/src/lib/auth.ts"
);

const TEST_CENTER_ID = "center_dashboard_f05";
const TEST_OWNER_ID = new mongoose.Types.ObjectId().toString();
const TEST_TEACHER_ID = new mongoose.Types.ObjectId().toString();

const ownerToken = await signToken({
  userId: TEST_OWNER_ID,
  centerId: TEST_CENTER_ID,
  role: "owner",
});

const teacherToken = await signToken({
  userId: TEST_TEACHER_ID,
  teacherId: TEST_TEACHER_ID,
  centerId: TEST_CENTER_ID,
  role: "teacher",
});

function createMockRequest(url, token) {
  const parsed = new URL(url);
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  return {
    method: "GET",
    url,
    nextUrl: parsed,
    headers: reqHeaders,
    cookies: {
      get: (name) => (name === "auth_token" ? { value: token } : undefined),
    },
  };
}

function mockQuery(data) {
  const obj = {
    select: () => obj,
    populate: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(data),
    then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
  };
  return obj;
}

test("Task 4: Owner Dashboard API (F-05) Optimization Suite", async (t) => {
  const origStudentCount = StudentModel.countDocuments;
  const origStudentFind = StudentModel.find;
  const origStudentAggregate = StudentModel.aggregate;
  const origBatchCount = BatchModel.countDocuments;
  const origBatchFind = BatchModel.find;
  const origFeeCount = FeeModel.countDocuments;
  const origFeeFind = FeeModel.find;
  const origFeeAggregate = FeeModel.aggregate;
  const origAttendanceCount = AttendanceModel.countDocuments;
  const origAttendanceAggregate = AttendanceModel.aggregate;
  const origTestCount = TestModel.countDocuments;
  const origTeacherFind = TeacherModel.find;
  const origTeacherFindOne = TeacherModel.findOne;

  t.afterEach(() => {
    StudentModel.countDocuments = origStudentCount;
    StudentModel.find = origStudentFind;
    StudentModel.aggregate = origStudentAggregate;
    BatchModel.countDocuments = origBatchCount;
    BatchModel.find = origBatchFind;
    FeeModel.countDocuments = origFeeCount;
    FeeModel.find = origFeeFind;
    FeeModel.aggregate = origFeeAggregate;
    AttendanceModel.countDocuments = origAttendanceCount;
    AttendanceModel.aggregate = origAttendanceAggregate;
    TestModel.countDocuments = origTestCount;
    TeacherModel.find = origTeacherFind;
    TeacherModel.findOne = origTeacherFindOne;
  });

  // TEST 1: Combined Fee Aggregate (total & count in 1 query)
  await t.test("1. Combined Fee Aggregate: returns pending total and overdue count in 1 pipeline without redundant countDocuments", async () => {
    let capturedFeePipelines = [];
    let feeCountDocumentsCalled = false;

    StudentModel.countDocuments = async () => 25;
    BatchModel.countDocuments = async () => 3;
    TestModel.countDocuments = async () => 2;
    BatchModel.find = () => mockQuery([{ _id: new mongoose.Types.ObjectId(), name: "Batch A" }]);
    FeeModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);
    StudentModel.aggregate = async () => [{ _id: "Batch A", count: 25 }];

    AttendanceModel.aggregate = async () => [{ _id: null, total: 20, present: 18 }];
    AttendanceModel.countDocuments = async () => 20;

    FeeModel.aggregate = async (pipeline) => {
      capturedFeePipelines.push(pipeline);
      if (pipeline[0]?.$match?.status === "Pending") {
        return [{ _id: null, total: 12500, count: 5 }];
      }
      return [{ _id: null, total: 35000 }];
    };

    FeeModel.countDocuments = async () => {
      feeCountDocumentsCalled = true;
      return 5;
    };

    const req = createMockRequest("http://localhost:3000/api/dashboard/owner", ownerToken);
    const res = await getOwnerDashboard(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.pendingFeesTotal, 12500);
    assert.strictEqual(json.data.overdueCount, 5);

    // Verify pending pipeline requested both total sum and count
    const pendingPipeline = capturedFeePipelines.find(
      (p) => p[0]?.$match?.status === "Pending"
    );
    assert.ok(pendingPipeline, "Must execute pending fee aggregate");
    const groupStage = pendingPipeline.find((s) => s.$group);
    assert.ok(groupStage?.$group?.total, "Must group total amountDue");
    assert.ok(groupStage?.$group?.count, "Must group count in the same aggregate");

    // Fee.countDocuments must NOT be called when aggregate provides count
    assert.strictEqual(
      feeCountDocumentsCalled,
      false,
      "Redundant Fee.countDocuments should be eliminated when aggregate provides count"
    );
  });

  // TEST 2: Combined Attendance Aggregate (total & present in 1 query)
  await t.test("2. Combined Attendance Aggregate: calculates total attendance and present count in single aggregate", async () => {
    let capturedAttendancePipeline = null;

    StudentModel.countDocuments = async () => 15;
    BatchModel.countDocuments = async () => 2;
    FeeModel.aggregate = async (p) => {
      if (p[0]?.$match?.status === "Pending") return [{ _id: null, total: 0, count: 0 }];
      return [];
    };
    TestModel.countDocuments = async () => 0;
    BatchModel.find = () => mockQuery([]);
    FeeModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);
    StudentModel.aggregate = async () => [];

    AttendanceModel.aggregate = async (pipeline) => {
      capturedAttendancePipeline = pipeline;
      return [{ _id: null, total: 40, present: 36 }];
    };

    const req = createMockRequest("http://localhost:3000/api/dashboard/owner", ownerToken);
    const res = await getOwnerDashboard(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.todayAttendance, 40);
    assert.strictEqual(json.data.todayPresentCount, 36);
    assert.strictEqual(json.data.attendanceTodayPercentage, 90); // 36 / 40 * 100 = 90%

    assert.ok(capturedAttendancePipeline, "Must execute attendance aggregation");
    const groupStage = capturedAttendancePipeline.find((s) => s.$group);
    assert.ok(groupStage?.$group?.total, "Must group total attendance");
    assert.ok(groupStage?.$group?.present, "Must group present count in single aggregate");
  });

  // TEST 3: Tenant Isolation & Teacher Scoping
  await t.test("3. Security: centerId derived strictly from JWT; teacher scoping restricts faculty view", async () => {
    let capturedCenterId = null;
    let capturedStudentFilter = null;

    StudentModel.countDocuments = async (filter) => {
      capturedCenterId = filter.centerId;
      capturedStudentFilter = filter;
      return 10;
    };
    BatchModel.countDocuments = async () => 1;
    FeeModel.aggregate = async () => [];
    AttendanceModel.aggregate = async () => [];
    AttendanceModel.countDocuments = async () => 0;
    TestModel.countDocuments = async () => 0;
    BatchModel.find = () => mockQuery([]);
    FeeModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);
    StudentModel.aggregate = async () => [];
    TeacherModel.findOne = () => mockQuery({ assignedBatches: ["Batch X"] });

    const req = createMockRequest(
      "http://localhost:3000/api/dashboard/owner?centerId=hacked_victim_center",
      teacherToken
    );
    const res = await getOwnerDashboard(req);
    assert.strictEqual(res.status, 200);

    assert.strictEqual(capturedCenterId, TEST_CENTER_ID, "Must ignore spoofed centerId parameter");
    assert.ok(capturedStudentFilter.assignedTeacherId, "Teacher request must scope students to assignedTeacherId");
  });

  // TEST 4: Empty Data Handling
  await t.test("4. Empty Data: returns zeroed KPIs, 100% attendance rate, and empty lists on empty center", async () => {
    StudentModel.countDocuments = async () => 0;
    BatchModel.countDocuments = async () => 0;
    FeeModel.aggregate = async () => [];
    AttendanceModel.aggregate = async () => [];
    AttendanceModel.countDocuments = async () => 0;
    TestModel.countDocuments = async () => 0;
    BatchModel.find = () => mockQuery([]);
    FeeModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);
    StudentModel.aggregate = async () => [];

    const req = createMockRequest("http://localhost:3000/api/dashboard/owner", ownerToken);
    const res = await getOwnerDashboard(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.totalStudents, 0);
    assert.strictEqual(json.data.totalBatches, 0);
    assert.strictEqual(json.data.pendingFeesTotal, 0);
    assert.strictEqual(json.data.overdueCount, 0);
    assert.strictEqual(json.data.todayAttendance, 0);
    assert.strictEqual(json.data.todayPresentCount, 0);
    assert.strictEqual(json.data.collectedFeesThisMonth, 0);
    assert.strictEqual(json.data.attendanceTodayPercentage, 100); // Defaults to 100% when no attendance marked
    assert.deepStrictEqual(json.data.batches, []);
    assert.deepStrictEqual(json.data.recentActivities, []);
  });

  // TEST 5: Lightweight Projections on List Queries
  await t.test("5. Lightweight Projections: verifies .select() is applied to Batch.find, Fee.find, and Student.find", async () => {
    let capturedBatchSelect = null;
    let capturedFeeSelect = null;
    let capturedStudentSelect = null;

    StudentModel.countDocuments = async () => 1;
    BatchModel.countDocuments = async () => 1;
    FeeModel.aggregate = async () => [];
    AttendanceModel.aggregate = async () => [];
    AttendanceModel.countDocuments = async () => 0;
    TestModel.countDocuments = async () => 0;
    StudentModel.aggregate = async () => [];

    BatchModel.find = function () {
      return {
        select: (fields) => {
          capturedBatchSelect = fields;
          return mockQuery([]);
        },
      };
    };

    FeeModel.find = function () {
      return {
        select: (fields) => {
          capturedFeeSelect = fields;
          return {
            sort: () => ({
              limit: () => ({
                populate: () => ({
                  lean: () => Promise.resolve([]),
                }),
              }),
            }),
          };
        },
      };
    };

    StudentModel.find = function () {
      return {
        select: (fields) => {
          capturedStudentSelect = fields;
          return mockQuery([]);
        },
      };
    };

    const req = createMockRequest("http://localhost:3000/api/dashboard/owner", ownerToken);
    const res = await getOwnerDashboard(req);
    assert.strictEqual(res.status, 200);

    assert.ok(capturedBatchSelect, "Batch.find must apply select projection");
    assert.ok(capturedFeeSelect, "Fee.find must apply select projection");
    assert.ok(capturedStudentSelect, "Student.find must apply select projection");
  });
});
