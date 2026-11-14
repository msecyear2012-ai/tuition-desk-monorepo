// test/cash_handover_visibility_and_custody.test.mjs
// MSEC: Cash Handover Visibility & Custody Attribution Test Suite
// Verifies fix for Teacher In-Hand cash visibility, cross-batch payment scoping,
// and single source of truth for custody across Owner and Teacher consoles.

import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test_jwt_secret_msec_handover_custody_fix_98765";
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
const { GET: getFeeDetailRoute } = await import(
  "../tution-desk-be/src/app/api/fees/[feeId]/route.ts"
);
const { GET: getHandoversRoute, POST: postHandoverRoute } = await import(
  "../tution-desk-be/src/app/api/handovers/route.ts"
);

const FeeModel = (
  await import("../tution-desk-be/src/models/Fee.ts")
).default;
const StudentModel = (
  await import("../tution-desk-be/src/models/Student.ts")
).default;
const TeacherModel = (
  await import("../tution-desk-be/src/models/Teacher.ts")
).default;
const CenterModel = (
  await import("../tution-desk-be/src/models/Center.ts")
).default;
const CashHandoverModel = (
  await import("../tution-desk-be/src/models/CashHandover.ts")
).default;
const StaffNotificationModel = (
  await import("../tution-desk-be/src/models/StaffNotification.ts")
).default;
const mongoose = (
  await import("../tution-desk-be/node_modules/mongoose/index.js")
).default;

function createMockRequest({
  token,
  url = "http://localhost:3000/api/fees",
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
    session: () => queryObj,
    lean: async () => result,
    distinct: async () => result,
    then: (resolve) => resolve(result),
  };
  return queryObj;
}

test("Cash Handover Visibility & Custody Attribution Suite", async (t) => {
  const centerId = "msce-8267";
  const ownerId = "6ae869d9c117e0a550dcb247";
  const teacherJitenderId = "6ae9ba93d29bd04896bac676";
  const teacherOtherId = "6ae9ba93d29bd04896bac699";
  const studentShobhaId = "6aed8bfcb1bcf9141efc2931";
  const feeId = "6aeed8a6b1bcf9141efc30aa";
  const paymentId = "6af476374a83ba2ca81c373b";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner MSCE",
  });

  const teacherJitenderToken = await signToken({
    userId: teacherJitenderId,
    centerId,
    role: "teacher",
    teacherId: teacherJitenderId,
    name: "Jitender Kumar",
  });

  const teacherOtherToken = await signToken({
    userId: teacherOtherId,
    centerId,
    role: "teacher",
    teacherId: teacherOtherId,
    name: "Other Faculty",
  });

  // Base mock student: Shobha is NOT assigned to Teacher Jitender (assignedTeacherId: null)
  const mockStudentShobha = {
    _id: new mongoose.Types.ObjectId(studentShobhaId),
    centerId,
    name: "shobha",
    batch: "Class 10 - Science",
    assignedTeacherId: null,
    phone: "8368948820",
    parentWhatsApp: "8368948820",
  };

  // Base mock fee: ₹1,500 cash payment collected by Teacher Jitender Kumar
  const mockFeeShobha = {
    _id: new mongoose.Types.ObjectId(feeId),
    centerId,
    studentId: mockStudentShobha,
    month: "Nov 2026",
    amountDue: 0,
    paidAmount: 1500,
    status: "Paid",
    assignedTeacherId: null,
    receivedBy: new mongoose.Types.ObjectId(teacherJitenderId),
    receivedByRole: "teacher",
    recordedBy: new mongoose.Types.ObjectId(teacherJitenderId),
    recordedByRole: "teacher",
    paymentHistory: [
      {
        _id: new mongoose.Types.ObjectId(paymentId),
        paymentId: new mongoose.Types.ObjectId(paymentId),
        amount: 1500,
        paymentMode: "Cash",
        paymentDate: new Date("2026-11-11T05:30:00Z"),
        receiptNumber: "RCPT-QBZPC9",
        recordedBy: new mongoose.Types.ObjectId(teacherJitenderId),
        recordedByRole: "teacher",
        receivedBy: new mongoose.Types.ObjectId(teacherJitenderId),
        receivedByRole: "teacher",
        custodyStatus: "teacher_custody",
        isProvisional: true,
        allocations: [],
      },
    ],
    toObject() {
      return { ...this };
    },
  };

  TeacherModel.find = () =>
    mockQuery([
      { _id: new mongoose.Types.ObjectId(teacherJitenderId), name: "Jitender Kumar", loginId: "8368948820" },
      { _id: new mongoose.Types.ObjectId(teacherOtherId), name: "Other Faculty", loginId: "8368948899" },
    ]);

  CenterModel.findOne = () =>
    mockQuery({
      _id: new mongoose.Types.ObjectId(),
      centerId,
      name: "MSCE Academy",
      ownerName: "Owner",
    });

  StudentModel.findById = async (id) =>
    String(id) === studentShobhaId ? mockStudentShobha : null;

  StudentModel.find = (query) => {
    const qTeacher = query?.assignedTeacherId ? String(query.assignedTeacherId) : "";
    if (qTeacher === teacherJitenderId) {
      return mockQuery([]); // Shobha is NOT assigned to Jitender
    }
    return mockQuery([]);
  };

  FeeModel.aggregate = async () => [];
  FeeModel.countDocuments = async () => 0;

  // TEST 1: Owner Overview correctly counts ₹1,500 as Teacher In-Hand
  await t.test(
    "1. Owner Overview counts ₹1,500 as Teacher In-Hand for unsubmitted cash collection",
    async () => {
      FeeModel.find = () => mockQuery([mockFeeShobha]);
      CashHandoverModel.find = () => mockQuery([]);

      const req = createMockRequest({
        token: ownerToken,
        url: "http://localhost:3000/api/fees/summary",
      });
      const res = await getFeeSummaryRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.role, "owner");
      assert.equal(json.data.kpis.teacherHeldCash, 1500);
      assert.equal(json.data.kpis.verifiedCashReceived, 0);
      assert.equal(json.data.kpis.pendingVerificationCash, 0);
    }
  );

  // TEST 2: Teacher GET /api/fees includes Shobha's fee because Jitender collected the payment
  await t.test(
    "2. Teacher GET /api/fees includes cross-batch/unassigned student fee where teacher collected cash",
    async () => {
      let capturedFilter = null;
      FeeModel.find = (filter) => {
        capturedFilter = filter;
        return mockQuery([mockFeeShobha]);
      };

      const req = createMockRequest({
        token: teacherJitenderToken,
        url: "http://localhost:3000/api/fees?status=Paid,Partial Paid",
      });
      const res = await getFeesRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.length, 1);
      assert.equal(String(json.data[0]._id), feeId);

      // Verify the filter includes payment collector attribution
      assert.ok(capturedFilter.$or);
      const hasCollectorCheck = capturedFilter.$or.some(
        (cond) =>
          cond["paymentHistory.receivedBy"] || cond["paymentHistory.recordedBy"]
      );
      assert.equal(hasCollectorCheck, true);
    }
  );

  // TEST 3: Teacher GET /api/fees/[feeId] allows teacher who collected payment to view fee & receipt
  await t.test(
    "3. Teacher GET /api/fees/[feeId] authorizes collector to view fee details with masked contact",
    async () => {
      FeeModel.findOne = () => mockQuery(mockFeeShobha);

      const req = createMockRequest({
        token: teacherJitenderToken,
        url: `http://localhost:3000/api/fees/${feeId}`,
      });
      const res = await getFeeDetailRoute(req, { params: Promise.resolve({ feeId }) });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.amountDue, 0);
      assert.equal(json.data.paidAmount, 1500);
      // Student contact is masked for teacher
      assert.ok(json.data.studentId.phone.includes("***"));
    }
  );

  // TEST 4: Cross-Teacher Isolation - Teacher Other cannot see Shobha's fee
  await t.test(
    "4. Cross-Teacher Isolation: Teacher Other who neither teaches nor collected Shobha receives 0 fees",
    async () => {
      let capturedFilter = null;
      FeeModel.find = (filter) => {
        capturedFilter = filter;
        // In real MongoDB, query with teacherOtherId would not match mockFeeShobha
        return mockQuery([]);
      };

      const req = createMockRequest({
        token: teacherOtherToken,
        url: "http://localhost:3000/api/fees?status=Paid,Partial Paid",
      });
      const res = await getFeesRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.length, 0);

      // Verify filter scopes by Teacher Other's ObjectId
      const matchesOther = capturedFilter.$or.some(
        (cond) =>
          cond.assignedTeacherId?.toString() === teacherOtherId ||
          cond["paymentHistory.receivedBy"]?.$in?.some(
            (id) => id.toString() === teacherOtherId
          )
      );
      assert.equal(matchesOther, true);
    }
  );

  // TEST 5: Handover scoping: Teacher Other cannot submit handover for Jitender's collection
  await t.test(
    "5. Teacher Other is blocked from submitting handover envelope for Jitender's collected cash",
    async () => {
      FeeModel.find = () => ({
        session: () => mockQuery([mockFeeShobha]),
      });

      const req = createMockRequest({
        token: teacherOtherToken,
        url: "http://localhost:3000/api/handovers",
        method: "POST",
        body: {
          items: [
            {
              feeId,
              paymentId,
              amount: 1500,
            },
          ],
        },
      });

      // Mock startSession
      mongoose.startSession = async () => ({
        startTransaction: () => {},
        commitTransaction: async () => {},
        abortTransaction: async () => {},
        endSession: async () => {},
      });

      const res = await postHandoverRoute(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.code, "UNAUTHORIZED_COLLECTOR_ALLOCATION");
    }
  );
});
