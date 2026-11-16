process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { GET: getFinancialSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/reports/financial-summary/route.ts"
);

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  token,
  url = "http://localhost:3000/api/reports/financial-summary",
  params = {},
}) {
  const reqUrl = new URL(url);
  for (const [key, val] of Object.entries(params)) {
    reqUrl.searchParams.set(key, String(val));
  }

  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }

  return {
    method: "GET",
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: reqUrl,
  };
}

function mockQuery(result, onPopulate) {
  const queryObj = {
    sort: () => queryObj,
    populate: (...args) => {
      if (onPopulate) onPopulate(...args);
      return queryObj;
    },
    select: () => queryObj,
    lean: async () => result,
  };
  return queryObj;
}

test("Task 1: Financial Reports API Optimization Regression Suite", async (t) => {
  const centerId = "center_task1_test";
  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";
  const student1Id = new mongoose.Types.ObjectId("507f191e810c19729de86011");
  const student2Id = new mongoose.Types.ObjectId("507f191e810c19729de86012");
  const inactiveStudentId = new mongoose.Types.ObjectId("507f191e810c19729de86013");

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Director",
  });

  const baseStudents = [
    {
      _id: student1Id,
      name: "Aarav Sharma",
      batch: "Batch A",
      parentName: "Sanjay Sharma",
      parentWhatsApp: "9876543210",
      phone: "9876543210",
      isActive: true,
    },
    {
      _id: student2Id,
      name: "Diya Patel",
      batch: "Batch B",
      parentName: "Kishore Patel",
      parentWhatsApp: "9876543211",
      phone: "9876543211",
      isActive: true,
    },
    {
      _id: inactiveStudentId,
      name: "Old Alumni",
      batch: "Alumni Batch",
      parentName: "Senior Parent",
      parentWhatsApp: "9876543212",
      phone: "9876543212",
      isActive: false, // Inactive student with historical fee
    },
  ];

  TeacherModel.find = () =>
    mockQuery([
      { _id: new mongoose.Types.ObjectId(teacherId), name: "Faculty Alpha", loginId: "alpha" },
    ]);
  CashHandoverModel.find = () => mockQuery([]);

  await t.test("1. No Duplicate Student Populate: feeQuery does not trigger redundant populate queries", async () => {
    let populateCalled = false;

    StudentModel.find = () => mockQuery(baseStudents);
    FeeModel.find = () =>
      mockQuery(
        [
          {
            _id: new mongoose.Types.ObjectId(),
            centerId,
            studentId: student1Id, // Raw ObjectId, NOT populated
            amountDue: 0,
            paidAmount: 5000,
            status: "Paid",
            month: "2026-11",
            createdAt: new Date("2026-11-01"),
            paymentHistory: [
              {
                paymentId: new mongoose.Types.ObjectId(),
                amount: 5000,
                paymentMode: "Cash",
                paymentDate: new Date("2026-11-05T10:00:00.000Z"),
                receiptNumber: "RCP-101",
                receivedBy: new mongoose.Types.ObjectId(ownerId),
                receivedByRole: "owner",
              },
            ],
          },
        ],
        () => {
          populateCalled = true;
        }
      );

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(populateCalled, false, "feeQuery.populate must NOT be called on FeeModel");

    // Verify student name was correctly resolved from studentMap without populate
    assert.equal(body.studentLedger.length, 1);
    assert.equal(body.studentLedger[0].studentName, "Aarav Sharma");
    assert.equal(body.studentLedger[0].batchName, "Batch A");
    assert.equal(body.studentLedger[0].parentName, "Sanjay Sharma");
    assert.equal(body.studentLedger[0].parentPhone, "9876543210");
  });

  await t.test("2. Historical resolution for Inactive Students: resolves student names without falling back to Unknown Student", async () => {
    StudentModel.find = () => mockQuery(baseStudents);
    FeeModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId(),
          centerId,
          studentId: inactiveStudentId,
          amountDue: 0,
          paidAmount: 3500,
          status: "Paid",
          month: "2026-06",
          createdAt: new Date("2026-06-01"),
          paymentHistory: [
            {
              paymentId: new mongoose.Types.ObjectId(),
              amount: 3500,
              paymentMode: "Cash",
              paymentDate: new Date("2026-06-05T10:00:00.000Z"),
              receiptNumber: "RCP-099",
              receivedBy: new mongoose.Types.ObjectId(ownerId),
              receivedByRole: "owner",
            },
          ],
        },
      ]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.studentLedger.length, 1);
    assert.equal(
      body.studentLedger[0].studentName,
      "Old Alumni",
      "Inactive student must resolve correctly from studentMap"
    );
    assert.equal(body.studentLedger[0].batchName, "Alumni Batch");
  });

  await t.test("3. Student ObjectId Pushdown: pushes studentId to feeFilter when valid ObjectId is provided", async () => {
    let capturedFeeFilter = null;
    StudentModel.find = () => mockQuery(baseStudents);
    FeeModel.find = (filter) => {
      capturedFeeFilter = filter;
      return mockQuery([]);
    };

    const targetStudentId = student1Id.toString();
    const req = createMockRequest({
      token: ownerToken,
      params: { student: targetStudentId },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    assert.ok(capturedFeeFilter, "FeeModel.find must be called with filter");
    assert.equal(capturedFeeFilter.centerId, centerId);
    assert.ok(capturedFeeFilter.studentId, "studentId must be pushed down to MongoDB filter");
    assert.equal(capturedFeeFilter.studentId.toString(), targetStudentId);
  });

  await t.test("4. Duplicate Ledger Serialization Removed: studentLedger exists at root but is omitted from data object", async () => {
    StudentModel.find = () => mockQuery(baseStudents);
    FeeModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId(),
          centerId,
          studentId: student1Id,
          amountDue: 1000,
          paidAmount: 4000,
          status: "Partial Paid",
          month: "2026-11",
          createdAt: new Date("2026-11-01"),
          paymentHistory: [],
        },
      ]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    const body = await res.json();

    // Root-level studentLedger contract must be preserved
    assert.ok(Array.isArray(body.studentLedger), "body.studentLedger must be an array at root");
    assert.equal(body.studentLedger.length, 1);

    // data object must retain summary, teacherReports, batchReports, handoverReports, metadata
    assert.ok(body.data, "body.data must exist");
    assert.ok(body.data.summary, "body.data.summary must exist");
    assert.ok(Array.isArray(body.data.teacherReports), "body.data.teacherReports must exist");
    assert.ok(Array.isArray(body.data.batchReports), "body.data.batchReports must exist");
    assert.ok(Array.isArray(body.data.handoverReports), "body.data.handoverReports must exist");
    assert.ok(body.data.metadata, "body.data.metadata must exist");
    assert.equal(body.data.metadata.filterCount.students, 1);

    // studentLedger must NOT be duplicated inside data object
    assert.equal(
      body.data.studentLedger,
      undefined,
      "Duplicate studentLedger must be omitted from data object"
    );
  });

  await t.test("5. Empty Results Handling: returns zeroed KPIs and empty arrays without errors", async () => {
    StudentModel.find = () => mockQuery([]);
    TeacherModel.find = () => mockQuery([]);
    FeeModel.find = () => mockQuery([]);
    CashHandoverModel.find = () => mockQuery([]);

    const req = createMockRequest({
      token: ownerToken,
      params: { batch: "NonExistentBatch", student: "UnknownStudent" },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.kpis.totalParentCollections, 0);
    assert.equal(body.kpis.verifiedCashReceived, 0);
    assert.equal(body.kpis.teacherHeldCash, 0);
    assert.equal(body.kpis.pendingVerificationCash, 0);
    assert.equal(body.kpis.outstandingFeeBalance, 0);
    assert.equal(body.kpis.activeDiscrepancies, 0);
    assert.deepEqual(body.studentLedger, []);
    assert.deepEqual(body.batchReports, []);
    assert.deepEqual(body.teacherReports, []);
    assert.deepEqual(body.handoverReports, []);
  });

  await t.test("6. Multiple Batches Aggregation: groups batch totals correctly without cross-batch pollution", async () => {
    StudentModel.find = () => mockQuery(baseStudents);
    FeeModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId(),
          centerId,
          studentId: student1Id,
          batchAtPayment: "Batch A",
          amountDue: 500,
          paidAmount: 2500,
          status: "Partial Paid",
          month: "2026-11",
          paymentHistory: [
            {
              paymentId: new mongoose.Types.ObjectId(),
              amount: 2500,
              paymentMode: "Cash",
              paymentDate: new Date("2026-11-02"),
              receiptNumber: "RCP-A1",
              receivedBy: new mongoose.Types.ObjectId(ownerId),
              receivedByRole: "owner",
            },
          ],
        },
        {
          _id: new mongoose.Types.ObjectId(),
          centerId,
          studentId: student2Id,
          batchAtPayment: "Batch B",
          amountDue: 0,
          paidAmount: 4000,
          status: "Paid",
          month: "2026-11",
          paymentHistory: [
            {
              paymentId: new mongoose.Types.ObjectId(),
              amount: 4000,
              paymentMode: "UPI",
              paymentDate: new Date("2026-11-03"),
              receiptNumber: "RCP-B1",
              receivedBy: new mongoose.Types.ObjectId(ownerId),
              receivedByRole: "owner",
            },
          ],
        },
      ]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.batchReports.length, 2);

    const batchA = body.batchReports.find((b) => b.batchName === "Batch A");
    const batchB = body.batchReports.find((b) => b.batchName === "Batch B");

    assert.ok(batchA, "Batch A report must exist");
    assert.ok(batchB, "Batch B report must exist");

    assert.equal(batchA.totalCollected, 2500);
    assert.equal(batchA.outstandingBalance, 500);
    assert.equal(batchA.partialPaymentCount, 1);

    assert.equal(batchB.totalCollected, 4000);
    assert.equal(batchB.outstandingBalance, 0);
    assert.equal(batchB.partialPaymentCount, 0);
  });
});
