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

process.env.JWT_SECRET = "test-jwt-secret-smart-campaign-engine-32chars!";
process.env.MONGODB_URI = "mongodb://localhost:27017/test_campaign";
process.env.WHATSAPP_MODE = "simulation";
process.env.ENABLE_LIVE_WHATSAPP = "false";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-12345";

// Mock connectDB global cache
global.mongooseCache = {
  conn: mongoose,
  promise: Promise.resolve(mongoose),
};

test("Smart Messaging Engine & Emergency Kill Switch Specification Suite", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { MessageCampaign } = await import("../tution-desk-be/src/models/MessageCampaign.ts");
  const { dispatchCampaign } = await import("../tution-desk-be/src/lib/campaignDispatcher.ts");
  const { GET: getCampaigns, POST: createCampaign } = await import("../tution-desk-be/src/app/api/campaigns/route.ts");
  const { GET: getCampaignById, PATCH: patchCampaignById } = await import("../tution-desk-be/src/app/api/campaigns/[id]/route.ts");

  const centerIdA = "msec";
  const centerIdB = "other-center";

  const ownerTokenA = await signToken({
    userId: "owner-user-001",
    centerId: centerIdA,
    role: "owner",
  });

  const teacherTokenA = await signToken({
    userId: "teacher-user-002",
    centerId: centerIdA,
    role: "teacher",
    teacherId: "teacher-profile-002",
  });

  const ownerTokenB = await signToken({
    userId: "owner-user-003",
    centerId: centerIdB,
    role: "owner",
  });

  // In-memory mock store for MessageCampaign
  const mockCampaignStore = new Map();

  // Install test mocks on MessageCampaign model methods
  MessageCampaign.create = async (doc) => {
    const id = new Types.ObjectId();
    const fullDoc = {
      _id: id,
      ...doc,
      messages: (doc.messages || []).map((m) => ({
        _id: new Types.ObjectId(),
        ...m,
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
      save: async function () {
        mockCampaignStore.set(String(this._id), this);
        return this;
      },
    };
    mockCampaignStore.set(String(id), fullDoc);
    return fullDoc;
  };

  MessageCampaign.find = (filter) => {
    return {
      sort: () => ({
        skip: (s) => ({
          limit: (l) => ({
            lean: async () => {
              const matches = [];
              for (const doc of mockCampaignStore.values()) {
                if (filter.centerId && doc.centerId !== filter.centerId) continue;
                if (filter.status && doc.status !== filter.status) continue;
                if (filter.campaignType && doc.campaignType !== filter.campaignType) continue;
                matches.push(doc);
              }
              return matches.slice(s, s + l);
            },
          }),
        }),
      }),
    };
  };

  MessageCampaign.countDocuments = async (filter) => {
    let count = 0;
    for (const doc of mockCampaignStore.values()) {
      if (filter.centerId && doc.centerId !== filter.centerId) continue;
      if (filter.status && doc.status !== filter.status) continue;
      count++;
    }
    return count;
  };

  MessageCampaign.findOne = (filter) => {
    for (const doc of mockCampaignStore.values()) {
      let match = true;
      if (filter._id && String(doc._id) !== String(filter._id)) match = false;
      if (filter.centerId && doc.centerId !== filter.centerId) match = false;
      if (match) {
        return {
          ...doc,
          save: async function () {
            mockCampaignStore.set(String(this._id), this);
            return this;
          },
          lean: async () => doc,
        };
      }
    }
    return {
      lean: async () => null,
      save: async () => null,
    };
  };

  MessageCampaign.findById = async (id, fields) => {
    const doc = mockCampaignStore.get(String(id));
    if (!doc) return null;
    return {
      ...doc,
      save: async function () {
        mockCampaignStore.set(String(this._id), this);
        return this;
      },
    };
  };

  MessageCampaign.updateOne = async (filter, update) => {
    let target = null;
    if (filter._id) {
      target = mockCampaignStore.get(String(filter._id));
    }
    if (!target) return { matchedCount: 0, modifiedCount: 0 };

    if (update.$set) {
      for (const [key, val] of Object.entries(update.$set)) {
        if (key.startsWith("messages.$.") && filter["messages._id"]) {
          const field = key.replace("messages.$.", "");
          const msg = target.messages.find(
            (m) => String(m._id) === String(filter["messages._id"])
          );
          if (msg) msg[field] = val;
        } else {
          target[key] = val;
        }
      }
    }
    if (update.$inc) {
      for (const [key, val] of Object.entries(update.$inc)) {
        const parts = key.split(".");
        if (parts.length === 2 && target[parts[0]]) {
          target[parts[0]][parts[1]] = (target[parts[0]][parts[1]] || 0) + val;
        }
      }
    }
    mockCampaignStore.set(String(target._id), target);
    return { matchedCount: 1, modifiedCount: 1 };
  };

  let createdCampaignId = null;

  // --------------------------------------------------------------------------
  // 1. Campaign Creation (Pending Status Default)
  // --------------------------------------------------------------------------
  await t.test("1.1 POST /api/campaigns creates campaign in 'pending' status awaiting Owner approval", async () => {
    const req = {
      headers: new Headers({
        Authorization: `Bearer ${teacherTokenA}`,
        "Content-Type": "application/json",
      }),
      cookies: { get: () => null },
      json: async () => ({
        title: "Daily Attendance Alert - Class 10th",
        campaignType: "attendance_alert",
        messages: [
          { phone: "9876543210", message: "Student Rahul is absent today.", studentName: "Rahul" },
          { phone: "9876543211", message: "Student Priya is absent today.", studentName: "Priya" },
          { phone: "9876543212", message: "Student Amit is absent today.", studentName: "Amit" },
        ],
      }),
      nextUrl: new URL("http://localhost:3000/api/campaigns"),
    };

    const res = await createCampaign(req);
    const json = await res.json();

    assert.strictEqual(res.status, 201);
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.campaign.status, "pending");
    assert.strictEqual(json.campaign.stats.total, 3);
    assert.strictEqual(json.campaign.stats.pending, 3);
    assert.strictEqual(json.campaign.stats.sent, 0);

    createdCampaignId = String(json.campaign._id);
  });

  await t.test("1.2 GET /api/campaigns returns campaigns strictly for authenticated center", async () => {
    const reqA = {
      headers: new Headers({ Authorization: `Bearer ${ownerTokenA}` }),
      cookies: { get: () => null },
      nextUrl: new URL("http://localhost:3000/api/campaigns"),
    };

    const resA = await getCampaigns(reqA);
    const jsonA = await resA.json();

    assert.strictEqual(resA.status, 200);
    assert.strictEqual(jsonA.success, true);
    assert.strictEqual(jsonA.campaigns.length, 1);
    assert.strictEqual(String(jsonA.campaigns[0]._id), createdCampaignId);

    // Cross-center isolation check
    const reqB = {
      headers: new Headers({ Authorization: `Bearer ${ownerTokenB}` }),
      cookies: { get: () => null },
      nextUrl: new URL("http://localhost:3000/api/campaigns"),
    };

    const resB = await getCampaigns(reqB);
    const jsonB = await resB.json();

    assert.strictEqual(resB.status, 200);
    assert.strictEqual(jsonB.campaigns.length, 0, "Center B must NOT see Center A's campaigns");
  });

  // --------------------------------------------------------------------------
  // 2. Strict Owner-only Authorization for Approval & Status Updates
  // --------------------------------------------------------------------------
  await t.test("2.1 Teacher cannot approve or modify campaign status (HTTP 403 Forbidden)", async () => {
    const req = {
      headers: new Headers({
        Authorization: `Bearer ${teacherTokenA}`,
        "Content-Type": "application/json",
      }),
      cookies: { get: () => null },
      json: async () => ({ status: "approved" }),
      nextUrl: new URL(`http://localhost:3000/api/campaigns/${createdCampaignId}`),
    };

    const res = await patchCampaignById(req, {
      params: Promise.resolve({ id: createdCampaignId }),
    });
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Only Institute Owner can approve/i);
  });

  await t.test("2.2 Owner approves campaign, updating status to 'approved' and setting approvedBy", async () => {
    const req = {
      headers: new Headers({
        Authorization: `Bearer ${ownerTokenA}`,
        "Content-Type": "application/json",
      }),
      cookies: { get: () => null },
      json: async () => ({ status: "approved", autoDispatch: false }),
      nextUrl: new URL(`http://localhost:3000/api/campaigns/${createdCampaignId}`),
    };

    const res = await patchCampaignById(req, {
      params: Promise.resolve({ id: createdCampaignId }),
    });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.campaign.status, "approved");
    assert.strictEqual(json.campaign.approvedBy, "owner-user-001");
  });

  // --------------------------------------------------------------------------
  // 3. Dispatch Service Execution & Duplicate Prevention
  // --------------------------------------------------------------------------
  await t.test("3.1 Dispatching approved campaign iterates messages and marks them simulated/sent", async () => {
    const summary = await dispatchCampaign(createdCampaignId, centerIdA);

    assert.strictEqual(summary.campaignId, createdCampaignId);
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.processed, 3);
    assert.strictEqual(summary.simulated, 3, "In simulation mode, messages are recorded as simulated");
    assert.strictEqual(summary.haltedByKillSwitch, false);
  });

  await t.test("3.2 Re-dispatching completed campaign does NOT duplicate messages", async () => {
    const summary = await dispatchCampaign(createdCampaignId, centerIdA);

    assert.strictEqual(summary.processed, 0, "Already processed messages must be skipped");
    assert.ok(summary.error?.includes("Cannot dispatch campaign in status 'completed'"));
  });

  // --------------------------------------------------------------------------
  // 4. Emergency Kill Switch Verification (Pause Mid-Dispatch)
  // --------------------------------------------------------------------------
  await t.test("4.1 Emergency Kill Switch: Pausing campaign halts dispatch iteration immediately", async () => {
    // Create new campaign with 5 messages
    const newDoc = await MessageCampaign.create({
      centerId: centerIdA,
      title: "Fee Reminder Urgent Run",
      campaignType: "fee_reminder",
      status: "approved",
      messages: [
        { phone: "9100000001", message: "Fee Due Rem 1", status: "pending" },
        { phone: "9100000002", message: "Fee Due Rem 2", status: "pending" },
        { phone: "9100000003", message: "Fee Due Rem 3", status: "pending" },
        { phone: "9100000004", message: "Fee Due Rem 4", status: "pending" },
        { phone: "9100000005", message: "Fee Due Rem 5", status: "pending" },
      ],
      createdBy: "owner-user-001",
      createdRole: "owner",
      stats: { total: 5, sent: 0, simulated: 0, failed: 0, pending: 5 },
    });

    // Simulate Kill Switch trigger after first message
    let checkCount = 0;
    const originalFindById = MessageCampaign.findById;
    MessageCampaign.findById = async (id, fields) => {
      checkCount++;
      const target = mockCampaignStore.get(String(id));
      if (checkCount >= 2) {
        // Owner clicks "PAUSE" in dashboard while dispatch is running!
        target.status = "paused";
      }
      return target;
    };

    try {
      const summary = await dispatchCampaign(newDoc._id, centerIdA);

      assert.strictEqual(summary.haltedByKillSwitch, true, "Kill switch must immediately halt processing");
      assert.strictEqual(summary.processed < 5, true, "Processing must not finish all 5 messages");
    } finally {
      MessageCampaign.findById = originalFindById;
    }
  });
});
