import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");
const { Types } = mongoose;

process.env.JWT_SECRET = "test-jwt-secret-failsafe-recovery-32chars!";
process.env.MONGODB_URI = "mongodb://localhost:27017/test_failsafe";
process.env.WHATSAPP_MODE = "simulation";
process.env.ENABLE_LIVE_WHATSAPP = "false";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-12345";

// Mock connectDB cache
globalThis.mongooseCache = {
  conn: mongoose,
  promise: Promise.resolve(mongoose),
};

function createMockRequest({
  method = "GET",
  url = "http://localhost:3001/api/whatsapp/retry",
  headers = {},
  body = null,
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: {
      get: (k) => headerMap.get(k.toLowerCase()) || null,
    },
    cookies: {
      get: () => null,
    },
    json: async () => body || {},
  };
}

test("Fail-Safe Recovery & WhatsApp Retry Engine Specification Suite", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { GET: getRetry, POST: postRetry } = await import(
    "../tution-desk-be/src/app/api/whatsapp/retry/route.ts"
  );
  const { AdmissionWelcomeJob } = await import(
    "../tution-desk-be/src/models/AdmissionWelcomeJob.ts"
  );
  const { default: FeeReminderLog } = await import(
    "../tution-desk-be/src/models/FeeReminderLog.ts"
  );
  const { MessageCampaign } = await import(
    "../tution-desk-be/src/models/MessageCampaign.ts"
  );
  const { default: Center } = await import(
    "../tution-desk-be/src/models/Center.ts"
  );

  const centerA = "center_alpha";
  const centerB = "center_beta";

  const ownerTokenA = await signToken({
    userId: "owner_a",
    centerId: centerA,
    role: "owner",
  });

  const teacherTokenA = await signToken({
    userId: "teacher_a",
    centerId: centerA,
    role: "teacher",
    teacherId: "teacher_profile_01",
  });

  Center.findOne = () => ({
    select: async () => ({ name: "Alpha Coaching Academy" }),
  });
  // Global stubs for MessageCampaign to prevent buffering timeouts during testing
  MessageCampaign.updateOne = async () => ({ modifiedCount: 1 });
  MessageCampaign.findById = async () => ({
    _id: new Types.ObjectId(),
    status: "in_progress",
    messages: [],
    save: async function () {
      return this;
    },
  });

  await t.test("1.1 GET /api/whatsapp/retry rejects unauthenticated requests with 401", async () => {
    const req = createMockRequest({ method: "GET" });
    const res = await getRetry(req);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  await t.test("1.2 GET /api/whatsapp/retry strictly restricts access to Owner (Teacher rejected 403)", async () => {
    const req = createMockRequest({
      method: "GET",
      headers: { Authorization: `Bearer ${teacherTokenA}` },
    });
    const res = await getRetry(req);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Owner role required/i);
  });

  await t.test("1.3 GET returns accurate counts and detailed items scoped to authenticated Owner's centerId", async () => {
    // Stub countDocuments and find
    const origAdmissionCount = AdmissionWelcomeJob.countDocuments;
    const origAdmissionFind = AdmissionWelcomeJob.find;
    const origFeeCount = FeeReminderLog.countDocuments;
    const origFeeFind = FeeReminderLog.find;
    const origCampaignFind = MessageCampaign.find;

    AdmissionWelcomeJob.countDocuments = async (filter) => {
      assert.equal(filter.centerId, centerA);
      return 2;
    };
    AdmissionWelcomeJob.find = (filter) => {
      assert.equal(filter.centerId, centerA);
      return {
        sort: () => ({
          limit: async () => [
            {
              _id: new Types.ObjectId(),
              parentPhone: "9876543210",
              studentName: "Aditi",
              status: "failed",
              failureReason: "Session offline",
              createdAt: new Date("2026-11-05T10:00:00Z"),
            },
            {
              _id: new Types.ObjectId(),
              parentPhone: "9876543211",
              studentName: "Rohan",
              status: "pending",
              createdAt: new Date("2026-11-05T10:05:00Z"),
            },
          ],
        }),
      };
    };

    FeeReminderLog.countDocuments = async (filter) => {
      assert.equal(filter.centerId, centerA);
      return 3;
    };
    FeeReminderLog.find = (filter) => {
      assert.equal(filter.centerId, centerA);
      return {
        populate: () => ({
          sort: () => ({
            limit: async () => [
              {
                _id: new Types.ObjectId(),
                recipientPhone: "9876543212",
                studentId: { _id: new Types.ObjectId(), name: "Kavya" },
                status: "failed",
                failureReason: "Gateway timeout",
                attemptedAt: new Date("2026-11-05T11:00:00Z"),
              },
            ],
          }),
        }),
      };
    };

    MessageCampaign.find = (filter) => {
      assert.equal(filter.centerId, centerA);
      return {
        sort: () => ({
          limit: async () => [
            {
              _id: new Types.ObjectId(),
              campaignType: "custom_announcement",
              messages: [
                {
                  _id: new Types.ObjectId(),
                  phone: "9876543213",
                  studentName: "Aman",
                  status: "failed",
                  error: "Network error",
                  dispatchedAt: new Date("2026-11-05T12:00:00Z"),
                },
                {
                  _id: new Types.ObjectId(),
                  phone: "9876543214",
                  studentName: "Simran",
                  status: "pending",
                  dispatchedAt: new Date("2026-11-05T12:05:00Z"),
                },
                {
                  _id: new Types.ObjectId(),
                  phone: "9876543215",
                  studentName: "Rahul",
                  status: "sent",
                  dispatchedAt: new Date("2026-11-05T12:10:00Z"),
                },
              ],
            },
          ],
        }),
      };
    };

    try {
      const req = createMockRequest({
        method: "GET",
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const res = await getRetry(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.breakdown.admissionWelcome, 2);
      assert.equal(data.breakdown.feeReminders, 3);
      assert.equal(data.breakdown.campaigns, 2);
      assert.equal(data.count, 7);
      assert.ok(Array.isArray(data.items));
      assert.equal(data.items.length, 5); // 2 admission + 1 fee + 2 campaign (failed/pending only)
      assert.equal(data.items[0].type, "campaign"); // Most recent timestamp (12:05)
      assert.ok(data.summary, "Must return aggregate summary counts");
      assert.ok(Array.isArray(data.recentActivity), "Must return recentActivity array");
      assert.ok(Array.isArray(data.pendingItems), "Must return pendingItems array");
      assert.ok(Array.isArray(data.failedItems), "Must return failedItems array");
      assert.equal(typeof data.inFlightCount, "number");
    } finally {
      AdmissionWelcomeJob.countDocuments = origAdmissionCount;
      AdmissionWelcomeJob.find = origAdmissionFind;
      FeeReminderLog.countDocuments = origFeeCount;
      FeeReminderLog.find = origFeeFind;
      MessageCampaign.find = origCampaignFind;
    }
  });

  await t.test("2.1 POST /api/whatsapp/retry rejects unauthenticated and teacher requests", async () => {
    const reqAnon = createMockRequest({ method: "POST" });
    const resAnon = await postRetry(reqAnon);
    assert.equal(resAnon.status, 401);

    const reqTeacher = createMockRequest({
      method: "POST",
      headers: { Authorization: `Bearer ${teacherTokenA}` },
    });
    const resTeacher = await postRetry(reqTeacher);
    assert.equal(resTeacher.status, 403);
  });

  await t.test("2.2 POST /api/whatsapp/retry handles zero pending jobs cleanly", async () => {
    const origAdmissionFind = AdmissionWelcomeJob.find;
    const origFeeFind = FeeReminderLog.find;
    const origCampaignFind = MessageCampaign.find;

    AdmissionWelcomeJob.find = () => ({ limit: async () => [] });
    FeeReminderLog.find = () => ({ populate: () => ({ limit: async () => [] }) });
    MessageCampaign.find = () => ({ limit: async () => [] });

    try {
      const req = createMockRequest({
        method: "POST",
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const res = await postRetry(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.requeuedCount, 0);
      assert.match(data.message, /No failed or pending messages/i);
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      AdmissionWelcomeJob.find = origAdmissionFind;
      FeeReminderLog.find = origFeeFind;
      MessageCampaign.find = origCampaignFind;
    }
  });

  await t.test("2.3 POST gathers failed jobs from all sources and pushes to fail_safe_retry campaign", async () => {
    const origAdmissionFind = AdmissionWelcomeJob.find;
    const origFeeFind = FeeReminderLog.find;
    const origCampaignFind = MessageCampaign.find;
    const origCampaignCreate = MessageCampaign.create;

    let createdCampaignDoc = null;

    AdmissionWelcomeJob.find = (filter) => {
      assert.equal(filter.centerId, centerA);
      return {
        limit: async () => [
          {
            centerId: centerA,
            parentPhone: "9876543210",
            studentName: "Rahul",
            batchName: "Class 10",
            studentId: new Types.ObjectId(),
            status: "failed",
            save: async () => {},
          },
        ],
      };
    };

    FeeReminderLog.find = (filter) => {
      assert.equal(filter.centerId, centerA);
      return {
        populate: () => ({
          limit: async () => [
            {
              centerId: centerA,
              recipientPhone: "9876543211",
              amountDue: 2500,
              dueDate: new Date("2026-11-10"),
              studentId: { _id: new Types.ObjectId(), name: "Aarav" },
              status: "failed",
              save: async () => {},
            },
          ],
        }),
      };
    };

    MessageCampaign.find = (filter) => {
      assert.equal(filter.centerId, centerA);
      return {
        limit: async () => [
          {
            centerId: centerA,
            messages: [
              {
                phone: "9876543212",
                message: "Test announcement message",
                studentId: new Types.ObjectId(),
                studentName: "Priya",
                status: "failed",
              },
            ],
            save: async () => {},
          },
        ],
      };
    };

    const origCampaignFindOne = MessageCampaign.findOne;
    const origCampaignFindById = MessageCampaign.findById;
    const origCampaignUpdateOne = MessageCampaign.updateOne;

    MessageCampaign.create = async (doc) => {
      createdCampaignDoc = {
        _id: new Types.ObjectId(),
        ...doc,
        save: async function () {
          return this;
        },
      };
      return createdCampaignDoc;
    };
    MessageCampaign.findOne = async () => createdCampaignDoc;
    MessageCampaign.findById = async () => createdCampaignDoc;
    MessageCampaign.updateOne = async () => ({ modifiedCount: 1 });

    try {
      const req = createMockRequest({
        method: "POST",
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const res = await postRetry(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.requeuedCount, 3);
      assert.ok(data.campaignId);

      assert.ok(createdCampaignDoc);
      assert.equal(createdCampaignDoc.centerId, centerA);
      assert.equal(createdCampaignDoc.campaignType, "fail_safe_retry");
      assert.ok(
        createdCampaignDoc.status === "approved" ||
        createdCampaignDoc.status === "in_progress" ||
        createdCampaignDoc.status === "completed",
        "Campaign status must transition through execution"
      );
      assert.equal(createdCampaignDoc.messages.length, 3);
      assert.equal(createdCampaignDoc.messages[0].phone, "9876543210");
      assert.equal(createdCampaignDoc.messages[1].phone, "9876543211");
      assert.equal(createdCampaignDoc.messages[2].phone, "9876543212");
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      AdmissionWelcomeJob.find = origAdmissionFind;
      FeeReminderLog.find = origFeeFind;
      MessageCampaign.find = origCampaignFind;
      MessageCampaign.create = origCampaignCreate;
      MessageCampaign.findOne = origCampaignFindOne;
      MessageCampaign.findById = origCampaignFindById;
      MessageCampaign.updateOne = origCampaignUpdateOne;
    }
  });
});
