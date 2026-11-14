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

const { CANONICAL_CATEGORY_TYPES } = await import(
  "../tution-desk-be/src/lib/notificationService.ts"
);

const {
  GET: getNotificationsRoute,
  PATCH: patchNotificationsRoute,
} = await import("../tution-desk-be/src/app/api/notifications/route.ts");

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

test("MSEC Phase 8.2 — Functional Notification Filters Specification Suite", async (t) => {
  const centerA = "center-msec-filter-101";
  const centerB = "center-msec-filter-202";

  const ownerId = new mongoose.Types.ObjectId().toString();
  const teacherAId = new mongoose.Types.ObjectId().toString();
  const teacherBId = new mongoose.Types.ObjectId().toString();
  const parentId = new mongoose.Types.ObjectId().toString();

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerA,
    role: "owner",
    name: "Director Sharma",
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

  const parentToken = await signToken({
    userId: parentId,
    centerId: centerA,
    role: "parent",
    name: "Parent Sunita",
  });

  // In-memory data store for StaffNotification
  let mockDb = [];

  function matchesFilter(item, filter) {
    if (!filter) return true;
    if (filter.centerId && item.centerId !== filter.centerId) return false;
    if (filter.recipientRole && item.recipientRole !== filter.recipientRole) return false;
    if (filter.isDismissed && filter.isDismissed.$ne && item.isDismissed === true) return false;
    if (typeof filter.isRead === "boolean" && item.isRead !== filter.isRead) return false;
    if (filter.category && item.category !== filter.category) return false;
    if (filter.recipientId && filter.recipientId.$in && !filter.recipientId.$in.includes(item.recipientId)) return false;
    if (filter._id && item._id !== filter._id) return false;

    if (filter.$or) {
      const orPass = filter.$or.some((sub) => {
        if (sub.recipientId) {
          if (sub.recipientId.$in) return sub.recipientId.$in.includes(item.recipientId);
          return sub.recipientId === item.recipientId;
        }
        if (sub.category) return sub.category === item.category;
        if (sub.type && sub.type.$in) return sub.type.$in.includes(item.type);
        return false;
      });
      if (!orPass) return false;
    }

    if (filter.$and) {
      const andPass = filter.$and.every((sub) => matchesFilter(item, sub));
      if (!andPass) return false;
    }

    return true;
  }

  StaffNotification.find = (filter) => {
    let result = mockDb.filter((item) => matchesFilter(item, filter));

    return {
      sort: () => ({
        skip: (skipCount = 0) => ({
          limit: (limitCount = 50) =>
            Promise.resolve(result.slice(skipCount, skipCount + limitCount)),
        }),
      }),
    };
  };

  StaffNotification.countDocuments = (filter) => {
    let count = mockDb.filter((item) => matchesFilter(item, filter)).length;
    return Promise.resolve(count);
  };

  StaffNotification.findOne = (filter) => {
    const item = mockDb.find((d) => matchesFilter(d, filter));
    return Promise.resolve(item || null);
  };

  StaffNotification.findOneAndUpdate = (filter, update, options) => {
    let item = mockDb.find((d) => matchesFilter(d, filter));

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
      if (matchesFilter(item, filter)) {
        if (update.$set) {
          Object.assign(item, update.$set, { updatedAt: new Date() });
        }
        matchedCount++;
      }
    });
    return Promise.resolve({ matchedCount, modifiedCount: matchedCount });
  };

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

  // Populate realistic test data for Teacher A
  function seedTeacherAData() {
    mockDb = [];

    // 1. Fee: Unread
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "fee",
      type: "cash_collection",
      title: "Fee Collection Recorded",
      message: "₹1,500 collected from Shobha",
      isRead: false,
    });

    // 2. Fee: Read
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "fee",
      type: "fee_reminder",
      title: "Fee Reminder Sent",
      message: "Reminder sent to Rohit",
      isRead: true,
    });

    // 3. Handover: Unread
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_verified",
      title: "Handover Envelope Verified",
      message: "Envelope #12 cleared",
      isRead: false,
    });

    // 4. Handover: Read
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_submitted",
      title: "Handover Envelope Submitted",
      message: "Submitted ₹2,000 to Owner",
      isRead: true,
    });

    // 5. Batch: Unread
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "batch",
      type: "batch_request_approved",
      title: "Batch Request Approved",
      message: "Student Rahul transferred to Batch 10A",
      isRead: false,
    });

    // 6. Academic: Read (legacy record with type only, no category)
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      type: "test_scheduled",
      title: "Maths Test Scheduled",
      message: "Test scheduled for Friday",
      isRead: true,
    });

    // 7. Academic: Unread
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "academic",
      type: "attendance_marked",
      title: "Attendance Recorded",
      message: "Batch 10A attendance marked",
      isRead: false,
    });

    // 8. Communication: Unread
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "communication",
      type: "parent_message",
      title: "Message from Parent",
      message: "Parent asked about exam schedule",
      isRead: false,
    });

    // 9. System: Read
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      category: "system",
      type: "announcement",
      title: "System Update",
      message: "Platform updated to v0.2.26",
      isRead: true,
    });
  }

  // =========================================================================
  // TEST 1: All Status Filter
  // =========================================================================
  await t.test("1. All Status Filter: returns all non-dismissed notifications across read and unread", async () => {
    seedTeacherAData();

    const req = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=all",
    });
    const res = await getNotificationsRoute(req);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.notifications.length, 9, "All 9 notifications must be returned");
    assert.equal(data.totalCount, 9);
    assert.equal(data.unreadCount, 5, "Unread count must accurately show 5 unread items");
  });

  // =========================================================================
  // TEST 2: Unread Status Filter
  // =========================================================================
  await t.test("2. Unread Status Filter: returns only isRead === false notifications", async () => {
    seedTeacherAData();

    const req = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=unread",
    });
    const res = await getNotificationsRoute(req);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.notifications.length, 5, "Must return exactly 5 unread notifications");
    assert.ok(data.notifications.every((n) => n.isRead === false));
    assert.equal(data.totalCount, 5, "totalCount must reflect 5 matching unread notifications");
    assert.equal(data.unreadCount, 5, "global unreadCount remains 5");
  });

  // =========================================================================
  // TEST 3: Read Status Filter
  // =========================================================================
  await t.test("3. Read Status Filter: returns only isRead === true notifications", async () => {
    seedTeacherAData();

    const req = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=read",
    });
    const res = await getNotificationsRoute(req);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.notifications.length, 4, "Must return exactly 4 read notifications");
    assert.ok(data.notifications.every((n) => n.isRead === true));
    assert.equal(data.totalCount, 4);
    assert.equal(data.unreadCount, 5, "unreadCount in header remains 5 total unread");
  });

  // =========================================================================
  // TEST 4: Each Category Filter
  // =========================================================================
  await t.test("4. Category Filters: maps and retrieves each canonical category", async () => {
    seedTeacherAData();

    const categoriesToTest = [
      { id: "fee", expectedCount: 2 },
      { id: "handover", expectedCount: 2 },
      { id: "batch", expectedCount: 1 },
      { id: "academic", expectedCount: 2 }, // 1 explicit category + 1 legacy type-only
      { id: "communication", expectedCount: 1 },
      { id: "system", expectedCount: 1 },
    ];

    for (const { id, expectedCount } of categoriesToTest) {
      const req = createMockRequest({
        token: teacherAToken,
        url: `http://localhost:3000/api/notifications?category=${id}`,
      });
      const res = await getNotificationsRoute(req);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(
        data.notifications.length,
        expectedCount,
        `Category '${id}' must return exactly ${expectedCount} items`
      );
      assert.equal(data.totalCount, expectedCount);
    }
  });

  // =========================================================================
  // TEST 5: Combined Status + Category Filtering
  // =========================================================================
  await t.test("5. Combined Filtering: status and category filters work in conjunction without collision", async () => {
    seedTeacherAData();

    // 1. Unread + Handover = 1 item (Handover Verified)
    const req1 = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=unread&category=handover",
    });
    const res1 = await getNotificationsRoute(req1);
    const data1 = await res1.json();

    assert.equal(data1.success, true);
    assert.equal(data1.notifications.length, 1);
    assert.equal(data1.notifications[0].title, "Handover Envelope Verified");
    assert.equal(data1.notifications[0].isRead, false);
    assert.equal(data1.totalCount, 1);

    // 2. Read + Academic = 1 item (Maths Test Scheduled legacy type)
    const req2 = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=read&category=academic",
    });
    const res2 = await getNotificationsRoute(req2);
    const data2 = await res2.json();

    assert.equal(data2.success, true);
    assert.equal(data2.notifications.length, 1);
    assert.equal(data2.notifications[0].title, "Maths Test Scheduled");
    assert.equal(data2.notifications[0].isRead, true);

    // 3. Unread + Batch = 1 item (Batch Request Approved)
    const req3 = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=unread&category=batch",
    });
    const res3 = await getNotificationsRoute(req3);
    const data3 = await res3.json();

    assert.equal(data3.success, true);
    assert.equal(data3.notifications.length, 1);
    assert.equal(data3.notifications[0].isRead, false);

    // 4. Read + Batch = 0 items
    const req4 = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=read&category=batch",
    });
    const res4 = await getNotificationsRoute(req4);
    const data4 = await res4.json();

    assert.equal(data4.success, true);
    assert.equal(data4.notifications.length, 0);
    assert.equal(data4.totalCount, 0);
  });

  // =========================================================================
  // TEST 6: Correct Notification Counts
  // =========================================================================
  await t.test("6. Count Accuracy: totalCount reflects filtered results; unreadCount reflects user total", async () => {
    seedTeacherAData();

    // Query Unread Fees
    const req = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=unread&category=fee",
    });
    const res = await getNotificationsRoute(req);
    const data = await res.json();

    assert.equal(data.totalCount, 1, "totalCount must reflect 1 unread fee notification");
    assert.equal(data.unreadCount, 5, "unreadCount must reflect all 5 unread notifications of the user");
  });

  // =========================================================================
  // TEST 7: Mark Read While Filter Active
  // =========================================================================
  await t.test("7. Mark Read Under Active Filter: updates item without losing recipient or center context", async () => {
    seedTeacherAData();

    const unreadFee = mockDb.find((n) => n.type === "cash_collection");
    assert.equal(unreadFee.isRead, false);

    const patchReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { notificationId: unreadFee._id },
    });
    const patchRes = await patchNotificationsRoute(patchReq);
    const patchData = await patchRes.json();

    assert.equal(patchRes.status, 200);
    assert.equal(patchData.success, true);

    const updatedInDb = mockDb.find((n) => n._id === unreadFee._id);
    assert.equal(updatedInDb.isRead, true);

    // Re-query unread fees
    const checkReq = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=unread&category=fee",
    });
    const checkRes = await getNotificationsRoute(checkReq);
    const checkData = await checkRes.json();

    assert.equal(checkData.notifications.length, 0, "Fee is no longer in unread fee query");
    assert.equal(checkData.unreadCount, 4, "Global unread count decremented to 4");
  });

  // =========================================================================
  // TEST 8: Mark All Read
  // =========================================================================
  await t.test("8. Mark All Read: marks all unread notifications persistently", async () => {
    seedTeacherAData();

    const patchReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { markAllRead: true },
    });
    const patchRes = await patchNotificationsRoute(patchReq);
    const patchData = await patchRes.json();

    assert.equal(patchRes.status, 200);
    assert.equal(patchData.success, true);

    const anyUnreadLeft = mockDb.some(
      (n) => n.recipientId === teacherAId && n.isRead === false
    );
    assert.equal(anyUnreadLeft, false, "All Teacher A notifications must be marked read");

    // Re-query unread tab
    const checkReq = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?status=unread",
    });
    const checkRes = await getNotificationsRoute(checkReq);
    const checkData = await checkRes.json();

    assert.equal(checkData.notifications.length, 0);
    assert.equal(checkData.unreadCount, 0);
  });

  // =========================================================================
  // TEST 9: Dismissed Notifications Excluded
  // =========================================================================
  await t.test("9. Dismissed Exclusion: Dismissed items are excluded from status and category filters", async () => {
    seedTeacherAData();

    // Dismiss all
    const dismissReq = createMockRequest({
      token: teacherAToken,
      method: "PATCH",
      body: { clearAll: true },
    });
    await patchNotificationsRoute(dismissReq);

    // Query all categories
    const checkReq = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?category=all&status=all",
    });
    const checkRes = await getNotificationsRoute(checkReq);
    const checkData = await checkRes.json();

    assert.equal(
      checkData.notifications.length,
      0,
      "Dismissed notifications must not appear in any filter"
    );
    assert.equal(checkData.totalCount, 0);
  });

  // =========================================================================
  // TEST 10: Owner, Teacher, and Parent Notification Isolation
  // =========================================================================
  await t.test("10. Multi-Role Isolation: Owner, Teacher, and Parent notifications are strictly isolated", async () => {
    mockDb = [];

    // Owner notification
    addMockNotification({
      centerId: centerA,
      recipientId: ownerId,
      recipientRole: "owner",
      title: "Owner Announcement",
      message: "Direct center announcement",
      isRead: false,
    });

    // Teacher A notification
    addMockNotification({
      centerId: centerA,
      recipientId: teacherAId,
      recipientRole: "teacher",
      title: "Teacher A Batch Alert",
      message: "Batch transfer pending",
      isRead: false,
    });

    // Teacher B notification
    addMockNotification({
      centerId: centerA,
      recipientId: teacherBId,
      recipientRole: "teacher",
      title: "Teacher B Homework",
      message: "Homework due",
      isRead: false,
    });

    // Parent notification
    addMockNotification({
      centerId: centerA,
      recipientId: parentId,
      recipientRole: "parent",
      title: "Parent Receipt",
      message: "Receipt for fees",
      isRead: false,
    });

    // Teacher A query
    const teacherReq = createMockRequest({ token: teacherAToken });
    const teacherRes = await getNotificationsRoute(teacherReq);
    const teacherData = await teacherRes.json();

    assert.equal(teacherData.notifications.length, 1);
    assert.equal(teacherData.notifications[0].title, "Teacher A Batch Alert");

    // Parent query
    const parentReq = createMockRequest({ token: parentToken });
    const parentRes = await getNotificationsRoute(parentReq);
    const parentData = await parentRes.json();

    assert.equal(parentData.notifications.length, 1);
    assert.equal(parentData.notifications[0].title, "Parent Receipt");

    // Owner query
    const ownerReq = createMockRequest({ token: ownerToken });
    const ownerRes = await getNotificationsRoute(ownerReq);
    const ownerData = await ownerRes.json();

    assert.equal(ownerData.notifications.length, 1);
    assert.equal(ownerData.notifications[0].title, "Owner Announcement");
  });

  // =========================================================================
  // TEST 11: Pagination and Count Correctness
  // =========================================================================
  await t.test("11. Pagination & Limits: totalCount is accurate across the entire set while limit subsets output", async () => {
    mockDb = [];

    // Add 6 unread fee notifications
    for (let i = 1; i <= 6; i++) {
      addMockNotification({
        centerId: centerA,
        recipientId: teacherAId,
        recipientRole: "teacher",
        category: "fee",
        type: "cash_collection",
        title: `Collection #${i}`,
        message: `Amount ₹${i * 500}`,
        isRead: false,
      });
    }

    const req = createMockRequest({
      token: teacherAToken,
      url: "http://localhost:3000/api/notifications?category=fee&status=unread&limit=2",
    });
    const res = await getNotificationsRoute(req);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.notifications.length, 2, "Returned items must be limited to 2");
    assert.equal(data.totalCount, 6, "totalCount must reflect all 6 matching items in DB");
    assert.equal(data.unreadCount, 6);
  });
});
