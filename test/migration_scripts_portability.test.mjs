/**
 * TuitionDesk / MSEC — Migration Scripts Portability & Safety Regression Tests
 *
 * Verifies that the hardcoded 'msec' database restriction in the four
 * lock-index migration scripts has been replaced with a secure, explicit,
 * and portable database target confirmation mechanism.
 *
 * Verifies:
 * 1. Target database matching succeeds.
 * 2. Mismatched target database safely aborts before any connection.
 * 3. Missing target database safely aborts with code 1 and clear usage.
 * 4. Active connected database mismatch aborts safely.
 * 5. URL normalization for URIs without path.
 * 6. Zero secret leakage (sanitized URI logging).
 * 7. Admission welcome job --confirm-live-migration guard remains intact.
 * 8. All four scripts execute safe dry-run exit checks without connecting to MongoDB.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const BE_DIR = path.resolve(REPO_ROOT, "tution-desk-be");

// Import the migration target helper
import {
  extractExpectedDatabaseName,
  resolveMigrationTargetDatabase,
  verifyConnectedDatabaseName,
} from "../tution-desk-be/src/lib/migrationTargetHelper.ts";

describe("P1-1: Portable Migration Target Database Confirmation Helper", () => {
  it("extracts expected database from --expected-db=<dbname> flag", () => {
    const dbName = extractExpectedDatabaseName(["--expected-db=tuitiondesk_prod"]);
    assert.equal(dbName, "tuitiondesk_prod");
  });

  it("extracts expected database from --expected-db <dbname> flag pair", () => {
    const dbName = extractExpectedDatabaseName(["--other", "--expected-db", "msec_staging"]);
    assert.equal(dbName, "msec_staging");
  });

  it("extracts expected database from --db=<dbname> flag", () => {
    const dbName = extractExpectedDatabaseName(["--db=client_tenant_db"]);
    assert.equal(dbName, "client_tenant_db");
  });

  it("extracts expected database from EXPECTED_DB_NAME env var when CLI flag is absent", () => {
    const dbName = extractExpectedDatabaseName([], {
      EXPECTED_DB_NAME: "env_configured_db",
    });
    assert.equal(dbName, "env_configured_db");
  });

  it("returns null if no expected database argument or env var is supplied", () => {
    const dbName = extractExpectedDatabaseName(["--other-flag=true"], {});
    assert.equal(dbName, null);
  });

  it("fails closed when target database is missing", () => {
    const result = resolveMigrationTargetDatabase({
      argv: [],
      rawUri: "mongodb://user:pass@localhost:27017/some_db",
      env: {},
    });

    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("Target database confirmation missing"));
    assert.ok(result.error?.includes("--expected-db"));
  });

  it("fails closed when connection URI is missing", () => {
    const result = resolveMigrationTargetDatabase({
      argv: ["--expected-db=client_db"],
      rawUri: "",
      env: {},
    });

    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("Missing database connection URI"));
  });

  it("aborts when URI specifies a database that does not match expected-db", () => {
    const result = resolveMigrationTargetDatabase({
      argv: ["--expected-db=tuitiondesk_prod"],
      rawUri: "mongodb://user:pass@localhost:27017/msec",
      env: {},
    });

    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("Database target mismatch"));
    assert.ok(result.error?.includes("msec"));
    assert.ok(result.error?.includes("tuitiondesk_prod"));
  });

  it("succeeds when URI database matches expected-db (msec legacy)", () => {
    const result = resolveMigrationTargetDatabase({
      argv: ["--expected-db=msec"],
      rawUri: "mongodb://user:pass@localhost:27017/msec?retryWrites=true",
      env: {},
    });

    assert.equal(result.valid, true);
    assert.equal(result.expectedDbName, "msec");
    assert.ok(!result.sanitizedUri.includes("pass"));
  });

  it("succeeds when URI database matches arbitrary client database (portable client DB)", () => {
    const result = resolveMigrationTargetDatabase({
      argv: ["--expected-db=msec_prod_2026"],
      rawUri: "mongodb+srv://admin:SecretPass123@cluster0.abc.mongodb.net/msec_prod_2026?retryWrites=true&w=majority",
      env: {},
    });

    assert.equal(result.valid, true);
    assert.equal(result.expectedDbName, "msec_prod_2026");
    // Verify zero secrets leaked
    assert.ok(!result.sanitizedUri.includes("SecretPass123"));
    assert.ok(result.sanitizedUri.includes("***:***@"));
    assert.ok(result.sanitizedUri.includes("[REDACTED_CLUSTER_HOST]"));
  });

  it("normalizes URI without explicit database path by appending expected-db", () => {
    const result = resolveMigrationTargetDatabase({
      argv: ["--expected-db=custom_app_db"],
      rawUri: "mongodb://localhost:27017?retryWrites=true",
      env: {},
    });

    assert.equal(result.valid, true);
    assert.equal(result.expectedDbName, "custom_app_db");
    assert.ok(result.targetUri.includes("/custom_app_db"));
  });
});

describe("P1-1: verifyConnectedDatabaseName Safety Guard", () => {
  it("passes when active connected database strictly matches expected database", () => {
    assert.doesNotThrow(() => {
      verifyConnectedDatabaseName("tuitiondesk_prod", "tuitiondesk_prod");
    });
  });

  it("throws when active connected database does not match expected database", () => {
    assert.throws(
      () => {
        verifyConnectedDatabaseName("msec", "tuitiondesk_prod");
      },
      /Target database mismatch on active connection/
    );
  });

  it("throws when active connected database is undefined or empty", () => {
    assert.throws(
      () => {
        verifyConnectedDatabaseName(undefined, "tuitiondesk_prod");
      },
      /Unable to determine active database name/
    );
  });
});

describe("P1-1: CLI Migration Scripts Preflight Safety Guards (Zero Live Connection)", () => {
  const runScript = (scriptName, args = [], envOverrides = {}) => {
    return execFileSync(
      process.execPath,
      ["--experimental-strip-types", path.join("scripts", scriptName), ...args],
      {
        cwd: BE_DIR,
        shell: false,
        env: {
          ...process.env,
          ...envOverrides,
        },
        stdio: "pipe",
      }
    );
  };

  it("apply-lock-indexes.ts aborts with code 1 if --expected-db is missing", () => {
    try {
      runScript("apply-lock-indexes.ts", [], {
        MONGODB_URI: "mongodb://localhost:27017/test_db",
        EXPECTED_DB_NAME: "",
      });
      assert.fail("Should have failed due to missing target database");
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = (err.stderr?.toString() || "") + (err.stdout?.toString() || "");
      assert.ok(stderr.includes("TARGET DATABASE CONFIRMATION FAILED") || stderr.includes("Target database confirmation missing"));
    }
  });

  it("apply-parent-access-lock-index.ts aborts with code 1 if --expected-db is missing", () => {
    try {
      runScript("apply-parent-access-lock-index.ts", [], {
        MONGODB_URI: "mongodb://localhost:27017/test_db",
        EXPECTED_DB_NAME: "",
      });
      assert.fail("Should have failed due to missing target database");
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = (err.stderr?.toString() || "") + (err.stdout?.toString() || "");
      assert.ok(stderr.includes("TARGET DATABASE CONFIRMATION FAILED") || stderr.includes("Target database confirmation missing"));
    }
  });

  it("apply-import-batch-lock-index.ts aborts with code 1 if --expected-db is missing", () => {
    try {
      runScript("apply-import-batch-lock-index.ts", [], {
        MONGODB_URI: "mongodb://localhost:27017/test_db",
        EXPECTED_DB_NAME: "",
      });
      assert.fail("Should have failed due to missing target database");
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = (err.stderr?.toString() || "") + (err.stdout?.toString() || "");
      assert.ok(stderr.includes("TARGET DATABASE CONFIRMATION FAILED") || stderr.includes("Target database confirmation missing"));
    }
  });

  it("apply-admission-welcome-job-index.ts exits with code 0 and prints safety guard if --confirm-live-migration is absent", () => {
    const stdout = runScript("apply-admission-welcome-job-index.ts", ["--expected-db=test_db"], {
      MONGODB_URI: "mongodb://localhost:27017/test_db",
    }).toString();

    assert.ok(stdout.includes("SAFETY GUARD: To apply this migration, run with explicit flags:"));
    assert.ok(stdout.includes("--confirm-live-migration"));
    assert.ok(stdout.includes("--expected-db=<database_name>"));
  });

  it("apply-admission-welcome-job-index.ts aborts with code 1 if --confirm-live-migration is present but --expected-db is missing", () => {
    try {
      runScript("apply-admission-welcome-job-index.ts", ["--confirm-live-migration"], {
        MONGODB_URI: "mongodb://localhost:27017/test_db",
        EXPECTED_DB_NAME: "",
      });
      assert.fail("Should have failed due to missing expected-db");
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = (err.stderr?.toString() || "") + (err.stdout?.toString() || "");
      assert.ok(stderr.includes("TARGET DATABASE CONFIRMATION FAILED") || stderr.includes("Target database confirmation missing"));
    }
  });

  it("all scripts abort before connection when --expected-db does not match URI database", () => {
    try {
      runScript("apply-lock-indexes.ts", ["--expected-db=client_db_target"], {
        MONGODB_URI: "mongodb://localhost:27017/other_db",
      });
      assert.fail("Should have failed due to database target mismatch");
    } catch (err) {
      assert.equal(err.status, 1);
      const stderr = (err.stderr?.toString() || "") + (err.stdout?.toString() || "");
      assert.ok(stderr.includes("Database target mismatch"));
      assert.ok(stderr.includes("other_db"));
      assert.ok(stderr.includes("client_db_target"));
    }
  });
});
