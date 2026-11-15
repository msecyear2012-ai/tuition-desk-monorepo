#!/usr/bin/env node
/**
 * TuitionDesk / MSEC — Production & Staging Centralized Database Index Management CLI
 *
 * Operational Capabilities:
 *   1. Full catalog audit across all 16 collections against canonical inventory.
 *   2. Strict Dry-Run Mode support (--dry-run).
 *   3. Preflight duplicate record detection before unique index creation.
 *   4. Zero silent record alterations or deletions.
 *   5. Never drops existing indexes automatically without manual review.
 *   6. Supports fresh database provisioning and existing cluster upgrades.
 *   7. Database target verification (--expected-db=<dbname>) to prevent accidental target execution.
 *
 * Usage:
 *   npx tsx scripts/manage-indexes.ts --verify --expected-db=<dbname>
 *   npx tsx scripts/manage-indexes.ts --apply --dry-run --expected-db=<dbname>
 *   npx tsx scripts/manage-indexes.ts --apply --expected-db=<dbname>
 */

import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import {
  resolveMigrationTargetDatabase,
  verifyConnectedDatabaseName,
} from "../src/lib/migrationTargetHelper.ts";
import {
  REQUIRED_INDEX_INVENTORY,
  verifyDatabaseIndexes,
  initializeDatabaseIndexes,
  type DatabaseIndexVerificationReport,
  type IndexInitResult,
} from "../src/lib/indexManager.ts";

// Automatically load local .env if present
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
  const args = process.argv.slice(2);
  const isVerifyOnly = args.includes("--verify") || args.includes("--check") || (!args.includes("--apply") && !args.includes("--init"));
  const isDryRun = args.includes("--dry-run");
  const isApply = (args.includes("--apply") || args.includes("--init")) && !isDryRun;

  const target = resolveMigrationTargetDatabase({
    argv: args,
    rawUri: process.env.MONGODB_URI || process.env.MONGODB_AUDIT_URI,
    env: process.env,
  });

  if (!target.valid) {
    console.error("\n❌ TARGET DATABASE CONFIRMATION FAILED:");
    console.error(target.error);
    console.error("\nUsage example:");
    console.error("  npx tsx scripts/manage-indexes.ts --verify --expected-db=<target_database_name>");
    console.error("  npx tsx scripts/manage-indexes.ts --apply --dry-run --expected-db=<target_database_name>");
    console.error("  npx tsx scripts/manage-indexes.ts --apply --expected-db=<target_database_name>");
    process.exit(1);
  }

  console.log("===============================================================================");
  console.log(" TuitionDesk / MSEC Centralized Database Index Management");
  console.log(` Target Database: '${target.expectedDbName}'`);
  console.log(` Mode: ${isVerifyOnly ? "VERIFY (Read-Only Audit)" : isDryRun ? "APPLY (Dry-Run Preview)" : "APPLY (Execute Idempotent Index Provisioning)"}`);
  console.log(` Target URI:     ${target.sanitizedUri}`);
  console.log("===============================================================================");

  let connection: typeof mongoose | null = null;

  try {
    connection = await mongoose.connect(target.targetUri, {
      autoIndex: false,
      bufferCommands: false,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("Failed to access MongoDB database instance.");
    }

    const activeDbName = db.databaseName;
    verifyConnectedDatabaseName(activeDbName, target.expectedDbName);
    console.log(`\n[CONNECTION OK] Connected to active database: '${activeDbName}'\n`);

    if (isVerifyOnly) {
      console.log("--- Executing Comprehensive Index Verification Audit ---");
      const report: DatabaseIndexVerificationReport = await verifyDatabaseIndexes(db);

      console.log(`\nAudit Results:`);
      console.log(`  Total Required Indexes: ${report.totalRequired}`);
      console.log(`  Verified & Active:      ${report.verifiedCount}`);
      console.log(`  Missing:                ${report.missingCount}`);
      console.log(`  Conflicts / Mismatches: ${report.conflictCount}`);
      console.log(`  Critical Locks Status:  ${report.criticalLocksVerified ? "✅ ALL CRITICAL LOCKS VERIFIED" : "❌ CRITICAL LOCKS MISSING"}`);
      console.log(`  Overall Health:         ${report.isHealthy ? "✅ HEALTHY" : "⚠️ ACTION REQUIRED"}`);

      if (report.summary.missing.length > 0) {
        console.log("\nMissing Indexes:");
        for (const m of report.summary.missing) {
          console.log(`  - ${m}`);
        }
      }

      if (report.summary.conflicts.length > 0) {
        console.log("\nConflicting Indexes (Require Manual Review):");
        for (const c of report.summary.conflicts) {
          console.log(`  - ${c}`);
        }
      }

      if (report.summary.criticalLocksMissing.length > 0) {
        console.log("\n⚠️ CRITICAL LOCKS MISSING (Blocks Concurrency & Idempotency):");
        for (const cl of report.summary.criticalLocksMissing) {
          console.log(`  - ${cl}`);
        }
      }

      if (!report.isHealthy) {
        console.log("\nRemedial Action:");
        console.log(`  Run: npx tsx scripts/manage-indexes.ts --apply --expected-db=${activeDbName}`);
      }

      process.exit(report.isHealthy ? 0 : 1);
    }

    // Apply or Dry-Run Mode
    console.log(`--- Executing Index Provisioning (${isDryRun ? "DRY-RUN" : "LIVE APPLY"}) ---`);
    const initResult: IndexInitResult = await initializeDatabaseIndexes(db, {
      dryRun: isDryRun,
      logger: console.log,
    });

    console.log("\nInitialization Summary:");
    console.log(`  Created / Would Create:  ${initResult.createdCount}`);
    console.log(`  Already Verified (Skip): ${initResult.skippedCount}`);
    console.log(`  Conflicts Flagged:       ${initResult.conflictCount}`);
    console.log(`  Blocked by Duplicates:   ${initResult.duplicateBlockedCount}`);
    console.log(`  Success Status:          ${initResult.success ? "✅ SUCCESS" : "❌ INCOMPLETE"}`);

    // Re-verify after apply
    if (isApply) {
      console.log("\n--- Running Post-Migration Verification Audit ---");
      const postAudit = await verifyDatabaseIndexes(db);
      console.log(`Post-Audit Health: ${postAudit.isHealthy ? "✅ 100% HEALTHY" : "⚠️ UNRESOLVED ITEMS REMAIN"}`);
      console.log(`Critical Locks:    ${postAudit.criticalLocksVerified ? "✅ ALL VERIFIED" : "❌ CRITICAL LOCKS UNVERIFIED"}`);
      process.exit(postAudit.isHealthy ? 0 : 1);
    }

    process.exit(initResult.success ? 0 : 1);
  } catch (error: any) {
    console.error("\n❌ FATAL INDEX MANAGEMENT EXCEPTION:");
    console.error(error?.message || error);
    process.exit(1);
  } finally {
    if (connection) {
      await mongoose.disconnect();
    }
  }
}

main().catch((err) => {
  console.error("Unhandled CLI Exception:", err);
  process.exit(1);
});
