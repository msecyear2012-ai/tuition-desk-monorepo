import mongoose from "mongoose";

/**
 * Definition of an expected index in the catalog.
 */
export interface ExpectedIndexSpec {
  key: Record<string, number | string>;
  name?: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
  sparse?: boolean;
  purpose: string;
  isLockIndex?: boolean;
}

/**
 * The Authoritative Index Catalog across all 16 TuitionDesk / MSEC Collections.
 * Sourced directly from Mongoose model schema declarations.
 */
export const REQUIRED_INDEX_INVENTORY: Record<string, ExpectedIndexSpec[]> = {
  fees: [
    {
      key: { centerId: 1, studentId: 1, month: 1 },
      name: "centerId_1_studentId_1_month_1",
      purpose: "Multi-tenant student monthly invoice lookup and invoice deduplication",
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
      partialFilterExpression: {
        "paymentHistory.idempotencyKey": { $type: "string", $gt: "" },
      },
      purpose: "Financial collection idempotency uniqueness per center",
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
      purpose: "Single-winner recurring fee generation distributed mutex",
      isLockIndex: true,
    },
    {
      key: { expiresAt: 1 },
      name: "expiresAt_1_ttl",
      expireAfterSeconds: 600,
      purpose: "10-minute TTL auto-expiration safety net for fee locks",
      isLockIndex: true,
    },
  ],

  importbatchlocks: [
    {
      key: { centerId: 1, previewId: 1 },
      name: "centerId_1_previewId_1_unique",
      unique: true,
      purpose: "Bulk student import preview concurrency lock",
      isLockIndex: true,
    },
  ],

  parentaccesslocks: [
    {
      key: { lockKey: 1 },
      name: "lockKey_1_unique",
      unique: true,
      purpose: "Parent access provisioning concurrency lock",
      isLockIndex: true,
    },
    {
      key: { expiresAt: 1 },
      name: "expiresAt_1_ttl",
      expireAfterSeconds: 600,
      purpose: "10-minute TTL safety net for parent locks",
      isLockIndex: true,
    },
  ],

  admissionwelcomejobs: [
    {
      key: { idempotencyKey: 1 },
      name: "idempotencyKey_1_unique",
      unique: true,
      purpose: "Admission welcome job deduplication",
      isLockIndex: true,
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

  parentaccesses: [
    {
      key: { tokenHash: 1 },
      name: "tokenHash_1_unique",
      unique: true,
      purpose: "Parent portal secure token hash lookup and deduplication",
    },
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
      purpose: "Unique center partition identifier across cluster",
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

  staffnotifications: [
    {
      key: { centerId: 1, recipientRole: 1, createdAt: -1 },
      name: "centerId_1_recipientRole_1_createdAt_-1",
      purpose: "Role-scoped staff notification chronological retrieval",
    },
    {
      key: { centerId: 1, recipientId: 1, createdAt: -1 },
      name: "centerId_1_recipientId_1_createdAt_-1",
      purpose: "User notification inbox chronological query",
    },
    {
      key: { centerId: 1, recipientId: 1, isRead: 1, createdAt: -1 },
      name: "centerId_1_recipientId_1_isRead_1_createdAt_-1",
      purpose: "Unread notification badge count and filtering",
    },
    {
      key: { centerId: 1, recipientId: 1, isDismissed: 1, createdAt: -1 },
      name: "centerId_1_recipientId_1_isDismissed_1_createdAt_-1",
      purpose: "Dismissed notification filtering in center view",
    },
    {
      key: { centerId: 1, category: 1, createdAt: -1 },
      name: "centerId_1_category_1_createdAt_-1",
      purpose: "Category filtering (academic, financial, handover, system)",
    },
    {
      key: { idempotencyKey: 1 },
      name: "idempotencyKey_1",
      sparse: true,
      purpose: "Staff notification idempotency and deduplication",
    },
  ],

  userpushsubscriptions: [
    {
      key: { endpoint: 1 },
      name: "endpoint_1_unique",
      unique: true,
      purpose: "Web Push browser endpoint uniqueness and lookup",
    },
    {
      key: { centerId: 1, userId: 1 },
      name: "centerId_1_userId_1",
      purpose: "Staff user Web Push subscription lookup",
    },
    {
      key: { centerId: 1, userRole: 1 },
      name: "centerId_1_userRole_1",
      purpose: "Role-scoped Web Push notification dispatch",
    },
  ],

  paymentproofs: [
    {
      key: { feeId: 1, createdAt: -1 },
      name: "feeId_1_createdAt_-1",
      purpose: "Fee invoice payment screenshot audit",
    },
    {
      key: { centerId: 1, status: 1 },
      name: "centerId_1_status_1",
      purpose: "Center pending payment verification queue",
    },
    {
      key: { studentId: 1, feeId: 1 },
      name: "studentId_1_feeId_1",
      purpose: "Student fee payment proof reconciliation",
    },
  ],

  studentbatchrequests: [
    {
      key: { centerId: 1, status: 1 },
      name: "centerId_1_status_1",
      purpose: "Batch change request status filtering",
    },
    {
      key: { centerId: 1, requesterId: 1, status: 1 },
      name: "centerId_1_requesterId_1_status_1",
      purpose: "Teacher batch request submission queries",
    },
    {
      key: { centerId: 1, createdAt: -1 },
      name: "centerId_1_createdAt_-1",
      purpose: "Chronological student batch request listing",
    },
    {
      key: { centerId: 1, studentId: 1 },
      name: "centerId_1_studentId_1_unique_pending",
      unique: true,
      partialFilterExpression: { status: "pending" },
      purpose: "Prevents duplicate active/pending batch requests for same student",
    },
  ],
};

/**
 * Normalizes an index key object to string representation for accurate comparison.
 * Preserves exact key order.
 */
export function normalizeKey(keyObj: Record<string, unknown> | undefined): string {
  if (!keyObj || typeof keyObj !== "object") return "";
  return Object.entries(keyObj)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

/**
 * Checks whether two partial filter expressions are equivalent.
 */
export function arePartialFiltersEqual(
  expected?: Record<string, unknown>,
  actual?: Record<string, unknown>
): boolean {
  if (!expected && !actual) return true;
  if (!expected || !actual) return false;
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export interface IndexComparisonResult {
  match: boolean;
  reasons: string[];
}

/**
 * Compares an expected index specification with an actual existing MongoDB index specification.
 */
export function compareIndexSpecs(
  expected: ExpectedIndexSpec,
  actual: any
): IndexComparisonResult {
  const reasons: string[] = [];

  if (!actual) {
    return { match: false, reasons: ["Index does not exist on collection"] };
  }

  // 1. Compare normalized key order and sort direction
  const expectedKeyNorm = normalizeKey(expected.key);
  const actualKeyNorm = normalizeKey(actual.key);

  if (expectedKeyNorm !== actualKeyNorm) {
    reasons.push(
      `Key pattern mismatch: expected { ${expectedKeyNorm} }, found { ${actualKeyNorm} }`
    );
  }

  // 2. Compare uniqueness
  const expectedUnique = Boolean(expected.unique);
  const actualUnique = Boolean(actual.unique);
  if (expectedUnique !== actualUnique) {
    reasons.push(
      `Uniqueness mismatch: expected unique=${expectedUnique}, found unique=${actualUnique}`
    );
  }

  // 3. Compare TTL (expireAfterSeconds)
  if (typeof expected.expireAfterSeconds === "number") {
    if (actual.expireAfterSeconds !== expected.expireAfterSeconds) {
      reasons.push(
        `TTL expireAfterSeconds mismatch: expected ${expected.expireAfterSeconds}, found ${actual.expireAfterSeconds}`
      );
    }
  } else if (typeof actual.expireAfterSeconds === "number") {
    reasons.push(
      `Unexpected TTL expireAfterSeconds: found ${actual.expireAfterSeconds}, but none expected`
    );
  }

  // 4. Compare partialFilterExpression
  if (expected.partialFilterExpression) {
    if (
      !actual.partialFilterExpression ||
      !arePartialFiltersEqual(
        expected.partialFilterExpression,
        actual.partialFilterExpression
      )
    ) {
      reasons.push(
        `partialFilterExpression mismatch: expected ${JSON.stringify(
          expected.partialFilterExpression
        )}, found ${JSON.stringify(actual.partialFilterExpression)}`
      );
    }
  } else if (actual.partialFilterExpression) {
    reasons.push(
      `Unexpected partialFilterExpression: found ${JSON.stringify(
        actual.partialFilterExpression
      )}, but none expected`
    );
  }

  // 5. Compare sparse
  if (Boolean(expected.sparse) !== Boolean(actual.sparse)) {
    reasons.push(
      `Sparse mismatch: expected sparse=${Boolean(
        expected.sparse
      )}, found sparse=${Boolean(actual.sparse)}`
    );
  }

  return {
    match: reasons.length === 0,
    reasons,
  };
}

export interface DuplicateCheckResult {
  hasDuplicates: boolean;
  duplicateCount: number;
  sampleDuplicates: Array<{ key: unknown; count: number }>;
}

/**
 * Detects whether any records violate the uniqueness constraint of a required unique index.
 * NEVER mutates, deletes, or alters data. Pure read-only aggregation.
 */
export async function detectDuplicateRecords(
  db: any,
  collectionName: string,
  spec: ExpectedIndexSpec
): Promise<DuplicateCheckResult> {
  if (!spec.unique) {
    return { hasDuplicates: false, duplicateCount: 0, sampleDuplicates: [] };
  }

  const collection = typeof db.collection === "function" ? db.collection(collectionName) : null;
  if (!collection) {
    return { hasDuplicates: false, duplicateCount: 0, sampleDuplicates: [] };
  }

  try {
    const pipeline: any[] = [];

    // Apply partial filter expression if present
    if (spec.partialFilterExpression) {
      pipeline.push({ $match: spec.partialFilterExpression });
    }

    // Build group key based on index key fields
    const groupKey: Record<string, string> = {};
    const keyFields = Object.keys(spec.key);

    // If subdocument multikey array (e.g. "paymentHistory.idempotencyKey")
    const hasArraySubdoc = keyFields.some((k) => k.startsWith("paymentHistory."));
    if (hasArraySubdoc && collectionName === "fees") {
      pipeline.push({ $unwind: "$paymentHistory" });
      if (spec.partialFilterExpression) {
        pipeline.push({ $match: spec.partialFilterExpression });
      }
    }

    for (const field of keyFields) {
      const safeAlias = field.replace(/\./g, "_");
      groupKey[safeAlias] = `$${field}`;
    }

    pipeline.push({
      $group: {
        _id: groupKey,
        count: { $sum: 1 },
      },
    });

    pipeline.push({
      $match: {
        count: { $gt: 1 },
      },
    });

    pipeline.push({ $limit: 10 });

    let duplicates: any[] = [];
    if (typeof collection.aggregate === "function") {
      const rawCursor = collection.aggregate(pipeline);
      const cursor = rawCursor && typeof rawCursor.then === "function" ? await rawCursor : rawCursor;
      duplicates =
        cursor && typeof cursor.toArray === "function" ? await cursor.toArray() : Array.isArray(cursor) ? cursor : [];
    }

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      return {
        hasDuplicates: true,
        duplicateCount: duplicates.length,
        sampleDuplicates: duplicates.map((d) => ({
          key: d._id,
          count: d.count,
        })),
      };
    }
  } catch (err) {
    // If collection does not exist yet (fresh DB), no duplicates exist
    return { hasDuplicates: false, duplicateCount: 0, sampleDuplicates: [] };
  }

  return { hasDuplicates: false, duplicateCount: 0, sampleDuplicates: [] };
}

export type IndexStatus = "VERIFIED" | "MISSING" | "CONFLICT";

export interface VerifiedIndexItem {
  collection: string;
  expected: ExpectedIndexSpec;
  status: IndexStatus;
  actualName?: string;
  actualKey?: Record<string, unknown>;
  reasons: string[];
}

export interface DatabaseIndexVerificationReport {
  timestamp: string;
  databaseName: string;
  isHealthy: boolean;
  criticalLocksVerified: boolean;
  totalRequired: number;
  verifiedCount: number;
  missingCount: number;
  conflictCount: number;
  resultsByCollection: Record<string, VerifiedIndexItem[]>;
  summary: {
    missing: string[];
    conflicts: string[];
    criticalLocksMissing: string[];
  };
}

/**
 * Audits all 16 collections against the required index catalog.
 * Read-only; executes zero index modifications or database writes.
 */
export async function verifyDatabaseIndexes(
  db: any
): Promise<DatabaseIndexVerificationReport> {
  const databaseName = db?.databaseName || "unknown";
  const resultsByCollection: Record<string, VerifiedIndexItem[]> = {};

  let totalRequired = 0;
  let verifiedCount = 0;
  let missingCount = 0;
  let conflictCount = 0;

  const missingList: string[] = [];
  const conflictList: string[] = [];
  const criticalLocksMissing: string[] = [];

  for (const [collectionName, specs] of Object.entries(REQUIRED_INDEX_INVENTORY)) {
    resultsByCollection[collectionName] = [];

    let existingIndexes: any[] = [];
    try {
      const collection = typeof db.collection === "function" ? db.collection(collectionName) : null;
      if (collection) {
        if (typeof collection.indexes === "function") {
          existingIndexes = await collection.indexes();
        } else if (typeof collection.listIndexes === "function") {
          const cursor = collection.listIndexes();
          existingIndexes =
            typeof cursor.toArray === "function" ? await cursor.toArray() : await cursor;
        }
      }
    } catch {
      // Collection does not exist yet (empty fresh database)
      existingIndexes = [];
    }

    if (!Array.isArray(existingIndexes)) {
      existingIndexes = [];
    }

    for (const spec of specs) {
      totalRequired++;
      const expectedNorm = normalizeKey(spec.key);

      // Match against existing index by key normalization
      const matchingExisting = existingIndexes.find(
        (idx) => normalizeKey(idx.key) === expectedNorm
      );

      if (!matchingExisting) {
        missingCount++;
        const item: VerifiedIndexItem = {
          collection: collectionName,
          expected: spec,
          status: "MISSING",
          reasons: ["Index does not exist on collection"],
        };
        resultsByCollection[collectionName].push(item);
        missingList.push(`${collectionName} -> { ${expectedNorm} }`);

        if (spec.isLockIndex) {
          criticalLocksMissing.push(`${collectionName} -> { ${expectedNorm} }`);
        }
      } else {
        const comp = compareIndexSpecs(spec, matchingExisting);
        if (comp.match) {
          verifiedCount++;
          resultsByCollection[collectionName].push({
            collection: collectionName,
            expected: spec,
            status: "VERIFIED",
            actualName: matchingExisting.name,
            actualKey: matchingExisting.key,
            reasons: [],
          });
        } else {
          conflictCount++;
          resultsByCollection[collectionName].push({
            collection: collectionName,
            expected: spec,
            status: "CONFLICT",
            actualName: matchingExisting.name,
            actualKey: matchingExisting.key,
            reasons: comp.reasons,
          });
          conflictList.push(
            `${collectionName} -> { ${expectedNorm} } [${comp.reasons.join("; ")}]`
          );

          if (spec.isLockIndex) {
            criticalLocksMissing.push(
              `${collectionName} -> { ${expectedNorm} } (CONFLICT)`
            );
          }
        }
      }
    }
  }

  const isHealthy = missingCount === 0 && conflictCount === 0;
  const criticalLocksVerified = criticalLocksMissing.length === 0;

  return {
    timestamp: new Date().toISOString(),
    databaseName,
    isHealthy,
    criticalLocksVerified,
    totalRequired,
    verifiedCount,
    missingCount,
    conflictCount,
    resultsByCollection,
    summary: {
      missing: missingList,
      conflicts: conflictList,
      criticalLocksMissing,
    },
  };
}

export interface IndexInitOptions {
  dryRun?: boolean;
  collections?: string[];
  logger?: (msg: string) => void;
}

export interface IndexInitResult {
  timestamp: string;
  databaseName: string;
  dryRun: boolean;
  success: boolean;
  createdCount: number;
  skippedCount: number;
  conflictCount: number;
  duplicateBlockedCount: number;
  details: Array<{
    collection: string;
    key: Record<string, unknown>;
    action: "CREATED" | "SKIPPED_ALREADY_VERIFIED" | "BLOCKED_DUPLICATES" | "CONFLICT_MANUAL_REVIEW";
    message: string;
  }>;
}

/**
 * Idempotently initializes database indexes across all 16 collections.
 *
 * Operational Safeguards:
 * 1. Strictly Idempotent: Verified existing indexes are skipped without alteration.
 * 2. Preflight Duplicate Checks: Scans for duplicate records before creating unique indexes.
 * 3. Never deletes, alters, or merges existing records to force index creation.
 * 4. Never drops conflicting indexes automatically without explicit manual migration.
 * 5. Handles fresh database provisioning seamlessly (creates collections on demand).
 */
export async function initializeDatabaseIndexes(
  db: any,
  options: IndexInitOptions = {}
): Promise<IndexInitResult> {
  const dryRun = Boolean(options.dryRun);
  const log = options.logger || console.log;
  const databaseName = db?.databaseName || "unknown";

  log(
    `[INDEX MANAGER] Starting ${dryRun ? "DRY-RUN" : "LIVE"} index initialization for database '${databaseName}'...`
  );

  // 1. Initial verification audit
  const preAudit = await verifyDatabaseIndexes(db);
  const targetCollections =
    options.collections && options.collections.length > 0
      ? options.collections
      : Object.keys(REQUIRED_INDEX_INVENTORY);

  const details: IndexInitResult["details"] = [];
  let createdCount = 0;
  let skippedCount = 0;
  let conflictCount = 0;
  let duplicateBlockedCount = 0;

  for (const collectionName of targetCollections) {
    const specs = REQUIRED_INDEX_INVENTORY[collectionName];
    if (!specs) continue;

    const collectionResults = preAudit.resultsByCollection[collectionName] || [];

    for (const spec of specs) {
      const normKey = normalizeKey(spec.key);
      const auditItem = collectionResults.find(
        (r) => normalizeKey(r.expected.key) === normKey
      );

      // A. Already verified -> Skip (idempotent no-op)
      if (auditItem?.status === "VERIFIED") {
        skippedCount++;
        details.push({
          collection: collectionName,
          key: spec.key,
          action: "SKIPPED_ALREADY_VERIFIED",
          message: `Index on { ${normKey} } already verified.`,
        });
        continue;
      }

      // B. Conflict detected -> Flag for manual review; never auto-drop
      if (auditItem?.status === "CONFLICT") {
        conflictCount++;
        const conflictMsg = `Conflict on { ${normKey} }: ${auditItem.reasons.join(", ")}. Requires manual review.`;
        log(`[INDEX CONFLICT] ${collectionName}: ${conflictMsg}`);
        details.push({
          collection: collectionName,
          key: spec.key,
          action: "CONFLICT_MANUAL_REVIEW",
          message: conflictMsg,
        });
        continue;
      }

      // C. Missing -> Preflight duplicate check before creating unique index
      if (spec.unique) {
        const dupCheck = await detectDuplicateRecords(db, collectionName, spec);
        if (dupCheck.hasDuplicates) {
          duplicateBlockedCount++;
          const blockMsg = `Blocked unique index on { ${normKey} }: Found ${dupCheck.duplicateCount} duplicate group(s). Never modifying records automatically.`;
          log(`[INDEX BLOCKED] ${collectionName}: ${blockMsg}`);
          details.push({
            collection: collectionName,
            key: spec.key,
            action: "BLOCKED_DUPLICATES",
            message: blockMsg,
          });
          continue;
        }
      }

      // D. Apply creation
      if (dryRun) {
        createdCount++;
        details.push({
          collection: collectionName,
          key: spec.key,
          action: "CREATED",
          message: `[DRY-RUN] Would create index on { ${normKey} }.`,
        });
        continue;
      }

      try {
        const collection = db.collection(collectionName);
        const indexOpts: Record<string, unknown> = {
          background: true,
        };

        if (spec.name) indexOpts.name = spec.name;
        if (spec.unique) indexOpts.unique = true;
        if (typeof spec.expireAfterSeconds === "number") {
          indexOpts.expireAfterSeconds = spec.expireAfterSeconds;
        }
        if (spec.partialFilterExpression) {
          indexOpts.partialFilterExpression = spec.partialFilterExpression;
        }
        if (spec.sparse) indexOpts.sparse = true;

        await collection.createIndex(spec.key, indexOpts);
        createdCount++;
        log(`[INDEX CREATED] ${collectionName} -> { ${normKey} }`);
        details.push({
          collection: collectionName,
          key: spec.key,
          action: "CREATED",
          message: `Successfully created index on { ${normKey} }.`,
        });
      } catch (createErr: any) {
        log(`[INDEX ERROR] Failed to create ${collectionName} index { ${normKey} }: ${createErr?.message}`);
        throw createErr;
      }
    }
  }

  const success = conflictCount === 0 && duplicateBlockedCount === 0;

  return {
    timestamp: new Date().toISOString(),
    databaseName,
    dryRun,
    success,
    createdCount,
    skippedCount,
    conflictCount,
    duplicateBlockedCount,
    details,
  };
}
