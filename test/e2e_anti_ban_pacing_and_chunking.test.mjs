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

// Setup mocked environment
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };
process.env.CRON_SECRET = "test_cron_secret_e2e_987654";
process.env.NODE_ENV = "production"; // Explicitly test production pacing behavior!

// Mock connection
const mockConn = {
  readyState: 1,
  db: {
    collection: () => ({
      indexes: async () => [],
      createIndex: async () => true,
    }),
  },
};
mongoose.connection = mockConn;

test("E2E WhatsApp Architecture: Anti-Ban Pacing, Chunking & Cron Sweep", async (t) => {
  const { dispatchCampaign, processApprovedCampaigns } = await import(
    "../tution-desk-be/src/lib/campaignDispatcher.ts"
  );
  const { processPendingAdmissionWelcomeJobs } = await import(
    "../tution-desk-be/src/lib/admissionWelcomeQueue.ts"
  );
  const MessageCampaign = (
    await import("../tution-desk-be/src/models/MessageCampaign.ts")
  ).default;
  const { AdmissionWelcomeJob } = await import(
    "../tution-desk-be/src/models/AdmissionWelcomeJob.ts"
  );
  const cronModule = await import(
    "../tution-desk-be/src/app/api/cron/process-campaigns/route.ts"
  );

  await t.test("1. Pacing in Production: 2 messages take >= 3000ms delay", async () => {
    // In production without DISABLE_DISPATCH_PACING, 2 messages must take at least 3 seconds
    const messages = [
      {
        _id: new Types.ObjectId(),
        phone: "919876543210",
        message: "Hello parent 1",
        status: "pending",
        sourceType: "admission_welcome",
      },
      {
        _id: new Types.ObjectId(),
        phone: "919876543211",
        message: "Hello parent 2",
        status: "pending",
        sourceType: "admission_welcome",
      },
    ];

    const campaignId = new Types.ObjectId();
    const fakeCampaign = {
      _id: campaignId,
      centerId: "center_pacing_test",
      campaignType: "admission_welcome",
      status: "approved",
      messages,
      stats: { total: 2, sent: 0, simulated: 0, failed: 0, pending: 2 },
      save: async function () {
        return this;
      },
    };

    const origFindOne = MessageCampaign.findOne;
    const origFindById = MessageCampaign.findById;
    const origUpdateOne = MessageCampaign.updateOne;

    MessageCampaign.findOne = () => fakeCampaign;
    MessageCampaign.findById = () => fakeCampaign;
    MessageCampaign.updateOne = async (_filter, update) => {
      if (update?.$set?.status) fakeCampaign.status = update.$set.status;
      return { modifiedCount: 1 };
    };

    const startTime = Date.now();
    const summary = await dispatchCampaign(campaignId, "center_pacing_test", {
      maxChunkSize: 15,
    });
    const elapsedMs = Date.now() - startTime;

    // Restore
    MessageCampaign.findOne = origFindOne;
    MessageCampaign.findById = origFindById;
    MessageCampaign.updateOne = origUpdateOne;

    assert.equal(summary.processed, 2);
    // Pacing delay between 2 messages is 3000ms - 7000ms
    assert.ok(
      elapsedMs >= 2900,
      `Expected elapsed time >= 2900ms for anti-ban pacing, got ${elapsedMs}ms`
    );
    console.log(
      `   [VERIFIED] Anti-ban pacing delay actively executed in production: ${elapsedMs}ms for 2 messages.`
    );
  });

  await t.test("2. Chunking Guard: Campaign with 20 messages processes exactly 15 and pauses", async () => {
    // Enable fast pacing for the chunking logic test
    process.env.DISABLE_DISPATCH_PACING = "true";

    const messages = Array.from({ length: 20 }, (_, idx) => ({
      _id: new Types.ObjectId(),
      phone: `9198765432${String(idx).padStart(2, "0")}`,
      message: `Hello student ${idx + 1}`,
      status: "pending",
      sourceType: "admission_welcome",
    }));

    const campaignId = new Types.ObjectId();
    const fakeCampaign = {
      _id: campaignId,
      centerId: "center_chunk_test",
      campaignType: "admission_welcome",
      status: "approved",
      messages,
      stats: { total: 20, sent: 0, simulated: 0, failed: 0, pending: 20 },
      save: async function () {
        return this;
      },
    };

    const origFindOne = MessageCampaign.findOne;
    const origFindById = MessageCampaign.findById;
    const origUpdateOne = MessageCampaign.updateOne;

    MessageCampaign.findOne = () => fakeCampaign;
    MessageCampaign.findById = () => fakeCampaign;
    MessageCampaign.updateOne = async (filter, update) => {
      if (update?.$set?.status) fakeCampaign.status = update.$set.status;
      if (filter["messages._id"]) {
        const msg = fakeCampaign.messages.find(
          (m) => String(m._id) === String(filter["messages._id"])
        );
        if (msg) {
          msg.status = update.$set["messages.$.status"] || msg.status;
        }
      }
      return { modifiedCount: 1 };
    };

    // First execution: process with default maxChunkSize = 15
    const firstRunSummary = await dispatchCampaign(
      campaignId,
      "center_chunk_test",
      { maxChunkSize: 15 }
    );

    assert.equal(firstRunSummary.processed, 15, "First run must process exactly 15 messages");
    assert.equal(fakeCampaign.status, "in_progress", "Campaign status must remain 'in_progress'");

    const pendingCountAfterFirst = fakeCampaign.messages.filter(
      (m) => m.status === "pending"
    ).length;
    assert.equal(
      pendingCountAfterFirst,
      5,
      "Exactly 5 messages must remain pending after first chunk"
    );
    console.log(
      `   [VERIFIED] First run correctly chunked: 15 processed, 5 pending remaining, status='in_progress'`
    );

    // Second execution (simulating next cron cycle): pick up remaining 5 messages
    const secondRunSummary = await dispatchCampaign(
      campaignId,
      "center_chunk_test",
      { maxChunkSize: 15 }
    );

    assert.equal(secondRunSummary.processed, 5, "Second run must process the remaining 5 messages");
    assert.equal(
      fakeCampaign.status,
      "completed",
      "Campaign must transition to 'completed' once all 20 are processed"
    );
    const pendingCountAfterSecond = fakeCampaign.messages.filter(
      (m) => m.status === "pending"
    ).length;
    assert.equal(pendingCountAfterSecond, 0, "Zero messages remain pending");
    console.log(
      `   [VERIFIED] Second run completed campaign: 5 processed, 0 pending remaining, status='completed'`
    );

    // Restore
    MessageCampaign.findOne = origFindOne;
    MessageCampaign.findById = origFindById;
    MessageCampaign.updateOne = origUpdateOne;
    delete process.env.DISABLE_DISPATCH_PACING;
  });

  await t.test("3. Cron Endpoint /api/cron/process-campaigns security & sweep execution", async () => {
    // 3a. Unauthorized request without CRON_SECRET rejected with 401
    const unauthReq = {
      nextUrl: new URL("http://localhost:3000/api/cron/process-campaigns"),
      url: "http://localhost:3000/api/cron/process-campaigns",
      headers: new Headers(),
      method: "POST",
      json: async () => ({}),
    };
    const unauthRes = await cronModule.POST(unauthReq);
    assert.equal(unauthRes.status, 401, "Missing CRON_SECRET must return HTTP 401");

    // 3b. Authorized request with valid CRON_SECRET invokes processApprovedCampaigns
    const origFind = MessageCampaign.find;
    MessageCampaign.find = () => ({
      sort: () => ({
        limit: () => [],
      }),
    });

    const authReq = {
      nextUrl: new URL("http://localhost:3000/api/cron/process-campaigns"),
      url: "http://localhost:3000/api/cron/process-campaigns",
      headers: new Headers({
        "x-cron-secret": "test_cron_secret_e2e_987654",
      }),
      method: "POST",
      json: async () => ({ limit: 15 }),
    };

    const authRes = await cronModule.POST(authReq);
    const authData = await authRes.json();

    assert.equal(authRes.status, 200, "Valid CRON_SECRET must return HTTP 200");
    assert.equal(authData.success, true);
    assert.equal(authData.message, "Message campaigns processed successfully");
    console.log(
      `   [VERIFIED] /api/cron/process-campaigns authorized and executed successfully (HTTP 200).`
    );

    MessageCampaign.find = origFind;
  });

  await t.test("4. Admission Cron Worker Pacing: 2 sequential retries take >= 2000ms delay", async () => {
    // Delete pacing bypass to test real production delay
    delete process.env.DISABLE_DISPATCH_PACING;

    AdmissionWelcomeJob.hasUniqueIdempotencyIndex = async () => true;
    let claimCount = 0;
    const origFindOneAndUpdate = AdmissionWelcomeJob.findOneAndUpdate;
    const origUpdateOne = AdmissionWelcomeJob.updateOne;

    AdmissionWelcomeJob.findOneAndUpdate = async () => {
      claimCount++;
      if (claimCount <= 2) {
        return {
          _id: new Types.ObjectId(),
          centerId: "center_retry_pacing",
          parentPhone: `91987654321${claimCount}`,
          studentName: `Student ${claimCount}`,
          batchName: "Batch A",
          attempts: 1,
          maxAttempts: 3,
          parentAccessStatus: "existing_active",
        };
      }
      return null; // queue drained
    };

    AdmissionWelcomeJob.updateOne = async () => ({ modifiedCount: 1 });

    const startTime = Date.now();
    const summary = await processPendingAdmissionWelcomeJobs("center_retry_pacing", 2);
    const elapsedMs = Date.now() - startTime;

    AdmissionWelcomeJob.findOneAndUpdate = origFindOneAndUpdate;
    AdmissionWelcomeJob.updateOne = origUpdateOne;
    delete AdmissionWelcomeJob.hasUniqueIdempotencyIndex;

    assert.equal(summary.processed, 2);
    // Pacing delay between 2 jobs is 2000ms - 5000ms
    assert.ok(
      elapsedMs >= 1900,
      `Expected elapsed time >= 1900ms for admission queue pacing, got ${elapsedMs}ms`
    );
    console.log(
      `   [VERIFIED] Admission queue pacing delay actively executed in production: ${elapsedMs}ms for 2 retries.`
    );
  });
});
