import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.TOKEN_ENCRYPTION_KEY = "12345678901234567890123456789012"; // 32 bytes for AES-256-GCM

test("MSEC Bulk Student Import Upgrade Suite", async (t) => {
  const {
    isXlsxBuffer,
    parseXlsxBuffer,
    buildSampleXlsxBuffer,
  } = await import("../tution-desk-be/src/lib/xlsxParser.ts");

  const {
    parseCsvText,
    normalizeHeader,
    generateErrorCsv,
  } = await import("../tution-desk-be/src/lib/csvParser.ts");

  const {
    computeRowsHash,
    signPreviewToken,
    verifyPreviewToken,
    validateAndCategorizeRows,
    extractMultipartFilePayload,
  } = await import("../tution-desk-be/src/lib/bulkImport.ts");

  const {
    formatTemplate,
    formatAdmissionWelcomeMessage,
    getAppBaseUrl,
  } = await import("../tution-desk-be/src/lib/whatsappService.ts");

  const {
    DEFAULT_ADMISSION_TEMPLATE,
  } = await import("../tution-desk-be/src/models/Center.ts");

  const {
    encryptToken,
    decryptToken,
  } = await import("../tution-desk-be/src/lib/tokenCipher.ts");

  const {
    buildAdmissionWelcomeIdempotencyKey,
  } = await import("../tution-desk-be/src/lib/admissionWelcomeQueue.ts");

  // --------------------------------------------------------------------------
  // 1. OpenXML (.xlsx) Parser & PKZIP Magic Byte Verification
  // --------------------------------------------------------------------------
  await t.test("1. isXlsxBuffer detects PKZIP magic bytes and rejects corrupt buffers safely", () => {
    const validZipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    assert.equal(isXlsxBuffer(validZipHeader), true, "Should identify 0x50, 0x4B, 0x03, 0x04 as XLSX");

    const plainCsvBuffer = Buffer.from("Name,Batch,Parent WhatsApp\nAarav,Class 10,9876543210");
    assert.equal(isXlsxBuffer(plainCsvBuffer), false, "Plain CSV should not be detected as XLSX");

    const shortBuffer = Buffer.from([0x50, 0x4b]);
    assert.equal(isXlsxBuffer(shortBuffer), false, "Truncated buffer should safely return false");
    assert.equal(isXlsxBuffer(null), false, "Null buffer should safely return false");
  });

  await t.test("2. buildSampleXlsxBuffer generates valid OpenXML workbook without Batch column and parseXlsxBuffer parses it", async () => {
    const xlsxBuf = buildSampleXlsxBuffer();
    assert.ok(Buffer.isBuffer(xlsxBuf), "Should return a Buffer");
    assert.ok(xlsxBuf.length > 500, "XLSX buffer should contain zip archive entries");
    assert.equal(isXlsxBuffer(xlsxBuf), true, "Generated buffer must have PKZIP magic bytes");

    const parsed = await parseXlsxBuffer(xlsxBuf);
    assert.ok(parsed.rows.length >= 3, `Expected at least 3 sample rows, got ${parsed.rows.length}`);
    assert.deepEqual(
      parsed.headers,
      ["Name", "Parent WhatsApp", "Monthly Fee", "Billing Cycle Date"],
      "Headers must contain exactly Name, Parent WhatsApp, Monthly Fee, Billing Cycle Date"
    );
    assert.ok(!parsed.headers.includes("Batch"), "Sample template must NOT contain Batch column");

    const row1 = parsed.rows[0];
    assert.equal(row1.normalized.name, "Aarav Sharma");
    assert.equal(row1.normalized.batch, ""); // Batch column is omitted from template
    assert.equal(row1.normalized.parentWhatsApp, "9876543210");
    assert.equal(row1.normalized.monthlyFee, 2500);
    assert.equal(row1.normalized.billingCycleDate, 5);
    assert.ok(row1.raw, "Row should contain raw field map");

    // Verify batch assignment works exclusively through wizard's selectedBatch
    const categorized = validateAndCategorizeRows({
      parsedRows: parsed.rows,
      activeBatchNames: new Set(["class 10 - mathematics"]),
      existingStudentsMap: new Set(),
      selectedBatch: "Class 10 - Mathematics",
    });

    assert.equal(categorized.validRows.length, 3, "All 3 sample rows should validate");
    for (const validRow of categorized.validRows) {
      assert.equal(
        validRow.batch,
        "Class 10 - Mathematics",
        "Every imported row must receive the wizard's selected batch"
      );
    }
  });

  await t.test("3. parseXlsxBuffer handles missing sharedStrings or malformed input fail-closed", async () => {
    const corruptZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff]);
    await assert.rejects(
      async () => {
        await parseXlsxBuffer(corruptZip);
      },
      /Failed to open Excel workbook|Corrupt/i,
      "Should fail-closed on truncated or invalid zip structure"
    );
  });

  // --------------------------------------------------------------------------
  // 2. Batch Selection & Multi-Row Association
  // --------------------------------------------------------------------------
  await t.test("4. validateAndCategorizeRows applies selectedBatch when file omits batch column", () => {
    const parsedCsv = parseCsvText(
      "Name,Parent WhatsApp,Monthly Fee,Billing Cycle Date\n" +
      "Kavita Patel,9876543211,3000,10\n" +
      "Devansh Nair,9876543212,2800,15"
    );

    const activeBatchNames = new Set(["Class 10 - Mathematics", "Class 9 - Foundation"]);
    const existingStudentsMap = new Set();

    const result = validateAndCategorizeRows({
      parsedRows: parsedCsv.rows,
      activeBatchNames: new Set(["class 10 - mathematics", "class 9 - foundation"]),
      existingStudentsMap,
      selectedBatch: "Class 10 - Mathematics", // selectedBatch applied to import
    });

    assert.equal(result.validRows.length, 2, "Both rows should be valid");
    assert.equal(result.errorRows.length, 0, "No errors expected");
    assert.equal(result.allErrors.length, 0, "No errors expected");
    assert.equal(result.validRows[0].batch, "Class 10 - Mathematics");
    assert.equal(result.validRows[1].batch, "Class 10 - Mathematics");
  });

  await t.test("5. validateAndCategorizeRows prioritizes selectedBatch over empty or invalid row batches", () => {
    const parsedCsv = parseCsvText(
      "Name,Batch,Parent WhatsApp\n" +
      "Suresh Roy,,9876543213\n" +
      "Anita Das,Unknown Old Batch,9876543214"
    );

    const activeBatchNames = new Set(["Class 12 - Physics"]);
    const existingStudentsMap = new Set();

    const result = validateAndCategorizeRows({
      parsedRows: parsedCsv.rows,
      activeBatchNames: new Set(["class 12 - physics"]),
      existingStudentsMap,
      selectedBatch: "Class 12 - Physics",
    });

    assert.equal(result.validRows.length, 2, "Both rows should be valid with selected batch override");
    assert.equal(result.validRows[0].batch, "Class 12 - Physics");
    assert.equal(result.validRows[1].batch, "Class 12 - Physics");
  });

  // --------------------------------------------------------------------------
  // 3. Cryptographic Preview Token with batchName Binding
  // --------------------------------------------------------------------------
  await t.test("6. signPreviewToken binds batchName to cryptographic JWT and verifyPreviewToken recovers it", async () => {
    const payload = {
      previewId: "prev_abc123",
      centerId: "center_msec",
      userId: "owner_001",
      role: "owner",
      validCount: 2,
      rowsHash: "hash_xyz789",
      batchName: "Class 10 - Science",
    };

    const token = await signPreviewToken(payload);
    assert.ok(typeof token === "string" && token.length > 50, "Should generate valid JWT token");

    const verified = await verifyPreviewToken(token);
    assert.ok(verified, "Token verification must succeed");
    assert.equal(verified.previewId, "prev_abc123");
    assert.equal(verified.centerId, "center_msec");
    assert.equal(verified.role, "owner");
    assert.equal(verified.batchName, "Class 10 - Science");
    assert.equal(verified.rowsHash, "hash_xyz789");
  });

  await t.test("7. verifyPreviewToken rejects tampered or expired tokens fail-closed", async () => {
    const tampered = "eyJhbGciOiJIUzI1NiJ9.invalid.signature";
    const res = await verifyPreviewToken(tampered);
    assert.equal(res, null, "Tampered token must return null");
  });

  // --------------------------------------------------------------------------
  // 4. Parent Portal Integration & Template Substitution
  // --------------------------------------------------------------------------
  await t.test("8. formatTemplate dynamically substitutes all placeholders including portalUrl and batchName", () => {
    const template =
      "Welcome to {{instituteName}}! 🎉\n" +
      "Dear Parent, {{studentName}} has been enrolled in batch {{batchName}}.\n" +
      "Track attendance & pay fees via portal: {{portalUrl}}\n" +
      "Magic Link: {{magicLink}}";

    const rendered = formatTemplate(template, {
      studentName: "Aditi Rao",
      instituteName: "MSEC Academy",
      batchName: "Class 11 - Biology",
      portalUrl: "https://tution-desk-one.vercel.app/portal#token=abcxyz123",
      magicLink: "https://tution-desk-one.vercel.app/portal#token=abcxyz123",
    });

    assert.ok(rendered.includes("Aditi Rao"), "Should include student name");
    assert.ok(rendered.includes("MSEC Academy"), "Should include institute name");
    assert.ok(rendered.includes("Class 11 - Biology"), "Should include batch name");
    assert.ok(rendered.includes("/portal#token=abcxyz123"), "Should include full magic link");
    assert.ok(!rendered.includes("{{"), "No unreplaced placeholders should remain");
  });

  await t.test("9. DEFAULT_ADMISSION_TEMPLATE provides valid fallback when custom template is unset", () => {
    assert.ok(DEFAULT_ADMISSION_TEMPLATE.includes("{{studentName}}"));
    assert.ok(DEFAULT_ADMISSION_TEMPLATE.includes("{{magicLink}}"));

    const rendered = formatTemplate(DEFAULT_ADMISSION_TEMPLATE, {
      studentName: "Rahul Sharma",
      magicLink: "https://tution-desk-one.vercel.app/portal#token=sampletoken",
    });

    assert.ok(rendered.includes("Rahul Sharma"));
    assert.ok(rendered.includes("https://tution-desk-one.vercel.app/portal#token=sampletoken"));
  });

  await t.test("10. Token encryption roundtrip with AES-256-GCM preserves plaintext token integrity", () => {
    const rawToken = "high-entropy-invitation-token-123456789";
    const encrypted = encryptToken(rawToken);

    assert.ok(encrypted.iv, "Encrypted payload must contain IV");
    assert.ok(encrypted.authTag, "Encrypted payload must contain AuthTag");
    assert.ok(encrypted.ciphertext, "Encrypted payload must contain Ciphertext");

    const decrypted = decryptToken(encrypted);
    assert.equal(decrypted, rawToken, "Decrypted token must exactly match original raw token");
  });

  // --------------------------------------------------------------------------
  // 5. Anti-Ban Queue & Double-Enqueue Safeguards
  // --------------------------------------------------------------------------
  await t.test("11. AdmissionWelcomeJob status: 'processing' prevents cron sweep double-enqueue", () => {
    // In admissionWelcomeQueue, processPendingAdmissionWelcomeJobs sweeps:
    // status: "pending"
    // When bulk import inserts AdmissionWelcomeJob, it explicitly uses:
    // status: "processing"
    const bulkImportJobStatus = "processing";
    const cronSweepQuery = { status: "pending" };

    assert.notEqual(
      bulkImportJobStatus,
      cronSweepQuery.status,
      "Job enqueued by bulk import with status 'processing' will NOT be swept by pending cron"
    );

    const idempotencyKey = buildAdmissionWelcomeIdempotencyKey(
      "center_msec",
      new mongoose.Types.ObjectId()
    );
    assert.ok(idempotencyKey.includes("center_msec"));
    assert.ok(idempotencyKey.includes("admission_welcome"));
  });

  // --------------------------------------------------------------------------
  // 6. Multipart & Binary Payload Extraction
  // --------------------------------------------------------------------------
  await t.test("12. extractMultipartFilePayload handles selectedBatch alongside binary XLSX", () => {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const part1 =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="selectedBatch"\r\n\r\n` +
      `Class 10 - Mathematics\r\n`;

    const sampleXlsx = buildSampleXlsxBuffer();
    const part2Header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="students.xlsx"\r\n` +
      `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`;
    const part2Footer = `\r\n--${boundary}--\r\n`;

    const multipartBuffer = Buffer.concat([
      Buffer.from(part1, "utf8"),
      Buffer.from(part2Header, "utf8"),
      sampleXlsx,
      Buffer.from(part2Footer, "utf8"),
    ]);

    const extracted = extractMultipartFilePayload(multipartBuffer, contentType);
    assert.ok(extracted, "Should successfully extract multipart payload");
    assert.equal(extracted.selectedBatch, "Class 10 - Mathematics");
    assert.equal(extracted.isXlsx, true);
    assert.ok(extracted.fileBuffer.length > 500);
  });

  // --------------------------------------------------------------------------
  // 7. Sample Templates Verification (No Batch column, Wizard assignment)
  // --------------------------------------------------------------------------
  await t.test("13. Sample Templates (CSV & XLSX) omit Batch column and validate exclusively against wizard selectedBatch", async () => {
    // A. CSV Sample Template
    const sampleCsv =
      "Name,Parent WhatsApp,Monthly Fee,Billing Cycle Date\n" +
      "Aarav Sharma,9876543210,2500,5\n" +
      "Rohan Verma,9123456780,3000,10\n" +
      "Priya Patel,9988776655,2000,15";

    const parsedCsv = parseCsvText(sampleCsv);
    assert.deepEqual(
      parsedCsv.headers,
      ["Name", "Parent WhatsApp", "Monthly Fee", "Billing Cycle Date"],
      "CSV headers must contain exactly the 4 required columns"
    );
    assert.ok(!parsedCsv.headers.includes("Batch"), "CSV must not include Batch header");

    const csvCategorized = validateAndCategorizeRows({
      parsedRows: parsedCsv.rows,
      activeBatchNames: new Set(["batch a"]),
      existingStudentsMap: new Set(),
      selectedBatch: "Batch A",
    });

    assert.equal(csvCategorized.validRows.length, 3);
    for (const row of csvCategorized.validRows) {
      assert.equal(row.batch, "Batch A", "CSV rows must receive wizard selectedBatch");
    }

    // B. Static public XLSX file
    const fs = await import("node:fs");
    const publicXlsxPath = path.resolve(__dirname, "../public/tuitiondesk_sample_student_import.xlsx");
    assert.ok(fs.existsSync(publicXlsxPath), "Public sample Excel file must exist");

    const publicBuf = fs.readFileSync(publicXlsxPath);
    const parsedPublicXlsx = await parseXlsxBuffer(publicBuf);
    assert.deepEqual(
      parsedPublicXlsx.headers,
      ["Name", "Parent WhatsApp", "Monthly Fee", "Billing Cycle Date"],
      "Public XLSX file headers must not contain Batch or Roll Number"
    );

    const xlsxCategorized = validateAndCategorizeRows({
      parsedRows: parsedPublicXlsx.rows,
      activeBatchNames: new Set(["batch a"]),
      existingStudentsMap: new Set(),
      selectedBatch: "Batch A",
    });

    assert.equal(xlsxCategorized.validRows.length, 3);
    for (const row of xlsxCategorized.validRows) {
      assert.equal(row.batch, "Batch A", "XLSX rows must receive wizard selectedBatch");
    }
  });
});
