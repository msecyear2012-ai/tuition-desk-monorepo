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

process.env.JWT_SECRET = "test-jwt-secret-consistency-archive-32chars!";
process.env.MONGODB_URI = "mongodb://localhost:27017/test_consistency_archive";
process.env.WHATSAPP_MODE = "simulation";
process.env.ENABLE_LIVE_WHATSAPP = "false";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-12345";

// Mock connectDB cache
globalThis.mongooseCache = {
  conn: mongoose,
  promise: Promise.resolve(mongoose),
};
mongoose.connection = {
  readyState: 1,
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

test("WhatsApp Queue Production Safety & Soft-Archive Specification Suite", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const {
    GET: getRetry,
    POST: postRetry,
    DELETE: deleteRetry,
  } = await import("../tution-desk-be/src/app/api/whatsapp/retry/route.ts");
  const { POST: postClearDelivered } = await import(
    "../tution-desk-be/src/app/api/whatsapp/retry/clear-delivered/route.ts"
  );
  const { reconcileStaleInFlightRecords } = await import(
    "../tution-desk-be/src/lib/queueReconciler.ts"
  );
  const { executeClearDelivered } = await import(
    "../tution-desk-be/src/lib/clearDeliveredService.ts"
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

  const centerA = "center_consist_a";
  const centerB = "center_consist_b";

  const ownerTokenA = await signToken({
    userId: "owner_a",
    email: "owner_a@test.com",
    role: "owner",
    centerId: centerA,
  });

  const ownerTokenB = await signToken({
    userId: "owner_b",
    email: "owner_b@test.com",
    role: "owner",
    centerId: centerB,
  });

  const teacherTokenA = await signToken({
    userId: "teacher_a",
    email: "teacher_a@test.com",
    role: "teacher",
    centerId: centerA,
  });

  // Mock in-memory stores for collections
  const admissionStore = new Map();
  const feeStore = new Map();
  const campaignStore = new Map();

  let totalMutationCount = 0;

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
      if (k === "isArchived") {
        if (v && typeof v === "object" && "$ne" in v) {
          if (doc.isArchived === v.$ne) return false;
        } else if (Boolean(doc.isArchived) !== Boolean(v)) {
          return false;
        }
      }
      if (k === "attemptedAt" && v && typeof v === "object") {
        if (v.$lt && !(doc.attemptedAt < v.$lt)) return false;
        if (v.$lte && !(doc.attemptedAt <= v.$lte)) return false;
      }
      if (k === "createdAt" && v && typeof v === "object") {
        if (v.$lt && !(doc.createdAt < v.$lt)) return false;
        if (v.$lte && !(doc.createdAt <= v.$lte)) return false;
      }
      if (k === "messages.status" && v && typeof v === "object" && "$in" in v) {
        const hasMatch = (doc.messages || []).some((m) => v.$in.includes(m.status));
        if (!hasMatch) return false;
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

  // Intercept Mongoose Model queries with in-memory test mocks
  FeeReminderLog.countDocuments = async (filter = {}) => {
    let count = 0;
    for (const doc of feeStore.values()) {
      if (matchQuery(doc, filter)) count++;
    }
    return count;
  };

  FeeReminderLog.find = (filter = {}) => {
    const results = [];
    for (const doc of feeStore.values()) {
      if (matchQuery(doc, filter)) {
        results.push({ ...doc });
      }
    }
    const queryObj = {
      then: (resolve, reject) => Promise.resolve(results).then(resolve, reject),
      populate: () => ({
        sort: () => ({
          limit: () => Promise.resolve(results),
        }),
        limit: () => Promise.resolve(results),
      }),
      sort: () => ({
        limit: () => Promise.resolve(results),
      }),
      limit: () => Promise.resolve(results),
    };
    return queryObj;
  };

  FeeReminderLog.updateOne = async (filter, update) => {
    totalMutationCount++;
    const id = String(filter._id);
    const doc = feeStore.get(id);
    if (!doc) return { modifiedCount: 0 };
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    feeStore.set(id, doc);
    return { modifiedCount: 1 };
  };

  FeeReminderLog.updateMany = async (filter, update) => {
    totalMutationCount++;
    let modified = 0;
    for (const [id, doc] of feeStore.entries()) {
      if (matchQuery(doc, filter)) {
        if (update.$set) {
          Object.assign(doc, update.$set);
        }
        feeStore.set(id, doc);
        modified++;
      }
    }
    return { modifiedCount: modified };
  };

  FeeReminderLog.findOneAndUpdate = async (filter, update) => {
    totalMutationCount++;
    const id = String(filter._id);
    const doc = feeStore.get(id);
    if (!doc) return null;
    if (filter.status && doc.status !== filter.status) {
      return null; // Atomic guard precondition failed!
    }
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    feeStore.set(id, doc);
    return { ...doc };
  };

  AdmissionWelcomeJob.countDocuments = async (filter = {}) => {
    let count = 0;
    for (const doc of admissionStore.values()) {
      if (matchQuery(doc, filter)) count++;
    }
    return count;
  };

  AdmissionWelcomeJob.find = (filter = {}) => {
    const results = [];
    for (const doc of admissionStore.values()) {
      if (matchQuery(doc, filter)) {
        results.push({ ...doc });
      }
    }
    return {
      then: (resolve, reject) => Promise.resolve(results).then(resolve, reject),
      sort: () => ({
        limit: () => Promise.resolve(results),
      }),
      limit: () => Promise.resolve(results),
    };
  };

  AdmissionWelcomeJob.updateOne = async (filter, update) => {
    totalMutationCount++;
    const id = String(filter._id);
    const doc = admissionStore.get(id);
    if (!doc) return { modifiedCount: 0 };
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    admissionStore.set(id, doc);
    return { modifiedCount: 1 };
  };

  AdmissionWelcomeJob.updateMany = async (filter, update) => {
    totalMutationCount++;
    let modified = 0;
    for (const [id, doc] of admissionStore.entries()) {
      if (matchQuery(doc, filter)) {
        if (update.$set) {
          Object.assign(doc, update.$set);
        }
        admissionStore.set(id, doc);
        modified++;
      }
    }
    return { modifiedCount: modified };
  };

  AdmissionWelcomeJob.findOneAndUpdate = async (filter, update) => {
    totalMutationCount++;
    const id = String(filter._id);
    const doc = admissionStore.get(id);
    if (!doc) return null;
    if (filter.status && doc.status !== filter.status) {
      return null; // Atomic precondition failed!
    }
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    admissionStore.set(id, doc);
    return { ...doc };
  };

  MessageCampaign.countDocuments = async (filter = {}) => {
    let count = 0;
    for (const doc of campaignStore.values()) {
      if (matchQuery(doc, filter)) count++;
    }
    return count;
  };

  MessageCampaign.find = (filter = {}) => {
    const results = [];
    for (const doc of campaignStore.values()) {
      if (matchQuery(doc, filter)) {
        results.push({ ...doc });
      }
    }
    return {
      sort: () => ({
        limit: () => Promise.resolve(results),
      }),
      limit: () => Promise.resolve(results),
    };
  };

  MessageCampaign.findOne = (filter = {}) => {
    let match = null;
    for (const doc of campaignStore.values()) {
      if (filter.centerId && doc.centerId !== filter.centerId) continue;
      if (filter["messages.sourceId"]) {
        const hasMatch = (doc.messages || []).some(
          (m) => String(m.sourceId) === String(filter["messages.sourceId"])
        );
        if (hasMatch) {
          match = { ...doc };
          break;
        }
      }
      if (filter.$or) {
        const matchesOr = filter.$or.some((sub) => {
          if (sub["messages.sourceId"]) {
            return (doc.messages || []).some(
              (m) => String(m.sourceId) === String(sub["messages.sourceId"])
            );
          }
          return false;
        });
        if (matchesOr) {
          match = { ...doc };
          break;
        }
      }
    }
    return {
      then: (resolve, reject) => Promise.resolve(match).then(resolve, reject),
      sort: () => Promise.resolve(match),
    };
  };

  MessageCampaign.updateMany = async (filter, update) => {
    totalMutationCount++;
    let modified = 0;
    for (const [id, doc] of campaignStore.entries()) {
      if (matchQuery(doc, filter)) {
        if (update.$set) {
          if (update.$set.isArchived !== undefined) {
            doc.isArchived = update.$set.isArchived;
          }
          if (update.$set.archivedAt !== undefined) {
            doc.archivedAt = update.$set.archivedAt;
          }
        }
        campaignStore.set(id, doc);
        modified++;
      }
    }
    return { modifiedCount: modified };
  };

  MessageCampaign.create = async (doc) => {
    totalMutationCount++;
    const id = new Types.ObjectId().toString();
    const created = { _id: id, ...doc };
    campaignStore.set(id, created);
    return created;
  };

  Center.findOne = (filter = {}) => ({
    select: () => Promise.resolve({ name: "Test Coaching Academy" }),
  });

  await t.test("Priority 1: GET /api/whatsapp/retry is strictly read-only (zero DB writes)", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();
    totalMutationCount = 0;

    // Seed in-flight record that is older than 20 minutes
    const staleId = new Types.ObjectId().toString();
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);

    feeStore.set(staleId, {
      _id: staleId,
      centerId: centerA,
      recipientPhone: "919876543210",
      status: "attempted",
      attemptedAt: twentyMinsAgo,
      isArchived: false,
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    const res = await getRetry(req);
    const data = await res.json();

    assert.equal(res.status, 200);
    // Crucial: GET MUST NOT perform any mutations on database documents!
    assert.equal(totalMutationCount, 0, "GET must perform exactly ZERO database writes");

    // The document must remain completely intact in attempted status
    const docAfterGet = feeStore.get(staleId);
    assert.equal(docAfterGet.status, "attempted", "Document status must not be modified by GET");

    // In response, inFlightCount reflects the active attempted record
    assert.equal(data.inFlightCount, 1);
    assert.equal(data.failedCount, 0);
  });

  await t.test("Priority 2: Reconciler correlates strictly by exact messages.sourceId (no broad match)", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();

    const feeLogId = new Types.ObjectId().toString();
    const studentObjId = new Types.ObjectId();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    feeStore.set(feeLogId, {
      _id: feeLogId,
      centerId: centerA,
      studentId: studentObjId,
      recipientPhone: "919876543210",
      status: "attempted",
      attemptedAt: twoHoursAgo,
      isArchived: false,
    });

    // Unrelated campaign for the same student/phone but with different sourceId
    const unrelatedCampId = new Types.ObjectId().toString();
    campaignStore.set(unrelatedCampId, {
      _id: unrelatedCampId,
      centerId: centerA,
      status: "completed",
      messages: [
        {
          sourceId: new Types.ObjectId().toString(), // UNRELATED sourceId!
          studentId: studentObjId,
          phone: "919876543210",
          status: "sent",
        },
      ],
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    });

    // Run reconciliation
    const summary = await reconcileStaleInFlightRecords({ centerId: centerA });
    assert.equal(summary.processed, 1);
    assert.equal(summary.promotedSent, 0, "Unrelated campaign must NOT promote fee reminder to sent");
    assert.equal(summary.markedUncertain, 1, "Must transition to dispatch_uncertain when correlation is absent");

    const updatedDoc = feeStore.get(feeLogId);
    assert.equal(updatedDoc.status, "dispatch_uncertain", "Status must be dispatch_uncertain");
    assert.match(updatedDoc.failureReason, /uncertain/i);
  });

  await t.test("Priority 2: Matching messages.sourceId correctly promotes to sent", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();

    const feeLogId = new Types.ObjectId().toString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    feeStore.set(feeLogId, {
      _id: feeLogId,
      centerId: centerA,
      recipientPhone: "919876543210",
      status: "attempted",
      attemptedAt: twoHoursAgo,
      isArchived: false,
    });

    // Matching campaign with exact sourceId
    const matchingCampId = new Types.ObjectId().toString();
    campaignStore.set(matchingCampId, {
      _id: matchingCampId,
      centerId: centerA,
      status: "completed",
      messages: [
        {
          sourceId: feeLogId, // EXACT sourceId correlation
          phone: "919876543210",
          status: "sent",
          messageId: "wamid.HBgLMTIzNDU2",
        },
      ],
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    });

    const summary = await reconcileStaleInFlightRecords({ centerId: centerA });
    assert.equal(summary.promotedSent, 1);

    const updatedDoc = feeStore.get(feeLogId);
    assert.equal(updatedDoc.status, "sent", "Exact sourceId match must resolve to sent");
    assert.equal(updatedDoc.providerMessageId, "wamid.HBgLMTIzNDU2");
  });

  await t.test("Priority 2 & 3: Timeout alone transitions to dispatch_uncertain (never blind failure)", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();

    const feeLogId = new Types.ObjectId().toString();
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);

    feeStore.set(feeLogId, {
      _id: feeLogId,
      centerId: centerA,
      recipientPhone: "919876543210",
      status: "attempted",
      attemptedAt: twentyMinsAgo,
      isArchived: false,
    });

    // Reconcile with 15m threshold
    const summary = await reconcileStaleInFlightRecords({ centerId: centerA });
    assert.equal(summary.markedUncertain, 1);
    assert.equal(summary.markedFailed, 0, "Must NEVER mark failed merely because time elapsed");

    const updatedDoc = feeStore.get(feeLogId);
    assert.equal(updatedDoc.status, "dispatch_uncertain");
  });

  await t.test("Priority 2: Atomic status precondition prevents double-processing during concurrent reconciliation", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();

    const feeLogId = new Types.ObjectId().toString();
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);

    feeStore.set(feeLogId, {
      _id: feeLogId,
      centerId: centerA,
      recipientPhone: "919876543210",
      status: "attempted",
      attemptedAt: twentyMinsAgo,
      isArchived: false,
    });

    // Simulate concurrent live socket receipt completing the record
    feeStore.get(feeLogId).status = "delivered";

    // Attempting reconciliation now must safely fail the atomic guard and leave delivered untouched
    const summary = await reconcileStaleInFlightRecords({ centerId: centerA });
    assert.equal(summary.markedUncertain, 0);

    const doc = feeStore.get(feeLogId);
    assert.equal(doc.status, "delivered", "Delivered status must be preserved; atomic guard prevented overwrite");
  });

  await t.test("Priority 2: Preserved 'sent' records are never modified", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();

    const feeLogId = new Types.ObjectId().toString();
    feeStore.set(feeLogId, {
      _id: feeLogId,
      centerId: centerA,
      recipientPhone: "919876543210",
      status: "sent",
      attemptedAt: new Date(Date.now() - 60 * 60 * 1000),
      isArchived: false,
    });

    const summary = await reconcileStaleInFlightRecords({ centerId: centerA });
    assert.equal(summary.processed, 0, "Records already sent must never be queried or altered");
    assert.equal(feeStore.get(feeLogId).status, "sent");
  });

  await t.test("Priority 3: POST /api/whatsapp/retry only retries strictly eligible failed messages", async () => {
    admissionStore.clear();
    feeStore.clear();
    campaignStore.clear();

    const failedId = new Types.ObjectId().toString();
    const uncertainId = new Types.ObjectId().toString();
    const attemptedId = new Types.ObjectId().toString();

    // 1 strictly failed
    feeStore.set(failedId, {
      _id: failedId,
      centerId: centerA,
      recipientPhone: "919876543210",
      status: "failed",
      failureReason: "Recipient phone invalid",
      amountDue: 2500,
      dueDate: new Date(),
      isArchived: false,
    });

    // 1 uncertain (not eligible for blind retry)
    feeStore.set(uncertainId, {
      _id: uncertainId,
      centerId: centerA,
      recipientPhone: "919876543211",
      status: "dispatch_uncertain",
      amountDue: 3000,
      dueDate: new Date(),
      isArchived: false,
    });

    // 1 attempted (not eligible for blind retry)
    feeStore.set(attemptedId, {
      _id: attemptedId,
      centerId: centerA,
      recipientPhone: "919876543212",
      status: "attempted",
      amountDue: 3500,
      dueDate: new Date(),
      isArchived: false,
    });

    // POST /api/whatsapp/retry
    const req = createMockRequest({
      method: "POST",
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    const res = await postRetry(req);
    const data = await res.json();

    assert.equal(res.status, 200);
    // Should retry exactly 1 message (the failed one), NOT the uncertain or attempted ones!
    assert.equal(data.requeuedCount, 1, "Only failed messages should be requeued");

    // The uncertain record must remain untouched in dispatch_uncertain
    assert.equal(feeStore.get(uncertainId).status, "dispatch_uncertain");
  });

  await t.test("Priority 4: Clear Delivered soft-archives ONLY delivered status (canonical service)", async () => {
    feeStore.clear();

    const deliveredId = new Types.ObjectId().toString();
    const sentId = new Types.ObjectId().toString();
    const providerAcceptedId = new Types.ObjectId().toString();
    const failedId = new Types.ObjectId().toString();
    const uncertainId = new Types.ObjectId().toString();

    feeStore.set(deliveredId, {
      _id: deliveredId,
      centerId: centerA,
      status: "delivered",
      attemptedAt: new Date(),
      isArchived: false,
    });
    feeStore.set(sentId, {
      _id: sentId,
      centerId: centerA,
      status: "sent",
      attemptedAt: new Date(),
      isArchived: false,
    });
    feeStore.set(providerAcceptedId, {
      _id: providerAcceptedId,
      centerId: centerA,
      status: "provider_accepted",
      attemptedAt: new Date(),
      isArchived: false,
    });
    feeStore.set(failedId, {
      _id: failedId,
      centerId: centerA,
      status: "failed",
      attemptedAt: new Date(),
      isArchived: false,
    });
    feeStore.set(uncertainId, {
      _id: uncertainId,
      centerId: centerA,
      status: "dispatch_uncertain",
      attemptedAt: new Date(),
      isArchived: false,
    });

    const result = await executeClearDelivered({ centerId: centerA });
    assert.equal(result.success, true);
    assert.equal(result.archivedCount, 1, "Only terminal delivered record can be archived");

    // Delivered is archived
    assert.equal(feeStore.get(deliveredId).isArchived, true);

    // All others remain strictly unarchived
    assert.equal(feeStore.get(sentId).isArchived, false, "Sent records must NEVER be archived");
    assert.equal(feeStore.get(providerAcceptedId).isArchived, false, "Provider accepted must NEVER be archived");
    assert.equal(feeStore.get(failedId).isArchived, false, "Failed records must NEVER be archived");
    assert.equal(feeStore.get(uncertainId).isArchived, false, "Uncertain records must NEVER be archived");
  });

  await t.test("Priority 4: Multi-tenant isolation verified during Clear Delivered", async () => {
    feeStore.clear();

    const centerAId = new Types.ObjectId().toString();
    const centerBId = new Types.ObjectId().toString();

    feeStore.set(centerAId, {
      _id: centerAId,
      centerId: centerA,
      status: "delivered",
      attemptedAt: new Date(),
      isArchived: false,
    });
    feeStore.set(centerBId, {
      _id: centerBId,
      centerId: centerB,
      status: "delivered",
      attemptedAt: new Date(),
      isArchived: false,
    });

    const delReq = createMockRequest({
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    const delRes = await deleteRetry(delReq);
    const delData = await delRes.json();

    assert.equal(delRes.status, 200);
    assert.equal(delData.archivedCount, 1);

    assert.equal(feeStore.get(centerAId).isArchived, true);
    assert.equal(feeStore.get(centerBId).isArchived, false, "Center B data must NEVER be touched by Center A clear");
  });

  await t.test("Security: Non-owner roles are rejected with 403 Forbidden", async () => {
    const teacherReq = createMockRequest({
      headers: { Authorization: `Bearer ${teacherTokenA}` },
    });
    const res = await getRetry(teacherReq);
    assert.equal(res.status, 403, "Non-owner role should receive 403 Forbidden");

    const clearReq = createMockRequest({
      method: "POST",
      url: "http://localhost:3001/api/whatsapp/retry/clear-delivered",
      headers: { Authorization: `Bearer ${teacherTokenA}` },
    });
    const clearRes = await postClearDelivered(clearReq);
    assert.equal(clearRes.status, 403, "Clear-delivered must reject non-owner with 403");
  });
});
