import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_INDEX_INVENTORY,
  normalizeKey,
  compareIndexSpecs,
  detectDuplicateRecords,
  verifyDatabaseIndexes,
  initializeDatabaseIndexes,
} from "../tution-desk-be/src/lib/indexManager.ts";
import {
  verifyParentAccessLockIndexIntegrity,
  verifyParentAccessLockTtlIndexIntegrity,
} from "../tution-desk-be/src/models/ParentAccessLock.ts";
import {
  verifyLockIndexIntegrity,
  verifyFeeCreationLockTtlIndexIntegrity,
} from "../tution-desk-be/src/models/FeeCreationLock.ts";

/**
 * Creates an in-memory mock MongoDB Database instance to simulate
 * collections, index catalogs, listIndexes, createIndex, aggregate, and countDocuments.
 */
function createMockDatabase(dbName = "tuitiondesk_test") {
  const collections = new Map();

  function getOrCreateCollection(name) {
    if (!collections.has(name)) {
      collections.set(name, {
        name,
        indexes: [
          { v: 2, key: { _id: 1 }, name: "_id_" }, // Default MongoDB primary key
        ],
        documents: [],
      });
    }
    return collections.get(name);
  }

  return {
    databaseName: dbName,
    _collections: collections,

    collection(name) {
      const col = getOrCreateCollection(name);

      return {
        collectionName: name,

        async listIndexes() {
          return {
            async toArray() {
              return [...col.indexes];
            },
          };
        },

        async indexes() {
          return [...col.indexes];
        },

        async createIndex(key, options = {}) {
          const normKey = normalizeKey(key);
          const existingIdx = col.indexes.findIndex(
            (idx) => normalizeKey(idx.key) === normKey
          );

          const newIdx = {
            v: 2,
            key,
            name: options.name || Object.entries(key).map(([k, v]) => `${k}_${v}`).join("_"),
            ...(options.unique ? { unique: true } : {}),
            ...(typeof options.expireAfterSeconds === "number"
              ? { expireAfterSeconds: options.expireAfterSeconds }
              : {}),
            ...(options.partialFilterExpression
              ? { partialFilterExpression: options.partialFilterExpression }
              : {}),
            ...(options.sparse ? { sparse: true } : {}),
          };

          if (existingIdx >= 0) {
            col.indexes[existingIdx] = newIdx;
          } else {
            col.indexes.push(newIdx);
          }
          return newIdx.name;
        },

        aggregate(pipeline = []) {
          return {
            async toArray() {
              // Basic in-memory duplicate detector simulation matching aggregation contract
              const hasGroup = pipeline.some((stage) => stage.$group);
              if (hasGroup) {
                const keyCounts = new Map();
                for (const doc of col.documents) {
                  let kVal = doc.lockKey || doc.utrNumber || (doc.paymentHistory && doc.paymentHistory.idempotencyKey) || doc.idempotencyKey || doc.centerId;
                  if (kVal !== undefined && kVal !== null && kVal !== "") {
                    keyCounts.set(String(kVal), (keyCounts.get(String(kVal)) || 0) + 1);
                  }
                }
                const dups = [];
                for (const [k, count] of keyCounts.entries()) {
                  if (count > 1) {
                    dups.push({ _id: { key: k }, count });
                  }
                }
                return dups;
              }
              return [];
            },
          };
        },

        async countDocuments() {
          return col.documents.length;
        },

        async find() {
          return {
            async toArray() {
              return [...col.documents];
            },
          };
        },

        _seedDocuments(docs) {
          col.documents.push(...docs);
        },
      };
    },
  };
}

test("Permanent Centralized Database Index Management Suite", async (t) => {
  // ---------------------------------------------------------------------------
  // 1. Catalog Completeness & Inventory Audit
  // ---------------------------------------------------------------------------
  await t.test("1. Required index catalog covers all 20 collections and declared constraints", () => {
    const requiredCollections = [
      "fees",
      "cashhandovers",
      "teachers",
      "students",
      "feecreationlocks",
      "importbatchlocks",
      "parentaccesslocks",
      "admissionwelcomejobs",
      "parentaccesses",
      "attendances",
      "batches",
      "centers",
      "feereminderlogs",
      "messagecampaigns",
      "tests",
      "baileys_auth",
      "staffnotifications",
      "userpushsubscriptions",
      "paymentproofs",
      "studentbatchrequests",
    ];

    const catalogKeys = Object.keys(REQUIRED_INDEX_INVENTORY);
    assert.equal(catalogKeys.length, 20, "Must contain exactly 20 collections");

    for (const name of requiredCollections) {
      assert.ok(REQUIRED_INDEX_INVENTORY[name], `Catalog must contain collection '${name}'`);
      assert.ok(REQUIRED_INDEX_INVENTORY[name].length > 0, `Collection '${name}' must have index declarations`);
    }

    const totalDeclared = catalogKeys.reduce((acc, col) => acc + REQUIRED_INDEX_INVENTORY[col].length, 0);
    assert.equal(totalDeclared, 66, "Must contain exactly 66 declared custom indexes across all 20 collections");

    // Verify ParentAccessLock index definitions
    const parentLockIndexes = REQUIRED_INDEX_INVENTORY.parentaccesslocks;
    const uniqueLockIdx = parentLockIndexes.find((idx) => normalizeKey(idx.key) === "lockKey:1");
    assert.ok(uniqueLockIdx, "parentaccesslocks must declare { lockKey: 1 }");
    assert.equal(uniqueLockIdx.unique, true, "lockKey must be unique");

    const ttlLockIdx = parentLockIndexes.find((idx) => normalizeKey(idx.key) === "expiresAt:1");
    assert.ok(ttlLockIdx, "parentaccesslocks must declare { expiresAt: 1 } TTL");
    assert.equal(ttlLockIdx.expireAfterSeconds, 600, "TTL must be 600 seconds (10 minutes)");

    // Verify FeeCreationLock index definitions
    const feeLockIndexes = REQUIRED_INDEX_INVENTORY.feecreationlocks;
    assert.ok(feeLockIndexes.some((idx) => normalizeKey(idx.key) === "lockKey:1" && idx.unique === true));
    assert.ok(feeLockIndexes.some((idx) => normalizeKey(idx.key) === "expiresAt:1" && idx.expireAfterSeconds === 600));

    // Verify parentaccesses tokenHash unique index
    const parentAccessIndexes = REQUIRED_INDEX_INVENTORY.parentaccesses;
    const tokenHashIdx = parentAccessIndexes.find((idx) => normalizeKey(idx.key) === "tokenHash:1");
    assert.ok(tokenHashIdx, "parentaccesses must declare { tokenHash: 1 }");
    assert.equal(tokenHashIdx.unique, true, "tokenHash must be unique");

    // Verify staffnotifications idempotencyKey sparse index
    const staffNotifIndexes = REQUIRED_INDEX_INVENTORY.staffnotifications;
    const staffIdempIdx = staffNotifIndexes.find((idx) => normalizeKey(idx.key) === "idempotencyKey:1");
    assert.ok(staffIdempIdx, "staffnotifications must declare { idempotencyKey: 1 }");
    assert.equal(staffIdempIdx.sparse, true, "idempotencyKey must be sparse");

    // Verify userpushsubscriptions endpoint unique index
    const pushIndexes = REQUIRED_INDEX_INVENTORY.userpushsubscriptions;
    const pushEndpointIdx = pushIndexes.find((idx) => normalizeKey(idx.key) === "endpoint:1");
    assert.ok(pushEndpointIdx, "userpushsubscriptions must declare { endpoint: 1 }");
    assert.equal(pushEndpointIdx.unique, true, "endpoint must be unique");

    // Verify studentbatchrequests pending uniqueness
    const batchReqIndexes = REQUIRED_INDEX_INVENTORY.studentbatchrequests;
    const batchReqUniqueIdx = batchReqIndexes.find(
      (idx) => normalizeKey(idx.key) === "centerId:1,studentId:1"
    );
    assert.ok(batchReqUniqueIdx, "studentbatchrequests must declare { centerId: 1, studentId: 1 }");
    assert.equal(batchReqUniqueIdx.unique, true);
    assert.deepEqual(batchReqUniqueIdx.partialFilterExpression, { status: "pending" });

    // Verify Fee paymentHistory.idempotencyKey partial unique index
    const feeIndexes = REQUIRED_INDEX_INVENTORY.fees;
    const feeIdempIdx = feeIndexes.find(
      (idx) => normalizeKey(idx.key) === "centerId:1,paymentHistory.idempotencyKey:1"
    );
    assert.ok(feeIdempIdx, "Fee idempotency index must be declared");
    assert.equal(feeIdempIdx.unique, true);
    assert.deepEqual(feeIdempIdx.partialFilterExpression, {
      "paymentHistory.idempotencyKey": { $type: "string", $gt: "" },
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Fresh Database Verification (Unindexed State)
  // ---------------------------------------------------------------------------
  await t.test("2. Fresh unindexed database correctly reports MISSING indexes and NO_GO status", async () => {
    const freshDb = createMockDatabase("fresh_client_db");

    const report = await verifyDatabaseIndexes(freshDb);
    assert.equal(report.isHealthy, false, "Fresh database must not be marked healthy before initialization");
    assert.equal(report.criticalLocksVerified, false, "Critical locks must report unverified");
    assert.ok(report.missingCount > 30, `Expected >30 missing indexes, found ${report.missingCount}`);
    assert.equal(report.conflictCount, 0, "No conflicts expected on clean database");
    assert.ok(
      report.summary.criticalLocksMissing.includes("parentaccesslocks -> { lockKey:1 }"),
      "Must report parentaccesslocks lockKey index missing"
    );
    assert.ok(
      report.summary.criticalLocksMissing.includes("feecreationlocks -> { lockKey:1 }"),
      "Must report feecreationlocks lockKey index missing"
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Fresh Database Index Initialization & Provisioning
  // ---------------------------------------------------------------------------
  await t.test("3. initializeDatabaseIndexes successfully provisions all required indexes on fresh database", async () => {
    const mockDb = createMockDatabase("fresh_client_msec");

    const initResult = await initializeDatabaseIndexes(mockDb, {
      dryRun: false,
      logger: () => {}, // Suppress console during test
    });

    assert.equal(initResult.success, true, "Initialization must succeed on clean database");
    assert.ok(initResult.createdCount > 30, `Created count must be >30, got ${initResult.createdCount}`);
    assert.equal(initResult.conflictCount, 0);
    assert.equal(initResult.duplicateBlockedCount, 0);

    // Re-verify immediately after initialization
    const postAudit = await verifyDatabaseIndexes(mockDb);
    assert.equal(postAudit.isHealthy, true, "Database must be 100% healthy after initialization");
    assert.equal(postAudit.criticalLocksVerified, true, "All critical locks must be verified");
    assert.equal(postAudit.missingCount, 0, "Zero indexes should be missing");
    assert.equal(postAudit.conflictCount, 0, "Zero conflicts should exist");
  });

  // ---------------------------------------------------------------------------
  // 4. Repeated Initialization Idempotency
  // ---------------------------------------------------------------------------
  await t.test("4. Running initializeDatabaseIndexes repeatedly is strictly idempotent (no-op)", async () => {
    const mockDb = createMockDatabase("idempotent_test_db");

    // First run creates indexes
    await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });

    // Second run must be clean no-op
    const repeatResult = await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });
    assert.equal(repeatResult.success, true);
    assert.equal(repeatResult.createdCount, 0, "Second run must create 0 new indexes");
    assert.ok(repeatResult.skippedCount > 30, "All indexes must be skipped as already verified");
    assert.equal(repeatResult.conflictCount, 0);
    assert.equal(repeatResult.duplicateBlockedCount, 0);
  });

  // ---------------------------------------------------------------------------
  // 5. Dry-Run Mode Safety Guarantee
  // ---------------------------------------------------------------------------
  await t.test("5. Dry-run mode reports what would be created without executing createIndex", async () => {
    const mockDb = createMockDatabase("dry_run_test_db");

    const dryResult = await initializeDatabaseIndexes(mockDb, { dryRun: true, logger: () => {} });
    assert.equal(dryResult.dryRun, true);
    assert.ok(dryResult.createdCount > 30);

    // Confirm that zero indexes were actually written
    const col = mockDb.collection("parentaccesslocks");
    const indexes = await col.indexes();
    assert.equal(indexes.length, 1, "Only default _id_ must remain after dry run");
    assert.equal(indexes[0].name, "_id_");
  });

  // ---------------------------------------------------------------------------
  // 6. Conflict Detection Without Automatic Dropping
  // ---------------------------------------------------------------------------
  await t.test("6. Conflicting index definition is flagged as CONFLICT and NEVER automatically dropped", async () => {
    const mockDb = createMockDatabase("conflict_test_db");
    const col = mockDb.collection("parentaccesslocks");

    // Artificially create a conflicting non-unique index with same key
    await col.createIndex({ lockKey: 1 }, { unique: false, name: "lockKey_1_non_unique" });

    const audit = await verifyDatabaseIndexes(mockDb);
    assert.equal(audit.isHealthy, false);
    assert.ok(audit.conflictCount >= 1, "Must detect conflict");

    const parentLockReport = audit.resultsByCollection.parentaccesslocks.find(
      (r) => normalizeKey(r.expected.key) === "lockKey:1"
    );
    assert.ok(parentLockReport);
    assert.equal(parentLockReport.status, "CONFLICT");
    assert.ok(
      parentLockReport.reasons.some((r) => r.includes("Uniqueness mismatch")),
      "Must identify uniqueness mismatch reason"
    );

    // When initializeDatabaseIndexes is called, it must NOT drop or overwrite the conflict
    const initRes = await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });
    assert.equal(initRes.success, false, "Must fail initialization when conflict exists");
    assert.ok(initRes.conflictCount >= 1);

    // Existing index must remain preserved in database
    const finalIndexes = await col.indexes();
    const preserved = finalIndexes.find((idx) => normalizeKey(idx.key) === "lockKey:1");
    assert.ok(preserved, "Conflicting index must not be silently dropped");
    assert.equal(preserved.unique, undefined, "Preserved index still non-unique (requires explicit manual migration)");
  });

  // ---------------------------------------------------------------------------
  // 7. Duplicate Records Block Unique Index Fail-Closed
  // ---------------------------------------------------------------------------
  await t.test("7. Duplicate records block unique index creation fail-closed without altering data", async () => {
    const mockDb = createMockDatabase("duplicate_check_db");
    const col = mockDb.collection("parentaccesslocks");

    // Seed duplicate lockKey documents
    col._seedDocuments([
      { lockKey: "center_1:student_1:9876543210:parent_access_create", holderId: "token_1" },
      { lockKey: "center_1:student_1:9876543210:parent_access_create", holderId: "token_2" }, // Duplicate!
    ]);

    const dupCheck = await detectDuplicateRecords(mockDb, "parentaccesslocks", {
      key: { lockKey: 1 },
      unique: true,
      purpose: "Parent access lock",
    });

    assert.equal(dupCheck.hasDuplicates, true);
    assert.equal(dupCheck.duplicateCount, 1);

    // Run initializeDatabaseIndexes - must detect duplicates and abort creation for this index
    const initRes = await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });
    assert.equal(initRes.success, false, "Must report failure due to duplicate block");
    assert.equal(initRes.duplicateBlockedCount, 1);

    // Documents must remain completely untouched (NEVER silently deleted or modified)
    const docs = await (await col.find()).toArray();
    assert.equal(docs.length, 2, "Both duplicate documents must remain intact");

    // Index must NOT have been created
    const indexes = await col.indexes();
    assert.equal(
      indexes.some((idx) => normalizeKey(idx.key) === "lockKey:1"),
      false,
      "Unique index must NOT be created when duplicates exist"
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Model Verification Helpers Alignment
  // ---------------------------------------------------------------------------
  await t.test("8. ParentAccessLock and FeeCreationLock model verification helpers function correctly", async () => {
    const mockDb = createMockDatabase("helpers_test_db");

    // Before indexing
    const parentColBefore = mockDb.collection("parentaccesslocks");
    const feeColBefore = mockDb.collection("feecreationlocks");

    const parentModelBefore = { collection: parentColBefore };
    const feeModelBefore = { collection: feeColBefore };

    assert.equal(await verifyParentAccessLockIndexIntegrity(parentModelBefore), false);
    assert.equal(await verifyParentAccessLockTtlIndexIntegrity(parentModelBefore), false);
    assert.equal(await verifyLockIndexIntegrity(feeModelBefore), false);
    assert.equal(await verifyFeeCreationLockTtlIndexIntegrity(feeModelBefore), false);

    // Initialize indexes
    await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });

    // After indexing
    assert.equal(await verifyParentAccessLockIndexIntegrity(parentModelBefore), true);
    assert.equal(await verifyParentAccessLockTtlIndexIntegrity(parentModelBefore), true);
    assert.equal(await verifyLockIndexIntegrity(feeModelBefore), true);
    assert.equal(await verifyFeeCreationLockTtlIndexIntegrity(feeModelBefore), true);
  });

  // ---------------------------------------------------------------------------
  // 9. Deployment / Preflight Readiness Verification Gate
  // ---------------------------------------------------------------------------
  await t.test("9. Preflight readiness route blocks deployment on missing critical indexes", async () => {
    const { GET: readinessRoute } = await import(
      "../tution-desk-be/src/app/api/system/readiness/route.ts"
    );

    const mockDb = createMockDatabase("preflight_client_db");
    const originalConnectDB = (await import("../tution-desk-be/src/lib/db.ts")).connectDB;
    process.env.CRON_SECRET = "preflight_super_secret_key_123";

    try {
      // Mock db connection returning mockDb
      const mockConn = { connection: { db: mockDb } };
      if (!globalThis.mongooseCache) {
        globalThis.mongooseCache = { conn: null, promise: null };
      }
      globalThis.mongooseCache.conn = mockConn;
      globalThis.mongooseCache.promise = Promise.resolve(mockConn);

      // 1. Unauthorized request without secret
      const reqUnauth = new Request("http://localhost:3000/api/system/readiness");
      const resUnauth = await readinessRoute(reqUnauth);
      assert.equal(resUnauth.status, 401, "Must require authorization secret or owner session");

      // 2. Authorized request on fresh unindexed database -> 503 Service Unavailable
      const reqFresh = new Request("http://localhost:3000/api/system/readiness?secret=preflight_super_secret_key_123");
      const resFresh = await readinessRoute(reqFresh);
      assert.equal(resFresh.status, 503, "Must return 503 when critical indexes are missing");
      const dataFresh = await resFresh.json();
      assert.equal(dataFresh.ready, false);
      assert.equal(dataFresh.status, "CRITICAL_LOCKS_MISSING");
      assert.ok(dataFresh.remedialCommand.includes("manage-indexes.ts --apply"));

      // 3. Initialize indexes
      await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });

      // 4. Authorized request on fully provisioned database -> 200 OK Ready
      const reqReady = new Request("http://localhost:3000/api/system/readiness?secret=preflight_super_secret_key_123");
      const resReady = await readinessRoute(reqReady);
      assert.equal(resReady.status, 200, "Must return 200 OK when fully provisioned");
      const dataReady = await resReady.json();
      assert.equal(dataReady.ready, true);
      assert.equal(dataReady.status, "READY");
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Omission of Any Required Collection or Index Fails Readiness
  // ---------------------------------------------------------------------------
  await t.test("10. Omission of any required collection or index causes readiness to fail", async () => {
    const { GET: readinessRoute } = await import(
      "../tution-desk-be/src/app/api/system/readiness/route.ts"
    );

    const mockDb = createMockDatabase("omission_test_db");
    process.env.CRON_SECRET = "omission_test_secret_789";

    try {
      const mockConn = { connection: { db: mockDb } };
      if (!globalThis.mongooseCache) {
        globalThis.mongooseCache = { conn: null, promise: null };
      }
      globalThis.mongooseCache.conn = mockConn;
      globalThis.mongooseCache.promise = Promise.resolve(mockConn);

      // Provision all 20 collections
      await initializeDatabaseIndexes(mockDb, { dryRun: false, logger: () => {} });

      // Confirm healthy before tests
      const initialReport = await verifyDatabaseIndexes(mockDb);
      assert.equal(initialReport.isHealthy, true);

      // Scenario A: Drop a newly added collection index (tokenHash in parentaccesses)
      const parentCol = mockDb._collections.get("parentaccesses");
      const originalParentIndexes = [...parentCol.indexes];
      parentCol.indexes = parentCol.indexes.filter((idx) => normalizeKey(idx.key) !== "tokenHash:1");

      const reqA = new Request("http://localhost:3000/api/system/readiness?secret=omission_test_secret_789");
      const resA = await readinessRoute(reqA);
      assert.equal(resA.status, 503, "Must fail readiness when parentaccesses tokenHash is omitted");
      const dataA = await resA.json();
      assert.equal(dataA.ready, false);
      assert.ok(dataA.status === "MISSING_INDEXES" || dataA.status === "CRITICAL_LOCKS_MISSING");

      // Restore parentaccesses indexes
      parentCol.indexes = originalParentIndexes;

      // Scenario B: Drop userpushsubscriptions unique endpoint index
      const pushCol = mockDb._collections.get("userpushsubscriptions");
      const originalPushIndexes = [...pushCol.indexes];
      pushCol.indexes = pushCol.indexes.filter((idx) => normalizeKey(idx.key) !== "endpoint:1");

      const reqB = new Request("http://localhost:3000/api/system/readiness?secret=omission_test_secret_789");
      const resB = await readinessRoute(reqB);
      assert.equal(resB.status, 503, "Must fail readiness when userpushsubscriptions endpoint index is omitted");
      const dataB = await resB.json();
      assert.equal(dataB.ready, false);

      // Restore push indexes
      pushCol.indexes = originalPushIndexes;

      // Scenario C: Drop entire staffnotifications collection indexes (empty collection)
      const staffCol = mockDb._collections.get("staffnotifications");
      const originalStaffIndexes = [...staffCol.indexes];
      staffCol.indexes = [{ v: 2, key: { _id: 1 }, name: "_id_" }]; // only primary key

      const reqC = new Request("http://localhost:3000/api/system/readiness?secret=omission_test_secret_789");
      const resC = await readinessRoute(reqC);
      assert.equal(resC.status, 503, "Must fail readiness when staffnotifications collection indexes are omitted");
      const dataC = await resC.json();
      assert.equal(dataC.ready, false);

      // Restore staff indexes
      staffCol.indexes = originalStaffIndexes;

      // Scenario D: All indexes restored -> Must succeed with 200 OK
      const reqD = new Request("http://localhost:3000/api/system/readiness?secret=omission_test_secret_789");
      const resD = await readinessRoute(reqD);
      assert.equal(resD.status, 200, "Must pass readiness when all 20 collections and indexes are present");
      const dataD = await resD.json();
      assert.equal(dataD.ready, true);
      assert.equal(dataD.status, "READY");
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});
