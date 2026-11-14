import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_INDEX_CATALOG,
  normalizeKey,
  compareIndexSpecs,
  isApprovedStagingDatabase,
  extractDatabaseName,
  sanitizeMongoUri,
  detectDuplicateData,
  analyzeDatabaseIndexes,
  executeIndexMigration,
} from "../scripts/migrate-database-indexes.mjs";

test("Database Index Migration Utility — Safety & Dry-Run Test Suite", async (t) => {
  // ---------------------------------------------------------------------------
  // 1. Database Staging Safeguards
  // ---------------------------------------------------------------------------
  await t.test("1. Target database safety gate strictly rejects production targets", () => {
    // Production targets must be strictly rejected
    assert.equal(isApprovedStagingDatabase("msec"), false, "Must reject 'msec'");
    assert.equal(isApprovedStagingDatabase("tuitiondesk"), false, "Must reject 'tuitiondesk'");
    assert.equal(isApprovedStagingDatabase("production"), false, "Must reject 'production'");
    assert.equal(isApprovedStagingDatabase("prod"), false, "Must reject 'prod'");
    assert.equal(isApprovedStagingDatabase("msec", "msec"), false, "Even if explicit, reject 'msec'");

    // Approved isolated staging / test databases must be accepted
    assert.equal(isApprovedStagingDatabase("tuitiondesk_staging"), true);
    assert.equal(isApprovedStagingDatabase("msec_staging"), true);
    assert.equal(isApprovedStagingDatabase("staging_qa"), true);
    assert.equal(isApprovedStagingDatabase("test_tuitiondesk"), true);
    assert.equal(isApprovedStagingDatabase("tuitiondesk_test"), true);
  });

  // ---------------------------------------------------------------------------
  // 2. URI Sanitization & Database Parsing
  // ---------------------------------------------------------------------------
  await t.test("2. URI parser and secret sanitizer mask credentials cleanly", () => {
    const rawUri = "mongodb+srv://admin_user:SuperSecretPassword123@cluster0.abc.mongodb.net/tuitiondesk_staging?retryWrites=true";
    const sanitized = sanitizeMongoUri(rawUri);
    assert.ok(!sanitized.includes("SuperSecretPassword123"), "Password must be masked");
    assert.ok(sanitized.includes("admin_user:***@"), "Must include masked placeholder");

    const dbName = extractDatabaseName(rawUri);
    assert.equal(dbName, "tuitiondesk_staging");
  });

  // ---------------------------------------------------------------------------
  // 3. Expected Catalog Integrity
  // ---------------------------------------------------------------------------
  await t.test("3. Expected catalog contains all required core models and indexes", () => {
    const requiredCollections = [
      "fees",
      "cashhandovers",
      "teachers",
      "students",
      "feecreationlocks",
      "importbatchlocks",
      "admissionwelcomejobs",
      "parentaccess",
      "parentaccesslocks",
      "attendances",
      "batches",
      "centers",
      "feereminderlogs",
      "messagecampaigns",
      "tests",
      "baileys_auth",
    ];

    for (const col of requiredCollections) {
      assert.ok(EXPECTED_INDEX_CATALOG[col], `Catalog must contain collection '${col}'`);
      assert.ok(EXPECTED_INDEX_CATALOG[col].length > 0, `Collection '${col}' must have declared indexes`);
    }

    // Verify Fee Idempotency Index
    const feeIndexes = EXPECTED_INDEX_CATALOG.fees;
    const idempotencyIdx = feeIndexes.find(
      (idx) => normalizeKey(idx.key) === normalizeKey({ centerId: 1, "paymentHistory.idempotencyKey": 1 })
    );
    assert.ok(idempotencyIdx, "Fee catalog must contain paymentHistory.idempotencyKey index");
    assert.equal(idempotencyIdx.unique, true, "Idempotency index must be unique");
    assert.deepEqual(
      idempotencyIdx.partialFilterExpression,
      { "paymentHistory.idempotencyKey": { $type: "string", $gt: "" } },
      "Must have partialFilterExpression excluding null/empty"
    );

    // Verify CashHandover HandoverNumber Index
    const handoverIndexes = EXPECTED_INDEX_CATALOG.cashhandovers;
    const handoverNumIdx = handoverIndexes.find(
      (idx) => normalizeKey(idx.key) === normalizeKey({ centerId: 1, handoverNumber: 1 })
    );
    assert.ok(handoverNumIdx, "CashHandover must contain handoverNumber index");
    assert.equal(handoverNumIdx.unique, true, "Handover number index must be unique");
  });

  // ---------------------------------------------------------------------------
  // 4. Index Comparison & Conflict Detection
  // ---------------------------------------------------------------------------
  await t.test("4. compareIndexSpecs detects matching, missing and conflicting specs", () => {
    const declaredSpec = {
      key: { centerId: 1, handoverNumber: 1 },
      unique: true,
    };

    const matchingDoc = {
      key: { centerId: 1, handoverNumber: 1 },
      unique: true,
      name: "custom_name_1",
    };
    assert.equal(compareIndexSpecs(declaredSpec, matchingDoc).matches, true);

    const conflictingDoc = {
      key: { centerId: 1, handoverNumber: 1 },
      unique: false, // Conflict!
      name: "centerId_1_handoverNumber_1",
    };
    const conflictResult = compareIndexSpecs(declaredSpec, conflictingDoc);
    assert.equal(conflictResult.matches, false);
    assert.equal(conflictResult.reason, "option_mismatch");
  });

  // ---------------------------------------------------------------------------
  // 5. Duplicate Data Detection (Mocked DB)
  // ---------------------------------------------------------------------------
  await t.test("5. detectDuplicateData flags duplicate records preventing unique index", async () => {
    const mockCollectionWithDuplicates = {
      async aggregate(pipeline) {
        return [
          { _id: { centerId: "center_alpha", handoverNumber: "HO-001" }, count: 2, docIds: ["id1", "id2"] },
        ];
      },
    };

    const handoverSpec = {
      key: { centerId: 1, handoverNumber: 1 },
      unique: true,
    };

    const dupCheck = await detectDuplicateData(mockCollectionWithDuplicates, handoverSpec);
    assert.equal(dupCheck.hasDuplicates, true);
    assert.equal(dupCheck.duplicateCount, 1);
    assert.equal(dupCheck.sampleDuplicates[0]._id.handoverNumber, "HO-001");
  });

  // ---------------------------------------------------------------------------
  // 6. Subdocument Array Duplicate Detection
  // ---------------------------------------------------------------------------
  await t.test("6. detectDuplicateData handles paymentHistory.idempotencyKey subdocuments", async () => {
    const mockFeeCollection = {
      async aggregate(pipeline) {
        // Assert pipeline contains $unwind
        assert.ok(pipeline.some((stage) => stage.$unwind === "$paymentHistory"));
        return [
          { _id: { centerId: "center_alpha", idempotencyKey: "dup-key-999" }, count: 2, feeIds: ["fee1", "fee2"] },
        ];
      },
    };

    const feeIdempotencySpec = {
      key: { centerId: 1, "paymentHistory.idempotencyKey": 1 },
      unique: true,
      partialFilterExpression: { "paymentHistory.idempotencyKey": { $type: "string", $gt: "" } },
    };

    const dupCheck = await detectDuplicateData(mockFeeCollection, feeIdempotencySpec);
    assert.equal(dupCheck.hasDuplicates, true);
    assert.equal(dupCheck.duplicateCount, 1);
    assert.equal(dupCheck.sampleDuplicates[0]._id.idempotencyKey, "dup-key-999");
  });

  // ---------------------------------------------------------------------------
  // 7. Dry-Run Mode Analysis (Zero Writes)
  // ---------------------------------------------------------------------------
  await t.test("7. Dry-run mode analyzes database without calling createIndex", async () => {
    let createIndexCalled = false;

    const mockDb = {
      databaseName: "tuitiondesk_staging",
      collection(name) {
        return {
          async indexes() {
            if (name === "centers") {
              return [
                { key: { _id: 1 }, name: "_id_" },
                { key: { centerId: 1 }, name: "centerId_1_unique", unique: true },
              ];
            }
            return [{ key: { _id: 1 }, name: "_id_" }];
          },
          async aggregate() {
            return [];
          },
          async createIndex() {
            createIndexCalled = true;
          },
        };
      },
    };

    const result = await executeIndexMigration(mockDb, {
      apply: false, // Dry run
    });

    assert.equal(result.mode, "DRY_RUN");
    assert.equal(result.applied, false);
    assert.equal(createIndexCalled, false, "createIndex must NEVER be called in dry run");
    assert.ok(result.analysis.missingCount > 0, "Missing indexes must be detected");
    assert.equal(result.analysis.collections.centers.matched.length, 1, "centers.centerId must match");
  });

  // ---------------------------------------------------------------------------
  // 8. Safety Enforcement on Production DB
  // ---------------------------------------------------------------------------
  await t.test("8. executeIndexMigration throws if target database is production 'msec'", async () => {
    const mockProdDb = {
      databaseName: "msec",
      collection() {
        return {};
      },
    };

    await assert.rejects(
      async () => {
        await executeIndexMigration(mockProdDb, { apply: false });
      },
      /NOT recognized as an approved isolated staging database/,
      "Must throw error on production 'msec'"
    );
  });

  // ---------------------------------------------------------------------------
  // 9. Apply Mode Safeguards (Requires Confirmation)
  // ---------------------------------------------------------------------------
  await t.test("9. executeIndexMigration requires --confirm-staging-migration when apply: true", async () => {
    const mockStagingDb = {
      databaseName: "msec_staging",
      collection() {
        return {
          async indexes() {
            return [{ key: { _id: 1 }, name: "_id_" }];
          },
          async aggregate() {
            return [];
          },
        };
      },
    };

    await assert.rejects(
      async () => {
        await executeIndexMigration(mockStagingDb, {
          apply: true,
          confirmStaging: false, // Missing confirmation!
        });
      },
      /Migration execution requires explicit confirmation flag/,
      "Must require confirmation flag"
    );
  });

  // ---------------------------------------------------------------------------
  // 10. Conflict & Duplicate Abort in Live Apply Mode
  // ---------------------------------------------------------------------------
  await t.test("10. executeIndexMigration aborts live apply if duplicates or conflicts exist", async () => {
    const mockDbWithDuplicates = {
      databaseName: "msec_staging",
      collection(name) {
        return {
          async indexes() {
            return [{ key: { _id: 1 }, name: "_id_" }];
          },
          async aggregate() {
            // Simulate duplicate
            return [{ _id: { centerId: "test", loginId: "t1" }, count: 2 }];
          },
        };
      },
    };

    await assert.rejects(
      async () => {
        await executeIndexMigration(mockDbWithDuplicates, {
          apply: true,
          confirmStaging: true,
        });
      },
      /Detected .* unique index duplicate data blockers/,
      "Must abort apply if duplicate data exists"
    );
  });
});
