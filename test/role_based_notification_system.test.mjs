process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "../tution-desk-be/node_modules/mongoose/index.js";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StaffNotification = (await import("../tution-desk-be/src/models/StaffNotification.ts")).default;
const {
  createNotification,
  notifyCashCollectionEvents,
  notifyHandoverSubmittedEvents,
  notifyHandoverReviewEvents,
  notifyBatchRequestEvents,
  notifyStudentAdmissionEvents,
  notifyAttendanceEvents,
  notifyTestEvents,
} = await import("../tution-desk-be/src/lib/notificationService.ts");
const { GET: getNotificationsRoute, PATCH: patchNotificationsRoute } = await import(
  "../tution-desk-be/src/app/api/notifications/route.ts"
);

function createMockRequest({
  token,
  url = "http://localhost:3000/api/notifications",
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
    url: reqUrl.toString(),
    nextUrl: reqUrl,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    json: async () => body,
  };
}

test("Role-Based Notification System Specification Suite", async (t) => {
  const centerA = "center-msec-101";
  const centerB = "center-msec-202";

  const ownerId = new mongoose.Types.ObjectId().toString();
  const teacherAId = new mongoose.Types.ObjectId().toString();
  const teacherBId = new mongoose.Types.ObjectId().toString();
  const studentAId = new mongoose.Types.ObjectId().toString();
  const studentBId = new mongoose.Types.ObjectId().toString();

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerA,
    role: "owner",
    name: "Center Director",
  });

  const teacherAToken = await signToken({
    userId: teacherAId,
    centerId: centerA,
    role: "teacher",
    teacherId: teacherAId,
    name: "Teacher Jitender",
  });

  const teacherBToken = await signToken({
    userId: teacherBId,
    centerId: centerA,
    role: "teacher",
    teacherId: teacherBId,
    name: "Teacher Priya",
  });

  // In-memory notifications store for route test isolation
  const mockDb = [];

  StaffNotification.find = (filter) => {
    let result = mockDb.filter((item) => {
      if (filter.centerId && item.centerId !== filter.centerId) return false;
      if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return false;
      if (filter.category && item.category !== filter.category) return false;
      if (typeof filter.isRead === "boolean" && item.isRead !== filter.isRead) return false;
      if (filter.$or) {
        const matchesOr = filter.$or.some((clause) => {
          if (clause.recipientId && clause.recipientId.$in) {
            return clause.recipientId.$in.includes(item.recipientId);
          }
          if (clause.recipientId === item.recipientId) return true;
          return false;
        });
        if (!matchesOr) return false;
      }
      return true;
    });

    const queryObj = {
      sort: () => queryObj,
      skip: (s) => {
        result = result.slice(s);
        return queryObj;
      },
      limit: (l) => {
        result = result.slice(0, l);
        return queryObj;
      },
      lean: async () => result,
      then: (resolve) => resolve(result),
    };
    return queryObj;
  };

  StaffNotification.countDocuments = async (filter) => {
    return mockDb.filter((item) => {
      if (filter.centerId && item.centerId !== filter.centerId) return false;
      if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return false;
      if (filter.category && item.category !== filter.category) return false;
      if (typeof filter.isRead === "boolean" && item.isRead !== filter.isRead) return false;
      if (filter.$or) {
        return filter.$or.some((clause) => {
          if (clause.recipientId && clause.recipientId.$in) {
            return clause.recipientId.$in.includes(item.recipientId);
          }
          if (clause.recipientId === item.recipientId) return true;
          return false;
        });
      }
      return true;
    }).length;
  };

  StaffNotification.findOne = async (filter) => {
    return mockDb.find((item) => {
      if (filter.idempotencyKey && item.idempotencyKey === filter.idempotencyKey) return true;
      if (filter._id && String(item._id) === String(filter._id)) return true;
      return false;
    }) || null;
  };

  StaffNotification.findOneAndUpdate = async (filter, update) => {
    const item = mockDb.find((n) => {
      if (filter._id && String(n._id) !== String(filter._id)) return false;
      if (filter.centerId && n.centerId !== filter.centerId) return false;
      if (filter.$or) {
        const matchesOr = filter.$or.some((clause) => {
          if (clause.recipientId && clause.recipientId.$in) {
            return clause.recipientId.$in.includes(n.recipientId);
          }
          if (clause.recipientId === n.recipientId) return true;
          return false;
        });
        if (!matchesOr) return false;
      }
      return true;
    });
    if (!item) return null;
    if (update.$set) {
      Object.assign(item, update.$set);
    }
    return item;
  };

  StaffNotification.updateMany = async (filter, update) => {
    let matched = 0;
    mockDb.forEach((item) => {
      if (filter.centerId && item.centerId !== filter.centerId) return;
      if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return;
      if (typeof filter.isRead === "boolean" && item.isRead !== filter.isRead) return;
      if (filter.$or) {
        const matchesOr = filter.$or.some((clause) => {
          if (clause.recipientId && clause.recipientId.$in) {
            return clause.recipientId.$in.includes(item.recipientId);
          }
          if (clause.recipientId === item.recipientId) return true;
          return false;
        });
        if (!matchesOr) return;
      }
      if (update.$set) {
        Object.assign(item, update.$set);
      }
      matched++;
    });
    return { matchedCount: matched, modifiedCount: matched };
  };

  // Helper to push mock notif
  function recordMockNotif(doc) {
    const item = {
      _id: doc._id || new mongoose.Types.ObjectId().toString(),
      centerId: doc.centerId,
      recipientId: doc.recipientId,
      recipientRole: doc.recipientRole,
      category: doc.category || "system",
      type: doc.type,
      title: doc.title,
      message: doc.message,
      amount: doc.amount || 0,
      statusLabel: doc.statusLabel,
      feeId: doc.feeId,
      paymentId: doc.paymentId,
      studentId: doc.studentId,
      studentName: doc.studentName,
      collectorId: doc.collectorId,
      collectorName: doc.collectorName,
      deepLink: doc.deepLink || doc.link,
      link: doc.link || doc.deepLink,
      pushStatus: doc.pushStatus || "none",
      isRead: doc.isRead || false,
      readAt: doc.readAt,
      idempotencyKey: doc.idempotencyKey,
      createdAt: doc.createdAt || new Date(),
    };
    mockDb.push(item);
    return item;
  }

  // Hook createNotification internally to mockDb for unit checks
  const originalSave = StaffNotification.prototype.save;
  StaffNotification.prototype.save = async function () {
    recordMockNotif(this);
    return this;
  };

  await t.test("1. Correct Owner notification on Teacher cash collection", async () => {
    mockDb.length = 0;
    const feeId = new mongoose.Types.ObjectId().toString();
    const paymentId = new mongoose.Types.ObjectId().toString();

    await notifyCashCollectionEvents({
      centerId: centerA,
      feeId,
      paymentId,
      studentId: studentAId,
      studentName: "Shobha Sharma",
      amount: 1500,
      collectorId: teacherAId,
      collectorName: "Jitender Kumar",
      collectorRole: "teacher",
      receiptNumber: "RCPT-9871",
      billingMonth: "November 2026",
    });

    // Check Owner received notification
    const ownerNotif = mockDb.find(
      (n) => n.recipientRole === "owner" && n.type === "cash_collection"
    );
    assert.ok(ownerNotif, "Owner must receive cash_collection notification");
    assert.equal(ownerNotif.amount, 1500);
    assert.equal(ownerNotif.studentName, "Shobha Sharma");
    assert.match(ownerNotif.message, /collected ₹1,500 in physical cash/);
    assert.equal(ownerNotif.deepLink, "/fees?tab=payments&sub=paid");
  });

  await t.test("2. Correct Parent receipt notification on payment collection", async () => {
    // Check Parent notification was created in same collection
    const parentNotif = mockDb.find(
      (n) => n.recipientRole === "parent" && n.type === "cash_collection"
    );
    assert.ok(parentNotif, "Parent must receive payment receipt notification");
    assert.equal(parentNotif.recipientId, studentAId);
    assert.equal(parentNotif.amount, 1500);
    assert.match(parentNotif.message, /Payment of ₹1,500 received/);
    assert.match(parentNotif.message, /RCPT-9871/);
    assert.equal(parentNotif.deepLink, "/portal");
  });

  await t.test("3. Correct Owner handover notification on Teacher submission", async () => {
    const handoverId = new mongoose.Types.ObjectId().toString();

    await notifyHandoverSubmittedEvents({
      centerId: centerA,
      handoverId,
      handoverNumber: "HND-2026-0042",
      teacherId: teacherAId,
      teacherName: "Jitender Kumar",
      totalAmount: 3000,
      itemCount: 2,
    });

    const ownerHandoverNotif = mockDb.find(
      (n) => n.recipientRole === "owner" && n.type === "handover_submitted"
    );
    assert.ok(ownerHandoverNotif, "Owner must receive handover_submitted notification");
    assert.equal(ownerHandoverNotif.amount, 3000);
    assert.match(ownerHandoverNotif.message, /HND-2026-0042/);
    assert.match(ownerHandoverNotif.message, /2 collections totaling ₹3,000/);
    assert.equal(ownerHandoverNotif.deepLink, "/fees?tab=handovers");
  });

  await t.test("4. Correct Teacher verification, partial, and rejection notifications", async () => {
    const handoverId = new mongoose.Types.ObjectId().toString();

    // A. Approved
    await notifyHandoverReviewEvents({
      centerId: centerA,
      handoverId,
      handoverNumber: "HND-2026-0042",
      teacherId: teacherAId,
      decision: "approved",
      submittedAmount: 3000,
      approvedAmount: 3000,
    });

    const approvedNotif = mockDb.find(
      (n) => n.recipientId === teacherAId && n.type === "handover_verified" && n.statusLabel === "Approved"
    );
    assert.ok(approvedNotif, "Teacher must receive approval notification");
    assert.match(approvedNotif.message, /transferred to center custody/);

    // B. Rejected
    await notifyHandoverReviewEvents({
      centerId: centerA,
      handoverId,
      handoverNumber: "HND-2026-0043",
      teacherId: teacherAId,
      decision: "rejected",
      submittedAmount: 1500,
      reason: "Missing counterfoil signature",
    });

    const rejectedNotif = mockDb.find(
      (n) => n.recipientId === teacherAId && n.type === "handover_rejected"
    );
    assert.ok(rejectedNotif, "Teacher must receive rejection notification");
    assert.match(rejectedNotif.message, /Missing counterfoil signature/);
    assert.match(rejectedNotif.message, /returned to your physical custody/);
  });

  await t.test("5. Batch request notifications for Owner and Teacher", async () => {
    const requestId = new mongoose.Types.ObjectId().toString();

    // A. Submission
    await notifyBatchRequestEvents({
      centerId: centerA,
      requestId,
      studentId: studentAId,
      studentName: "Rohit Verma",
      batchName: "Class 10 - Science",
      currentBatch: "General",
      requesterId: teacherAId,
      requesterName: "Jitender Kumar",
      action: "submitted",
    });

    const ownerBatchNotif = mockDb.find(
      (n) => n.recipientRole === "owner" && n.type === "batch_request_submitted"
    );
    assert.ok(ownerBatchNotif, "Owner must receive batch_request_submitted");
    assert.match(ownerBatchNotif.message, /Class 10 - Science/);

    // B. Approval
    await notifyBatchRequestEvents({
      centerId: centerA,
      requestId,
      studentId: studentAId,
      studentName: "Rohit Verma",
      batchName: "Class 10 - Science",
      requesterId: teacherAId,
      requesterName: "Jitender Kumar",
      action: "approved",
    });

    const approvedBatchNotif = mockDb.find(
      (n) => n.recipientId === teacherAId && n.type === "batch_request_approved"
    );
    assert.ok(approvedBatchNotif, "Teacher must receive batch_request_approved");
    assert.match(approvedBatchNotif.message, /Owner approved your request/);
  });

  await t.test("6. Attendance absent alerts and Test result notifications", async () => {
    // Attendance
    await notifyAttendanceEvents({
      centerId: centerA,
      batch: "Class 9 - Maths",
      date: new Date("2026-11-12"),
      recorderId: teacherAId,
      recorderRole: "teacher",
      presentCount: 15,
      absentCount: 1,
      absentStudents: [{ studentId: studentAId, studentName: "Shobha Sharma" }],
    });

    const parentAbsentNotif = mockDb.find(
      (n) => n.recipientRole === "parent" && n.type === "attendance_marked"
    );
    assert.ok(parentAbsentNotif, "Parent must receive absent alert");
    assert.match(parentAbsentNotif.message, /marked absent for batch 'Class 9 - Maths'/);

    // Test Result
    const testId = new mongoose.Types.ObjectId().toString();
    await notifyTestEvents({
      centerId: centerA,
      testId,
      testTitle: "Trigonometry Unit Test",
      batch: "Class 10 - Maths",
      maxMarks: 50,
      eventType: "test_result",
      results: [{ studentId: studentAId, studentName: "Shobha Sharma", marksObtained: 45 }],
    });

    const parentTestResultNotif = mockDb.find(
      (n) => n.recipientRole === "parent" && n.type === "test_result"
    );
    assert.ok(parentTestResultNotif, "Parent must receive test score alert");
    assert.match(parentTestResultNotif.message, /scored 45\/50 \(90%\) in 'Trigonometry Unit Test'/);
  });

  await t.test("7. Cross-center notification isolation", async () => {
    // Notification for Center B
    recordMockNotif({
      centerId: centerB,
      recipientId: centerB,
      recipientRole: "owner",
      type: "cash_collection",
      title: "Center B Payment",
      message: "Secret payment from Center B",
      amount: 50000,
    });

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/notifications",
    });

    const res = await getNotificationsRoute(req);
    const data = await res.json();
    assert.equal(res.status, 200);

    const centerBNotif = (data.notifications || []).find((n) => n.centerId === centerB);
    assert.equal(centerBNotif, undefined, "Center A owner must NEVER receive Center B notifications");
  });

  await t.test("8. Teacher assignment and recipient isolation", async () => {
    // Notification specifically for Teacher A
    recordMockNotif({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      type: "handover_verified",
      title: "Teacher A Private Handover",
      message: "Private for Teacher A",
    });

    // Request from Teacher B
    const reqTeacherB = createMockRequest({
      token: teacherBToken,
      url: "http://localhost:3000/api/notifications",
    });

    const res = await getNotificationsRoute(reqTeacherB);
    const data = await res.json();

    const teacherANotif = (data.notifications || []).find(
      (n) => n.title === "Teacher A Private Handover"
    );
    assert.equal(teacherANotif, undefined, "Teacher B must NOT see Teacher A's private notification");
  });

  await t.test("9. Duplicate event prevention via idempotency", async () => {
    const duplicateKey = "idemp_test_event_999";

    const notif1 = await createNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      type: "system",
      title: "Idempotent Alert",
      message: "This should only exist once",
      idempotencyKey: duplicateKey,
    });

    const notif2 = await createNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      type: "system",
      title: "Idempotent Alert - Duplicate Attempt",
      message: "This should be discarded",
      idempotencyKey: duplicateKey,
    });

    assert.equal(String(notif1._id), String(notif2._id), "Duplicate call must return existing notification");
    const count = mockDb.filter((n) => n.idempotencyKey === duplicateKey).length;
    assert.equal(count, 1, "Idempotency key must prevent duplicate DB entries");
  });

  await t.test("10. Read / Unread PATCH behavior with recipient authorization", async () => {
    const unreadItem = recordMockNotif({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      type: "system",
      title: "Unread Alert for Teacher A",
      message: "Needs read",
      isRead: false,
    });

    // Teacher B tries to mark Teacher A's notification as read -> Should not update
    const patchReqUnauthorized = createMockRequest({
      token: teacherBToken,
      method: "PATCH",
      body: { notificationId: unreadItem._id },
    });
    const unauthRes = await patchNotificationsRoute(patchReqUnauthorized);
    assert.equal(unauthRes.status, 404, "Teacher B cannot modify Teacher A's notification");
    assert.equal(unreadItem.isRead, false, "Item must remain unread");

    // Teacher A marks own notification as read
    const patchReqAuthorized = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { notificationId: unreadItem._id },
    });
    const authRes = await patchNotificationsRoute(patchReqAuthorized);
    assert.equal(authRes.status, 200);
    assert.equal(unreadItem.isRead, true, "Item must be marked as read");

    // Mark all as read
    const unreadItem2 = recordMockNotif({
      centerId: centerA,
      recipientId: teacherAToken ? teacherAId : "",
      recipientRole: "teacher",
      type: "system",
      title: "Another Alert",
      message: "Unread",
      isRead: false,
    });

    const markAllReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { markAllRead: true },
    });
    const markAllRes = await patchNotificationsRoute(markAllReq);
    assert.equal(markAllRes.status, 200);
    assert.equal(unreadItem2.isRead, true, "Mark all must mark Teacher A's items as read");
  });

  await t.test("11. Web Push graceful fallback when unavailable", async () => {
    // When pushing to a parent with no push subscriptions, returns safely
    const notif = await createNotification({
      centerId: centerA,
      recipientId: new mongoose.Types.ObjectId().toString(),
      recipientRole: "parent",
      type: "system",
      title: "Simulated Push",
      message: "Safe push fallback check",
      studentId: studentAId,
    });

    assert.ok(notif, "Notification should be created successfully");
    assert.equal(notif.pushStatus, "none", "Push status should be none when no subscription active");
  });
});
