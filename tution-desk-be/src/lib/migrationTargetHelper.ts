/**
 * TuitionDesk / MSEC — Migration Target Database Confirmation Helper
 *
 * Provides safe, strict, and portable database target confirmation for
 * database migration scripts. Eliminates hardcoded database names while
 * preventing any migration from silently executing against an unintended database.
 *
 * SAFETY GUARANTEES:
 * 1. Fails closed: Missing target database aborts execution immediately.
 * 2. Cross-checks CLI arguments, environment variables, URI path, and active connection.
 * 3. Never prints raw credentials or cluster details (sanitizes all outputs).
 * 4. Zero mutations, zero index operations.
 */

import { parseMongoDatabaseName, sanitizeMongoUri } from "./reconciliationEngine.ts";

export interface MigrationTargetResolutionOptions {
  argv?: string[];
  rawUri?: string;
  env?: Record<string, string | undefined>;
  scriptName?: string;
}

export interface MigrationTargetResolutionResult {
  valid: boolean;
  expectedDbName: string;
  targetUri: string;
  sanitizedUri: string;
  error?: string;
}

/**
 * Extracts the operator-provided expected database name from CLI flags or environment variables.
 * Supported CLI flags:
 *   --expected-db=<dbname>
 *   --expected-db <dbname>
 *   --db=<dbname>
 *   --db <dbname>
 * Supported environment variables:
 *   EXPECTED_DB_NAME
 *   EXPECTED_DATABASE_NAME
 */
export function extractExpectedDatabaseName(
  argv?: string[],
  env?: Record<string, string | undefined>
): string | null {
  const args = argv || [];
  const environment = env || process.env;

  // 1. Check CLI arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--expected-db=")) {
      const val = arg.slice("--expected-db=".length).trim();
      if (val) return val;
    }
    if (arg === "--expected-db" && i + 1 < args.length) {
      const nextVal = args[i + 1]?.trim();
      if (nextVal && !nextVal.startsWith("-")) return nextVal;
    }
    if (arg.startsWith("--db=")) {
      const val = arg.slice("--db=".length).trim();
      if (val) return val;
    }
    if (arg === "--db" && i + 1 < args.length) {
      const nextVal = args[i + 1]?.trim();
      if (nextVal && !nextVal.startsWith("-")) return nextVal;
    }
  }

  // 2. Check environment variables
  if (environment.EXPECTED_DB_NAME && environment.EXPECTED_DB_NAME.trim()) {
    return environment.EXPECTED_DB_NAME.trim();
  }
  if (environment.EXPECTED_DATABASE_NAME && environment.EXPECTED_DATABASE_NAME.trim()) {
    return environment.EXPECTED_DATABASE_NAME.trim();
  }

  return null;
}

/**
 * Resolves and strictly validates the target database against the connection URI.
 * - Confirms expected database is explicitly supplied.
 * - Parses database from connection URI.
 * - If URI has a database name, verifies it matches expected database name.
 * - If URI has no database in path, safely appends expected database name.
 * - Sanitizes URI for logging.
 */
export function resolveMigrationTargetDatabase(
  options: MigrationTargetResolutionOptions = {}
): MigrationTargetResolutionResult {
  const argv = options.argv || process.argv.slice(2);
  const environment = options.env || process.env;
  const rawUri =
    options.rawUri ||
    environment.MONGODB_URI ||
    environment.MONGODB_AUDIT_URI;

  const expectedDbName = extractExpectedDatabaseName(argv, environment);

  if (!expectedDbName) {
    return {
      valid: false,
      expectedDbName: "",
      targetUri: "",
      sanitizedUri: "",
      error:
        "SAFETY GUARD: Target database confirmation missing. You must explicitly specify the expected database using '--expected-db=<database_name>' or the EXPECTED_DB_NAME environment variable.",
    };
  }

  if (!rawUri || !rawUri.trim()) {
    return {
      valid: false,
      expectedDbName,
      targetUri: "",
      sanitizedUri: "",
      error:
        "SAFETY GUARD: Missing database connection URI. Please provide MONGODB_URI in environment.",
    };
  }

  const trimmedUri = rawUri.trim();
  const uriDbName = parseMongoDatabaseName(trimmedUri);

  let targetUri = trimmedUri;

  if (uriDbName) {
    if (uriDbName !== expectedDbName) {
      return {
        valid: false,
        expectedDbName,
        targetUri: trimmedUri,
        sanitizedUri: sanitizeMongoUri(trimmedUri),
        error: `SAFETY GUARD: Database target mismatch. Connection URI specifies database "${uriDbName}", but expected target database is "${expectedDbName}". Migration aborted to protect unintended database.`,
      };
    }
  } else {
    // Normalize URI by appending expected database name
    const httpEquiv = targetUri.replace(/^mongodb(\+srv)?:\/\//i, "http://");
    try {
      const parsed = new URL(httpEquiv);
      const pathname = parsed.pathname.replace(/^\/+/, "");
      if (!pathname) {
        targetUri = targetUri.replace(/\/?(\?|$)/, `/${expectedDbName}$1`);
      }
    } catch {
      targetUri = targetUri.replace(/\/?(\?|$)/, `/${expectedDbName}$1`);
    }
  }

  return {
    valid: true,
    expectedDbName,
    targetUri,
    sanitizedUri: sanitizeMongoUri(targetUri),
  };
}

/**
 * Validates that the active connected database matches the expected target database name.
 * Throws an Error if there is any mismatch.
 */
export function verifyConnectedDatabaseName(
  activeDbName: string | undefined,
  expectedDbName: string
): void {
  if (!activeDbName || typeof activeDbName !== "string") {
    throw new Error(
      `SAFETY GUARD: Unable to determine active database name from MongoDB connection. Expected: "${expectedDbName}".`
    );
  }

  if (activeDbName !== expectedDbName) {
    throw new Error(
      `ABORT: Target database mismatch on active connection! Expected database "${expectedDbName}", but active connected database is "${activeDbName}". Operation terminated.`
    );
  }
}
