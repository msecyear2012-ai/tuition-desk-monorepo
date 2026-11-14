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

function mockQuery(result) {
  const queryObj = {
    sort: () => queryObj,
    populate: () => queryObj,
    select: () => queryObj,
    lean: async () => result,
  };
  return queryObj;
}

test("Phase 5.6: Owner Collection Reports & Financial Dashboard Test Suite", async (t) => {
  const centerAlpha = "center_alpha";

  const ownerId = "507f191e810c19729de860f1";
  const teacher1Id = "507f191e810c19729de860f2";
  const teacher2Id = "507f191e810c19729de860f3";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerAlpha,
    role: "owner",
    name: "Owner Director Alpha",
  });

  const teacherToken = await signToken({
    userId: teacher1Id,
    teacherId: teacher1Id,
    centerId: centerAlpha,
    role: "teacher",
    name: "Teacher Ramanujan",
  });

  // Default setup
  TeacherModel.find = () =>
    mockQuery([
      { _id: new mongoose.Types.ObjectId(teacher1Id), name: "Teacher Ramanujan" },
      { _id: new mongoose.Types.ObjectId(teacher2Id), name: "Teacher Aryabhata" },
    ]);

  StudentModel.find = () =>
    mockQuery([
      { _id: new mongoose.Types.ObjectId("507f191e810c19729de86221"), name: "Rahul Sharma", batch: "Batch Math 10" },
      { _id: new mongoose.Types.ObjectId("507f191e810c19729de86222"), name: "Priya Patel", batch: "Batch Physics 11" },
    ]);

  // TEST 1: Role protection - Teachers are forbidden (403 UNAUTHORIZED_ROLE)
  await t.test("1. Teacher role receives HTTP 403 UNAUTHORIZED_ROLE", async () => {
    const req = createMockRequest({ token: teacherToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, "UNAUTHORIZED_ROLE");
  });

  // TEST 2: Missing auth receives HTTP 401
  await t.test("2. Unauthenticated request receives HTTP 401 UNAUTHORIZED", async () => {
    const req = createMockRequest({ token: null });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, "Authentication required");
  });

  // TEST 3: Owner receives complete 6 KPIs and all 4 report tables
  await t.test("3. Owner receives 6 KPIs and all 4 reporting sub-views", async () => {
    const feeDoc1 = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86111"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86221"),
        name: "Rahul Sharma",
        parentName: "Sanjay Sharma",
        parentPhone: "9876543210",
        batch: "Batch Math 10",
      },
      amountDue: 0,
      paidAmount: 5000,
      status: "Paid",
      month: "2026-11",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86331"),
          amount: 5000,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-05T10:00:00.000Z"),
          receiptNumber: "RCP-101",
          receivedBy: new mongoose.Types.ObjectId(ownerId),
          receivedByName: "Owner Director Alpha",
          receivedByRole: "owner",
          isOwnerVerified: true,
          status: "approved",
          allocations: [],
        },
      ],
    };

    const feeDoc2 = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86112"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86222"),
        name: "Priya Patel",
        parentName: "Kiran Patel",
        parentPhone: "9123456789",
        batch: "Batch Physics 11",
      },
      amountDue: 3000,
      paidAmount: 3000,
      status: "Partial Paid",
      month: "2026-11",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86332"),
          amount: 3000,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-06T11:00:00.000Z"),
          receiptNumber: "RCP-102",
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          receivedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: false,
          status: "approved",
          allocations: [],
        },
      ],
    };

    FeeModel.find = (query) => {
      assert.equal(query.centerId, centerAlpha);
      return mockQuery([feeDoc1, feeDoc2]);
    };

    CashHandoverModel.find = (query) => {
      assert.equal(query.centerId, centerAlpha);
      return mockQuery([
        {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86441"),
          centerId: centerAlpha,
          handoverNumber: "HO-202611-001",
          teacherId: new mongoose.Types.ObjectId(teacher1Id),
          submittedAmount: 3000,
          approvedAmount: 2500,
          discrepancyAmount: 500,
          status: "partially_approved",
          discrepancyStatus: "disputed",
          submittedAt: new Date("2026-11-07T14:00:00.000Z"),
          items: [{ amount: 3000, receiptNumber: "RCP-102" }],
          incrementalSettlements: [],
        },
      ]);
    };

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    // Verify 6 KPIs
    assert.equal(body.kpis.totalParentCollections, 8000); // 5000 + 3000
    assert.equal(body.kpis.verifiedCashReceived, 5000); // Owner collected directly
    assert.equal(body.kpis.teacherHeldCash, 3000); // Teacher collected
    assert.equal(body.kpis.outstandingFeeBalance, 3000); // Partial fee due is 3000
    assert.equal(body.kpis.activeDiscrepancies, 500); // Disputed shortage in handover

    // Verify 4 report tables presence
    assert.ok(Array.isArray(body.teacherReports));
    assert.ok(Array.isArray(body.batchReports));
    assert.ok(Array.isArray(body.studentLedger));
    assert.ok(Array.isArray(body.handoverReports));

    assert.equal(body.teacherReports.length, 3); // 2 active teachers + 1 owner collector
    assert.equal(body.batchReports.length, 2); // Batch Math 10 + Batch Physics 11
    assert.equal(body.studentLedger.length, 2);
    assert.equal(body.handoverReports.length, 1);
  });

  // TEST 4: Financial Invariant - Parent collections never include handover transfers
  await t.test("4. Financial Invariant: Parent collections exclude handover transfers and only count tuition receipts", async () => {
    const feeDoc = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86113"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86223"),
        name: "Ananya Roy",
        parentName: "Debashis Roy",
        parentPhone: "9988776655",
        batch: "Batch Chemistry 12",
      },
      amountDue: 0,
      paidAmount: 2000,
      status: "Paid",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86333"),
          amount: 2000,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-08T10:00:00.000Z"),
          receiptNumber: "RCP-103",
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          receivedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: true,
          status: "approved",
          allocations: [
            {
              allocationId: new mongoose.Types.ObjectId("507f191e810c19729de86551"),
              handoverId: new mongoose.Types.ObjectId("507f191e810c19729de86442"),
              handoverNumber: "HO-002",
              allocatedAmount: 2000,
              status: "verified",
            },
          ],
        },
      ],
    };

    FeeModel.find = () => mockQuery([feeDoc]);

    CashHandoverModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86442"),
          centerId: centerAlpha,
          handoverNumber: "HO-002",
          teacherId: new mongoose.Types.ObjectId(teacher1Id),
          submittedAmount: 2000,
          approvedAmount: 2000,
          discrepancyAmount: 0,
          status: "approved",
          discrepancyStatus: "none",
          submittedAt: new Date("2026-11-08T15:00:00.000Z"),
          items: [{ amount: 2000, receiptNumber: "RCP-103" }],
        },
      ]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.totalParentCollections, 2000);
    assert.equal(body.kpis.verifiedCashReceived, 2000); // Now verified in safe
    assert.equal(body.kpis.teacherHeldCash, 0); // No longer held by teacher
    assert.equal(body.kpis.pendingVerificationCash, 0);
    assert.equal(body.kpis.activeDiscrepancies, 0);
  });

  // TEST 5: Financial Invariant - Shortages/discrepancies are NEVER counted as physical safe cash
  await t.test("5. Financial Invariant: Shortages are never included in safe cash or student ledger balance", async () => {
    const feeDoc = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86114"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86224"),
        name: "Vikram Sen",
        parentName: "Alok Sen",
        parentPhone: "9830112233",
        batch: "Batch Math 10",
      },
      amountDue: 0,
      paidAmount: 5000,
      status: "Paid",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86334"),
          amount: 5000,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-09T10:00:00.000Z"),
          receiptNumber: "RCP-104",
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          receivedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: false,
          status: "approved",
          allocations: [
            {
              allocationId: new mongoose.Types.ObjectId("507f191e810c19729de86552"),
              handoverId: new mongoose.Types.ObjectId("507f191e810c19729de86443"),
              handoverNumber: "HO-003",
              allocatedAmount: 5000,
              verifiedAmount: 4500,
              status: "partially_verified",
            },
          ],
        },
      ],
    };

    FeeModel.find = () => mockQuery([feeDoc]);

    CashHandoverModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86443"),
          centerId: centerAlpha,
          handoverNumber: "HO-003",
          teacherId: new mongoose.Types.ObjectId(teacher1Id),
          submittedAmount: 5000,
          approvedAmount: 4500,
          discrepancyAmount: 500,
          status: "partially_approved",
          discrepancyStatus: "shortage_confirmed",
          submittedAt: new Date("2026-11-09T16:00:00.000Z"),
          items: [{ amount: 5000, receiptNumber: "RCP-104" }],
          incrementalSettlements: [],
        },
      ]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.totalParentCollections, 5000);
    assert.equal(body.kpis.activeDiscrepancies, 500); // 500 confirmed shortage
    assert.equal(body.kpis.outstandingFeeBalance, 0); // Student owes 0! Student not penalized!
    assert.equal(body.studentLedger[0].paidAmount, 5000);
    assert.equal(body.studentLedger[0].outstandingBalance, 0);
  });

  // TEST 6: Multi-step incremental settlements reduce remaining discrepancy balance
  await t.test("6. Multi-step incremental settlements reduce active discrepancy balance", async () => {
    FeeModel.find = () => mockQuery([]);

    CashHandoverModel.find = () =>
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86444"),
          centerId: centerAlpha,
          handoverNumber: "HO-004",
          teacherId: new mongoose.Types.ObjectId(teacher1Id),
          submittedAmount: 2000,
          approvedAmount: 1500,
          discrepancyAmount: 500,
          status: "partially_approved",
          discrepancyStatus: "disputed",
          submittedAt: new Date("2026-11-10T11:00:00.000Z"),
          items: [],
          incrementalSettlements: [
            {
              amountReceived: 300,
              receivedAt: new Date("2026-11-10T17:00:00.000Z"),
              receivedBy: new mongoose.Types.ObjectId(ownerId),
              remainingDiscrepancy: 200,
            },
          ],
        },
      ]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.activeDiscrepancies, 200); // 500 - 300 = 200
    assert.equal(body.handoverReports[0].remainingDiscrepancy, 200);
    assert.equal(body.handoverReports[0].settlementsCount, 1);
  });

  // TEST 7: Multi-filter combinations work simultaneously (date range + batch + status)
  await t.test("7. Combined multi-filters filter records across all dimensions", async () => {
    const fee1 = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86115"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86225"),
        name: "Aarav Gupta",
        parentName: "Manoj Gupta",
        parentPhone: "9876543210",
        batch: "Batch Math 10",
      },
      amountDue: 0,
      paidAmount: 4000,
      status: "Paid",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86335"),
          amount: 4000,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-05T10:00:00.000Z"),
          receiptNumber: "RCP-105",
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          receivedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: true,
          status: "approved",
          allocations: [],
        },
      ],
    };

    const fee2 = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86116"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86226"),
        name: "Sneha Mukherjee",
        parentName: "Amit Mukherjee",
        parentPhone: "9123456780",
        batch: "Batch Physics 11", // Different batch
      },
      amountDue: 3000,
      paidAmount: 2000,
      status: "Partial Paid", // Different status
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86336"),
          amount: 2000,
          paymentMode: "upi",
          paymentDate: new Date("2026-10-15T10:00:00.000Z"), // Different date (October)
          receiptNumber: "RCP-106",
          receivedBy: new mongoose.Types.ObjectId(teacher2Id),
          receivedByName: "Teacher Aryabhata",
          receivedByRole: "teacher",
          isOwnerVerified: true,
          status: "approved",
          allocations: [],
        },
      ],
    };

    FeeModel.find = () => mockQuery([fee1, fee2]);
    CashHandoverModel.find = () => mockQuery([]);

    // Query with filter: startDate=2026-11-01, endDate=2026-11-30, batch=Batch Math 10, status=Paid
    const req = createMockRequest({
      token: ownerToken,
      params: {
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        batch: "Batch Math 10",
        status: "Paid",
      },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.totalParentCollections, 4000); // fee2 filtered out!
    assert.equal(body.studentLedger.length, 1);
    assert.equal(body.studentLedger[0].studentName, "Aarav Gupta");
    assert.equal(body.batchReports.length, 1);
    assert.equal(body.batchReports[0].batchName, "Batch Math 10");
  });

  // TEST 8: Tenant isolation - center Alpha cannot see center Beta data
  await t.test("8. Tenant isolation: Owner of Center Alpha only queries records scoped to Center Alpha", async () => {
    let queriedCenterId = null;
    FeeModel.find = (query) => {
      queriedCenterId = query.centerId;
      return mockQuery([]);
    };

    let handoverQueriedCenterId = null;
    CashHandoverModel.find = (query) => {
      handoverQueriedCenterId = query.centerId;
      return mockQuery([]);
    };

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);

    assert.equal(queriedCenterId, centerAlpha);
    assert.equal(handoverQueriedCenterId, centerAlpha);
  });

  // TEST 9: Academic teacher vs actual payment collector attribution separation & recordedBy fallback
  await t.test("9. Academic teacher and actual payment collector remain strictly separate", async () => {
    // Student assigned to academic teacher 2 (Aryabhata), but cash was collected by teacher 1 (Ramanujan) via recordedBy
    const feeWithSeparateRoles = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86117"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86227"),
        name: "Tanvi Verma",
        parentName: "Suresh Verma",
        parentPhone: "9876543299",
        batch: "Batch Physics 11",
        assignedTeacherId: new mongoose.Types.ObjectId(teacher2Id), // Academic teacher is Aryabhata
      },
      amountDue: 0,
      paidAmount: 3500,
      status: "Paid",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86337"),
          amount: 3500,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-08T10:00:00.000Z"),
          receiptNumber: "RCP-107",
          recordedBy: new mongoose.Types.ObjectId(teacher1Id), // Actual collector is Ramanujan
          recordedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: false,
          status: "approved",
          allocations: [],
        },
      ],
    };

    FeeModel.find = () => mockQuery([feeWithSeparateRoles]);
    CashHandoverModel.find = () => mockQuery([]);

    // Query filtering specifically by collector Ramanujan (teacher1Id)
    const req = createMockRequest({
      token: ownerToken,
      params: {
        teacherId: teacher1Id,
      },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Ramanujan collected ₹3500
    assert.equal(body.kpis.totalParentCollections, 3500);
    assert.equal(body.teacherReports.length, 1);
    assert.equal(body.teacherReports[0].teacherId, teacher1Id);
    assert.equal(body.teacherReports[0].totalCollected, 3500);

    // Query without teacher filter: both teachers appear, but Aryabhata collected 0
    const reqAll = createMockRequest({ token: ownerToken });
    const resAll = await getFinancialSummaryRoute(reqAll);
    const bodyAll = await resAll.json();
    assert.equal(bodyAll.teacherReports.find((t) => t.teacherId === teacher1Id)?.totalCollected, 3500);
    assert.equal(bodyAll.teacherReports.find((t) => t.teacherId === teacher2Id)?.totalCollected, 0);
  });

  // TEST 10: Multi-partial payments spanning different dates filter accurately by paymentDate
  await t.test("10. Multi-partial payments spanning different dates aggregate correctly per date window", async () => {
    // Single Fee document with 2 partial payments:
    // P1: ₹1,500 on 2026-10-20
    // P2: ₹2,500 on 2026-11-05
    const multiPartialFee = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86118"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86228"),
        name: "Karan Johar",
        parentName: "Yash Johar",
        parentPhone: "9876543288",
        batch: "Batch Math 10",
      },
      amountDue: 0,
      paidAmount: 4000,
      status: "Paid",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86338"),
          amount: 1500,
          paymentMode: "cash",
          paymentDate: new Date("2026-10-20T10:00:00.000Z"), // October payment
          receiptNumber: "RCP-108A",
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          receivedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: false,
          status: "approved",
          allocations: [],
        },
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86339"),
          amount: 2500,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-05T10:00:00.000Z"), // November payment
          receiptNumber: "RCP-108B",
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          receivedByName: "Teacher Ramanujan",
          receivedByRole: "teacher",
          isOwnerVerified: false,
          status: "approved",
          allocations: [],
        },
      ],
    };

    FeeModel.find = () => mockQuery([multiPartialFee]);
    CashHandoverModel.find = () => mockQuery([]);

    // Query for November window only (2026-11-01 to 2026-11-30)
    const req = createMockRequest({
      token: ownerToken,
      params: {
        startDate: "2026-11-01",
        endDate: "2026-11-30",
      },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Only November payment (₹2,500) should be included; October payment (₹1,500) must be excluded
    assert.equal(body.kpis.totalParentCollections, 2500);
    assert.equal(body.studentLedger[0].payments.length, 1);
    assert.equal(body.studentLedger[0].payments[0].amount, 2500);
    assert.equal(body.studentLedger[0].payments[0].receiptNumber, "RCP-108B");
  });

  // TEST 11: Regression for missing optional amount fields & safe toLocaleString formatting
  await t.test("11. Regression: Report rows with missing optional amount fields receive safe numeric values without throwing TypeError", async () => {
    // Incomplete legacy fee without originalAmountDue, paidAmount, or amountDue
    const legacyFee = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86119"),
      centerId: centerAlpha,
      studentId: {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86229"),
        name: "Legacy Student",
        batch: "Batch Incomplete",
      },
      // Missing amountDue, paidAmount, originalAmountDue, status
      month: "2026-11",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86340"),
          // Missing optional fields on payment entry
          amount: 2000,
          paymentMode: "cash",
          paymentDate: new Date("2026-11-10T10:00:00.000Z"),
          receivedBy: new mongoose.Types.ObjectId(teacher1Id),
          // isOwnerVerified missing
          // allocations missing
        },
      ],
    };

    // Incomplete handover document with missing optional amount fields
    const legacyHandover = {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86449"),
      centerId: centerAlpha,
      handoverNumber: "HO-LEGACY-001",
      teacherId: new mongoose.Types.ObjectId(teacher1Id),
      // Missing submittedAmount, approvedAmount, discrepancyAmount, incrementalSettlements
      status: "pending_verification",
      submittedAt: new Date("2026-11-10T12:00:00.000Z"),
      items: [],
    };

    FeeModel.find = () => mockQuery([legacyFee]);
    CashHandoverModel.find = () => mockQuery([legacyHandover]);

    const req = createMockRequest({ token: ownerToken });
    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    // 1. Verify Teacher Report Rows have defined numeric amounts
    assert.ok(body.teacherReports.length > 0);
    for (const tRow of body.teacherReports) {
      assert.notEqual(tRow.teacherInHandAmount, undefined, `teacherInHandAmount should be defined on teacher ${tRow.teacherId}`);
      assert.notEqual(tRow.ownerPendingAmount, undefined, `ownerPendingAmount should be defined on teacher ${tRow.teacherId}`);
      assert.notEqual(tRow.ownerVerifiedAmount, undefined, `ownerVerifiedAmount should be defined on teacher ${tRow.teacherId}`);
      assert.notEqual(tRow.totalCollected, undefined);
      assert.notEqual(tRow.activeDiscrepancies, undefined);
      assert.notEqual(tRow.transactionCount, undefined);

      assert.equal(typeof tRow.teacherInHandAmount, "number");
      assert.equal(typeof tRow.ownerPendingAmount, "number");
      assert.equal(typeof tRow.ownerVerifiedAmount, "number");
      assert.equal(typeof tRow.totalCollected, "number");
      assert.equal(typeof tRow.activeDiscrepancies, "number");
      assert.equal(typeof tRow.transactionCount, "number");

      assert.ok(!isNaN(tRow.teacherInHandAmount));
      assert.ok(!isNaN(tRow.ownerPendingAmount));
      assert.ok(!isNaN(tRow.ownerVerifiedAmount));

      // Assert that calling toLocaleString directly on amount fields does not throw
      assert.doesNotThrow(() => {
        tRow.totalCollected.toLocaleString("en-IN");
        tRow.teacherInHandAmount.toLocaleString("en-IN");
        tRow.ownerPendingAmount.toLocaleString("en-IN");
        tRow.ownerVerifiedAmount.toLocaleString("en-IN");
        tRow.activeDiscrepancies.toLocaleString("en-IN");
      });
    }

    // 2. Verify Batch Report Rows have defined numeric amounts and collectionRate
    assert.ok(body.batchReports.length > 0);
    for (const bRow of body.batchReports) {
      assert.equal(typeof bRow.totalInvoiced, "number");
      assert.equal(typeof bRow.totalCollected, "number");
      assert.equal(typeof bRow.outstandingBalance, "number");
      assert.equal(typeof bRow.partialPaymentCount, "number");
      assert.equal(typeof bRow.collectionRate, "number");
      assert.equal(typeof bRow.collectionRatePercent, "number");

      assert.doesNotThrow(() => {
        bRow.totalInvoiced.toLocaleString("en-IN");
        bRow.totalCollected.toLocaleString("en-IN");
        bRow.outstandingBalance.toLocaleString("en-IN");
      });
    }

    // 3. Verify Student Ledger Rows have defined numeric amounts
    assert.ok(body.studentLedger.length > 0);
    for (const sRow of body.studentLedger) {
      assert.equal(typeof sRow.amountDue, "number");
      assert.equal(typeof sRow.paidAmount, "number");
      assert.equal(typeof sRow.outstandingBalance, "number");
      assert.equal(typeof sRow.originalAmountDue, "number");

      assert.doesNotThrow(() => {
        sRow.amountDue.toLocaleString("en-IN");
        sRow.paidAmount.toLocaleString("en-IN");
        sRow.outstandingBalance.toLocaleString("en-IN");
      });

      for (const p of sRow.payments) {
        assert.equal(typeof p.amount, "number");
        assert.doesNotThrow(() => {
          p.amount.toLocaleString("en-IN");
        });
      }
    }

    // 4. Verify Handover Report Rows have defined numeric amounts
    assert.ok(body.handoverReports.length > 0);
    for (const hRow of body.handoverReports) {
      assert.equal(typeof hRow.submittedAmount, "number");
      assert.equal(typeof hRow.approvedAmount, "number");
      assert.equal(typeof hRow.discrepancyAmount, "number");
      assert.equal(typeof hRow.remainingDiscrepancy, "number");

      assert.doesNotThrow(() => {
        hRow.submittedAmount.toLocaleString("en-IN");
        hRow.approvedAmount.toLocaleString("en-IN");
        hRow.discrepancyAmount.toLocaleString("en-IN");
        hRow.remainingDiscrepancy.toLocaleString("en-IN");
      });
    }
  });
});
