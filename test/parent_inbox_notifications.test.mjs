import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// Setup mock test environment
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-parent-inbox-notifications-32-chars";
process.env.APP_URL = "http://localhost:3000";
process.env.ALLOWED_ORIGINS = "http://localhost:3000,https://tution-desk-one.vercel.app";

// In-memory mongoose cache
global.mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };
process.env.MONGODB_URI = "mongodb://localhost:27017/test_tuitiondesk";

const { default: MessageCampaign } = await import(
  "../tution-desk-be/src/models/MessageCampaign.ts"
);
const { default: ParentAccess } = await import(
  "../tution-desk-be/src/models/ParentAccess.ts"
);
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { GET: parentNotificationsRoute } = await import(
  "../tution-desk-be/src/app/api/parent/notifications/route.ts"
);

function createMockRequest({
  method = "GET",
  url = "http://localhost:3001/api/parent/notifications",
  headers = {},
  cookies = {},
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }

  return {
    method,
    nextUrl: new URL(url),
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) || null,
    },
    cookies: {
      get: (name) => (cookies[name] ? { value: cookies[name] } : undefined),
    },
  };
}

test("Parent Portal Notification Inbox Specification Suite", async (t) => {
  const testCenterId = "msec-center-101";
  const otherCenterId = "other-center-999";
  const parentAccessId = new mongoose.Types.ObjectId().toString();
  const studentA = new mongoose.Types.ObjectId();
  const studentB = new mongoose.Types.ObjectId();

  let validParentSessionToken = "";

  t.before(async () => {
    validParentSessionToken = await signToken({
      userId: parentAccessId,
      parentAccessId: parentAccessId,
      centerId: testCenterId,
      role: "parent",
      tokenPrefix: "pt_inbox1",
    });
  });

  await t.test("1.1 GET /api/parent/notifications rejects unapproved Origin with 403 Forbidden", async () => {
    const req = createMockRequest({
      headers: {
        origin: "https://evil-hacker.com",
      },
    });

    const res = await parentNotificationsRoute(req);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes("Origin is not authorized"));
  });

  await t.test("1.2 GET /api/parent/notifications rejects unauthenticated request with 401", async () => {
    const req = createMockRequest({
      headers: {
        origin: "http://localhost:3000",
      },
    });

    const res = await parentNotificationsRoute(req);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  await t.test(
    "1.3 GET /api/parent/notifications queries campaigns matching parent phone or linked students",
    async () => {
      // Mock ParentAccess findOne
      const originalParentFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenPrefix: "pt_inbox1",
        status: "active",
        linkedStudentIds: [studentA, studentB],
      });

      // Mock MessageCampaign aggregate
      const originalAggregate = MessageCampaign.aggregate;
      let capturedPipeline = null;

      MessageCampaign.aggregate = async (pipeline) => {
        capturedPipeline = pipeline;
        return [
          {
            id: "msg_1",
            campaignId: "camp_1",
            title: "Morning Attendance",
            campaignType: "attendance_alert",
            body: "Rahul was marked Present for Physics.",
            status: "sent",
            studentId: studentA.toString(),
            studentName: "Rahul Sharma",
            dispatchedAt: new Date("2026-11-05T09:00:00Z"),
          },
          {
            id: "msg_2",
            campaignId: "camp_2",
            title: "Monthly Fee Reminder",
            campaignType: "fee_reminder",
            body: "Dear Parent, November 2026 fee is due.",
            status: "simulated",
            studentId: studentA.toString(),
            studentName: "Rahul Sharma",
            dispatchedAt: new Date("2026-11-04T10:00:00Z"),
          },
        ];
      };

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
          },
        });

        const res = await parentNotificationsRoute(req);
        assert.equal(res.status, 200);
        const data = await res.json();

        assert.equal(data.success, true);
        assert.equal(data.count, 2);
        assert.equal(data.notifications[0].title, "Morning Attendance");
        assert.equal(data.notifications[1].title, "Monthly Fee Reminder");

        // Verify aggregation pipeline matches strictly authenticated centerId
        assert.ok(capturedPipeline);
        const matchStage = capturedPipeline[0].$match;
        assert.equal(matchStage.centerId, testCenterId);
        assert.ok(matchStage.status.$in.includes("completed"));
      } finally {
        ParentAccess.findOne = originalParentFindOne;
        MessageCampaign.aggregate = originalAggregate;
      }
    }
  );

  await t.test(
    "1.4 GET /api/parent/notifications handles empty notifications array cleanly",
    async () => {
      const originalParentFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenPrefix: "pt_inbox1",
        status: "active",
        linkedStudentIds: [studentA],
      });

      const originalAggregate = MessageCampaign.aggregate;
      MessageCampaign.aggregate = async () => [];

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
          },
        });

        const res = await parentNotificationsRoute(req);
        assert.equal(res.status, 200);
        const data = await res.json();

        assert.equal(data.success, true);
        assert.equal(data.count, 0);
        assert.deepEqual(data.notifications, []);
      } finally {
        ParentAccess.findOne = originalParentFindOne;
        MessageCampaign.aggregate = originalAggregate;
      }
    }
  );

  await t.test(
    "1.5 GET /api/parent/notifications verifies strict pipeline criteria separating studentId from phone",
    async () => {
      const originalParentFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenPrefix: "pt_inbox1",
        status: "active",
        linkedStudentIds: [studentA],
      });

      const originalAggregate = MessageCampaign.aggregate;
      let capturedPipeline = null;

      MessageCampaign.aggregate = async (pipeline) => {
        capturedPipeline = pipeline;
        return [];
      };

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
          },
        });

        await parentNotificationsRoute(req);

        assert.ok(capturedPipeline);
        const rootMatch = capturedPipeline[0].$match;
        const unwindMatch = capturedPipeline[2].$match;

        // Verify root criteria
        assert.ok(rootMatch.$or);
        assert.equal(rootMatch.$or.length, 2);

        // Clause 0: studentMatchClause must check messages.studentId in linked targets
        const studentClause = rootMatch.$or[0];
        assert.ok(studentClause["messages.studentId"]);
        assert.ok(studentClause["messages.studentId"].$in);

        // Clause 1: broadcastMatchClause must require phone AND missing/null studentId
        const broadcastClause = rootMatch.$or[1];
        assert.ok(broadcastClause.$and);
        assert.ok(broadcastClause.$and[0]["messages.phone"]);
        assert.ok(broadcastClause.$and[1].$or); // { $exists: false }, { null }

        // Verify post-unwind criteria matches root privacy rules
        assert.deepEqual(unwindMatch.$or, rootMatch.$or);
      } finally {
        ParentAccess.findOne = originalParentFindOne;
        MessageCampaign.aggregate = originalAggregate;
      }
    }
  );

  await t.test(
    "1.6 Privacy Filter: prevents shared-phone and unlinked-sibling exposure while allowing linked siblings and center announcements",
    async () => {
      const studentLinkedSibling = new mongoose.Types.ObjectId();
      const studentUnlinkedSibling = new mongoose.Types.ObjectId();
      const studentSharedPhoneStranger = new mongoose.Types.ObjectId();

      const originalParentFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenPrefix: "pt_inbox1",
        status: "active",
        linkedStudentIds: [studentA, studentLinkedSibling], // studentA and studentLinkedSibling are linked
      });

      const originalAggregate = MessageCampaign.aggregate;

      // Realistic pipeline simulator evaluating the exact MongoDB match logic against test messages
      MessageCampaign.aggregate = async (pipeline) => {
        const rootMatch = pipeline[0].$match;
        const unwindMatch = pipeline[2].$match;

        const candidateMessages = [
          // 1. Linked student notification (MUST MATCH)
          {
            phone: "+919876543210",
            studentId: studentA,
            message: "Rahul attendance update: Present",
            status: "sent",
          },
          // 2. Linked sibling notification (MUST MATCH)
          {
            phone: "+919876543210",
            studentId: studentLinkedSibling,
            message: "Sneha fee reminder: ₹2500 due",
            status: "sent",
          },
          // 3. Unlinked sibling notification with identical parent phone (MUST NOT MATCH)
          {
            phone: "+919876543210",
            studentId: studentUnlinkedSibling,
            message: "Unlinked sibling confidential fee slip",
            status: "sent",
          },
          // 4. Shared / recycled phone notification for stranger student (MUST NOT MATCH)
          {
            phone: "+919876543210",
            studentId: studentSharedPhoneStranger,
            message: "Stranger student exam marks",
            status: "sent",
          },
          // 5. Genuine center-wide announcement with null studentId (MUST MATCH)
          {
            phone: "+919876543210",
            studentId: null,
            message: "Institute holiday on Diwali",
            status: "sent",
          },
          // 6. Center-wide announcement with missing studentId field (MUST MATCH)
          {
            phone: "9876543210",
            message: "Annual sports day scheduled",
            status: "sent",
          },
          // 7. General announcement sent to another phone number (MUST NOT MATCH)
          {
            phone: "+919999999999",
            studentId: null,
            message: "Other parent notice",
            status: "sent",
          },
        ];

        // Evaluate the exact criteria built in route.ts
        const [studentClause, broadcastClause] = unwindMatch.$or;
        const validStudentIds = new Set(
          studentClause["messages.studentId"].$in.map(String)
        );
        const validPhones = new Set(broadcastClause.$and[0]["messages.phone"].$in);

        const filtered = candidateMessages.filter((msg) => {
          // Condition 1: Student-specific match
          if (msg.studentId && validStudentIds.has(String(msg.studentId))) {
            return true;
          }
          // Condition 2: Broadcast match (phone match AND studentId is null/undefined)
          const isBroadcast = msg.studentId === null || msg.studentId === undefined;
          if (isBroadcast && validPhones.has(msg.phone)) {
            return true;
          }
          return false;
        });

        return filtered.map((msg, idx) => ({
          id: `msg_${idx}`,
          campaignId: `camp_${idx}`,
          title: "Notice",
          campaignType: "announcement",
          body: msg.message,
          status: msg.status,
          studentId: msg.studentId ? String(msg.studentId) : null,
          dispatchedAt: new Date(),
        }));
      };

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
          },
        });

        const res = await parentNotificationsRoute(req);
        assert.equal(res.status, 200);
        const data = await res.json();

        assert.equal(data.success, true);
        assert.equal(data.count, 4); // Exactly 4 matched: linked student, linked sibling, 2 broadcasts

        const returnedBodies = data.notifications.map((n) => n.body);

        // Assert linked student and sibling ARE returned
        assert.ok(returnedBodies.includes("Rahul attendance update: Present"));
        assert.ok(returnedBodies.includes("Sneha fee reminder: ₹2500 due"));

        // Assert center-wide announcements ARE returned
        assert.ok(returnedBodies.includes("Institute holiday on Diwali"));
        assert.ok(returnedBodies.includes("Annual sports day scheduled"));

        // CRITICAL PRIVACY ASSERTIONS:
        // Assert unlinked sibling is NOT returned despite matching parent phone!
        assert.ok(!returnedBodies.includes("Unlinked sibling confidential fee slip"));
        // Assert stranger with shared phone is NOT returned despite matching parent phone!
        assert.ok(!returnedBodies.includes("Stranger student exam marks"));
        // Assert message for different phone is NOT returned
        assert.ok(!returnedBodies.includes("Other parent notice"));
      } finally {
        ParentAccess.findOne = originalParentFindOne;
        MessageCampaign.aggregate = originalAggregate;
      }
    }
  );
});
