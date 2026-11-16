/**
 * Task 3: Fees Summary API (F-02) Optimization & Regression Test Suite
 *
 * Verifies:
 * 1. Financial Totals & Custody KPIs (exact calculation preservation).
 * 2. Top-10 Sorting & Exact Selection (bounded top-10 descending chronological order).
 * 3. Populated vs Unpopulated Student Name Resolution (preserves names, avoids "[object Object]").
 * 4. Empty Results Handling (zeroed KPIs, empty arrays, graceful 200).
 * 5. Multi-Tenant Center Isolation (strictly enforces JWT centerId, ignores query params).
 * 6. Teacher Role Scoping & Invariants (Section A Financials & Section B Student Status).
 * 7. Handover Query Optimization (filters non-actionable historical handovers, projects fields).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const mongoose = require(path.resolve(__dirname, "../tution-desk-be/node_modules/mongoose"));

process.env.JWT_SECRET = "test_jwt_secret_task3_optimization_key_12345";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const { GET: getFeesSummary } = await import(
  "../tution-desk-be/src/app/api/fees/summary/route.ts"
);
const { default: FeeModel } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const { default: StudentModel } = await import(
  "../tution-desk-be/src/models/Student.ts"
);
const { default: TeacherModel } = await import(
  "../tution-desk-be/src/models/Teacher.ts"
);
const { default: CashHandoverModel } = await import(
  "../tution-desk-be/src/models/CashHandover.ts"
);
const { signToken } = await import(
  "../tution-desk-be/src/lib/auth.ts"
);

const TEST_CENTER_ID = "center_task3_test";
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
  return {
    select: function () {
      return this;
    },
    populate: function () {
      return this;
    },
    sort: function () {
      return this;
    },
    limit: function () {
      return this;
    },
    lean: function () {
      return Promise.resolve(data);
    },
    then: function (resolve, reject) {
      return Promise.resolve(data).then(resolve, reject);
    },
  };
}

test("Task 3: Fees Summary API (F-02) Optimization Suite", async (t) => {
  const origFeeFind = FeeModel.find;
  const origFeeAggregate = FeeModel.aggregate;
  const origFeeCountDocuments = FeeModel.countDocuments;
  const origStudentFind = StudentModel.find;
  const origTeacherFind = TeacherModel.find;
  const origHandoverFind = CashHandoverModel.find;

  t.afterEach(() => {
    FeeModel.find = origFeeFind;
    FeeModel.aggregate = origFeeAggregate;
    FeeModel.countDocuments = origFeeCountDocuments;
    StudentModel.find = origStudentFind;
    TeacherModel.find = origTeacherFind;
    CashHandoverModel.find = origHandoverFind;
  });

  // TEST 1: Totals & Custody KPIs Exact Preservation
  await t.test("1. Totals & Custody KPIs: exact preservation of 6 KPIs and Action Required metrics", async () => {
    FeeModel.aggregate = async (pipeline) => {
      const pStr = JSON.stringify(pipeline);
      if (pStr.includes("amountDue") && pStr.includes("Pending")) {
        return [{ _id: null, total: 4500 }];
      }
      if (pStr.includes("paidAmount")) {
        return [{ _id: null, total: 8000 }];
      }
      return [];
    };
    FeeModel.countDocuments = async () => 3;

    const teacherObjId = new mongoose.Types.ObjectId(TEST_TEACHER_ID);
    const mockFees = [
      {
        _id: new mongoose.Types.ObjectId(),
        studentId: new mongoose.Types.ObjectId(),
        paidAmount: 5000,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: 5000,
            paymentDate: new Date("2026-05-01"),
            receiptNumber: "RCPT-001",
            receivedByRole: "owner",
          },
        ],
      },
      {
        _id: new mongoose.Types.ObjectId(),
        studentId: new mongoose.Types.ObjectId(),
        paidAmount: 3000,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: 3000,
            paymentDate: new Date("2026-05-02"),
            receiptNumber: "RCPT-002",
            receivedBy: teacherObjId,
            receivedByRole: "teacher",
            allocations: [],
          },
        ],
      },
    ];

    FeeModel.find = () => mockQuery(mockFees);
    TeacherModel.find = () => mockQuery([{ _id: teacherObjId, name: "Anita Sharma" }]);
    CashHandoverModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId(),
          status: "pending_approval",
          discrepancyStatus: "none",
          submittedAmount: 3000,
          discrepancyAmount: 0,
          incrementalSettlements: [],
        },
        {
          _id: new mongoose.Types.ObjectId(),
          status: "disputed",
          discrepancyStatus: "disputed",
          submittedAmount: 1000,
          discrepancyAmount: 200,
          incrementalSettlements: [{ amountReceived: 50 }],
        },
      ]);
    StudentModel.find = () => mockQuery([]);

    const req = createMockRequest("http://localhost:3000/api/fees/summary", ownerToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.totalPendingAmount, 4500);
    assert.strictEqual(json.data.pendingStudentsCount, 3);
    assert.strictEqual(json.data.collectedAmount, 8000);

    const kpis = json.data.kpis;
    assert.strictEqual(kpis.totalParentCollections, 8000);
    assert.strictEqual(kpis.verifiedCashReceived, 5000); // 5000 owner direct
    assert.strictEqual(kpis.teacherHeldCash, 3000); // 3000 unallocated in teacher hand
    assert.strictEqual(kpis.pendingVerificationCash, 0);
    assert.strictEqual(kpis.outstandingFeeBalance, 4500);
    assert.strictEqual(kpis.activeDiscrepancies, 150); // 200 - 50 = 150

    const action = json.data.actionRequired;
    assert.strictEqual(action.pendingHandoversCount, 1);
    assert.strictEqual(action.pendingHandoversAmount, 3000);
    assert.strictEqual(action.disputesCount, 1);
  });

  // TEST 2: Bounded Top-10 Chronological Sorting
  await t.test("2. Top-10 Sorting: returns exactly the 10 most recent collections in descending order", async () => {
    FeeModel.aggregate = async () => [];
    FeeModel.countDocuments = async () => 0;

    // Create 15 payment entries with explicit timestamps from day 1 to day 15
    const mockFees = [];
    for (let day = 1; day <= 15; day++) {
      const padDay = String(day).padStart(2, "0");
      mockFees.push({
        _id: new mongoose.Types.ObjectId(),
        studentId: new mongoose.Types.ObjectId(),
        paidAmount: day * 100,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: day * 100,
            paymentDate: new Date(`2026-06-${padDay}T10:00:00Z`),
            receiptNumber: `REC-${padDay}`,
            receivedByRole: "owner",
          },
        ],
      });
    }

    FeeModel.find = () => mockQuery(mockFees);
    TeacherModel.find = () => mockQuery([]);
    CashHandoverModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);

    const req = createMockRequest("http://localhost:3000/api/fees/summary", ownerToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    const recent = json.data.recentCollections;
    assert.strictEqual(recent.length, 10, "Must return exactly 10 items");

    // The most recent item must be June 15 (amount 1500)
    assert.strictEqual(recent[0].amount, 1500);
    assert.strictEqual(recent[0].receiptNumber, "REC-15");

    // The 10th item must be June 06 (amount 600)
    assert.strictEqual(recent[9].amount, 600);
    assert.strictEqual(recent[9].receiptNumber, "REC-06");

    // Days 1 through 5 must NOT appear in recent collections
    const amounts = recent.map((r) => r.amount);
    for (let day = 1; day <= 5; day++) {
      assert.ok(!amounts.includes(day * 100), `Day ${day} must be excluded from top 10`);
    }

    // Verify strictly descending chronological order
    for (let i = 0; i < recent.length - 1; i++) {
      const timeA = new Date(recent[i].paymentDate).getTime();
      const timeB = new Date(recent[i + 1].paymentDate).getTime();
      assert.ok(timeA >= timeB, `Item ${i} (${timeA}) must be >= Item ${i + 1} (${timeB})`);
    }
  });

  // TEST 3: Populated vs Unpopulated Student Names
  await t.test("3. Student Name Resolution: handles populated student object and unpopulated ObjectId reference", async () => {
    FeeModel.aggregate = async () => [];
    FeeModel.countDocuments = async () => 0;

    const unpopulatedStudentId = new mongoose.Types.ObjectId();
    const mockFees = [
      {
        _id: new mongoose.Types.ObjectId(),
        // Populated student object
        studentId: {
          _id: new mongoose.Types.ObjectId(),
          name: "Deepak Verma",
          batch: "Grade 11",
        },
        paidAmount: 2000,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: 2000,
            paymentDate: new Date("2026-07-02"),
            receiptNumber: "REC-P01",
            receivedByRole: "owner",
          },
        ],
      },
      {
        _id: new mongoose.Types.ObjectId(),
        // Unpopulated ObjectId reference
        studentId: unpopulatedStudentId,
        paidAmount: 1500,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: 1500,
            paymentDate: new Date("2026-07-01"),
            receiptNumber: "REC-P02",
            receivedByRole: "owner",
          },
        ],
      },
    ];

    FeeModel.find = () => mockQuery(mockFees);
    TeacherModel.find = () => mockQuery([]);
    CashHandoverModel.find = () => mockQuery([]);

    // Student.find resolves the unpopulated ID
    StudentModel.find = (filter) => {
      assert.ok(filter._id?.$in, "Should query by $in for unpopulated student IDs");
      return mockQuery([{ _id: unpopulatedStudentId, name: "Pooja Singh" }]);
    };

    const req = createMockRequest("http://localhost:3000/api/fees/summary", ownerToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    const recent = json.data.recentCollections;
    assert.strictEqual(recent.length, 2);

    assert.strictEqual(recent[0].studentName, "Deepak Verma", "Populated student name must be preserved");
    assert.strictEqual(recent[1].studentName, "Pooja Singh", "Unpopulated student ID must be hydrated via Student.find");
  });

  // TEST 4: Empty Data Handling
  await t.test("4. Empty Data: returns zeroed KPIs and empty recent collections array without errors", async () => {
    FeeModel.aggregate = async () => [];
    FeeModel.countDocuments = async () => 0;
    FeeModel.find = () => mockQuery([]);
    TeacherModel.find = () => mockQuery([]);
    CashHandoverModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);

    const req = createMockRequest("http://localhost:3000/api/fees/summary", ownerToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.totalPendingAmount, 0);
    assert.strictEqual(json.data.pendingStudentsCount, 0);
    assert.strictEqual(json.data.collectedAmount, 0);
    assert.strictEqual(json.data.kpis.totalParentCollections, 0);
    assert.strictEqual(json.data.kpis.verifiedCashReceived, 0);
    assert.strictEqual(json.data.kpis.teacherHeldCash, 0);
    assert.strictEqual(json.data.actionRequired.pendingHandoversCount, 0);
    assert.strictEqual(json.data.actionRequired.disputesCount, 0);
    assert.deepStrictEqual(json.data.recentCollections, []);
  });

  // TEST 5: Tenant Isolation
  await t.test("5. Multi-Tenant Isolation: centerId is derived exclusively from JWT; client query param is ignored", async () => {
    let capturedCenterId = null;

    FeeModel.aggregate = async (pipeline) => {
      const matchStage = pipeline.find((stage) => stage.$match)?.$match;
      if (matchStage) {
        capturedCenterId = matchStage.centerId;
      }
      return [];
    };
    FeeModel.countDocuments = async () => 0;
    FeeModel.find = () => mockQuery([]);
    TeacherModel.find = () => mockQuery([]);
    CashHandoverModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);

    const req = createMockRequest(
      "http://localhost:3000/api/fees/summary?centerId=malicious_victim_center",
      ownerToken
    );
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedCenterId, TEST_CENTER_ID, "Must use JWT session centerId, never spoofed query param");
  });

  // TEST 6: Teacher Role Scoping & Invariants
  await t.test("6. Teacher Role Scoping: returns Section A (financial activity) & Section B (student status) scoped to teacher", async () => {
    const teacherObjectId = new mongoose.Types.ObjectId(TEST_TEACHER_ID);
    const student1Id = new mongoose.Types.ObjectId();

    // Teacher has 1 assigned student
    StudentModel.find = (filter) => {
      if (filter.assignedTeacherId) {
        return mockQuery([
          { _id: student1Id, name: "Aarav Kumar", batch: "Batch Alpha", monthlyFee: 2500 },
        ]);
      }
      return mockQuery([]);
    };

    FeeModel.aggregate = async () => [];
    FeeModel.countDocuments = async () => 0;

    const mockTeacherFees = [
      {
        _id: new mongoose.Types.ObjectId(),
        studentId: student1Id,
        amountDue: 1000,
        paidAmount: 1500,
        status: "Partial Paid",
        dueDate: new Date("2026-05-10"),
        month: "May 2026",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: 1500,
            paymentDate: new Date("2026-05-05"),
            receiptNumber: "T-REC-01",
            receivedBy: teacherObjectId,
            receivedByRole: "teacher",
            allocations: [],
          },
        ],
      },
    ];

    FeeModel.find = () => mockQuery(mockTeacherFees);
    CashHandoverModel.find = () => mockQuery([]);

    const req = createMockRequest("http://localhost:3000/api/fees/summary", teacherToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.role, "teacher");

    // Section A: Financial Activity
    assert.strictEqual(json.data.kpis.ownCashCollected, 1500);
    assert.strictEqual(json.data.kpis.ownCashInHand, 1500);

    // Section B: Student Status
    assert.strictEqual(json.data.studentStatus.totalAssignedStudents, 1);
    assert.strictEqual(json.data.studentStatus.studentsWithDues, 1);
    assert.strictEqual(json.data.studentStatus.studentsFullyPaid, 0);
    assert.strictEqual(json.data.studentStatus.totalOutstandingBalance, 1000);
  });

  // TEST 7: Handover Query Optimization
  await t.test("7. Cash Handover Optimization: filters out closed handovers and applies field projection", async () => {
    let capturedHandoverFilter = null;
    let capturedHandoverSelect = null;

    FeeModel.aggregate = async () => [];
    FeeModel.countDocuments = async () => 0;
    FeeModel.find = () => mockQuery([]);
    TeacherModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);

    CashHandoverModel.find = function (filter) {
      capturedHandoverFilter = filter;
      return {
        select: function (fields) {
          capturedHandoverSelect = fields;
          return this;
        },
        lean: function () {
          return Promise.resolve([]);
        },
      };
    };

    const req = createMockRequest("http://localhost:3000/api/fees/summary", ownerToken);
    const res = await getFeesSummary(req);
    assert.strictEqual(res.status, 200);

    assert.ok(capturedHandoverFilter, "Must call CashHandover.find with a filter");
    assert.strictEqual(capturedHandoverFilter.centerId, TEST_CENTER_ID);
    assert.ok(capturedHandoverFilter.$or, "Must filter handovers by pending/disputed status");
    assert.ok(capturedHandoverSelect, "Must apply field projection to avoid loading items array");
    assert.ok(!capturedHandoverSelect.includes("items"), "Must NOT select heavy items array");
  });
});
