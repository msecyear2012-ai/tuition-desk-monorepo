process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "../tution-desk-be/node_modules/mongoose/index.js";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StaffNotification = (
  await import("../tution-desk-be/src/models/StaffNotification.ts")
).default;
const UserPushSubscription = (
  await import("../tution-desk-be/src/models/UserPushSubscription.ts")
).default;
const ParentAccess = (
  await import("../tution-desk-be/src/models/ParentAccess.ts")
).default;

const {
  createNotification,
  notifyCashCollectionEvents,
  notifyHandoverSubmittedEvents,
  notifyHandoverReviewEvents,
} = await import("../tution-desk-be/src/lib/notificationService.ts");

const {
  sendPushToUser,
  sendPushToStaff,
  sanitizeLockscreenPayload,
} = await import("../tution-desk-be/src/lib/pushService.ts");

const { GET: getNotificationsRoute, PATCH: patchNotificationsRoute } = await import(
  "../tution-desk-be/src/app/api/notifications/route.ts"
);

const { POST: pushSubscribeRoute } = await import(
  "../tution-desk-be/src/app/api/push/subscribe/route.ts"
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
      get: (name) => {
        if (name === "auth_token" && token) {
          return { value: token };
        }
        return undefined;
      },
    },
    json: async () => body,
  };
}

test("MSEC Phase 8.1 — Notification Reliability, Role Isolation & Mobile Push Suite", async (t) => {
  const centerA = "center-msec-push-101";
  const centerB = "center-msec-push-202";

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

  const centerBTeacherToken = await signToken({
    userId: teacherAId,
    centerId: centerB,
    role: "teacher",
    teacherId: teacherAId,
    name: "Teacher Jitender (Center B)",
  });

  // In-memory data store for StaffNotification
  let mockDb = [];

  StaffNotification.find = (filter) => {
    let result = mockDb.filter((item) => {
      if (filter.centerId && item.centerId !== filter.centerId) return false;
      if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return false;
      if (filter.category && item.category !== filter.category) return false;
      if (filter.isDismissed && filter.isDismissed.$ne && item.isDismissed === true) return false;
      if (typeof filter.isRead === "boolean" && item.isRead !== filter.isRead) return false;
      if (filter.$or) {
        const matchesOr = filter.$or.some((clause) => {
          if (clause.recipientId && clause.recipientId.$in) {
            return clause.recipientId.$in.includes(item.recipientId);
          }
          if (clause.recipientId === item.recipientId) return true;
          if (clause.recipientId === null && item.recipientId == null) return true;
          return false;
        });
        if (!matchesOr) return false;
      }
      return true;
    });

    return {
      sort: () => ({
        skip: () => ({
          limit: () => Promise.resolve(result),
        }),
      }),
    };
  };

  StaffNotification.countDocuments = (filter) => {
    let count = mockDb.filter((item) => {
      if (filter.centerId && item.centerId !== filter.centerId) return false;
      if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return false;
      if (filter.category && item.category !== filter.category) return false;
      if (filter.isDismissed && filter.isDismissed.$ne && item.isDismissed === true) return false;
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
    return Promise.resolve(count);
  };

  StaffNotification.findOne = (filter) => {
    const item = mockDb.find((d) => {
      if (filter.centerId && d.centerId !== filter.centerId) return false;
      if (filter.idempotencyKey && d.idempotencyKey !== filter.idempotencyKey) return false;
      return true;
    });
    return Promise.resolve(item || null);
  };

  StaffNotification.findOneAndUpdate = (filter, update, options) => {
    let item = mockDb.find((d) => {
      if (filter._id && d._id !== filter._id) return false;
      if (filter.centerId && d.centerId !== filter.centerId) return false;
      if (filter.idempotencyKey && d.idempotencyKey !== filter.idempotencyKey) return false;
      return true;
    });

    if (!item && options?.upsert) {
      item = {
        _id: new mongoose.Types.ObjectId().toString(),
        centerId: filter.centerId,
        idempotencyKey: filter.idempotencyKey,
        ...(update.$setOnInsert || {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.push(item);
      return Promise.resolve(item);
    }

    if (item && update.$set) {
      Object.assign(item, update.$set, { updatedAt: new Date() });
    }
    return Promise.resolve(item);
  };

  StaffNotification.updateMany = (filter, update) => {
    let matchedCount = 0;
    mockDb.forEach((item) => {
      if (filter.centerId && item.centerId !== filter.centerId) return;
      if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return;
      if (filter.isDismissed && filter.isDismissed.$ne && item.isDismissed === true) return;
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
        Object.assign(item, update.$set, { updatedAt: new Date() });
      }
      matchedCount++;
    });
    return Promise.resolve({ matchedCount, modifiedCount: matchedCount });
  };

  // In-memory data store for UserPushSubscription
  let pushSubsDb = [];

  UserPushSubscription.find = (filter) => {
    const res = pushSubsDb.filter((sub) => {
      if (filter.centerId && sub.centerId !== filter.centerId) return false;
      if (filter.userId && sub.userId !== filter.userId) return false;
      if (filter.userRole && typeof filter.userRole === "string" && sub.userRole !== filter.userRole) return false;
      if (filter.userRole && filter.userRole.$in && !filter.userRole.$in.includes(sub.userRole)) return false;
      return true;
    });
    return Promise.resolve(res);
  };

  UserPushSubscription.findOneAndUpdate = (filter, update, options) => {
    let item = pushSubsDb.find((s) => s.endpoint === filter.endpoint);
    if (!item && options?.upsert) {
      item = {
        _id: new mongoose.Types.ObjectId().toString(),
        endpoint: filter.endpoint,
        ...(update.$set || {}),
        save: async () => item,
      };
      pushSubsDb.push(item);
      return Promise.resolve(item);
    }
    if (item && update.$set) {
      Object.assign(item, update.$set);
    }
    return Promise.resolve(item);
  };

  UserPushSubscription.deleteOne = (filter) => {
    const initialLen = pushSubsDb.length;
    pushSubsDb = pushSubsDb.filter((s) => {
      if (s.endpoint === filter.endpoint) {
        if (filter.centerId && s.centerId !== filter.centerId) return true;
        if (filter.userId && s.userId !== filter.userId) return true;
        return false;
      }
      return true;
    });
    return Promise.resolve({ deletedCount: initialLen - pushSubsDb.length });
  };

  UserPushSubscription.deleteMany = (filter) => {
    const initialLen = pushSubsDb.length;
    if (filter.endpoint && filter.endpoint.$in) {
      pushSubsDb = pushSubsDb.filter((s) => !filter.endpoint.$in.includes(s.endpoint));
    }
    return Promise.resolve({ deletedCount: initialLen - pushSubsDb.length });
  };

  // Helper to add mock notification
  function addMockNotification(item) {
    const doc = {
      _id: new mongoose.Types.ObjectId().toString(),
      isRead: false,
      isDismissed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...item,
    };
    mockDb.push(doc);
    return doc;
  }

  // Reset databases before tests
  mockDb = [];
  pushSubsDb = [];

  // =========================================================================
  // TEST 1: Header Context Structural Equality Guard
  // =========================================================================
  await t.test("1. Header Context: Prevents infinite re-render loops on identical configs", () => {
    const isHeaderConfigEqual = (prev, next) => {
      return (
        prev.title === next.title &&
        prev.subtitle === next.subtitle &&
        prev.badgeText === next.badgeText &&
        prev.showNotifications === next.showNotifications &&
        prev.showLogout === next.showLogout
      );
    };

    const configA = {
      title: "Fee Management",
      subtitle: "Overview",
      badgeText: "Admin",
      showNotifications: true,
      showLogout: true,
    };

    const configB = {
      title: "Fee Management",
      subtitle: "Overview",
      badgeText: "Admin",
      showNotifications: true,
      showLogout: true,
    };

    assert.equal(
      isHeaderConfigEqual(configA, configB),
      true,
      "Structural equality guard must return true for identical configs"
    );

    const configDifferent = {
      ...configA,
      subtitle: "Payments",
    };

    assert.equal(
      isHeaderConfigEqual(configA, configDifferent),
      false,
      "Structural equality guard must detect real changes"
    );
  });

  // =========================================================================
  // TEST 2: Clear All Persistence
  // =========================================================================
  await t.test("2. Clear All Persistence: Dismissed notifications do not reappear on refresh", async () => {
    mockDb = [];

    // Add 2 notifications for Teacher A
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "fee",
      type: "cash_collection",
      title: "Cash Collection Recorded",
      message: "₹1,500 collected from Shobha",
    });

    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_verified",
      title: "Handover Verified",
      message: "₹1,500 verified by Owner",
    });

    // Initial GET before Clear All
    const getReq1 = createMockRequest({ token: teacherAToken });
    const res1 = await getNotificationsRoute(getReq1);
    const data1 = await res1.json();

    assert.equal(data1.success, true);
    assert.equal(data1.alerts.length, 2, "Should return 2 active notifications initially");
    assert.equal(data1.unreadCount, 2);

    // Call PATCH /api/notifications with { clearAll: true }
    const patchReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { clearAll: true },
    });
    const patchRes = await patchNotificationsRoute(patchReq);
    const patchData = await patchRes.json();

    assert.equal(patchRes.status, 200);
    assert.equal(patchData.success, true);

    // Verify notifications are marked as isDismissed: true in DB
    const dismissedCount = mockDb.filter(
      (n) =>
        n.recipientId === teacherAId &&
        n.isDismissed === true &&
        n.category !== "system"
    ).length;
    assert.equal(dismissedCount, 2, "All items for recipient should be dismissed");

    // Subsequent GET (simulating page refresh)
    const getReq2 = createMockRequest({ token: teacherAToken });
    const res2 = await getNotificationsRoute(getReq2);
    const data2 = await res2.json();

    assert.equal(data2.success, true);
    assert.equal(
      data2.alerts.length,
      0,
      "Dismissed notifications must NOT reappear in subsequent GET"
    );
    assert.equal(data2.unreadCount, 0, "Unread count must be 0 after Clear All");
  });

  // =========================================================================
  // TEST 3: Clear All Isolation Between Users
  // =========================================================================
  await t.test("3. Clear All Isolation: Teacher A clear does NOT affect Teacher B", async () => {
    mockDb = [];

    // Add notification for Teacher A and Teacher B
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      title: "Teacher A Handover Ready",
      message: "Ready for review",
    });

    addMockNotification({
      centerId: centerA,
      recipientId: teacherBId,
      recipientRole: "teacher",
      title: "Teacher B Attendance Alert",
      message: "Batch 10A attendance pending",
    });

    // Teacher A executes Clear All
    const patchReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { clearAll: true },
    });
    await patchNotificationsRoute(patchReq);

    // Teacher B queries notifications
    const getTeacherBReq = createMockRequest({ token: teacherBToken });
    const resB = await getNotificationsRoute(getTeacherBReq);
    const dataB = await resB.json();

    assert.equal(dataB.success, true);
    assert.equal(
      dataB.alerts.length,
      1,
      "Teacher B notifications must remain active when Teacher A clears all"
    );
    assert.equal(dataB.alerts[0].title, "Teacher B Attendance Alert");
  });

  // =========================================================================
  // TEST 4: Newly Generated Notification Appears Normally After Clear All
  // =========================================================================
  await t.test("4. New Notification Delivery: New alerts arrive normally after Clear All", async () => {
    mockDb = [];

    // Clear all existing
    const patchReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { clearAll: true },
    });
    await patchNotificationsRoute(patchReq);

    // Generate brand new notification for Teacher A
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "academic",
      type: "student_admitted",
      title: "New Student Assigned",
      message: "Student Rahul assigned to Physics Batch",
    });

    // Teacher A checks notifications
    const getReq = createMockRequest({ token: teacherAToken });
    const res = await getNotificationsRoute(getReq);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.alerts.length, 1, "New notification must appear after Clear All");
    assert.equal(data.alerts[0].title, "New Student Assigned");
    assert.equal(data.unreadCount, 1);
  });

  // =========================================================================
  // TEST 5: WhatsApp QR & Connection Alerts are Owner-Only
  // =========================================================================
  await t.test("5. Role Authorization: WhatsApp engine alerts are strictly Owner-Only", async () => {
    mockDb = [];

    // Teacher requests notifications
    const teacherReq = createMockRequest({ token: teacherAToken });
    const teacherRes = await getNotificationsRoute(teacherReq);
    const teacherData = await teacherRes.json();

    assert.equal(teacherData.success, true);
    assert.equal(
      teacherData.isWhatsappConnected,
      null,
      "isWhatsappConnected must be null for non-owner requests"
    );

    const hasWhatsappAlert = teacherData.alerts.some(
      (a) => a.id.includes("whatsapp") || a.title.includes("WhatsApp")
    );
    assert.equal(
      hasWhatsappAlert,
      false,
      "Teachers must NEVER receive WhatsApp engine connection or QR alerts"
    );
  });

  // =========================================================================
  // TEST 6: Teacher Scoping: Cannot Access Other Teachers' Notifications
  // =========================================================================
  await t.test("6. Teacher Scoping: Teacher cannot view other teachers' private notifications", async () => {
    mockDb = [];

    addMockNotification({
      centerId: centerA,
      recipientId: teacherBId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_submitted",
      title: "Teacher B Handover Submitted",
      message: "Envelope #99 submitted",
    });

    // Teacher A queries
    const teacherAReq = createMockRequest({ token: teacherAToken });
    const teacherARes = await getNotificationsRoute(teacherAReq);
    const teacherAData = await teacherARes.json();

    assert.equal(teacherAData.success, true);
    assert.equal(
      teacherAData.alerts.length,
      0,
      "Teacher A must not receive Teacher B's handover notification"
    );
  });

  // =========================================================================
  // TEST 7: Cross-Center Isolation
  // =========================================================================
  await t.test("7. Center Isolation: Notifications are never leaked across centers", async () => {
    mockDb = [];

    addMockNotification({
      centerId: centerB,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "fee",
      type: "cash_collection",
      title: "Center B Payment",
      message: "Payment at Center B",
    });

    // Teacher A at Center A queries
    const centerAReq = createMockRequest({ token: teacherAToken });
    const centerARes = await getNotificationsRoute(centerAReq);
    const centerAData = await centerARes.json();

    assert.equal(centerAData.success, true);
    assert.equal(
      centerAData.alerts.length,
      0,
      "Center A query must not receive Center B notifications"
    );
  });

  // =========================================================================
  // TEST 8: Web Push Device Subscriptions (Multiple Devices & Opt-In)
  // =========================================================================
  await t.test("8. Web Push Registration: Supports multiple devices and server-side ownership", async () => {
    pushSubsDb = [];

    // Device 1: Desktop Chrome
    const subDesktop = {
      endpoint: "https://fcm.googleapis.com/fcm/send/device-desktop-teacher-a",
      keys: {
        p256dh: "mock-p256dh-key-desktop-12345",
        auth: "mock-auth-secret-desktop-67890",
      },
    };

    const subscribeReq1 = createMockRequest({
      token: teacherAToken,
      method: "POST",
      body: {
        action: "subscribe",
        subscription: subDesktop,
      },
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      },
    });

    const res1 = await pushSubscribeRoute(subscribeReq1);
    const data1 = await res1.json();

    assert.equal(res1.status, 200);
    assert.equal(data1.success, true);
    assert.equal(data1.role, "teacher");

    // Device 2: Mobile Android PWA
    const subMobile = {
      endpoint: "https://fcm.googleapis.com/fcm/send/device-mobile-teacher-a",
      keys: {
        p256dh: "mock-p256dh-key-mobile-12345",
        auth: "mock-auth-secret-mobile-67890",
      },
    };

    const subscribeReq2 = createMockRequest({
      token: teacherAToken,
      method: "POST",
      body: {
        action: "subscribe",
        subscription: subMobile,
      },
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36",
      },
    });

    const res2 = await pushSubscribeRoute(subscribeReq2);
    const data2 = await res2.json();

    assert.equal(res2.status, 200);
    assert.equal(data2.success, true);

    // Verify both devices registered in DB for Teacher A
    const activeSubs = pushSubsDb.filter(
      (s) => s.userId === teacherAId && s.centerId === centerA
    );
    assert.equal(activeSubs.length, 2, "Teacher A must have 2 active push subscriptions");

    // Unsubscribe Device 1
    const unsubReq = createMockRequest({
      token: teacherAToken,
      method: "POST",
      body: {
        action: "unsubscribe",
        subscription: subDesktop,
      },
    });

    const unsubRes = await pushSubscribeRoute(unsubReq);
    const unsubData = await unsubRes.json();

    assert.equal(unsubRes.status, 200);
    assert.equal(unsubData.success, true);

    const remainingSubs = pushSubsDb.filter(
      (s) => s.userId === teacherAId && s.centerId === centerA
    );
    assert.equal(remainingSubs.length, 1, "Only Device 2 should remain after unsubscribing Device 1");
    assert.equal(remainingSubs[0].endpoint, subMobile.endpoint);
  });

  // =========================================================================
  // TEST 9: Lockscreen Privacy Sanitization
  // =========================================================================
  await t.test("9. Lockscreen Privacy: Redacts private financial figures and phone numbers", () => {
    const rawPayload = {
      title: "Payment Collected",
      body: "Shobha paid ₹1,500 cash to Jitender Kumar. Contact: 9876543210. Fee balance: Rs. 0.",
      url: "/fees?tab=payments&sub=paid",
    };

    const sanitized = sanitizeLockscreenPayload(rawPayload, true);

    assert.ok(
      !sanitized.body.includes("9876543210"),
      "Phone number must be redacted from lockscreen payload"
    );
    assert.ok(
      !sanitized.body.includes("₹1,500"),
      "Explicit rupee amounts must be redacted from lockscreen payload"
    );
    assert.ok(
      sanitized.body.includes("[Redacted]"),
      "Redacted placeholder must be present"
    );
  });

  // =========================================================================
  // TEST 10: Push Dispatch Simulation Mode when VAPID unconfigured
  // =========================================================================
  await t.test("10. Push Service Resilience: Runs safely in simulation mode when VAPID is unconfigured", async () => {
    pushSubsDb = [
      {
        centerId: centerA,
        userId: teacherAId,
        userRole: "teacher",
        endpoint: "https://fcm.googleapis.com/fcm/send/device-sim-1",
        keys: { p256dh: "dummy-key", auth: "dummy-auth" },
      },
    ];

    const result = await sendPushToUser(
      centerA,
      teacherAId,
      {
        title: "Test Alert",
        body: "Test Body Message",
      },
      "teacher"
    );

    assert.equal(result.attempted, 1);
    assert.equal(result.sent, 1);
    assert.equal(result.simulated, true, "Must flag simulation when VAPID keys not present");
    assert.equal(result.failed, 0);
  });

  // =========================================================================
  // TEST 11: Auto-Pruning Dead Endpoints
  // =========================================================================
  await t.test("11. Auto-Pruning: Pruning logic cleans up expired endpoints", async () => {
    pushSubsDb = [
      {
        centerId: centerA,
        userId: teacherAId,
        userRole: "teacher",
        endpoint: "https://fcm.googleapis.com/fcm/send/dead-endpoint-410",
        keys: { p256dh: "key-1", auth: "auth-1" },
      },
      {
        centerId: centerA,
        userId: teacherAId,
        userRole: "teacher",
        endpoint: "https://fcm.googleapis.com/fcm/send/live-endpoint",
        keys: { p256dh: "key-2", auth: "auth-2" },
      },
    ];

    // Simulate deleteMany on expired endpoint
    await UserPushSubscription.deleteMany({
      endpoint: { $in: ["https://fcm.googleapis.com/fcm/send/dead-endpoint-410"] },
    });

    assert.equal(pushSubsDb.length, 1);
    assert.equal(pushSubsDb[0].endpoint, "https://fcm.googleapis.com/fcm/send/live-endpoint");
  });

  // =========================================================================
  // TEST 12: Notification Single Item Dismissal
  // =========================================================================
  await t.test("12. Single Notification Dismissal: Marking single notification as dismissed", async () => {
    mockDb = [];

    const notif = addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      title: "Individual Item",
      message: "To be dismissed individually",
    });

    const patchReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: {
        notificationId: notif._id,
        dismiss: true,
      },
    });

    const patchRes = await patchNotificationsRoute(patchReq);
    const patchData = await patchRes.json();

    assert.equal(patchRes.status, 200);
    assert.equal(patchData.success, true);
    assert.equal(patchData.message, "Notification dismissed");

    const itemInDb = mockDb.find((d) => d._id === notif._id);
    assert.equal(itemInDb.isDismissed, true);
    assert.equal(itemInDb.isRead, true);
  });
});
