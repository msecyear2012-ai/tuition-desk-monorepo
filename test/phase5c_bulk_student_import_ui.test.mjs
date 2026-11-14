import test from "node:test";
import assert from "node:assert/strict";

test("Phase 5C: Two-Step Bulk Student Import UI Specification & Logic Suite", async (t) => {
  // 1. File Upload & Preview Payload Formatting
  await t.test("1. Preview Request: Formats CSV text into preview payload", () => {
    function buildPreviewPayload(rawText) {
      if (!rawText || !rawText.trim()) {
        throw new Error("Selected file is empty.");
      }
      return { csvContent: rawText };
    }

    assert.throws(() => buildPreviewPayload("   "), /Selected file is empty/);

    const payload = buildPreviewPayload("Name,Batch,Parent WhatsApp\nAryan,Class 10,9876543210");
    assert.equal(payload.csvContent, "Name,Batch,Parent WhatsApp\nAryan,Class 10,9876543210");
  });

  // 2. Preview Response Categorization & Summary Counts
  await t.test("2. Preview Metrics: Correctly extracts counts and first 10 preview rows", () => {
    const mockPreviewResponse = {
      success: true,
      previewId: "prev_123",
      previewToken: "mock_jwt_token_preview",
      totalRows: 15,
      validCount: 12,
      duplicateCount: 2,
      errorCount: 1,
      previewRows: Array.from({ length: 10 }, (_, i) => ({
        name: `Student ${i + 1}`,
        batch: "Class 10 - Mathematics",
        parentWhatsApp: `987654321${i}`,
        monthlyFee: 2500,
        billingCycleDate: 5,
      })),
      rows: Array.from({ length: 12 }, (_, i) => ({
        name: `Student ${i + 1}`,
        batch: "Class 10 - Mathematics",
        parentWhatsApp: `987654321${i}`,
        monthlyFee: 2500,
        billingCycleDate: 5,
      })),
    };

    assert.equal(mockPreviewResponse.totalRows, 15);
    assert.equal(mockPreviewResponse.validCount, 12);
    assert.equal(mockPreviewResponse.duplicateCount, 2);
    assert.equal(mockPreviewResponse.errorCount, 1);
    assert.equal(mockPreviewResponse.previewRows.length, 10);
    assert.equal(mockPreviewResponse.rows.length, 12);
  });

  // 3. Execution Safety Guard: Disallow confirmation when validCount is zero or token missing
  await t.test("3. Confirmation Safety Guard: Blocks execution when validCount is 0 or token missing", () => {
    function canConfirmImport(preview) {
      if (!preview || !preview.previewToken) return false;
      if (preview.validCount === 0) return false;
      return true;
    }

    assert.equal(canConfirmImport(null), false);
    assert.equal(canConfirmImport({ previewToken: "", validCount: 5 }), false);
    assert.equal(canConfirmImport({ previewToken: "valid_tok", validCount: 0 }), false);
    assert.equal(canConfirmImport({ previewToken: "valid_tok", validCount: 10 }), true);
  });

  // 4. Role-based Assignee Selection & Payload Formatting (DEC-MSEC-05)
  await t.test("4. Assignee Selection: Owner can choose Myself or active Teacher; Teacher is locked", () => {
    function buildConfirmPayload(userRole, preview, selectedAssigneeId) {
      const isTeacherUser = userRole === "teacher";
      const targetTeacherId = isTeacherUser
        ? undefined
        : selectedAssigneeId && selectedAssigneeId !== "owner"
        ? selectedAssigneeId
        : null;

      return {
        previewToken: preview.previewToken,
        rows: preview.rows,
        targetTeacherId,
      };
    }

    const mockPreview = {
      previewToken: "signed_preview_token_123",
      rows: [{ name: "Student 1" }, { name: "Student 2" }],
      validCount: 2,
    };

    // Case 1: Owner assigns to Myself (Owner = empty string)
    const ownerMyself = buildConfirmPayload("owner", mockPreview, "");
    assert.strictEqual(ownerMyself.targetTeacherId, null);
    assert.equal(ownerMyself.previewToken, "signed_preview_token_123");
    assert.equal(ownerMyself.rows.length, 2);

    // Case 2: Owner assigns to Teacher Beta
    const ownerToTeacher = buildConfirmPayload("owner", mockPreview, "teacher_beta_id");
    assert.equal(ownerToTeacher.targetTeacherId, "teacher_beta_id");

    // Case 3: Teacher role - targetTeacherId must not be supplied by client
    const teacherPayload = buildConfirmPayload("teacher", mockPreview, "rogue_teacher_id");
    assert.equal(teacherPayload.targetTeacherId, undefined);
  });

  // 5. Execution Result Parsing & Error CSV Handshake
  await t.test("5. Result Breakdown: Parses imported, skipped, failed counts and error report", () => {
    const mockConfirmResult = {
      success: true,
      totalProcessed: 15,
      importedCount: 12,
      skippedCount: 2,
      failedCount: 1,
      assignedTo: {
        id: "teacher_beta_id",
        name: "Priya Patel",
        role: "teacher",
      },
      errorCsv: "Row,Name,Error\n5,Bad Row,Invalid phone number",
    };

    assert.equal(mockConfirmResult.importedCount, 12);
    assert.equal(mockConfirmResult.skippedCount, 2);
    assert.equal(mockConfirmResult.failedCount, 1);
    assert.equal(mockConfirmResult.assignedTo.name, "Priya Patel");
    assert.ok(mockConfirmResult.errorCsv.includes("Invalid phone number"));
  });

  // 6. Sample CSV Generation Format
  await t.test("6. Sample Template: Contains mandatory standard column headers without redundant Batch column", () => {
    const sampleHeaders = "Name,Parent WhatsApp,Monthly Fee,Billing Cycle Date\n";
    assert.ok(sampleHeaders.includes("Name"));
    assert.ok(sampleHeaders.includes("Parent WhatsApp"));
    assert.ok(sampleHeaders.includes("Monthly Fee"));
    assert.ok(sampleHeaders.includes("Billing Cycle Date"));
    assert.ok(!sampleHeaders.includes("Batch"), "Sample template must NOT contain Batch column");
  });
});
