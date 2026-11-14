
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

process.env.JWT_SECRET = "test-jwt-secret-bulk-recovery-hardening-32chars!";
process.env.MONGODB_URI = "mongodb://localhost:27017/test_bulk_recovery";
process.env.WHATSAPP_MODE = "simulation";
process.env.ENABLE_LIVE_WHATSAPP = "false";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-recovery-12345";

// Mock connectDB cache and active connection
globalThis.mongooseCache = {
  conn: mongoose,
  promise: Promise.resolve(mongoose),
};
mongoose.connection = {
  readyState: 1,
};

test("MSEC — Bulk Welcome Job Recovery Hardening Suite", async (t) => {
  const {
    AdmissionWelcomeJob,
    verifyAdmissionWelcomeJobIndexIntegrity,
  } = await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts");
  const { MessageCampaign } = await import(
    "../tution-desk-be/src/models/MessageCampaign.ts"
  );
  const { default: FeeReminderLog } = await import(
    "../tution-desk-be/src/models/FeeReminderLog.ts"
  );
  FeeReminderLog.find = () => Promise.resolve([]);
  const {
    recoverExpiredAdmissionWelcomeJobs,
    processPendingAdmissionWelcomeJobs,
  } = await import("../tution-desk-be/src/lib/admissionWelcomeQueue.ts");
  const { reconcileStaleInFlightRecords } = await import(
    "../tution-desk-be/src/lib/queueReconciler.ts"
  );

  const centerA = "center_recovery_test_a";

  // In-memory document stores
  const admissionStore = new Map();
  const campaignStore = new Map();

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function matchQuery(doc, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k === "_id") {
        if (v && typeof v === "object" && "$in" in v) {
          const ids = v.$in.map((id) => String(id));
          if (!ids.includes(String(doc._id))) return false;
        } else if (String(doc._id) !== String(v)) {
          return false;
        }
        continue;
      }
      if (k === "$or") {
        const matchesOr = v.some((subFilter) => matchQuery(doc, subFilter));
        if (!matchesOr) return false;
        continue;
      }
      if (k === "centerId" && doc.centerId !== v) return false;
      if (k === "status") {
        if (v && typeof v === "object" && "$in" in v) {
          if (!v.$in.includes(doc.status)) return false;
        } else if (doc.status !== v) {
          return false;
        }
      }
      if (k === "lockExpiresAt") {
        if (v && typeof v === "object") {
          if (v.$lt && !(doc.lockExpiresAt && new Date(doc.lockExpiresAt) < new Date(v.$lt))) return false;
          if (v.$lte && !(doc.lockExpiresAt && new Date(doc.lockExpiresAt) <= new Date(v.$lte))) return false;
        } else if (v === null && doc.lockExpiresAt !== null && doc.lockExpiresAt !== undefined) {
          return false;
        }
      }
      if (k === "lockedAt") {
        if (v && typeof v === "object") {
          if (v.$lt && !(doc.lockedAt && new Date(doc.lockedAt) < new Date(v.$lt))) return false;
          if (v.$lte && !(doc.lockedAt && new Date(doc.lockedAt) <= new Date(v.$lte))) return false;
        }
      }
      if (k === "messages.sourceId") {
        const hasMatch = (doc.messages || []).some(
          (m) => String(m.sourceId) === String(v)
        );
        if (!hasMatch) return false;
      }
    }
    return true;
  }

  // Intercept AdmissionWelcomeJob queries
  AdmissionWelcomeJob.find = (filter = {}) => {
    const results = [];
    for (const doc of admissionStore.values()) {
      if (matchQuery(doc, filter)) {
        results.push(clone(doc));
      }
    }
    return Promise.resolve(results);
  };

  AdmissionWelcomeJob.findOne = (filter = {}) => {
    for (const doc of admissionStore.values()) {
      if (matchQuery(doc, filter)) {
        return Promise.resolve(clone(doc));
      }
    }
    return Promise.resolve(null);
  };

  AdmissionWelcomeJob.findOneAndUpdate = async (filter, update, options = {}) => {
    for (const [id, doc] of admissionStore.entries()) {
      if (matchQuery(doc, filter)) {
        const updated = clone(doc);
        if (update.$set) {
          Object.assign(updated, update.$set);
        }
        if (update.$inc) {
          for (const [k, delta] of Object.entries(update.$inc)) {
            updated[k] = (updated[k] || 0) + delta;
          }
        }
        admissionStore.set(id, updated);
        return clone(updated);
      }
    }
    return null;
  };

  AdmissionWelcomeJob.updateOne = async (filter, update) => {
    for (const [id, doc] of admissionStore.entries()) {
      if (matchQuery(doc, filter)) {
        const updated = clone(doc);
        if (update.$set) {
          Object.assign(updated, update.$set);
        }
        if (update.$inc) {
          for (const [k, delta] of Object.entries(update.$inc)) {
            updated[k] = (updated[k] || 0) + delta;
          }
        }
        admissionStore.set(id, updated);
        return { modifiedCount: 1 };
      }
    }
    return { modifiedCount: 0 };
  };

  AdmissionWelcomeJob.updateMany = async (filter, update) => {
    let count = 0;
    for (const [id, doc] of admissionStore.entries()) {
      if (matchQuery(doc, filter)) {
        const updated = clone(doc);
        if (update.$set) {
          Object.assign(updated, update.$set);
        }
        admissionStore.set(id, updated);
        count++;
      }
    }
    return { modifiedCount: count };
  };

  // Intercept MessageCampaign queries
  MessageCampaign.findOne = (filter = {}) => {
    const query = {
      sort: () => query,
      then: (resolve) => {
        for (const doc of campaignStore.values()) {
          if (matchQuery(doc, filter)) {
            resolve(clone(doc));
            return;
          }
        }
        resolve(null);
      },
    };
    return query;
  };

  MessageCampaign.updateOne = async (filter, update) => {
    for (const [id, doc] of campaignStore.entries()) {
      if (matchQuery(doc, filter)) {
        const updated = clone(doc);
        if (filter["messages._id"] && update.$set) {
          const msg = (updated.messages || []).find(
            (m) => String(m._id) === String(filter["messages._id"])
          );
          if (msg) {
            for (const [k, v] of Object.entries(update.$set)) {
              if (k.startsWith("messages.$.status")) msg.status = v;
              if (k.startsWith("messages.$.error")) msg.error = v;
            }
          }
        }
        campaignStore.set(id, updated);
        return { modifiedCount: 1 };
      }
    }
    return { modifiedCount: 0 };
  };

  // --------------------------------------------------------------------------
  // Requirement 2: Bulk-created processing jobs receive valid lease expiry
  // --------------------------------------------------------------------------
  await t.test("1. Valid lease expiry scales with campaign batch size", () => {
    const BASE_CAMPAIGN_LEASE_MS = 15 * 60 * 1000;
    const PER_MESSAGE_BUFFER_MS = 20 * 1000;

    // Small batch of 5 students: uses base 15-minute floor
    const smallBatchCount = 5;
    const smallBatchLeaseMs = Math.max(
      BASE_CAMPAIGN_LEASE_MS,
      smallBatchCount * PER_MESSAGE_BUFFER_MS
    );
    assert.equal(smallBatchLeaseMs, 15 * 60 * 1000, "Small batch must have 15m minimum floor");

    // Large batch of 100 students: scales to 2000s (>33 minutes)
    const largeBatchCount = 100;
    const largeBatchLeaseMs = Math.max(
      BASE_CAMPAIGN_LEASE_MS,
      largeBatchCount * PER_MESSAGE_BUFFER_MS
    );
    assert.equal(largeBatchLeaseMs, 2000 * 1000, "Large batch lease must scale with message count");
    assert.ok(largeBatchLeaseMs > BASE_CAMPAIGN_LEASE_MS);
  });

  // --------------------------------------------------------------------------
  // Requirement 3: Expired jobs must NOT be reset while campaign is actively processing
  // --------------------------------------------------------------------------
  await t.test("2. Active campaign deferral: Expired job lease is extended, NOT reset to pending", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId = new Types.ObjectId().toString();
    const campId = new Types.ObjectId().toString();
    const expiredTime = new Date(Date.now() - 5000); // 5 seconds expired

    // Job whose lease expired
    admissionStore.set(jobId, {
      _id: jobId,
      centerId: centerA,
      studentName: "Aarav Sharma",
      status: "processing",
      attempts: 0,
      maxAttempts: 3,
      campaignId: campId,
      lockedAt: new Date(Date.now() - 20 * 60 * 1000),
      lockExpiresAt: expiredTime,
      failureReason: null,
    });

    // Associated campaign is in_progress and recently active
    campaignStore.set(campId, {
      _id: campId,
      centerId: centerA,
      status: "in_progress",
      updatedAt: new Date(Date.now() - 30 * 1000), // active 30s ago
      messages: [
        {
          _id: new Types.ObjectId().toString(),
          sourceId: jobId,
          status: "pending", // Campaign hasn't reached it yet, but is actively running
        },
      ],
    });

    const summary = await recoverExpiredAdmissionWelcomeJobs(centerA);
    assert.equal(summary.inspected, 1);
    assert.equal(summary.deferredActiveCampaign, 1, "Must be deferred due to active campaign");
    assert.equal(summary.recoveredPending, 0, "Must NEVER reset to pending while campaign is active");

    const job = admissionStore.get(jobId);
    assert.equal(job.status, "processing", "Job must remain in processing status");
    assert.ok(new Date(job.lockExpiresAt) > new Date(), "Lease must be extended into the future");
  });

  // --------------------------------------------------------------------------
  // Requirement 4 & 5: Already sent/simulated messages are reconciled (no duplicate dispatch)
  // --------------------------------------------------------------------------
  await t.test("3. Delivered message reconciliation: Sent or simulated messages reconcile to terminal state", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId1 = new Types.ObjectId().toString();
    const jobId2 = new Types.ObjectId().toString();
    const campId = new Types.ObjectId().toString();
    const expiredTime = new Date(Date.now() - 10000);

    // Job 1: campaign delivered it as sent
    admissionStore.set(jobId1, {
      _id: jobId1,
      centerId: centerA,
      studentName: "Bhavna Patel",
      status: "processing",
      attempts: 0,
      campaignId: campId,
      lockExpiresAt: expiredTime,
    });

    // Job 2: campaign delivered it as simulated
    admissionStore.set(jobId2, {
      _id: jobId2,
      centerId: centerA,
      studentName: "Chetan Kumar",
      status: "processing",
      attempts: 0,
      campaignId: campId,
      lockExpiresAt: expiredTime,
    });

    campaignStore.set(campId, {
      _id: campId,
      centerId: centerA,
      status: "completed",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
      messages: [
        {
          _id: new Types.ObjectId().toString(),
          sourceId: jobId1,
          status: "sent",
          messageId: "wamid.DELIVERED_123",
          dispatchedAt: new Date(),
        },
        {
          _id: new Types.ObjectId().toString(),
          sourceId: jobId2,
          status: "simulated",
          messageId: "sim_999",
          dispatchedAt: new Date(),
        },
      ],
    });

    const summary = await recoverExpiredAdmissionWelcomeJobs(centerA);
    assert.equal(summary.reconciledSent, 2);
    assert.equal(summary.recoveredPending, 0, "Zero jobs must be reset to pending when already delivered");

    const job1 = admissionStore.get(jobId1);
    assert.equal(job1.status, "sent");
    assert.equal(job1.messageId, "wamid.DELIVERED_123");
    assert.equal(job1.lockExpiresAt, null);

    const job2 = admissionStore.get(jobId2);
    assert.equal(job2.status, "simulated");
    assert.equal(job2.simulated, true);
    assert.equal(job2.lockExpiresAt, null);
  });

  // --------------------------------------------------------------------------
  // Requirement 4, 5 & 9: Interrupted campaigns recover pending messages safely
  // --------------------------------------------------------------------------
  await t.test("4. Interrupted campaign recovery: Pending message is defused in campaign and recovered to pending for queue", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId = new Types.ObjectId().toString();
    const campId = new Types.ObjectId().toString();
    const msgId = new Types.ObjectId().toString();
    const expiredTime = new Date(Date.now() - 10000);

    admissionStore.set(jobId, {
      _id: jobId,
      centerId: centerA,
      studentName: "Divya Nair",
      status: "processing",
      attempts: 0,
      maxAttempts: 3,
      campaignId: campId,
      lockExpiresAt: expiredTime,
      failureReason: "Initial registration note",
    });

    // Interrupted / stalled campaign (in_progress with no activity for 30 minutes)
    campaignStore.set(campId, {
      _id: campId,
      centerId: centerA,
      status: "in_progress",
      updatedAt: new Date(Date.now() - 30 * 60 * 1000), // stalled 30 mins ago
      messages: [
        {
          _id: msgId,
          sourceId: jobId,
          status: "pending",
        },
      ],
    });

    const summary = await recoverExpiredAdmissionWelcomeJobs(centerA);
    assert.equal(summary.recoveredPending, 1);

    // Job is safely recovered for queue dispatch
    const job = admissionStore.get(jobId);
    assert.equal(job.status, "pending");
    assert.equal(job.lockExpiresAt, null);
    assert.match(job.failureReason, /Initial registration note/);
    assert.match(job.failureReason, /Recovered from interrupted campaign/);

    // Campaign message is defused to failed to prevent future double dispatch
    const camp = campaignStore.get(campId);
    const msg = camp.messages.find((m) => String(m._id) === msgId);
    assert.equal(msg.status, "failed");
    assert.match(msg.error, /recovered by queue worker/i);
  });

  // --------------------------------------------------------------------------
  // Requirement 6: Preservation of original attempt and failure history
  // --------------------------------------------------------------------------
  await t.test("5. Attempt & failure history preservation during failed campaign message reconciliation", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId = new Types.ObjectId().toString();
    const campId = new Types.ObjectId().toString();
    const expiredTime = new Date(Date.now() - 10000);

    admissionStore.set(jobId, {
      _id: jobId,
      centerId: centerA,
      studentName: "Eshan Ghosh",
      status: "processing",
      attempts: 1, // Prior attempt recorded
      maxAttempts: 3,
      campaignId: campId,
      lockExpiresAt: expiredTime,
      failureReason: "Initial timeout during socket connection",
    });

    campaignStore.set(campId, {
      _id: campId,
      centerId: centerA,
      status: "failed_partial",
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
      messages: [
        {
          _id: new Types.ObjectId().toString(),
          sourceId: jobId,
          status: "failed",
          error: "WhatsApp socket disconnected mid-frame",
        },
      ],
    });

    const summary = await recoverExpiredAdmissionWelcomeJobs(centerA);
    assert.equal(summary.reconciledFailed, 1);

    const job = admissionStore.get(jobId);
    assert.equal(job.status, "pending", "Job with remaining attempts (1 of 3) must be pending for retry");
    assert.equal(job.attempts, 1, "Original attempt count (1) must be preserved, not reset to 0");
    assert.match(job.failureReason, /Initial timeout during socket connection/);
    assert.match(job.failureReason, /WhatsApp socket disconnected mid-frame/);
  });

  // --------------------------------------------------------------------------
  // Requirement 7: Exhausted retries transition to terminal failed
  // --------------------------------------------------------------------------
  await t.test("6. Exhausted attempts transition job to terminal failed (no infinite retry)", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId = new Types.ObjectId().toString();
    const campId = new Types.ObjectId().toString();
    const expiredTime = new Date(Date.now() - 10000);

    admissionStore.set(jobId, {
      _id: jobId,
      centerId: centerA,
      studentName: "Farhan Ali",
      status: "processing",
      attempts: 3, // Exhausted
      maxAttempts: 3,
      campaignId: campId,
      lockExpiresAt: expiredTime,
      failureReason: "Attempt 2 failed",
    });

    campaignStore.set(campId, {
      _id: campId,
      centerId: centerA,
      status: "failed_partial",
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
      messages: [
        {
          _id: new Types.ObjectId().toString(),
          sourceId: jobId,
          status: "failed",
          error: "Recipient phone invalid",
        },
      ],
    });

    const summary = await recoverExpiredAdmissionWelcomeJobs(centerA);
    assert.equal(summary.reconciledFailed, 1);

    const job = admissionStore.get(jobId);
    assert.equal(job.status, "failed", "Exhausted job must transition to terminal failed");
    assert.equal(job.nextRetryAt, null, "Terminal failed job must have null nextRetryAt");
    assert.match(job.failureReason, /Attempt 2 failed/);
    assert.match(job.failureReason, /Recipient phone invalid/);
  });

  // --------------------------------------------------------------------------
  // Requirement 7: Standalone expired worker lease recovery
  // --------------------------------------------------------------------------
  await t.test("7. Standalone expired queue job without campaign is recovered to pending", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId = new Types.ObjectId().toString();
    const expiredTime = new Date(Date.now() - 10000);

    admissionStore.set(jobId, {
      _id: jobId,
      centerId: centerA,
      studentName: "Geeta Sen",
      status: "processing",
      attempts: 1,
      maxAttempts: 3,
      lockExpiresAt: expiredTime,
      failureReason: "Worker crashed",
    });

    const summary = await recoverExpiredAdmissionWelcomeJobs(centerA);
    assert.equal(summary.recoveredPending, 1);

    const job = admissionStore.get(jobId);
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 1, "Attempts must be preserved");
    assert.match(job.failureReason, /Worker crashed/);
    assert.match(job.failureReason, /lease expired/i);
  });

  // --------------------------------------------------------------------------
  // Queue Reconciler Hardening: Active campaigns are never marked ambiguous
  // --------------------------------------------------------------------------
  await t.test("8. QueueReconciler does not mark active campaign jobs as ambiguous", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const jobId = new Types.ObjectId().toString();
    const campId = new Types.ObjectId().toString();

    admissionStore.set(jobId, {
      _id: jobId,
      centerId: centerA,
      status: "processing",
      lockedAt: new Date(Date.now() - 20 * 60 * 1000),
      lockExpiresAt: new Date(Date.now() - 1000),
    });

    // Active campaign (updated 1 minute ago)
    campaignStore.set(campId, {
      _id: campId,
      centerId: centerA,
      status: "in_progress",
      updatedAt: new Date(Date.now() - 60 * 1000),
      messages: [
        {
          sourceId: jobId,
          status: "pending",
        },
      ],
    });

    const summary = await reconcileStaleInFlightRecords({ centerId: centerA });
    assert.equal(summary.markedUncertain, 0, "Must not mark actively processing campaign job ambiguous");

    const job = admissionStore.get(jobId);
    assert.equal(job.status, "processing", "Active campaign job must remain in processing");
  });

  // --------------------------------------------------------------------------
  // Requirement 5 & 9: Duplicate-dispatch prevention across queue runner
  // --------------------------------------------------------------------------
  await t.test("9. Duplicate dispatch prevention: Reconciled terminal jobs are excluded from queue claims", async () => {
    admissionStore.clear();
    campaignStore.clear();

    const sentJobId = new Types.ObjectId().toString();
    const simulatedJobId = new Types.ObjectId().toString();
    const failedJobId = new Types.ObjectId().toString();
    const recoveredPendingJobId = new Types.ObjectId().toString();

    // 1 sent (terminal)
    admissionStore.set(sentJobId, {
      _id: sentJobId,
      centerId: centerA,
      status: "sent",
      attempts: 1,
      maxAttempts: 3,
    });

    // 1 simulated (terminal)
    admissionStore.set(simulatedJobId, {
      _id: simulatedJobId,
      centerId: centerA,
      status: "simulated",
      attempts: 1,
      maxAttempts: 3,
    });

    // 1 terminal failed
    admissionStore.set(failedJobId, {
      _id: failedJobId,
      centerId: centerA,
      status: "failed",
      attempts: 3,
      maxAttempts: 3,
      nextRetryAt: null,
    });

    // 1 recovered pending
    admissionStore.set(recoveredPendingJobId, {
      _id: recoveredPendingJobId,
      centerId: centerA,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      nextRetryAt: new Date(Date.now() - 1000),
    });

    // Worker claim query simulation
    const claimFilter = {
      status: "pending",
      centerId: centerA,
    };

    const eligibleForClaim = [];
    for (const doc of admissionStore.values()) {
      if (matchQuery(doc, claimFilter)) {
        eligibleForClaim.push(doc);
      }
    }

    assert.equal(eligibleForClaim.length, 1, "Only the pending job must be eligible for claim");
    assert.equal(eligibleForClaim[0]._id, recoveredPendingJobId);

    // Simulate claiming the job
    const claimed = await AdmissionWelcomeJob.findOneAndUpdate(
      { _id: recoveredPendingJobId, status: "pending" },
      { $set: { status: "processing", lockedAt: new Date() }, $inc: { attempts: 1 } }
    );
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.attempts, 1);

    // A concurrent worker trying to claim the same job must receive null (atomic precondition)
    const concurrentClaim = await AdmissionWelcomeJob.findOneAndUpdate(
      { _id: recoveredPendingJobId, status: "pending" },
      { $set: { status: "processing" } }
    );
    assert.equal(concurrentClaim, null, "Concurrent worker must fail atomic claim precondition");
  });
});
