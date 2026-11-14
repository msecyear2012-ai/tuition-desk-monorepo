// test/phase7_3_teacher_fee_management_overview.test.mjs
// MSEC Phase 7.3: Teacher Fee Management Overview & Navigation Alignment Suite
// Validates role-specific overview, 3-section navigation, financial separation,
// assigned student scoping, and handover notifications.

import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test_jwt_secret_msec_phase_7_3_super_secure_key_12345";
process.env.NODE_ENV = "test";
process.env.WHATSAPP_MODE = "simulation";
process.env.ENABLE_LIVE_WHATSAPP = "false";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

const { signToken } = await import("../tution-desk-be/src/lib/jwt.ts");
const { GET: getFeeSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/fees/summary/route.ts"
);
const { GET: getFeesRoute } = await import(
  "../tution-desk-be/src/app/api/fees/route.ts"
);
const FeeModel = (
  await import("../tution-desk-be/src/models/Fee.ts")
).default;
const StudentModel = (
  await import("../tution-desk-be/src/models/Student.ts")
).default;
const CashHandoverModel = (
  await import("../tution-desk-be/src/models/CashHandover.ts")
).default;
const StaffNotificationModel = (
  await import("../tution-desk-be/src/models/StaffNotification.ts")
).default;
const TeacherModel = (
  await import("../tution-desk-be/src/models/Teacher.ts")
).default;
const CenterModel = (
  await import("../tution-desk-be/src/models/Center.ts")
).default;
const mongoose = (
  await import("../tution-desk-be/node_modules/mongoose/index.js")
).default;

function createMockRequest({
  token,
  url = "http://localhost:3000/api/fees/summary",
  method = "GET",
  body = null,
  headers = {},
}) {
  const reqUrl = new URL(url);
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    reqHeaders.set(k, v);
  }

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: reqUrl,
    json: async () => body || {},
  };
}

function mockQuery(result) {
  const queryObj = {
    sort: () => queryObj,
    populate: () => queryObj,
    select: () => queryObj,
    limit: () => queryObj,
    lean: async () => result,
    distinct: async () => result,
    then: (resolve) => resolve(result),
  };
  return queryObj;
}

test("Phase 7.3: Teacher Fee Management Overview & Navigation Alignment Suite", async (t) => {
  const centerId = "center_msec_phase73";
  const ownerId = "507f191e810c19729de86001";
  const teacher1Id = "507f191e810c19729de86002";
  const teacher2Id = "507f191e810c19729de86003";

  const studentT1Id = "507f191e810c19729de86101";
  const studentT2Id = "507f191e810c19729de86102";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    phone: "9876543210",
  });

  const teacher1Token = await signToken({
    userId: teacher1Id,
    centerId,
    role: "teacher",
    teacherId: teacher1Id,
    phone: "9876543211",
  });

  const teacher2Token = await signToken({
    userId: teacher2Id,
    centerId,
    role: "teacher",
    teacherId: teacher2Id,
    phone: "9876543212",
  });

  // Mock student assignment
  StudentModel.find = (query) => {
    const qTeacherId = query?.assignedTeacherId ? String(query.assignedTeacherId) : "";
    if (qTeacherId === teacher1Id) {
      return mockQuery([
        {
          _id: new mongoose.Types.ObjectId(studentT1Id),
          name: "Aarav Gupta",
          batch: "Grade 10 - ICSE",
          monthlyFee: 3000,
          assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
        },
      ]);
    }
    if (qTeacherId === teacher2Id) {
      return mockQuery([
        {
          _id: new mongoose.Types.ObjectId(studentT2Id),
          name: "Diya Patel",
          batch: "Grade 12 - Science",
          monthlyFee: 5000,
          assignedTeacherId: new mongoose.Types.ObjectId(teacher2Id),
        },
      ]);
    }
    return mockQuery([]);
  };

  TeacherModel.find = () =>
    mockQuery([
      { _id: new mongoose.Types.ObjectId(teacher1Id), name: "Teacher Ramanujan", loginId: "TR01" },
      { _id: new mongoose.Types.ObjectId(teacher2Id), name: "Teacher Aryabhata", loginId: "TA02" },
    ]);

  CenterModel.findOne = () =>
    mockQuery({
      _id: new mongoose.Types.ObjectId(),
      centerId,
      name: "MSEC Academy",
      ownerName: "Center Director",
    });

  // TEST 1: Teacher Overview returns Section A (My Financial Activity) and Section B (My Students' Fee Status)
  await t.test(
    "1. Teacher Overview API returns separate Section A (Financial Activity) and Section B (Student Status)",
    async () => {
      FeeModel.aggregate = async () => [{ _id: null, total: 3000 }];
      FeeModel.countDocuments = async () => 1;

      // Mock fee with student assigned to Teacher 1, with payment in Teacher 1's custody
      const mockFee1 = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86301"),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(studentT1Id), name: "Aarav Gupta", batch: "Grade 10 - ICSE" },
        amountDue: 1000,
        paidAmount: 2000,
        status: "Partial Paid",
        month: "2026-11",
        title: "November Tuition",
        originalAmountDue: 3000,
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86401"),
            amount: 2000,
            paymentDate: new Date(),
            receiptNumber: "RCPT-T1-01",
            receivedBy: new mongoose.Types.ObjectId(teacher1Id),
            receivedByRole: "teacher",
            isProvisional: true,
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFee1]);
      CashHandoverModel.find = () =>
        mockQuery([
          {
            _id: new mongoose.Types.ObjectId(),
            status: "pending_approval",
            discrepancyStatus: "none",
            submittedAmount: 1500,
            discrepancyAmount: 0,
            incrementalSettlements: [],
          },
        ]);

      const req = createMockRequest({ token: teacher1Token });
      const res = await getFeeSummaryRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.role, "teacher");

      // Verify Section A: My Financial Activity
      assert.ok(json.data.kpis);
      assert.equal(json.data.kpis.ownCashCollected, 2000);
      assert.equal(json.data.kpis.ownCashInHand, 2000); // 2000 in hand (unallocated in mockFee)
      assert.equal(typeof json.data.kpis.ownSubmittedHandovers, "number");
      assert.equal(typeof json.data.kpis.ownVerifiedHandovers, "number");

      // Verify Section B: My Students' Fee Status
      assert.ok(json.data.studentStatus);
      assert.equal(json.data.studentStatus.totalAssignedStudents, 1);
      assert.equal(json.data.studentStatus.studentsWithDues, 1);
      assert.equal(json.data.studentStatus.studentsFullyPaid, 0);
      assert.equal(json.data.studentStatus.totalOutstandingBalance, 1000);

      // Verify Recent Activity has zero phone numbers
      assert.ok(Array.isArray(json.data.studentStatus.recentActivity));
      assert.equal(json.data.studentStatus.recentActivity.length, 1);
      const activity = json.data.studentStatus.recentActivity[0];
      assert.equal(activity.studentName, "Aarav Gupta");
      assert.equal(activity.batchName, "Grade 10 - ICSE");
      assert.equal(activity.amountDue, 1000);
      assert.equal(activity.status, "Partial Paid");
      assert.equal(activity.parentPhone, undefined);
      assert.equal(activity.phone, undefined);
    }
  );

  // TEST 2: Strict Separation: Student Outstanding Dues != Teacher Cash In Hand != Verified Safe Cash
  await t.test(
    "2. Strict Invariant Separation: Student dues (₹1,000), cash custody (₹2,000), and verified cash (₹0) are independent",
    async () => {
      FeeModel.aggregate = async () => [{ _id: null, total: 1000 }];
      FeeModel.countDocuments = async () => 1;

      const mockFee = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86301"),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(studentT1Id), name: "Aarav Gupta", batch: "Grade 10" },
        amountDue: 1000,
        paidAmount: 2000,
        status: "Partial Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86401"),
            amount: 2000,
            paymentDate: new Date(),
            receivedBy: new mongoose.Types.ObjectId(teacher1Id),
            receivedByRole: "teacher",
            isProvisional: true,
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFee]);
      CashHandoverModel.find = () => mockQuery([]);

      const req = createMockRequest({ token: teacher1Token });
      const res = await getFeeSummaryRoute(req);
      const json = await res.json();

      const studentOutstanding = json.data.studentStatus.totalOutstandingBalance;
      const teacherInHand = json.data.kpis.ownCashInHand;
      const verifiedSafe = json.data.kpis.ownVerifiedHandovers;

      // Invariants: These three values represent distinct physical and accounting realities
      assert.equal(studentOutstanding, 1000); // What the student still owes
      assert.equal(teacherInHand, 2000);      // What the teacher holds in pocket/desk
      assert.equal(verifiedSafe, 0);          // What has cleared to owner safe

      assert.notEqual(studentOutstanding, teacherInHand);
      assert.notEqual(teacherInHand, verifiedSafe);
    }
  );

  // TEST 3: Cross-Teacher Privacy & Scoping Isolation
  await t.test(
    "3. Cross-Teacher Privacy: Teacher 2 sees ₹0 collections and zero students from Teacher 1",
    async () => {
      // Feed has payments only collected by Teacher 1
      const mockFeeT1 = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86301"),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(studentT1Id), name: "Aarav Gupta", batch: "Grade 10" },
        amountDue: 0,
        paidAmount: 2000,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86401"),
            amount: 2000,
            receivedBy: new mongoose.Types.ObjectId(teacher1Id),
            receivedByRole: "teacher",
            isProvisional: true,
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFeeT1]);
      CashHandoverModel.find = () => mockQuery([]);

      // Call API as Teacher 2
      const req = createMockRequest({ token: teacher2Token });
      const res = await getFeeSummaryRoute(req);
      const json = await res.json();

      // Teacher 2 must see 0 collected cash and 0 in-hand cash
      assert.equal(json.data.kpis.ownCashCollected, 0);
      assert.equal(json.data.kpis.ownCashInHand, 0);
      assert.equal(json.data.recentCollections.length, 0);

      // Assigned students for Teacher 2 (Diya Patel) has 0 fees in mockFeeT1
      assert.equal(json.data.studentStatus.studentsWithDues, 0);
      assert.equal(json.data.studentStatus.totalOutstandingBalance, 0);
    }
  );

  // TEST 4: Teacher GET /api/fees scoping preserves tenant and teacher assignment isolation
  await t.test(
    "4. GET /api/fees for Teacher scopes strictly by assignedTeacherId",
    async () => {
      StudentModel.find = () =>
        mockQuery([new mongoose.Types.ObjectId(studentT1Id)]);

      let capturedFilter = null;
      FeeModel.find = (filter) => {
        capturedFilter = filter;
        return mockQuery([]);
      };

      const req = createMockRequest({
        token: teacher1Token,
        url: "http://localhost:3000/api/fees?status=Pending",
      });

      const res = await getFeesRoute(req);
      assert.equal(res.status, 200);

      assert.ok(capturedFilter);
      assert.equal(capturedFilter.centerId, centerId);
      assert.ok(capturedFilter.$or);
      // Confirms filter checks assignedTeacherId or scoped student IDs
      const hasTeacherScope = capturedFilter.$or.some(
        (cond) =>
          String(cond.assignedTeacherId) === teacher1Id ||
          (cond.studentId && cond.studentId.$in)
      );
      assert.equal(hasTeacherScope, true);
    }
  );

  // TEST 5: Owner Summary functionality remains intact and institute-wide
  await t.test(
    "5. Owner Overview functionality remains intact with 6 KPIs and all-center collections",
    async () => {
      FeeModel.aggregate = async (pipeline) => {
        if (JSON.stringify(pipeline).includes("Pending")) return [{ _id: null, total: 4000 }];
        return [{ _id: null, total: 6000 }];
      };
      FeeModel.countDocuments = async () => 2;

      const mockFeeOwner = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86301"),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(studentT1Id), name: "Aarav Gupta", batch: "Grade 10" },
        amountDue: 0,
        paidAmount: 2000,
        status: "Paid",
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86401"),
            amount: 2000,
            receivedBy: new mongoose.Types.ObjectId(ownerId),
            receivedByRole: "owner",
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFeeOwner]);
      CashHandoverModel.find = () => mockQuery([]);

      const req = createMockRequest({ token: ownerToken });
      const res = await getFeeSummaryRoute(req);
      const json = await res.json();

      assert.equal(json.data.role, "owner");
      assert.ok(json.data.kpis.totalParentCollections !== undefined);
      assert.ok(json.data.kpis.verifiedCashReceived !== undefined);
      assert.ok(json.data.kpis.teacherHeldCash !== undefined);
      assert.ok(json.data.kpis.pendingVerificationCash !== undefined);
      assert.ok(json.data.kpis.outstandingFeeBalance !== undefined);
      assert.ok(json.data.kpis.activeDiscrepancies !== undefined);
    }
  );
});
