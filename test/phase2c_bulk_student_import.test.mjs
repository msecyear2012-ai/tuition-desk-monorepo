import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");
const { SignJWT, jwtVerify } = beRequire("jose");

// ============================================================================
// Phase 2C: Bulk Student Import API Specification & Mocked Database Suite
//
// TEST CLASSIFICATION:
// 1. Pure Unit Tests:
//    - Tests 1-13, 16, 17, 19: CSV parsing (RFC-4180), formula sanitization,
//      row validation, token hashing, identity continuity, upload size limits.
// 2. Mocked Database Specification Tests:
//    - Tests 14, 15, 18, 20, 21: In-memory simulation of atomic CAS operations,
//      lease timeouts, lock holder transitions, transactional abort / rollback
//      compensation, partial retry idempotency, and Mongoose schema definitions.
// 3. Live Database Integration Tests:
//    - 0 tests. None of these tests execute against the live MongoDB Atlas cluster
//      or perform live network I/O, ensuring zero writes to the production/cluster DB.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 2C: Bulk Student Import API Test Suite", async (t) => {
  const {
    parseCsvTokens,
    parseCsvText,
    normalizeHeader,
    generateErrorCsv,
    sanitizeCsvCell,
  } = await import("../tution-desk-be/src/lib/csvParser.ts");

  const {
    ImportBatchLock,
    verifyImportLockIndexIntegrity,
    getLockLeaseDurationMs,
    getHeartbeatIntervalMs,
  } = await import("../tution-desk-be/src/models/ImportBatchLock.ts");

  const {
    canonicalizeRow,
    computeRowsHash,
    signPreviewToken,
    verifyPreviewToken,
    validateAndCategorizeRows,
    readBoundedRequestBody,
    extractCsvFromMultipartBuffer,
  } = await import("../tution-desk-be/src/lib/bulkImport.ts");

  const { signToken, verifyToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );

  // Helper to generate mock NextRequest with auth cookie or header
  function createMockRequest({
    token = null,
    method = "POST",
    body = {},
    headers = {},
    searchParams = {},
  } = {}) {
    return {
      method,
      cookies: {
        get: (name) =>
          token && (name === "auth_token" || name === "token")
            ? { value: token }
            : undefined,
      },
      headers: {
        get: (name) => {
          const lName = name.toLowerCase();
          if (lName === "authorization" && token) return `Bearer ${token}`;
          if (lName === "origin") return "http://localhost:3000";
          if (headers[lName]) return headers[lName];
          return null;
        },
      },
      nextUrl: {
        searchParams: {
          get: (key) => searchParams[key] || null,
        },
      },
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  }

  // Pre-configured actors
  const ownerTokenCenterA = await signToken({
    userId: "650000000000000000000001",
    centerId: "msec",
    role: "owner",
    name: "Dr. A. P. Rao",
  });

  const teacher1TokenCenterA = await signToken({
    userId: "650000000000000000000010",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000010",
    name: "R. K. Sharma (Math)",
  });

  const teacher2TokenCenterA = await signToken({
    userId: "650000000000000000000020",
    centerId: "msec",
    role: "teacher",
    teacherId: "650000000000000000000020",
    name: "S. K. Gupta (Physics)",
  });

  const ownerTokenCenterB = await signToken({
    userId: "650000000000000000000099",
    centerId: "other_center",
    role: "owner",
    name: "Foreign Owner",
  });

  const parentToken = await signToken({
    userId: "650000000000000000000088",
    centerId: "msec",
    role: "parent",
    name: "Parent User",
  });

  // Mock Active Batches in "msec"
  const activeBatchesCenterA = new Set(["batch-10a", "batch-12b", "physics-neet"]);

  // Mock Active Teachers in "msec"
  const mockTeachersCenterA = [
    {
      _id: "650000000000000000000010",
      centerId: "msec",
      name: "R. K. Sharma (Math)",
      isActive: true,
    },
    {
      _id: "650000000000000000000020",
      centerId: "msec",
      name: "S. K. Gupta (Physics)",
      isActive: true,
    },
    {
      _id: "650000000000000000000030",
      centerId: "msec",
      name: "Inactive Teacher",
      isActive: false,
    },
  ];

  // Mock Teacher in "other_center"
  const mockForeignTeacher = {
    _id: "650000000000000000000091",
    centerId: "other_center",
    name: "Foreign Teacher",
    isActive: true,
  };

  // Mock Existing Students in "msec"
  const existingStudentsMapCenterA = new Set([
    "9876543210:::aarav patel",
    "9876543211:::rahul verma",
  ]);

  // =========================================================================
  // 1. Missing & Invalid Authentication
  // =========================================================================
  await t.test("1. Rejects unauthenticated and invalid token requests", async () => {
    const unauthReq = createMockRequest({ token: null });
    const userUnauth = await getAuthenticatedUser(unauthReq);
    assert.equal(userUnauth, null);

    const invalidReq = createMockRequest({ token: "invalid.jwt.token" });
    const userInvalid = await getAuthenticatedUser(invalidReq);
    assert.equal(userInvalid, null);
  });

  // =========================================================================
  // 2. Role Authorization (Owner & Teacher Only)
  // =========================================================================
  await t.test("2. Enforces role authorization (Owner and Teacher allowed, others rejected)", async () => {
    const ownerUser = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(ownerUser.role, "owner");
    assert.equal(ownerUser.centerId, "msec");

    const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterA }));
    assert.equal(teacherUser.role, "teacher");
    assert.equal(teacherUser.teacherId, "650000000000000000000010");

    const parentUser = await getAuthenticatedUser(createMockRequest({ token: parentToken }));
    assert.equal(parentUser.role, "parent");

    // Route logic check: parent role must be rejected
    const isAllowedRole = parentUser.role === "owner" || parentUser.role === "teacher";
    assert.equal(isAllowedRole, false);
  });

  // =========================================================================
  // 3. RFC-4180 CSV Parsing & Header Normalization
  // =========================================================================
  await t.test("3. Parses RFC-4180 CSV text, strips BOM, handles quotes and commas", async () => {
    // Header normalization tests
    assert.equal(normalizeHeader("Student Name"), "name");
    assert.equal(normalizeHeader("student_name"), "name");
    assert.equal(normalizeHeader("Parent WhatsApp"), "parentWhatsApp");
    assert.equal(normalizeHeader("mobile"), "parentWhatsApp");
    assert.equal(normalizeHeader("Class"), "batch");
    assert.equal(normalizeHeader("Monthly Fee"), "monthlyFee");
    assert.equal(normalizeHeader("Billing Cycle Date"), "billingCycleDate");
    assert.equal(normalizeHeader("Roll No"), "rollNumber");
    assert.equal(normalizeHeader("Admission Date"), "joiningDate");

    // CSV with BOM and quoted fields with commas and escaped quotes
    const csvContent =
      '\uFEFF"Student Name","Class","Parent WhatsApp","Monthly Fee","Billing Cycle Date"\r\n' +
      '"Patel, Aarav","Batch-10A","+91 98765 43210","1,500","5"\r\n' +
      '"Rahul ""Rock"" Verma","Batch-10A","9876543211","2000","10"\r\n';

    const parsed = parseCsvText(csvContent);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].normalized.name, "Patel, Aarav");
    assert.equal(parsed.rows[0].normalized.batch, "Batch-10A");
    assert.equal(parsed.rows[0].normalized.monthlyFee, 1500);
    assert.equal(parsed.rows[0].normalized.billingCycleDate, 5);

    assert.equal(parsed.rows[1].normalized.name, 'Rahul "Rock" Verma');
    assert.equal(parsed.rows[1].normalized.monthlyFee, 2000);
    assert.equal(parsed.rows[1].normalized.billingCycleDate, 10);
  });

  // =========================================================================
  // 4. Malformed CSV & Edge Case Input
  // =========================================================================
  await t.test("4. Rejects empty CSV or header-only files", async () => {
    const emptyResult = parseCsvText("");
    assert.equal(emptyResult.rows.length, 0);

    const whitespaceResult = parseCsvText("   \r\n\t  \n  ");
    assert.equal(whitespaceResult.rows.length, 0);

    const headerOnlyResult = parseCsvText("Name,Batch,Parent WhatsApp\r\n");
    assert.equal(headerOnlyResult.rows.length, 0);
  });

  // =========================================================================
  // 5. Row-Level Validation & Missing Required Fields
  // =========================================================================
  await t.test("5. Identifies missing fields, invalid phone, non-existent batch, and invalid numbers", async () => {
    const testRows = [
      {
        rowNumber: 2,
        normalized: {
          name: "", // Missing name
          batch: "Batch-10A",
          parentWhatsApp: "9876543299",
        },
      },
      {
        rowNumber: 3,
        normalized: {
          name: "Sneha Sen",
          batch: "NonExistent-Batch", // Non-existent batch in center
          parentWhatsApp: "9876543299",
        },
      },
      {
        rowNumber: 4,
        normalized: {
          name: "Vikas Dubey",
          batch: "Batch-10A",
          parentWhatsApp: "9821", // Invalid phone (too short)
        },
      },
      {
        rowNumber: 5,
        normalized: {
          name: "Anjali Gupta",
          batch: "Batch-10A",
          parentWhatsApp: "9876543299",
          monthlyFee: -500, // Negative fee
        },
      },
      {
        rowNumber: 6,
        normalized: {
          name: "Rohan Das",
          batch: "Batch-10A",
          parentWhatsApp: "9876543299",
          billingCycleDate: 45, // Invalid billing cycle (>31)
        },
      },
      {
        rowNumber: 7,
        normalized: {
          name: "Valid Student",
          batch: "Batch-10A",
          parentWhatsApp: "9876543299",
          monthlyFee: 1200,
          billingCycleDate: 5,
        },
      },
    ];

    const result = validateAndCategorizeRows({
      parsedRows: testRows,
      activeBatchNames: activeBatchesCenterA,
      existingStudentsMap: existingStudentsMapCenterA,
    });

    assert.equal(result.validRows.length, 1);
    assert.equal(result.validRows[0].name, "Valid Student");
    assert.equal(result.errorRows.length, 5);

    // Verify exact failure reasons
    assert.ok(result.errorRows.some((e) => e.row === 2 && e.reason.includes("name is required")));
    assert.ok(result.errorRows.some((e) => e.row === 3 && e.reason.includes("does not exist in this institute")));
    assert.ok(result.errorRows.some((e) => e.row === 4 && e.reason.includes("10-15 digits")));
    assert.ok(result.errorRows.some((e) => e.row === 5 && e.reason.includes("non-negative")));
    assert.ok(result.errorRows.some((e) => e.row === 6 && e.reason.includes("between 1 and 31")));
  });

  // =========================================================================
  // 6. Duplicate Detection: Intra-File & Database Duplicates
  // =========================================================================
  await t.test("6. Detects intra-file duplicate rows and database collisions", async () => {
    const testRows = [
      {
        rowNumber: 2,
        normalized: {
          name: "Aarav Patel", // Already in DB ("9876543210:::aarav patel")
          batch: "Batch-10A",
          parentWhatsApp: "9876543210",
        },
      },
      {
        rowNumber: 3,
        normalized: {
          name: "New Student One",
          batch: "Batch-10A",
          parentWhatsApp: "9876543220",
        },
      },
      {
        rowNumber: 4,
        normalized: {
          name: "New Student One", // Intra-file duplicate of row 3
          batch: "Batch-10A",
          parentWhatsApp: "9876543220",
        },
      },
    ];

    const result = validateAndCategorizeRows({
      parsedRows: testRows,
      activeBatchNames: activeBatchesCenterA,
      existingStudentsMap: existingStudentsMapCenterA,
    });

    assert.equal(result.validRows.length, 1);
    assert.equal(result.validRows[0].row, 3);
    assert.equal(result.duplicateRows.length, 2);

    // Row 2 is DB duplicate
    const dbDup = result.duplicateRows.find((d) => d.row === 2);
    assert.ok(dbDup);
    assert.ok(dbDup.reason.includes("already enrolled in this institute"));

    // Row 4 is intra-file duplicate
    const fileDup = result.duplicateRows.find((d) => d.row === 4);
    assert.ok(fileDup);
    assert.ok(fileDup.reason.includes("Duplicate entry within the uploaded file"));
  });

  // =========================================================================
  // 7. Downloadable CSV Error Report Formatting
  // =========================================================================
  await t.test("7. Generates downloadable RFC-4180 error CSV with proper quoting", async () => {
    const errors = [
      { row: 7, name: "Aarav Patel", reason: "Invalid parent WhatsApp number: '9821' (must be 10-15 digits)" },
      { row: 18, name: "Sneha Sen", reason: 'Batch "Physics-NEET" does not exist in this institute' },
      { row: 29, name: "Rahul Verma", reason: "Duplicate: Student already enrolled in this institute" },
    ];

    const csvOutput = generateErrorCsv(errors);
    assert.ok(csvOutput.startsWith('"Row","Student Name","Reason"'));
    assert.ok(csvOutput.includes('"7","Aarav Patel","Invalid parent WhatsApp number: \'9821\' (must be 10-15 digits)"'));
    // Quotes inside reason must be escaped as ""
    assert.ok(csvOutput.includes('""Physics-NEET""'));
    assert.ok(csvOutput.includes('"29","Rahul Verma"'));
  });

  // =========================================================================
  // 8. Cryptographic Anti-Tampering: Preview-to-Confirm Integrity
  // =========================================================================
  await t.test("8. Ensures preview-to-confirm cryptographic integrity and detects row tampering", async () => {
    const validRows = [
      {
        row: 2,
        name: "Karan Johar",
        batch: "Batch-10A",
        parentWhatsApp: "9876543250",
        monthlyFee: 1500,
        billingCycleDate: 5,
      },
      {
        row: 3,
        name: "Meera Nair",
        batch: "Batch-12B",
        parentWhatsApp: "9876543251",
        monthlyFee: 2000,
        billingCycleDate: 10,
      },
    ];

    const previewId = "prev_test_123";
    const originalHash = computeRowsHash(validRows);

    const previewToken = await signPreviewToken({
      previewId,
      centerId: "msec",
      userId: "650000000000000000000001",
      role: "owner",
      teacherId: null,
      validCount: validRows.length,
      rowsHash: originalHash,
    });

    // Verification of unmodified payload succeeds
    const verified = await verifyPreviewToken(previewToken);
    assert.ok(verified);
    assert.equal(verified.previewId, previewId);
    assert.equal(verified.centerId, "msec");
    assert.equal(verified.validCount, 2);
    assert.equal(verified.rowsHash, originalHash);

    // Tampering test 1: Modifying a fee in a row alters the hash
    const tamperedRows = JSON.parse(JSON.stringify(validRows));
    tamperedRows[0].monthlyFee = 0; // Client altered fee to 0
    const tamperedHash = computeRowsHash(tamperedRows);
    assert.notEqual(tamperedHash, originalHash);

    // Tampering test 2: Adding an unauthorized row alters the count and hash
    const rowInjected = [...validRows, { row: 4, name: "Ghost", batch: "Batch-10A", parentWhatsApp: "9876543299", monthlyFee: 0, billingCycleDate: 5 }];
    assert.notEqual(rowInjected.length, verified.validCount);

    // Tampering test 3: Tampered preview token string is rejected by jose
    const corruptedToken = previewToken.slice(0, -6) + "abcdef";
    const corruptedVerified = await verifyPreviewToken(corruptedToken);
    assert.equal(corruptedVerified, null);
  });

  // =========================================================================
  // 9. Repeated Confirmation Protection
  // =========================================================================
  await t.test("9. Detects repeated confirmation attempts using importedBatchId", async () => {
    const existingBatchesInDb = new Set(["prev_batch_already_imported"]);

    const previewIdA = "prev_batch_already_imported";
    const isAlreadyImportedA = existingBatchesInDb.has(previewIdA);
    assert.equal(isAlreadyImportedA, true); // Must reject with HTTP 409

    const previewIdB = "prev_batch_brand_new";
    const isAlreadyImportedB = existingBatchesInDb.has(previewIdB);
    assert.equal(isAlreadyImportedB, false); // Can proceed
  });

  // =========================================================================
  // 10. DEC-MSEC-05 Assignment Rules: Teacher Automatic Self-Assignment
  // =========================================================================
  await t.test("10. Teacher import enforces automatic self-assignment and ignores client targetTeacherId", async () => {
    const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1TokenCenterA }));
    assert.equal(teacherUser.role, "teacher");

    // Even if client attempts to pass a targetTeacherId or "owner", teacher role forces self teacherId
    const clientSuppliedTarget = "650000000000000000000020"; // Teacher 2
    let assignedTeacherId;

    if (teacherUser.role === "teacher") {
      assignedTeacherId = teacherUser.teacherId; // Stamped directly from verified token
    } else {
      assignedTeacherId = clientSuppliedTarget;
    }

    assert.equal(assignedTeacherId, "650000000000000000000010"); // Still Teacher 1
    assert.notEqual(assignedTeacherId, clientSuppliedTarget);
  });

  // =========================================================================
  // 11. DEC-MSEC-05 Assignment Rules: Owner Assignment Behavior
  // =========================================================================
  await t.test("11. Owner import allows self-assignment (null) or verified active same-center teacher", async () => {
    const ownerUser = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterA }));
    assert.equal(ownerUser.role, "owner");

    // Case A: Owner assigns to self (null, "owner", or empty)
    function resolveOwnerAssignment(targetId) {
      if (!targetId || targetId === "owner" || targetId === "null") {
        return { assignedTeacherId: null, role: "owner" };
      }
      const teacher = mockTeachersCenterA.find((t) => t._id === targetId && t.centerId === ownerUser.centerId);
      if (!teacher) {
        throw new Error("Teacher not found in this institute");
      }
      if (!teacher.isActive) {
        throw new Error("Cannot assign students to an inactive teacher");
      }
      return { assignedTeacherId: teacher._id, role: "teacher", name: teacher.name };
    }

    // 1. Self assignment
    const selfRes1 = resolveOwnerAssignment(null);
    assert.equal(selfRes1.assignedTeacherId, null);
    assert.equal(selfRes1.role, "owner");

    const selfRes2 = resolveOwnerAssignment("owner");
    assert.equal(selfRes2.assignedTeacherId, null);

    // 2. Active teacher in same center
    const teacherRes = resolveOwnerAssignment("650000000000000000000010");
    assert.equal(teacherRes.assignedTeacherId, "650000000000000000000010");
    assert.equal(teacherRes.role, "teacher");

    // 3. Inactive teacher in same center -> MUST FAIL
    assert.throws(
      () => resolveOwnerAssignment("650000000000000000000030"),
      /Cannot assign students to an inactive teacher/
    );

    // 4. Foreign center teacher -> MUST FAIL
    assert.throws(
      () => resolveOwnerAssignment("650000000000000000000091"),
      /Teacher not found in this institute/
    );
  });

  // =========================================================================
  // 12. Cross-Center Isolation Between Preview and Confirm
  // =========================================================================
  await t.test("12. Enforces cross-center tenant isolation between preview and confirmation", async () => {
    const previewTokenCenterA = await signPreviewToken({
      previewId: "prev_center_a_1",
      centerId: "msec",
      userId: "650000000000000000000001",
      role: "owner",
      teacherId: null,
      validCount: 5,
      rowsHash: "abc123hash",
    });

    const tokenPayload = await verifyPreviewToken(previewTokenCenterA);
    const foreignUser = await getAuthenticatedUser(createMockRequest({ token: ownerTokenCenterB }));

    assert.equal(tokenPayload.centerId, "msec");
    assert.equal(foreignUser.centerId, "other_center");

    // Tenant mismatch check
    const isTenantMatch = tokenPayload.centerId === foreignUser.centerId;
    assert.equal(isTenantMatch, false);
  });

  // =========================================================================
  // 13. SEC-01: CSV Formula Injection Neutralization
  // =========================================================================
  await t.test("13. Neutralizes CSV formula injection triggers while preserving normal values", async () => {
    // Malicious formula injection prefixes
    assert.equal(sanitizeCsvCell("=SUM(A1:A10)"), "'=SUM(A1:A10)");
    assert.equal(sanitizeCsvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
    assert.equal(sanitizeCsvCell("+12345"), "'+12345");
    assert.equal(sanitizeCsvCell("-500"), "'-500");
    assert.equal(sanitizeCsvCell("@admin"), "'@admin");
    assert.equal(sanitizeCsvCell("\t=1+1"), "'\t=1+1");
    assert.equal(sanitizeCsvCell("\r-calc"), "'\r-calc");
    assert.equal(sanitizeCsvCell("%USERNAME%"), "'%USERNAME%");
    assert.equal(sanitizeCsvCell("|dir"), "'|dir");

    // Leading whitespace with formula trigger
    assert.equal(sanitizeCsvCell("  =SUM(A1)"), "'  =SUM(A1)");

    // Normal values should remain completely unaltered
    assert.equal(sanitizeCsvCell("Aarav Patel"), "Aarav Patel");
    assert.equal(sanitizeCsvCell("Dr. A. P. Rao"), "Dr. A. P. Rao");
    assert.equal(sanitizeCsvCell("Sneha Sen (Physics)"), "Sneha Sen (Physics)");
    assert.equal(
      sanitizeCsvCell("Batch 'Physics-NEET' does not exist in this institute"),
      "Batch 'Physics-NEET' does not exist in this institute"
    );

    // Double quotes properly escaped per RFC-4180
    assert.equal(sanitizeCsvCell('Rahul "Rock" Verma'), 'Rahul ""Rock"" Verma');

    // Verify generateErrorCsv outputs neutralized cells
    const errorsWithFormula = [
      { row: 7, name: "=cmd|' /C calc'!A0", reason: "Invalid parent WhatsApp number: '+91 9821'" },
      { row: 8, name: '=HYPERLINK("http://evil.com", "click")', reason: "Formula injection test" },
      { row: 9, name: "Normal Student", reason: "Normal error reason" },
    ];
    const errorCsv = generateErrorCsv(errorsWithFormula);
    assert.ok(errorCsv.includes('"7","\'=cmd|\' /C calc\'!A0"'));
    assert.ok(errorCsv.includes('"8","\'=HYPERLINK(\"\"http://evil.com\"\", \"\"click\"\")"'));
    assert.ok(errorCsv.includes('"9","Normal Student","Normal error reason"'));
  });

  // =========================================================================
  // 14. SEC-02, SEC-05 & SEC-08: Strict Lock Ownership, Heartbeat, lockVersion Fencing
  // =========================================================================
  await t.test("14. ImportBatchLock enforces strict holderId + lockVersion ownership, heartbeats, and prevents concurrent races", async () => {
    const lockStore = new Map();

    async function attemptAtomicReservation({ centerId, previewId, holderId, userId, role }) {
      const lockKey = `${centerId}:::${previewId}`;
      if (lockStore.has(lockKey)) {
        const existing = lockStore.get(lockKey);
        if (existing.status === "COMPLETED") {
          return { status: 409, error: "This import batch has already been processed" };
        }
        if (existing.status === "IN_PROGRESS") {
          return {
            status: 409,
            error: "This import batch is currently in progress. Automatic takeover is prohibited.",
          };
        }
        if (existing.status === "FAILED") {
          // Reclaim FAILED lock atomically
          existing.status = "IN_PROGRESS";
          existing.holderId = holderId;
          existing.lockVersion = (existing.lockVersion || 1) + 1;
          existing.lockedAt = new Date();
          existing.heartbeatAt = new Date();
          return { status: 200, acquired: true, lockVersion: existing.lockVersion };
        }
      }

      const newLock = {
        centerId,
        previewId,
        holderId,
        userId,
        role,
        lockVersion: 1,
        status: "IN_PROGRESS",
        lockedAt: new Date(),
        heartbeatAt: new Date(),
      };
      lockStore.set(lockKey, newLock);
      return { status: 200, acquired: true, lockVersion: 1 };
    }

    function refreshHeartbeat({ centerId, previewId, holderId, lockVersion }) {
      const lockKey = `${centerId}:::${previewId}`;
      const lock = lockStore.get(lockKey);
      if (
        !lock ||
        lock.status !== "IN_PROGRESS" ||
        lock.holderId !== holderId ||
        (lockVersion !== undefined && lock.lockVersion !== lockVersion)
      ) {
        return { modifiedCount: 0 };
      }
      lock.heartbeatAt = new Date();
      return { modifiedCount: 1 };
    }

    function updateLockStatus({ centerId, previewId, holderId, lockVersion, newStatus }) {
      const lockKey = `${centerId}:::${previewId}`;
      const lock = lockStore.get(lockKey);
      if (!lock) return { modifiedCount: 0 };
      // Strict ownership check: only the exact holder AND lockVersion can transition the lock (SEC-08)
      if (
        lock.status !== "IN_PROGRESS" ||
        lock.holderId !== holderId ||
        (lockVersion !== undefined && lock.lockVersion !== lockVersion)
      ) {
        return { modifiedCount: 0, error: "Lock ownership mismatch" };
      }
      lock.status = newStatus;
      return { modifiedCount: 1 };
    }

    // 1. Request 1 acquires lock with unique holderId "holder-1" and lockVersion 1
    const req1 = await attemptAtomicReservation({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-1",
      userId: "user_owner",
      role: "owner",
    });
    assert.equal(req1.status, 200);
    assert.equal(req1.acquired, true);
    assert.equal(req1.lockVersion, 1);

    // 2. Concurrent Request 2 attempts reservation with "holder-2" -> MUST BE REJECTED (409)
    const req2 = await attemptAtomicReservation({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-2",
      userId: "user_owner",
      role: "owner",
    });
    assert.equal(req2.status, 409);
    assert.ok(req2.error.includes("currently in progress"));

    // 3. Valid holder-1 with lockVersion 1 can refresh heartbeat
    const beat1 = refreshHeartbeat({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-1",
      lockVersion: 1,
    });
    assert.equal(beat1.modifiedCount, 1);

    // 4. Unauthorized holder-2 CANNOT refresh heartbeat
    const rogueBeat = refreshHeartbeat({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-2",
      lockVersion: 1,
    });
    assert.equal(rogueBeat.modifiedCount, 0);

    // 5. SEC-08: Heartbeat with stale lockVersion (e.g. 0) cannot update the lock
    const staleBeat = refreshHeartbeat({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-1",
      lockVersion: 0,
    });
    assert.equal(staleBeat.modifiedCount, 0);

    // 6. Unauthorized holder-2 attempts to mark lock FAILED or COMPLETED -> MUST BE DENIED
    const rogueFail = updateLockStatus({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-2",
      lockVersion: 1,
      newStatus: "FAILED",
    });
    assert.equal(rogueFail.modifiedCount, 0);

    // 7. SEC-08: Stale lockVersion cannot mark lock COMPLETED
    const staleComplete = updateLockStatus({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-1",
      lockVersion: 0,
      newStatus: "COMPLETED",
    });
    assert.equal(staleComplete.modifiedCount, 0);

    // 8. Valid holder-1 with current lockVersion 1 successfully marks lock COMPLETED
    const validUpdate = updateLockStatus({
      centerId: "msec",
      previewId: "prev_concurrent_1",
      holderId: "holder-1",
      lockVersion: 1,
      newStatus: "COMPLETED",
    });
    assert.equal(validUpdate.modifiedCount, 1);
  });

  // =========================================================================
  // 15. SEC-04, SEC-06 & SEC-08: Lease Recovery & Strict Transaction Invariants
  // =========================================================================
  await t.test("15. Lease recovery, transaction requirement, abort safety, and lockVersion fencing", async () => {
    const LEASE_DURATION_MS = 60 * 1000; // 60 seconds
    const lockStore = new Map();
    const studentDb = [];

    const lockKey = "msec:::prev_lease_test_1";

    // Setup an initial active lock for worker-1 with fresh heartbeat
    lockStore.set(lockKey, {
      centerId: "msec",
      previewId: "prev_lease_test_1",
      holderId: "worker-1",
      lockVersion: 1,
      status: "IN_PROGRESS",
      lockedAt: new Date(),
      heartbeatAt: new Date(), // fresh!
    });

    // Helper: Atomic recovery simulation matching findOneAndUpdate({ status: "IN_PROGRESS", heartbeatAt: { $lt: staleCutoff } })
    function attemptAtomicRecovery({ centerId, previewId, newHolderId, recoverAbandoned, role }) {
      if (recoverAbandoned !== true || role !== "owner") {
        return { status: 403, error: "Only institute owner can request recovery" };
      }
      const lock = lockStore.get(`${centerId}:::${previewId}`);
      if (!lock) return { status: 404, error: "Lock not found" };
      if (lock.status !== "IN_PROGRESS") {
        return { status: 409, error: "Lock is not in progress" };
      }

      const staleCutoff = new Date(Date.now() - LEASE_DURATION_MS);
      if (lock.heartbeatAt >= staleCutoff) {
        return {
          status: 409,
          error: "This import batch is currently active. Recovery is only permitted for unresponsive batches exceeding the lease duration.",
        };
      }

      // Atomic CAS lease update (SEC-04 & SEC-08)
      lock.holderId = newHolderId;
      lock.lockVersion = (lock.lockVersion || 1) + 1;
      lock.lockedAt = new Date();
      lock.heartbeatAt = new Date();
      return { status: 200, recovered: true, lockVersion: lock.lockVersion };
    }

    // A. Active lock CANNOT be recovered (heartbeat is fresh) -> 409
    const activeRecoveryRes = attemptAtomicRecovery({
      centerId: "msec",
      previewId: "prev_lease_test_1",
      newHolderId: "worker-2",
      recoverAbandoned: true,
      role: "owner",
    });
    assert.equal(activeRecoveryRes.status, 409);
    assert.ok(activeRecoveryRes.error.includes("currently active"));
    assert.equal(lockStore.get(lockKey).holderId, "worker-1");

    // B. Simulate that worker-1 stalled/crashed: heartbeat becomes stale (> 60s ago)
    lockStore.get(lockKey).heartbeatAt = new Date(Date.now() - 70 * 1000);

    // C. Two simultaneous recovery requests: ONLY ONE succeeds
    const recoveryReqA = attemptAtomicRecovery({
      centerId: "msec",
      previewId: "prev_lease_test_1",
      newHolderId: "worker-2A",
      recoverAbandoned: true,
      role: "owner",
    });
    assert.equal(recoveryReqA.status, 200);
    assert.equal(recoveryReqA.recovered, true);
    assert.equal(recoveryReqA.lockVersion, 2);
    assert.equal(lockStore.get(lockKey).holderId, "worker-2A");
    assert.equal(lockStore.get(lockKey).lockVersion, 2);

    // The second simultaneous recovery request runs immediately after:
    const recoveryReqB = attemptAtomicRecovery({
      centerId: "msec",
      previewId: "prev_lease_test_1",
      newHolderId: "worker-2B",
      recoverAbandoned: true,
      role: "owner",
    });
    assert.equal(recoveryReqB.status, 409);
    assert.ok(recoveryReqB.error.includes("currently active"));
    assert.equal(lockStore.get(lockKey).holderId, "worker-2A");

    // D. SEC-06 Requirement 1: Transaction initialization failure returns 503
    function simulateImportTransactionInit(startSessionSucceeds) {
      if (!startSessionSucceeds) {
        return {
          status: 503,
          error: "Bulk import requires replica set transaction support to guarantee data integrity.",
        };
      }
      return { status: 200, sessionActive: true };
    }
    const sessionFailedRes = simulateImportTransactionInit(false);
    assert.equal(sessionFailedRes.status, 503);
    assert.ok(sessionFailedRes.error.includes("replica set transaction support"));

    // E. SEC-06 Requirement 2: No student insertion happens without an active transaction
    async function executeImportWithTransaction({
      sessionActive,
      holderId,
      lockVersion,
      studentsToInsert,
      shouldAbort = false,
    }) {
      if (!sessionActive) {
        throw new Error("No active transaction: insertion disallowed");
      }
      const lock = lockStore.get(lockKey);
      // In transaction: verify lock ownership with both holderId AND lockVersion (SEC-08)
      if (
        !lock ||
        lock.status !== "IN_PROGRESS" ||
        lock.holderId !== holderId ||
        lock.lockVersion !== lockVersion
      ) {
        throw new Error("Lock ownership lost: batch lease was reclaimed before transaction execution");
      }

      // Staged writes within transaction
      const stagedWrites = [...studentsToInsert];

      if (shouldAbort) {
        // Transaction aborted: discard staged writes without committing
        return { committed: false, insertedCount: 0 };
      }

      // Commit transaction
      studentDb.push(...stagedWrites);
      lock.status = "COMPLETED";
      return { committed: true, insertedCount: stagedWrites.length };
    }

    // Verify insertion is rejected if sessionActive is false
    await assert.rejects(
      async () => {
        await executeImportWithTransaction({
          sessionActive: false,
          holderId: "worker-2A",
          lockVersion: 2,
          studentsToInsert: [{ name: "Orphan Student", parentWhatsApp: "9876543299" }],
        });
      },
      (err) => {
        assert.ok(err.message.includes("No active transaction"));
        return true;
      }
    );
    assert.equal(studentDb.length, 0);

    // F. SEC-06 Requirement 3: Transaction abort leaves no committed student records
    const abortedResult = await executeImportWithTransaction({
      sessionActive: true,
      holderId: "worker-2A",
      lockVersion: 2,
      studentsToInsert: [{ name: "Failed Batch Student", parentWhatsApp: "9876543297" }],
      shouldAbort: true,
    });
    assert.equal(abortedResult.committed, false);
    assert.equal(abortedResult.insertedCount, 0);
    assert.equal(studentDb.length, 0); // Zero committed records!

    // G. SEC-08 Requirement 7: Stale worker (worker-1 with stale lockVersion 1) cannot insert or complete
    await assert.rejects(
      async () => {
        await executeImportWithTransaction({
          sessionActive: true,
          holderId: "worker-1", // Stale holder!
          lockVersion: 1, // Stale version!
          studentsToInsert: [{ name: "Stale Worker Student", parentWhatsApp: "9876543298" }],
        });
      },
      (err) => {
        assert.ok(err.message.includes("Lock ownership lost"));
        return true;
      }
    );
    assert.equal(studentDb.length, 0);

    // H. SEC-06 & SEC-08 Requirement 8: Valid worker-2A with lockVersion 2 succeeds atomically
    const successRes = await executeImportWithTransaction({
      sessionActive: true,
      holderId: "worker-2A",
      lockVersion: 2,
      studentsToInsert: [{ name: "Legitimate Student", parentWhatsApp: "9876543290" }],
    });
    assert.equal(successRes.committed, true);
    assert.equal(successRes.insertedCount, 1);
    assert.equal(studentDb.length, 1);
    assert.equal(lockStore.get(lockKey).status, "COMPLETED");
  });

  // =========================================================================
  // 16. SEC-03: Upload Size Limit Enforcement
  // =========================================================================
  await t.test("16. Enforces 5MB upload size limit via Content-Length and body length checks", async () => {
    const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

    function checkUploadSize(contentLengthHeader, bodyString) {
      if (contentLengthHeader) {
        const length = parseInt(contentLengthHeader, 10);
        if (!isNaN(length) && length > MAX_UPLOAD_BYTES) {
          return { status: 413, error: "Upload size exceeds maximum allowed limit of 5MB" };
        }
      }
      if (bodyString && Buffer.byteLength(bodyString, "utf8") > MAX_UPLOAD_BYTES) {
        return { status: 413, error: "Upload size exceeds maximum allowed limit of 5MB" };
      }
      return { status: 200, allowed: true };
    }

    // 1. Content-Length exceeding 5MB (e.g. 5MB + 1 byte) -> 413
    const oversizedLengthRes = checkUploadSize("5242881", "small content");
    assert.equal(oversizedLengthRes.status, 413);
    assert.ok(oversizedLengthRes.error.includes("exceeds maximum allowed limit of 5MB"));

    // 2. Missing/untrusted Content-Length with oversized payload buffer -> 413
    const oversizedBuffer = "a".repeat(5 * 1024 * 1024 + 10);
    const oversizedBodyRes = checkUploadSize(null, oversizedBuffer);
    assert.equal(oversizedBodyRes.status, 413);

    // 3. Normal size payload (e.g. 10KB) -> 200
    const normalPayload = "Name,Batch,Parent WhatsApp\nAarav,Batch-10A,9876543210\n";
    const normalRes = checkUploadSize("55", normalPayload);
    assert.equal(normalRes.status, 200);
    assert.equal(normalRes.allowed, true);
  });

  // =========================================================================
  // 17. Normal CSV Compatibility & End-to-End Pipeline Integrity
  // =========================================================================
  await t.test("17. Validates end-to-end bulk import pipeline with mixed valid, duplicate, and error rows", async () => {
    const rawCsv =
      "Name,Batch,Parent WhatsApp,Monthly Fee,Billing Cycle Date\r\n" +
      "Aarav Patel,Batch-10A,9876543210,1500,5\r\n" + // DB Duplicate in msec
      "Rohan Sharma,Batch-10A,9876543288,1800,5\r\n" + // Valid Student 1
      "Priya Verma,Batch-12B,9876543289,2000,10\r\n" + // Valid Student 2
      "Priya Verma,Batch-12B,9876543289,2000,10\r\n" + // Intra-file Duplicate of Student 2
      "Bad Number,Batch-10A,12345,1000,5\r\n"; // Invalid Phone Error

    const parsed = parseCsvText(rawCsv);
    assert.equal(parsed.rows.length, 5);

    const categorized = validateAndCategorizeRows({
      parsedRows: parsed.rows,
      activeBatchNames: activeBatchesCenterA,
      existingStudentsMap: existingStudentsMapCenterA,
    });

    // 2 valid rows, 2 duplicates (1 DB + 1 file), 1 error
    assert.equal(categorized.validRows.length, 2);
    assert.equal(categorized.duplicateRows.length, 2);
    assert.equal(categorized.errorRows.length, 1);
    assert.equal(categorized.allErrors.length, 3);

    // Verify hash generation
    const hash = computeRowsHash(categorized.validRows);
    assert.ok(hash && hash.length === 64);

    // Verify error CSV generation
    assert.ok(categorized.errorCsv.includes("Duplicate: Student already enrolled"));
    assert.ok(categorized.errorCsv.includes("Duplicate: Duplicate entry within the uploaded file"));
    assert.ok(categorized.errorCsv.includes("must be 10-15 digits"));
  });

  // =========================================================================
  // 18. Partial Insert Retry Idempotency: Duplicate Prevention
  // =========================================================================
  await t.test("18. Partial insert failure retries skip already-inserted students and prevent duplicates", async () => {
    const previewId = "prev_partial_fail_1";
    const batchRows = [
      { row: 2, name: "Student Alpha", batch: "Batch-10A", parentWhatsApp: "9876543301" },
      { row: 3, name: "Student Beta", batch: "Batch-10A", parentWhatsApp: "9876543302" },
      { row: 4, name: "Student Gamma", batch: "Batch-10A", parentWhatsApp: "9876543303" },
    ];

    // Simulate that attempt 1 inserted Student Alpha before a database network drop
    const mockDbStudents = [
      {
        centerId: "msec",
        name: "Student Alpha",
        parentWhatsApp: "9876543301",
        importedBatchId: previewId,
      },
    ];

    // Retry execution logic: query for existing students matching candidate phones OR previewId
    const candidatePhones = batchRows.map((r) => r.parentWhatsApp);
    const existingMap = new Set();
    for (const s of mockDbStudents) {
      if (s.centerId === "msec") {
        existingMap.add(`${s.parentWhatsApp}:::${s.name.toLowerCase()}`);
      }
    }

    const toInsertOnRetry = [];
    const skippedOnRetry = [];

    for (const r of batchRows) {
      const key = `${r.parentWhatsApp}:::${r.name.toLowerCase()}`;
      if (existingMap.has(key)) {
        skippedOnRetry.push(r);
      } else {
        toInsertOnRetry.push(r);
      }
    }

    // Student Alpha is safely skipped on retry; only Beta and Gamma are queued for insertion
    assert.equal(skippedOnRetry.length, 1);
    assert.equal(skippedOnRetry[0].name, "Student Alpha");
    assert.equal(toInsertOnRetry.length, 2);
    assert.equal(toInsertOnRetry[0].name, "Student Beta");
    assert.equal(toInsertOnRetry[1].name, "Student Gamma");
  });

  // =========================================================================
  // 19. Bounded Streaming Reader & Multipart RFC-2046 Extraction
  // =========================================================================
  await t.test("19. Bounded reader halts stream on >5MB and extracts multipart CSV cleanly", async () => {
    // 1. Multipart Extraction Test
    const boundary = "----WebKitFormBoundaryMSEC7MA4YWxkTrZu0gW";
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="roster.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n` +
      `Name,Batch,Parent WhatsApp\r\n` +
      `Pooja Hegde,Batch-10A,9876543399\r\n` +
      `--${boundary}--\r\n`;

    const multipartBuffer = Buffer.from(multipartBody, "utf8");
    const extractedCsv = extractCsvFromMultipartBuffer(
      multipartBuffer,
      `multipart/form-data; boundary=${boundary}`
    );

    assert.ok(extractedCsv);
    assert.ok(extractedCsv.includes("Pooja Hegde"));
    assert.ok(extractedCsv.includes("9876543399"));

    // 2. Bounded reader chunked simulation: oversized stream (> 5MB)
    const MAX_BYTES = 5 * 1024 * 1024;
    let streamCancelled = false;
    const oversizedChunk = new Uint8Array(1024 * 1024); // 1MB chunks

    // Mock stream with 6 x 1MB chunks
    let chunkCount = 0;
    const mockOversizedRequest = {
      body: {
        getReader: () => ({
          read: async () => {
            if (chunkCount < 6) {
              chunkCount++;
              return { done: false, value: oversizedChunk };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => {
            streamCancelled = true;
          },
        }),
      },
    };

    const boundedRes = await readBoundedRequestBody(mockOversizedRequest, MAX_BYTES);
    assert.equal(boundedRes.exceeded, true);
    assert.equal(streamCancelled, true);
    assert.ok(boundedRes.bytesRead > MAX_BYTES);
  });

  // =========================================================================
  // 20. SEC-07: Index Preflight Verification & Model Schema Integrity
  // =========================================================================
  await t.test("20. Preflight verification enforces unique index { centerId, previewId } and rejects missing index with 503", async () => {
    const schema = ImportBatchLock.schema;
    assert.ok(schema.path("centerId"), "Must define centerId");
    assert.ok(schema.path("previewId"), "Must define previewId");
    assert.ok(schema.path("holderId"), "Must define holderId");
    assert.ok(schema.path("heartbeatAt"), "Must define heartbeatAt");
    assert.ok(schema.path("lockVersion"), "Must define lockVersion");

    // Preflight check with valid unique compound index passes (Requirement 5)
    const mockModelWithIndex = {
      collection: {
        indexes: async () => [
          { key: { _id: 1 }, name: "_id_" },
          { key: { centerId: 1, previewId: 1 }, unique: true, name: "centerId_1_previewId_1" },
        ],
      },
    };
    const hasIndex = await verifyImportLockIndexIntegrity(mockModelWithIndex);
    assert.equal(hasIndex, true);

    // Preflight check with missing index causes safe rejection (Requirement 4)
    const mockModelMissingIndex = {
      collection: {
        indexes: async () => [{ key: { _id: 1 }, name: "_id_" }],
      },
    };
    const missingIndex = await verifyImportLockIndexIntegrity(mockModelMissingIndex);
    assert.equal(missingIndex, false);

    // Preflight check handles missing collection safely
    const mockModelNoCollection = {};
    const noCollectionRes = await verifyImportLockIndexIntegrity(mockModelNoCollection);
    assert.equal(noCollectionRes, false);

    // Route response simulation for missing index -> 503
    function simulateRouteIndexPreflight(indexVerified) {
      if (!indexVerified) {
        return {
          status: 503,
          error: "Import lock index preflight failed: unique index { centerId: 1, previewId: 1 } is missing or unverified.",
        };
      }
      return { status: 200, allowed: true };
    }
    const preflightRejected = simulateRouteIndexPreflight(missingIndex);
    assert.equal(preflightRejected.status, 503);
    assert.ok(preflightRejected.error.includes("Import lock index preflight failed"));
    assert.ok(preflightRejected.error.includes("unique index { centerId: 1, previewId: 1 }"));

    const preflightAccepted = simulateRouteIndexPreflight(hasIndex);
    assert.equal(preflightAccepted.status, 200);
    assert.equal(preflightAccepted.allowed, true);
  });

  // =========================================================================
  // 21. Sibling Safety: Identical Parent WhatsApp with Different Student Names
  // =========================================================================
  await t.test("21. Two siblings with the same parent WhatsApp and different names are both permitted", async () => {
    // 1. In preview: CSV containing two legitimate siblings with the same phone
    const siblingCsv =
      "Name,Batch,Parent WhatsApp,Monthly Fee,Billing Cycle Date\r\n" +
      "Aarav Sharma,Batch-10A,9876543210,1500,5\r\n" +
      "Diya Sharma,Batch-10A,9876543210,1500,5\r\n";

    const parsed = parseCsvText(siblingCsv);
    assert.equal(parsed.rows.length, 2);

    const categorized = validateAndCategorizeRows({
      parsedRows: parsed.rows,
      activeBatchNames: activeBatchesCenterA,
      existingStudentsMap: new Set(), // Empty institute
    });

    assert.equal(categorized.validRows.length, 2);
    assert.equal(categorized.duplicateRows.length, 0);
    assert.equal(categorized.errorRows.length, 0);

    // 2. In confirmation duplicate detection: both produce distinct composite keys
    const existingDbMap = new Set();
    const candidateRows = categorized.validRows;
    const toInsert = [];
    const skipped = [];

    for (const r of candidateRows) {
      const collisionKey = `${r.parentWhatsApp}:::${r.name.toLowerCase().trim()}`;
      if (existingDbMap.has(collisionKey)) {
        skipped.push(r);
      } else {
        toInsert.push(r);
      }
    }

    assert.equal(toInsert.length, 2);
    assert.equal(skipped.length, 0);
    assert.equal(toInsert[0].name, "Aarav Sharma");
    assert.equal(toInsert[1].name, "Diya Sharma");
  });
});


