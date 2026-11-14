#!/usr/bin/env node
/**
 * TuitionDesk / MSEC — Production & Staging Database Index Migration Utility
 *
 * Operational Capabilities:
 *   1. Complete catalog inspection matching model schema declarations.
 *   2. Strict Dry-Run Mode by default (zero mutations without explicit flags).
 *   3. Pre-flight duplicate data detection before attempting unique index creation.
 *   4. Strict isolated staging database gating (refuses production execution).
 *   5. Never drops, alters, or replaces existing database indexes automatically.
 *   6. Sanitized connection strings and zero-secret logging.
 */

import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";

/**
 * Approved Staging / Isolated Database Name Patterns
 */
export const APPROVED_STAGING_PATTERNS = [
  /^tuitiondesk_staging$/i,
  /^msec_staging$/i,
  /^staging.*$/i,
  /.*_staging$/i,
  /^test.*$/i,
  /.*_test$/i,
];

/**
 * Sanitizes MongoDB connection string by masking user credentials.
 */
export function sanitizeMongoUri(uri) {
  if (!uri || typeof uri !== "string") return "[NOT SET]";
  try {
    return uri.replace(
      /mongodb(\+srv)?:\/\/([^:]+):([^@]+)@/i,
      "mongodb$1://$2:***@"
    );
  } catch {
    return "[MALFORMED URI]";
  }
}

/**
 * Extracts database name from MongoDB URI.
 */
export function extractDatabaseName(uri) {
  if (!uri || typeof uri !== "string") return null;
  try {
    const httpEquiv = uri.trim().replace(/^mongodb(\+srv)?:\/\//i, "http://");
    const parsed = new URL(httpEquiv);
    const pathname = parsed.pathname.replace(/^\/+/, "").split("?")[0].trim();
    return pathname || null;
  } catch {
    return null;
  }
}

/**
 * Checks whether a database name is an approved isolated staging / test database.
 */
export function isApprovedStagingDatabase(dbName, explicitAllowed = null) {
  if (!dbName || typeof dbName !== "string") return false;
  const cleanName = dbName.trim().toLowerCase();

  // If user explicitly allowed this exact database name via --allow-database
  if (explicitAllowed && explicitAllowed.trim().toLowerCase() === cleanName) {
    // Even if explicitly passed, reject production names 'msec' or 'production' without 'staging'
    if (cleanName === "msec" || cleanName === "tuitiondesk_prod" || cleanName === "production") {
      return false;
    }
    return true;
  }

  // Strictly block production names
  if (cleanName === "msec" || cleanName === "tuitiondesk" || cleanName === "production" || cleanName === "prod") {
    return false;
  }

  return APPROVED_STAGING_PATTERNS.some((pattern) => pattern.test(cleanName));
}

/**
 * The Authoritative Index Catalog across all TuitionDesk & MSEC Models.
 * Sourced directly from Mongoose schema declarations.
 */
export const EXPECTED_INDEX_CATALOG = {
  fees: [
    {
      key: { centerId: 1, studentId: 1, month: 1 },
      name: "centerId_1_studentId_1_month_1",
      purpose: "Multi-tenant student monthly invoice lookup",
    },
    {
      key: { centerId: 1, status: 1 },
      name: "centerId_1_status_1",
      purpose: "Multi-tenant fee status and overdue queries",
    },
    {
      key: { centerId: 1, utrNumber: 1 },
      name: "centerId_1_utrNumber_1_unique",
      unique: true,
      partialFilterExpression: { utrNumber: { $type: "string", $gt: "" } },
      purpose: "UPI transaction reference deduplication per center",
    },
    {
      key: { centerId: 1, assignedTeacherAtPayment: 1, paymentDate: 1 },
      name: "centerId_1_assignedTeacherAtPayment_1_paymentDate_1",
      purpose: "Teacher academic collection reporting",
    },
    {
      key: { centerId: 1, receivedBy: 1, paymentDate: 1 },
      name: "centerId_1_receivedBy_1_paymentDate_1",
      purpose: "Physical collector ledger reporting",
    },
    {
      key: { centerId: 1, recordedBy: 1, recordedAt: 1 },
      name: "centerId_1_recordedBy_1_recordedAt_1",
      purpose: "Staff operator audit reporting",
    },
    {
      key: { centerId: 1, "paymentHistory.receivedBy": 1 },
      name: "centerId_1_paymentHistory.receivedBy_1",
      purpose: "Subdocument collector payment filtering",
    },
    {
      key: { centerId: 1, "paymentHistory.allocations.handoverId": 1 },
      name: "centerId_1_paymentHistory.allocations.handoverId_1",
      purpose: "Handover payment reconciliation index",
    },
    {
      key: { centerId: 1, "paymentHistory.receiptNumber": 1 },
      name: "centerId_1_paymentHistory.receiptNumber_1",
      purpose: "Parent receipt lookup and verification",
    },
    {
      key: { centerId: 1, "paymentHistory.idempotencyKey": 1 },
      name: "centerId_1_paymentHistory.idempotencyKey_1_unique",
      unique: true,
      partialFilterExpression: { "paymentHistory.idempotencyKey": { $type: "string", $gt: "" } },
      purpose: "Phase 4 financial collection idempotency uniqueness",
    },
  ],

  cashhandovers: [
    {
      key: { centerId: 1, handoverNumber: 1 },
      name: "centerId_1_handoverNumber_1_unique",
      unique: true,
      purpose: "Unique handover envelope identifier per center",
    },
    {
      key: { centerId: 1, teacherId: 1, submittedAt: -1 },
      name: "centerId_1_teacherId_1_submittedAt_-1",
      purpose: "Teacher handover history chronological sorting",
    },
    {
      key: { centerId: 1, status: 1 },
      name: "centerId_1_status_1",
      purpose: "Owner pending verification queries",
    },
    {
      key: { centerId: 1, "items.feeId": 1 },
      name: "centerId_1_items.feeId_1",
      purpose: "Subdocument fee item reconciliation",
    },
  ],

  teachers: [
    {
      key: { centerId: 1, loginId: 1 },
      name: "centerId_1_loginId_1_unique",
      unique: true,
      purpose: "Unique teacher login credential per center",
    },
    {
      key: { centerId: 1, phone: 1 },
      name: "centerId_1_phone_1",
      purpose: "Teacher phone lookup",
    },
    {
      key: { centerId: 1, isActive: 1 },
      name: "centerId_1_isActive_1",
      purpose: "Active teacher directory queries",
    },
  ],

  students: [
    {
      key: { centerId: 1, batch: 1 },
      name: "centerId_1_batch_1",
      purpose: "Batch student roster queries",
    },
    {
      key: { centerId: 1, assignedTeacherId: 1 },
      name: "centerId_1_assignedTeacherId_1",
      purpose: "Teacher student assignment queries",
    },
    {
      key: { centerId: 1, assignedTeacherId: 1, isActive: 1 },
      name: "centerId_1_assignedTeacherId_1_isActive_1",
      purpose: "Active student roster per assigned teacher",
    },
    {
      key: { centerId: 1, name: "text" },
      name: "centerId_1_name_text",
      purpose: "Full-text student search within center",
    },
  ],

  feecreationlocks: [
    {
      key: { lockKey: 1 },
      name: "lockKey_1_unique",
      unique: true,
      purpose: "Single-winner recurring fee generation mutex",
    },
    {
      key: { expiresAt: 1 },
      name: "expiresAt_1_ttl",
      expireAfterSeconds: 600,
      purpose: "10-minute TTL auto-expiration safety net",
    },
  ],

  importbatchlocks: [
    {
      key: { centerId: 1, previewId: 1 },
      name: "centerId_1_previewId_1_unique",
      unique: true,
      purpose: "Bulk student import preview concurrency lock",
    },
  ],

  admissionwelcomejobs: [
    {
      key: { idempotencyKey: 1 },
      name: "idempotencyKey_1_unique",
      unique: true,
      purpose: "Admission welcome job deduplication",
    },
    {
      key: { status: 1, nextRetryAt: 1, createdAt: 1 },
      name: "status_1_nextRetryAt_1_createdAt_1",
      purpose: "Background queue polling and retry scheduling",
    },
    {
      key: { centerId: 1, studentId: 1 },
      name: "centerId_1_studentId_1",
      purpose: "Student admission job lookup",
    },
    {
      key: { centerId: 1, isArchived: 1, createdAt: -1 },
      name: "centerId_1_isArchived_1_createdAt_-1",
      purpose: "Archived welcome job cleanup queries",
    },
  ],

  parentaccess: [
    {
      key: { centerId: 1, parentPhone: 1 },
      name: "centerId_1_parentPhone_1",
      purpose: "Parent portal phone lookup and authentication",
    },
    {
      key: { centerId: 1, linkedStudentIds: 1 },
      name: "centerId_1_linkedStudentIds_1",
      purpose: "Parent-to-child relationship lookup",
    },
    {
      key: { centerId: 1, status: 1 },
      name: "centerId_1_status_1",
      purpose: "Parent access status queries",
    },
    {
      key: { "pushSubscriptions.endpoint": 1 },
      name: "pushSubscriptions.endpoint_1",
      sparse: true,
      purpose: "Web Push subscription delivery lookup",
    },
  ],

  parentaccesslocks: [
    {
      key: { lockKey: 1 },
      name: "lockKey_1_unique",
      unique: true,
      purpose: "Parent access provisioning concurrency lock",
    },
    {
      key: { expiresAt: 1 },
      name: "expiresAt_1_ttl",
      expireAfterSeconds: 600,
      purpose: "10-minute TTL safety net for parent locks",
    },
  ],

  attendances: [
    {
      key: { centerId: 1, studentId: 1, date: 1 },
      name: "centerId_1_studentId_1_date_1",
      purpose: "Student daily attendance ledger lookup",
    },
    {
      key: { centerId: 1, batch: 1, date: 1 },
      name: "centerId_1_batch_1_date_1",
      purpose: "Batch daily attendance lookup",
    },
    {
      key: { centerId: 1, assignedTeacherId: 1, date: -1 },
      name: "centerId_1_assignedTeacherId_1_date_-1",
      purpose: "Teacher attendance history chronological",
    },
  ],

  batches: [
    {
      key: { centerId: 1, name: 1 },
      name: "centerId_1_name_1",
      purpose: "Multi-tenant batch name indexing",
    },
  ],

  centers: [
    {
      key: { centerId: 1 },
      name: "centerId_1_unique",
      unique: true,
      purpose: "Unique center partition identifier",
    },
  ],

  feereminderlogs: [
    {
      key: { feeId: 1, attemptedAt: -1 },
      name: "feeId_1_attemptedAt_-1",
      purpose: "Fee reminder history audit",
    },
    {
      key: { centerId: 1, attemptedAt: -1 },
      name: "centerId_1_attemptedAt_-1",
      purpose: "Center-wide reminder chronological audit",
    },
    {
      key: { centerId: 1, isArchived: 1, attemptedAt: -1 },
      name: "centerId_1_isArchived_1_attemptedAt_-1",
      purpose: "Active vs archived reminder logs",
    },
  ],

  messagecampaigns: [
    {
      key: { centerId: 1, status: 1 },
      name: "centerId_1_status_1",
      purpose: "Campaign status filtering",
    },
    {
      key: { centerId: 1, createdAt: -1 },
      name: "centerId_1_createdAt_-1",
      purpose: "Campaign chronological listing",
    },
    {
      key: { centerId: 1, isArchived: 1, createdAt: -1 },
      name: "centerId_1_isArchived_1_createdAt_-1",
      purpose: "Archived campaign queries",
    },
  ],

  tests: [
    {
      key: { centerId: 1, date: -1 },
      name: "centerId_1_date_-1",
      purpose: "Center exam list chronological",
    },
    {
      key: { centerId: 1, assignedTeacherId: 1, date: -1 },
      name: "centerId_1_assignedTeacherId_1_date_-1",
      purpose: "Teacher assigned test chronological",
    },
  ],

  baileys_auth: [
    {
      key: { centerId: 1, key: 1 },
      name: "centerId_1_key_1_unique",
      unique: true,
      purpose: "Multi-tenant WhatsApp credential and Signal key isolation",
    },
    {
      key: { centerId: 1 },
      name: "centerId_1",
      purpose: "WhatsApp session discovery per center",
    },
  ],
};

/**
 * Normalizes an index key object to string representation for accurate comparison.
 */
export function normalizeKey(keyObj) {
  if (!keyObj || typeof keyObj !== "object") return "";
  return Object.entries(keyObj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

/**
 * Compares declared index spec against existing MongoDB index doc.
 */
export function compareIndexSpecs(declaredSpec, existingDoc) {
  const declaredKeyStr = normalizeKey(declaredSpec.key);
  const existingKeyStr = normalizeKey(existingDoc.key);

  if (declaredKeyStr !== existingKeyStr) {
    return { matches: false, reason: "key_mismatch" };
  }

  // Check unique option
  const declaredUnique = Boolean(declaredSpec.unique);
  const existingUnique = Boolean(existingDoc.unique);
  if (declaredUnique !== existingUnique) {
    return {
      matches: false,
      reason: "option_mismatch",
      detail: `unique declared=${declaredUnique} existing=${existingUnique}`,
    };
  }

  // Check partialFilterExpression if specified
  if (declaredSpec.partialFilterExpression) {
    const declaredFilter = JSON.stringify(declaredSpec.partialFilterExpression);
    const existingFilter = JSON.stringify(existingDoc.partialFilterExpression || null);
    if (declaredFilter !== existingFilter) {
      return {
        matches: false,
        reason: "option_mismatch",
        detail: `partialFilterExpression declared=${declaredFilter} existing=${existingFilter}`,
      };
    }
  }

  return { matches: true };
}

/**
 * Inspects a collection for duplicate data that would prevent creating a unique index.
 *
 * @param {object} collection MongoDB collection object
 * @param {object} spec Expected index spec
 * @returns {Promise<{ hasDuplicates: boolean, duplicateCount: number, sampleDuplicates: any[] }>}
 */
export async function detectDuplicateData(collection, spec) {
  if (!spec.unique) {
    return { hasDuplicates: false, duplicateCount: 0, sampleDuplicates: [] };
  }

  try {
    const keyFields = Object.keys(spec.key);

    // Special handling for subdocument array paths like paymentHistory.idempotencyKey
    if (keyFields.some((k) => k.startsWith("paymentHistory."))) {
      const arrayField = "paymentHistory";
      const subField = "idempotencyKey";

      const pipeline = [
        { $unwind: `$${arrayField}` },
        {
          $match: {
            [`${arrayField}.${subField}`]: { $type: "string", $gt: "" },
          },
        },
        {
          $group: {
            _id: {
              centerId: "$centerId",
              idempotencyKey: `$${arrayField}.${subField}`,
            },
            count: { $sum: 1 },
            feeIds: { $push: "$_id" },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 10 },
      ];

      let duplicates = [];
      if (typeof collection.aggregate === "function") {
        const res = await collection.aggregate(pipeline);
        if (res && typeof res.toArray === "function") {
          duplicates = await res.toArray();
        } else if (Array.isArray(res)) {
          duplicates = res;
        }
      }

      return {
        hasDuplicates: duplicates.length > 0,
        duplicateCount: duplicates.length,
        sampleDuplicates: duplicates,
      };
    }

    // Standard group by unique keys
    const groupId = {};
    for (const f of keyFields) {
      groupId[f] = `$${f}`;
    }

    const matchStage = {};
    if (spec.partialFilterExpression) {
      Object.assign(matchStage, spec.partialFilterExpression);
    } else {
      // Exclude null/missing if unique allows single null, or include all
      for (const f of keyFields) {
        matchStage[f] = { $exists: true, $ne: null };
      }
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: groupId,
          count: { $sum: 1 },
          docIds: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ];

    let duplicates = [];
    if (typeof collection.aggregate === "function") {
      const res = await collection.aggregate(pipeline);
      if (res && typeof res.toArray === "function") {
        duplicates = await res.toArray();
      } else if (Array.isArray(res)) {
        duplicates = res;
      }
    }

    return {
      hasDuplicates: duplicates.length > 0,
      duplicateCount: duplicates.length,
      sampleDuplicates: duplicates,
    };
  } catch (err) {
    return {
      hasDuplicates: false,
      duplicateCount: 0,
      sampleDuplicates: [],
      error: err.message,
    };
  }
}

/**
 * Analyzes existing vs expected indexes across the catalog in a given database.
 */
export async function analyzeDatabaseIndexes(db, catalog = EXPECTED_INDEX_CATALOG) {
  const analysis = {
    totalCollections: Object.keys(catalog).length,
    totalExpectedIndexes: 0,
    existingCount: 0,
    missingCount: 0,
    conflictingCount: 0,
    duplicateBlockers: 0,
    collections: {},
  };

  for (const [colName, expectedSpecs] of Object.entries(catalog)) {
    analysis.totalExpectedIndexes += expectedSpecs.length;

    const colObj = db.collection(colName);
    let existingIndexes = [];
    try {
      if (typeof colObj.indexes === "function") {
        existingIndexes = await colObj.indexes();
      } else if (typeof colObj.listIndexes === "function") {
        const cursor = colObj.listIndexes();
        existingIndexes = typeof cursor.toArray === "function" ? await cursor.toArray() : await cursor;
      }
    } catch {
      existingIndexes = [];
    }

    const colReport = {
      collection: colName,
      existingIndexes: existingIndexes.map((idx) => ({ name: idx.name, key: idx.key, unique: Boolean(idx.unique) })),
      matched: [],
      missing: [],
      conflicts: [],
      duplicates: [],
    };

    for (const spec of expectedSpecs) {
      // Check if existing index matches
      const matchingIdx = existingIndexes.find(
        (existing) => normalizeKey(existing.key) === normalizeKey(spec.key)
      );

      if (!matchingIdx) {
        // Index is missing. Check if data contains duplicates that would block creation
        const dupResult = await detectDuplicateData(colObj, spec);
        if (dupResult.hasDuplicates) {
          analysis.duplicateBlockers++;
          colReport.duplicates.push({
            spec,
            duplicateCount: dupResult.duplicateCount,
            samples: dupResult.sampleDuplicates,
          });
        }
        colReport.missing.push(spec);
        analysis.missingCount++;
      } else {
        const comparison = compareIndexSpecs(spec, matchingIdx);
        if (comparison.matches) {
          colReport.matched.push({ spec, existing: matchingIdx });
          analysis.existingCount++;
        } else {
          colReport.conflicts.push({
            spec,
            existing: matchingIdx,
            reason: comparison.reason,
            detail: comparison.detail,
          });
          analysis.conflictingCount++;
        }
      }
    }

    analysis.collections[colName] = colReport;
  }

  return analysis;
}

/**
 * Plans migration actions and dry-run execution.
 */
export async function executeIndexMigration(db, options = {}) {
  const {
    apply = false,
    confirmStaging = false,
    allowDatabase = null,
    catalog = EXPECTED_INDEX_CATALOG,
  } = options;

  const dbName = db.databaseName || "";
  const isStaging = isApprovedStagingDatabase(dbName, allowDatabase);

  if (!isStaging) {
    throw new Error(
      `ABORT: Database '${dbName}' is NOT recognized as an approved isolated staging database. Index migration execution strictly prohibited on production or unverified targets.`
    );
  }

  const analysis = await analyzeDatabaseIndexes(db, catalog);

  if (!apply) {
    return {
      mode: "DRY_RUN",
      databaseName: dbName,
      applied: false,
      analysis,
      message: "Dry-run analysis completed successfully. Zero changes were written to the database.",
    };
  }

  // To apply, strict confirmation flags are required
  if (!confirmStaging) {
    throw new Error(
      "ABORT: Migration execution requires explicit confirmation flag '--confirm-staging-migration'."
    );
  }

  if (analysis.duplicateBlockers > 0) {
    throw new Error(
      `ABORT: Detected ${analysis.duplicateBlockers} unique index duplicate data blockers. Resolve data anomalies prior to applying indexes.`
    );
  }

  if (analysis.conflictingCount > 0) {
    throw new Error(
      `ABORT: Detected ${analysis.conflictingCount} index conflicts. Migration will never drop or alter indexes automatically.`
    );
  }

  // Execute creation of missing indexes
  const created = [];
  for (const [colName, colReport] of Object.entries(analysis.collections)) {
    const colObj = db.collection(colName);
    for (const spec of colReport.missing) {
      const indexOpts = { name: spec.name };
      if (spec.unique) indexOpts.unique = true;
      if (spec.partialFilterExpression) indexOpts.partialFilterExpression = spec.partialFilterExpression;
      if (spec.expireAfterSeconds !== undefined) indexOpts.expireAfterSeconds = spec.expireAfterSeconds;
      if (spec.sparse) indexOpts.sparse = true;

      await colObj.createIndex(spec.key, indexOpts);
      created.push({ collection: colName, spec });
    }
  }

  return {
    mode: "APPLIED",
    databaseName: dbName,
    applied: true,
    createdCount: created.length,
    created,
    analysis,
    message: `Successfully created ${created.length} missing indexes on database '${dbName}'.`,
  };
}

// -----------------------------------------------------------------------------
// CLI Runner
// -----------------------------------------------------------------------------
async function runCli() {
  const args = process.argv.slice(2);
  const isApply = args.includes("--apply");
  const isConfirm = args.includes("--confirm-staging-migration");
  const allowDbArg = args.find((a) => a.startsWith("--allow-database="));
  const allowDatabase = allowDbArg ? allowDbArg.split("=")[1].trim() : null;

  const rawUri = process.env.MONGODB_URI;
  if (!rawUri || !rawUri.trim()) {
    console.error("❌ ERROR: MONGODB_URI environment variable is required.");
    console.error("To run safely against an isolated staging environment, provide a staging URI:");
    console.error("  MONGODB_URI='mongodb://.../tuitiondesk_staging' node scripts/migrate-database-indexes.mjs");
    process.exit(1);
  }

  const targetUri = rawUri.trim();
  const dbName = extractDatabaseName(targetUri);

  console.log("===============================================================================");
  console.log(" TuitionDesk / MSEC: Database Index Migration Utility");
  console.log(` Target URI:     ${sanitizeMongoUri(targetUri)}`);
  console.log(` Target DB:      ${dbName || "[UNSPECIFIED]"}`);
  console.log(` Mode:           ${isApply ? "APPLY (LIVE EXECUTION)" : "DRY-RUN (READ ONLY)"}`);
  console.log("===============================================================================");

  if (!dbName) {
    console.error("❌ ERROR: Database name could not be resolved from MONGODB_URI.");
    process.exit(1);
  }

  if (!isApprovedStagingDatabase(dbName, allowDatabase)) {
    console.error(`❌ FATAL SAFETY VIOLATION: Target database '${dbName}' is NOT an approved staging database.`);
    console.error("To protect client production data, this script refuses to run against shared or unverified databases.");
    console.error("Approved database names must match: tuitiondesk_staging, msec_staging, *staging*, or *test*.");
    process.exit(1);
  }

  let connection = null;
  try {
    connection = await mongoose.connect(targetUri, {
      autoIndex: false,
      bufferCommands: false,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("Failed to access MongoDB database handle.");
    }

    const result = await executeIndexMigration(db, {
      apply: isApply,
      confirmStaging: isConfirm,
      allowDatabase,
    });

    console.log("\n📊 MIGRATION ANALYSIS REPORT:");
    console.log(`- Mode:               ${result.mode}`);
    console.log(`- Database:           ${result.databaseName}`);
    console.log(`- Total Collections:  ${result.analysis.totalCollections}`);
    console.log(`- Total Expected:     ${result.analysis.totalExpectedIndexes}`);
    console.log(`- Existing Matches:   ${result.analysis.existingCount}`);
    console.log(`- Missing Indexes:    ${result.analysis.missingCount}`);
    console.log(`- Conflicting Indexes:${result.analysis.conflictingCount}`);
    console.log(`- Duplicate Blockers: ${result.analysis.duplicateBlockers}`);

    if (result.analysis.missingCount > 0) {
      console.log("\n📋 Missing Indexes to Apply:");
      for (const [col, colReport] of Object.entries(result.analysis.collections)) {
        for (const missing of colReport.missing) {
          console.log(`  [+] ${col}.${missing.name}: ${JSON.stringify(missing.key)} (${missing.purpose})`);
        }
      }
    }

    if (result.analysis.duplicateBlockers > 0) {
      console.log("\n⚠️ DUPLICATE DATA DETECTED (MIGRATION BLOCKERS):");
      for (const [col, colReport] of Object.entries(result.analysis.collections)) {
        for (const dup of colReport.duplicates) {
          console.log(`  [!] ${col}: ${dup.duplicateCount} duplicates on key ${JSON.stringify(dup.spec.key)}`);
        }
      }
    }

    console.log(`\n✅ ${result.message}`);
  } catch (err) {
    console.error("\n❌ MIGRATION ERROR:", err.message);
    process.exit(1);
  } finally {
    if (connection) {
      await mongoose.disconnect().catch(() => {});
    }
  }
}

// Run CLI when executed directly
const isDirectCli = process.argv[1] && process.argv[1].endsWith("migrate-database-indexes.mjs");
if (isDirectCli) {
  runCli();
}
