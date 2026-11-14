/**
 * MSEC — Execute Approved ImportBatchLock Unique Index Migration
 *
 * Target:
 *   Database:   Explicitly confirmed via --expected-db=<dbname> or EXPECTED_DB_NAME
 *   Collection: importbatchlocks
 *
 * Index to apply:
 *   Keys:    { centerId: 1, previewId: 1 }
 *   Options: { unique: true, name: "centerId_1_previewId_1" }
 *
 * SAFETY GUARANTEES:
 * - Requires explicit database confirmation via CLI flag (--expected-db) or env var.
 * - Cross-validates connection URI and active database instance.
 * - Scans existing documents for duplicate { centerId, previewId } before creating index.
 * - Stops immediately if any duplicate combinations exist (zero document mutations).
 * - Confirms index creation with listIndexes() and verifyImportLockIndexIntegrity().
 * - Sanitizes all connection strings and logs (zero secrets).
 */

import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { sanitizeMongoUri } from "../src/lib/reconciliationEngine.ts";
import {
  resolveMigrationTargetDatabase,
  verifyConnectedDatabaseName,
} from "../src/lib/migrationTargetHelper.ts";
import { verifyImportLockIndexIntegrity, ImportBatchLock } from "../src/models/ImportBatchLock.ts";

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
    console.error("  npx tsx scripts/apply-import-batch-lock-index.ts --expected-db=<target_database_name>");
    process.exit(1);
  }

  console.log("===============================================================================");
  console.log(" MSEC ImportBatchLock Unique Index Provisioning");
  console.log(` TARGET: Database '${target.expectedDbName}', Collection 'importbatchlocks'`);
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
    console.log(`\n[STEP 1] Active Database Name: '${activeDbName}'`);
    verifyConnectedDatabaseName(activeDbName, target.expectedDbName);

    const collectionName = "importbatchlocks";
    console.log(`[STEP 1b] Target Collection: '${collectionName}'`);
    const collection = db.collection(collectionName);

    // Step 2: Inspect existing indexes
    console.log("\n[STEP 2] Inspecting existing indexes on 'importbatchlocks'...");
    const existingIndexesBefore = await collection.indexes();
    console.log("Existing indexes:", JSON.stringify(existingIndexesBefore, null, 2));

    // Step 3: Check for duplicate { centerId, previewId } combinations
    console.log("\n[STEP 3] Scanning for duplicate { centerId, previewId } combinations...");
    const docCount = await collection.countDocuments();
    console.log(`Total documents currently in 'importbatchlocks': ${docCount}`);

    const duplicates = await collection
      .aggregate([
        {
          $group: {
            _id: { centerId: "$centerId", previewId: "$previewId" },
            count: { $sum: 1 },
            docs: { $push: { _id: "$_id", status: "$status", createdAt: "$createdAt" } },
          },
        },
        {
          $match: {
            count: { $gt: 1 },
          },
        },
      ])
      .toArray();

    if (duplicates.length > 0) {
      console.error("\n🛑 STOP: Duplicate { centerId, previewId } combinations detected!");
      console.error(JSON.stringify(duplicates, null, 2));
      throw new Error("Aborting index creation due to duplicate keys. Zero documents were modified.");
    }

    console.log("✔ Zero duplicate combinations found. Safe to apply unique index.");

    // Step 4: Check if index already exists
    const existingIndex = existingIndexesBefore.find(
      (idx) =>
        idx.name === "centerId_1_previewId_1" ||
        (idx.key && idx.key.centerId === 1 && idx.key.previewId === 1)
    );

    if (existingIndex) {
      console.log(`\nℹ Index 'centerId_1_previewId_1' already exists:`, JSON.stringify(existingIndex, null, 2));
      if (!existingIndex.unique) {
        throw new Error("Existing index is NOT unique! Manual intervention required.");
      }
    } else {
      console.log("\n[STEP 4] Creating unique compound index on { centerId: 1, previewId: 1 }...");
      const createResult = await collection.createIndex(
        { centerId: 1, previewId: 1 },
        { unique: true, name: "centerId_1_previewId_1" }
      );
      console.log(`✔ Index created successfully: '${createResult}'`);
    }

    // Step 5: Read back and verify index definition and uniqueness
    console.log("\n[STEP 5] Reading back verified indexes...");
    const verifiedIndexes = await collection.indexes();
    console.log("Verified indexes:", JSON.stringify(verifiedIndexes, null, 2));

    const targetIdx = verifiedIndexes.find((idx) => idx.name === "centerId_1_previewId_1");
    if (!targetIdx) {
      throw new Error("Verification failed: Index 'centerId_1_previewId_1' not found in collection.indexes().");
    }
    if (targetIdx.unique !== true) {
      throw new Error("Verification failed: Index 'centerId_1_previewId_1' unique flag is not true.");
    }
    if (!targetIdx.key || targetIdx.key.centerId !== 1 || targetIdx.key.previewId !== 1) {
      throw new Error("Verification failed: Index key definition mismatch.");
    }

    console.log("\n[STEP 5b] Verifying via application helper verifyImportLockIndexIntegrity()...");
    const hasAppIntegrity = await verifyImportLockIndexIntegrity(ImportBatchLock);
    console.log(`verifyImportLockIndexIntegrity: ${hasAppIntegrity}`);
    if (!hasAppIntegrity) {
      throw new Error("Application helper verifyImportLockIndexIntegrity returned false!");
    }

    console.log("\n===============================================================================");
    console.log(`✔ SUCCESS: Unique index 'centerId_1_previewId_1' verified on '${target.expectedDbName}.importbatchlocks'`);
    console.log("===============================================================================");
  } finally {
    if (connection) {
      await mongoose.disconnect();
      console.log("✔ Disconnected cleanly from database.");
    }
  }
}

main().catch((err) => {
  console.error("\n❌ FATAL INDEX MIGRATION ERROR:", err.message);
  process.exit(1);
});
