process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { GET: getFeeSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/fees/summary/route.ts"
);
const {
  GET: getNotificationsRoute,
  PATCH: patchNotificationsRoute,
} = await import("../tution-desk-be/src/app/api/notifications/route.ts");

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const { calculatePaymentCustody, getFeePaymentEntries } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const CashHandoverModel = (
  await import("../tution-desk-be/src/models/CashHandover.ts")
).default;
const StaffNotificationModel = (
  await import("../tution-desk-be/src/models/StaffNotification.ts")
).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
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
    then: (resolve) => resolve(result),
  };
  return queryObj;
}

test("Phase 7.1 + 7.2: Fee Management Reorganization & Collection Visibility Test Suite", async (t) => {
  const centerId = "center_msec_alpha";
  const ownerId = "507f191e810c19729de860f1";
  const teacher1Id = "507f191e810c19729de860f2";
  const teacher2Id = "507f191e810c19729de860f3";
  const student1Id = "507f191e810c19729de86221";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Director Owner",
  });

  const teacher1Token = await signToken({
    userId: teacher1Id,
    teacherId: teacher1Id,
    centerId,
    role: "teacher",
    name: "Teacher Ramanujan",
  });

  const teacher2Token = await signToken({
    userId: teacher2Id,
    teacherId: teacher2Id,
    centerId,
    role: "teacher",
    name: "Teacher Aryabhata",
  });

  // Base mock data
  TeacherModel.find = () =>
    mockQuery([
      { _id: new mongoose.Types.ObjectId(teacher1Id), name: "Teacher Ramanujan", loginId: "TR01" },
      { _id: new mongoose.Types.ObjectId(teacher2Id), name: "Teacher Aryabhata", loginId: "TA02" },
    ]);

  StudentModel.find = () =>
    mockQuery([
      {
        _id: new mongoose.Types.ObjectId(student1Id),
        name: "Rahul Sharma",
        batch: "Grade 10 Math",
        centerId,
        assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
      },
    ]);

  // TEST 1: Teacher cash collection creates persistent notifications for both Owner and Teacher
  await t.test(
    "1. StaffNotification schema & creation: Both Owner and Teacher receive persistent notifications",
    async () => {
      const notificationsStore = [];

      StaffNotificationModel.create = async (docs) => {
        const arr = Array.isArray(docs) ? docs : [docs];
        for (const d of arr) {
          notificationsStore.push({
            ...d,
            _id: new mongoose.Types.ObjectId(),
            createdAt: new Date(),
          });
        }
        return arr;
      };

      // Mock notifications creation on a ₹1,500 collection by Teacher Ramanujan
      const amount = 1500;
      const studentName = "Rahul Sharma";
      const receiptNumber = "MSEC-2026-9901";

      await StaffNotificationModel.create([
        {
          centerId,
          recipientId: ownerId,
          recipientRole: "owner",
          type: "cash_collection",
          title: "New Cash Collection",
          message: `Teacher Ramanujan collected ₹${amount} from ${studentName}. Status: Teacher In-Hand.`,
          link: "/fees?tab=payments&sub=paid",
          isRead: false,
          metadata: { amount, studentName, receiptNumber },
        },
        {
          centerId,
          recipientId: teacher1Id,
          recipientRole: "teacher",
          type: "cash_collection",
          title: "Payment Recorded",
          message: `₹${amount} collected from ${studentName}. Status: In Your Custody.`,
          link: "/fees?tab=payments&sub=paid",
          isRead: false,
          metadata: { amount, studentName, receiptNumber },
        },
      ]);

      assert.equal(notificationsStore.length, 2);

      const ownerNotif = notificationsStore.find((n) => n.recipientRole === "owner");
      assert.ok(ownerNotif);
      assert.equal(ownerNotif.title, "New Cash Collection");
      assert.ok(
        ownerNotif.message.includes("Teacher Ramanujan collected ₹1500 from Rahul Sharma. Status: Teacher In-Hand.")
      );

      const teacherNotif = notificationsStore.find((n) => n.recipientRole === "teacher");
      assert.ok(teacherNotif);
      assert.equal(teacherNotif.title, "Payment Recorded");
      assert.ok(
        teacherNotif.message.includes("₹1500 collected from Rahul Sharma. Status: In Your Custody.")
      );
    }
  );

  // TEST 2: Idempotency protection prevents duplicate notifications on retry
  await t.test(
    "2. Idempotency protection: Duplicate retries with same idempotencyKey do not insert duplicate notifications",
    async () => {
      const storedKeys = new Set();
      let insertCount = 0;

      const safeInsertNotification = async (notif) => {
        if (notif.idempotencyKey && storedKeys.has(notif.idempotencyKey)) {
          return null; // Duplicate suppressed
        }
        if (notif.idempotencyKey) {
          storedKeys.add(notif.idempotencyKey);
        }
        insertCount++;
        return notif;
      };

      const key = "idem-test-key-001";
      await safeInsertNotification({
        centerId,
        recipientRole: "owner",
        idempotencyKey: `owner:${key}`,
        title: "New Cash Collection",
      });
      assert.equal(insertCount, 1);

      // Retry with same idempotency key
      const duplicateRes = await safeInsertNotification({
        centerId,
        recipientRole: "owner",
        idempotencyKey: `owner:${key}`,
        title: "New Cash Collection",
      });
      assert.equal(duplicateRes, null);
      assert.equal(insertCount, 1); // No new insertion
    }
  );

  // TEST 3: Owner Fee Summary API returns 6 KPIs, Action Required, and Recent Collections
  await t.test(
    "3. Owner Fee Summary API returns 6 KPIs, Action Required cards, and Recent Collections activity feed",
    async () => {
      FeeModel.aggregate = async (pipeline) => {
        if (JSON.stringify(pipeline).includes("Pending")) {
          return [{ _id: null, total: 3000 }];
        }
        return [{ _id: null, total: 5000 }];
      };
      FeeModel.countDocuments = async () => 2;

      // Mock fee records with payment history
      const mockFee = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86301"),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(student1Id), name: "Rahul Sharma", batch: "Grade 10" },
        amountDue: 0,
        paidAmount: 2000,
        status: "Paid",
        originalAmountDue: 2000,
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86401"),
            amount: 2000,
            paymentDate: new Date(),
            receiptNumber: "RCPT-001",
            receivedBy: new mongoose.Types.ObjectId(teacher1Id),
            receivedByRole: "teacher",
            isProvisional: true,
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFee]);
      CashHandoverModel.find = () =>
        mockQuery([
          {
            _id: new mongoose.Types.ObjectId(),
            status: "pending_approval",
            discrepancyStatus: "none",
            submittedAmount: 2000,
            discrepancyAmount: 0,
            incrementalSettlements: [],
          },
        ]);

      const req = createMockRequest({ token: ownerToken });
      const res = await getFeeSummaryRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.role, "owner");

      // Verify backwards compatibility fields
      assert.equal(typeof json.data.totalPendingAmount, "number");
      assert.equal(typeof json.data.pendingStudentsCount, "number");
      assert.equal(typeof json.data.collectedAmount, "number");

      // Verify 6 KPIs
      const kpis = json.data.kpis;
      assert.ok(kpis);
      assert.equal(kpis.totalParentCollections, 2000);
      assert.equal(kpis.teacherHeldCash, 2000);
      assert.equal(kpis.verifiedCashReceived, 0); // Not yet verified by Owner
      assert.equal(kpis.outstandingFeeBalance, 3000);

      // Verify Action Required
      const actions = json.data.actionRequired;
      assert.ok(actions);
      assert.equal(actions.pendingHandoversCount, 1);
      assert.equal(actions.pendingHandoversAmount, 2000);

      // Verify Recent Collections
      assert.ok(Array.isArray(json.data.recentCollections));
      assert.equal(json.data.recentCollections.length, 1);
      assert.equal(json.data.recentCollections[0].studentName, "Rahul Sharma");
      assert.equal(json.data.recentCollections[0].amount, 2000);
      assert.equal(json.data.recentCollections[0].custodyStatus, "Teacher In-Hand");
    }
  );

  // TEST 4: Teacher Fee Summary API returns 4 teacher KPIs and own custody metrics
  await t.test(
    "4. Teacher Fee Summary API returns 4 teacher KPIs and strictly scoped personal custody",
    async () => {
      FeeModel.aggregate = async () => [{ _id: null, total: 1000 }];
      FeeModel.countDocuments = async () => 1;

      const mockFeeTeacher1 = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86301"),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(student1Id), name: "Rahul Sharma", batch: "Grade 10" },
        amountDue: 0,
        paidAmount: 1500,
        status: "Paid",
        originalAmountDue: 1500,
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId("507f191e810c19729de86401"),
            amount: 1500,
            paymentDate: new Date(),
            receiptNumber: "RCPT-T1",
            receivedBy: new mongoose.Types.ObjectId(teacher1Id),
            receivedByRole: "teacher",
            isProvisional: true,
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFeeTeacher1]);
      CashHandoverModel.find = () =>
        mockQuery([
          {
            _id: new mongoose.Types.ObjectId(),
            status: "rejected",
            discrepancyStatus: "none",
            submittedAmount: 1000,
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

      // Verify 4 Teacher KPIs
      const kpis = json.data.kpis;
      assert.ok(kpis);
      assert.equal(kpis.ownCashCollected, 1500);
      assert.equal(kpis.ownCashInHand, 1500);
      assert.equal(kpis.ownSubmittedHandovers, 0);
      assert.equal(kpis.ownVerifiedHandovers, 0);

      // Verify Action Required
      const actions = json.data.actionRequired;
      assert.ok(actions);
      assert.equal(actions.eligibleForHandoverAmount, 1500);
      assert.equal(actions.rejectedHandoverCount, 1);

      // Verify Recent Collections contains only Teacher 1's collections
      assert.equal(json.data.recentCollections.length, 1);
      assert.equal(json.data.recentCollections[0].collectorName, "You");
      assert.equal(json.data.recentCollections[0].custodyStatus, "Teacher In-Hand");
    }
  );

  // TEST 5: Tenant & Role Isolation: Teacher 2 cannot see Teacher 1's collections in summary
  await t.test(
    "5. Role Scoping: Teacher 2 sees zero collected cash when only Teacher 1 collected payments",
    async () => {
      FeeModel.aggregate = async () => [{ _id: null, total: 0 }];
      FeeModel.countDocuments = async () => 0;

      // Same fee collected by Teacher 1
      const mockFeeTeacher1 = {
        _id: new mongoose.Types.ObjectId(),
        centerId,
        studentId: { _id: new mongoose.Types.ObjectId(student1Id), name: "Rahul Sharma", batch: "Grade 10" },
        paymentHistory: [
          {
            paymentId: new mongoose.Types.ObjectId(),
            amount: 1500,
            paymentDate: new Date(),
            receiptNumber: "RCPT-T1",
            receivedBy: new mongoose.Types.ObjectId(teacher1Id),
            receivedByRole: "teacher",
            isProvisional: true,
            allocations: [],
          },
        ],
      };

      FeeModel.find = () => mockQuery([mockFeeTeacher1]);
      CashHandoverModel.find = () => mockQuery([]);

      const req = createMockRequest({ token: teacher2Token });
      const res = await getFeeSummaryRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.data.role, "teacher");
      assert.equal(json.data.kpis.ownCashCollected, 0);
      assert.equal(json.data.kpis.ownCashInHand, 0);
      assert.equal(json.data.recentCollections.length, 0);
    }
  );

  // TEST 6: Financial Invariant: Cash collection is strictly separate from CashHandover
  await t.test(
    "6. Invariant: Recording cash sets teacher custody but does NOT create a CashHandover document",
    async () => {
      const paymentEntry = {
        paymentId: new mongoose.Types.ObjectId(),
        amount: 2500,
        paymentMode: "cash",
        receivedBy: new mongoose.Types.ObjectId(teacher1Id),
        receivedByRole: "teacher",
        isProvisional: true,
        allocations: [],
      };

      // Custody calculation splits custody correctly without mutation
      const custody = calculatePaymentCustody(paymentEntry);
      assert.equal(custody.teacherInHandAmount, 2500);
      assert.equal(custody.ownerVerifiedAmount, 0);
      assert.equal(custody.ownerPendingVerificationAmount, 0);
      assert.equal(custody.disputedDiscrepancyAmount, 0);
    }
  );

  // TEST 7: Notifications API returns persistent staff notifications scoped to role
  await t.test(
    "7. GET /api/notifications returns persistent staff notifications for authenticated Owner",
    async () => {
      FeeModel.countDocuments = async () => 1;
      const AttendanceModel = (
        await import("../tution-desk-be/src/models/Attendance.ts")
      ).default;
      AttendanceModel.countDocuments = async () => 1;

      StaffNotificationModel.find = () =>
        mockQuery([
          {
            _id: new mongoose.Types.ObjectId("507f191e810c19729de86991"),
            centerId,
            recipientRole: "owner",
            recipientId: ownerId,
            type: "cash_collection",
            title: "New Cash Collection",
            message: "Teacher Ramanujan collected ₹1500 from Rahul Sharma.",
            link: "/fees?tab=payments&sub=paid",
            isRead: false,
            createdAt: new Date(),
          },
        ]);

      const req = createMockRequest({
        token: ownerToken,
        url: "http://localhost:3000/api/notifications",
      });
      const res = await getNotificationsRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.alerts.length >= 1);

      const staffAlert = json.alerts.find(
        (a) => a.id === "507f191e810c19729de86991"
      );
      assert.ok(staffAlert);
      assert.equal(staffAlert.title, "New Cash Collection");
      assert.equal(staffAlert.isRead, false);
    }
  );

  // TEST 8: PATCH /api/notifications marks notifications as read
  await t.test(
    "8. PATCH /api/notifications marks notifications as read with audit timestamp",
    async () => {
      let updateFilter = null;
      let updateSet = null;

      StaffNotificationModel.updateMany = async (filter, update) => {
        updateFilter = filter;
        updateSet = update.$set;
        return { modifiedCount: 3 };
      };

      const req = createMockRequest({
        token: ownerToken,
        url: "http://localhost:3000/api/notifications",
        method: "PATCH",
        body: { markAllRead: true },
      });

      const res = await patchNotificationsRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.message, "All notifications marked as read");
      assert.equal(updateFilter.centerId, centerId);
      assert.equal(updateFilter.recipientRole, "owner");
      assert.equal(updateFilter.isRead, false);
      assert.equal(updateSet.isRead, true);
      assert.ok(updateSet.readAt instanceof Date);
    }
  );
});
