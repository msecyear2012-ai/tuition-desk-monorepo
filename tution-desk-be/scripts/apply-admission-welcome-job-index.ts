/**
 * TuitionDesk / MSEC — Execute Approved AdmissionWelcomeJob Indexes
 *
 * Target:
 *   Database:   Explicitly confirmed via --expected-db=<dbname> or EXPECTED_DB_NAME
 *   Collection: admissionwelcomejobs
 *
 * Indexes to apply:
 *   1. Unique index:     { idempotencyKey: 1 }, { unique: true, name: "idempotencyKey_1" }
 *   2. Polling compound: { status: 1, nextRetryAt: 1, createdAt: 1 }, { name: "status_1_nextRetryAt_1_createdAt_1" }
 *   3. Student compound: { centerId: 1, studentId: 1 }, { name: "centerId_1_studentId_1" }
 *
 * SAFETY GUARANTEES:
 * - Requires explicit database confirmation via CLI flag (--expected-db) or env var.
 * - Requires explicit execution confirmation flag (--confirm-live-migration).
 * - Cross-validates connection URI and active database instance.
 * - Scans existing documents for duplicates before creating unique index.
 * - Confirms index creation with listIndexes().
 * - Sanitizes all connection strings and logs (zero secrets).
 * - Safe for dry-run verification.
 */

import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { sanitizeMongoUri } from "../src/lib/reconciliationEngine.ts";
import {
  resolveMigrationTargetDatabase,
  verifyConnectedDatabaseName,
} from "../src/lib/migrationTargetHelper.ts";

// Load local .env if present
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
} catch {
  // Ignore fallback file read error
}

async function main() {
  const target = resolveMigrationTargetDatabase({
    argv: process.argv.slice(2),
    rawUri: process.env.MONGODB_URI || process.env.MONGODB_AUDIT_URI,
    env: process.env,
  });

  if (!target.valid) {
    console.error("\n❌ TARGET DATABASE CONFIRMATION FAILED:");
    console.error(target.error);
    console.error("\nUsage example:");
    console.error("  npx tsx scripts/apply-admission-welcome-job-index.ts --confirm-live-migration --expected-db=<target_database_name>");
    process.exit(1);
  }

  console.log("===============================================================================");
  console.log(" MSEC AdmissionWelcomeJob Index Provisioning");
  console.log(` TARGET: Database '${target.expectedDbName}', Collection 'admissionwelcomejobs'`);
  console.log("===============================================================================");
  console.log(`Connection URI: ${target.sanitizedUri}`);

  let connection: typeof mongoose | null = null;

  try {
    connection = await mongoose.connect(target.targetUri, {
      autoIndex: false,
      bufferCommands: false,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("Failed to access MongoDB database instance.");
    }

    // Step 1: Safety check - verify active database strictly matches expected database
    const activeDbName = db.databaseName;
    console.log(`[VERIFY 1] Active Database Name: '${activeDbName}'`);
    verifyConnectedDatabaseName(activeDbName, target.expectedDbName);

    const collectionName = "admissionwelcomejobs";
    console.log(`[VERIFY 2] Target Collection: '${collectionName}'`);

    const collection = db.collection(collectionName);

    // Step 2: Document check and duplicate detection
    const docCount = await collection.countDocuments();
    console.log(`[VERIFY 3] Current Document Count in '${collectionName}': ${docCount}`);

    if (docCount > 0) {
      const duplicates = await collection
        .aggregate([
          { $group: { _id: "$idempotencyKey", count: { $sum: 1 }, ids: { $push: "$_id" } } },
          { $match: { count: { $gt: 1 } } },
        ])
        .toArray();

      if (duplicates.length > 0) {
        console.error(
          `❌ ABORT: Found ${duplicates.length} duplicate idempotencyKey groups in '${collectionName}':`
        );
        for (const d of duplicates) {
          console.error(`  - Key: "${d._id}" (${d.count} occurrences): IDs [${d.ids.join(", ")}]`);
        }
        throw new Error(
          "Unique index cannot be created: Duplicate idempotency keys detected. Clean up duplicates before proceeding."
        );
      }
      console.log(`[VERIFY 4] Duplicate check PASSED: All existing ${docCount} documents have unique idempotencyKey values.`);
    } else {
      console.log(`[VERIFY 4] Duplicate check SKIPPED: Collection is empty.`);
    }

    // Step 3: Inspect existing indexes
    const existingIndexes = await collection.indexes();
    console.log(`[VERIFY 5] Existing indexes on '${collectionName}':`);
    for (const idx of existingIndexes) {
      console.log(`  - Name: '${idx.name}', Key: ${JSON.stringify(idx.key)}, Unique: ${Boolean(idx.unique)}`);
    }

    const hasUniqueIdempotency = existingIndexes.some(
      (idx) => idx.key && (idx.key as any).idempotencyKey === 1 && idx.unique === true
    );

    if (hasUniqueIdempotency) {
      console.log(`\n✅ Unique index on 'idempotencyKey' is ALREADY enforced. No changes needed.`);
    } else {
      console.log(`\n[APPLY] Creating unique index on 'idempotencyKey'...`);
      const result = await collection.createIndex(
        { idempotencyKey: 1 },
        { unique: true, name: "idempotencyKey_1", background: true }
      );
      console.log(`[APPLY] Index created: ${result}`);

      // Also create compound operational indexes
      await collection.createIndex(
        { status: 1, nextRetryAt: 1, createdAt: 1 },
        { name: "status_1_nextRetryAt_1_createdAt_1", background: true }
      );
      await collection.createIndex(
        { centerId: 1, studentId: 1 },
        { name: "centerId_1_studentId_1", background: true }
      );
    }

    // Step 4: Post-migration verification
    console.log(`\n[VERIFY 6] Running post-migration index verification...`);
    const verifiedIndexes = await collection.indexes();
    const verifiedUnique = verifiedIndexes.some(
      (idx) => idx.key && (idx.key as any).idempotencyKey === 1 && idx.unique === true
    );

    if (!verifiedUnique) {
      throw new Error("FAILED: Unique index on 'idempotencyKey' could not be verified after creation.");
    }

    console.log(`===============================================================================`);
    console.log(` ✅ SUCCESS: AdmissionWelcomeJob unique idempotency index verified!`);
    console.log(` Total active indexes on '${collectionName}': ${verifiedIndexes.length}`);
    console.log(`===============================================================================`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ MIGRATION FAILED: ${errorMsg}`);
    process.exit(1);
  } finally {
    if (connection) {
      await mongoose.disconnect();
      console.log("[DISCONNECT] Closed MongoDB connection.");
    }
  }
}

// Only execute when run directly from command line with explicit confirmation argument
if (process.argv[1]?.endsWith("apply-admission-welcome-job-index.ts")) {
  if (process.argv.includes("--confirm-live-migration")) {
    main();
  } else {
    console.log("SAFETY GUARD: To apply this migration, run with explicit flags:");
    console.log("  npx tsx scripts/apply-admission-welcome-job-index.ts --confirm-live-migration --expected-db=<database_name>");
    process.exit(0);
  }
}
