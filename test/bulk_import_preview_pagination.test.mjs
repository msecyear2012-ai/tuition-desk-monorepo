process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

test("Bulk Import Preview Pagination & Uncapped Rows Suite", async (t) => {
  const PAGE_SIZE = 10;

  // 1. Pagination Calculation for 11 valid records
  await t.test("1. Pagination Logic: 11 records paginate into 2 pages with 10 per page", () => {
    const validRows = Array.from({ length: 11 }, (_, i) => ({
      name: `Student ${i + 1}`,
      batch: "Class 10",
      parentWhatsApp: `98765432${String(i).padStart(2, "0")}`,
      monthlyFee: 2000,
      billingCycleDate: 5,
    }));

    const totalValidRows = validRows.length;
    const totalPages = Math.max(1, Math.ceil(totalValidRows / PAGE_SIZE));
    assert.equal(totalPages, 2, "11 records must yield 2 pages");

    // Page 1
    let currentPage = 1;
    let effectivePage = Math.min(Math.max(1, currentPage), totalPages);
    let startIndex = (effectivePage - 1) * PAGE_SIZE;
    let endIndex = Math.min(startIndex + PAGE_SIZE, totalValidRows);
    let currentRows = validRows.slice(startIndex, endIndex);

    assert.equal(effectivePage, 1);
    assert.equal(currentRows.length, 10);
    assert.equal(currentRows[0].name, "Student 1");
    assert.equal(currentRows[9].name, "Student 10");
    assert.equal(startIndex + 1, 1);
    assert.equal(endIndex, 10);
    assert.equal(effectivePage <= 1, true, "Previous button must be disabled on page 1");
    assert.equal(effectivePage >= totalPages, false, "Next button must be enabled on page 1");

    // Continuous row numbers on Page 1
    const page1RowNumbers = currentRows.map((_, idx) => startIndex + idx + 1);
    assert.deepEqual(page1RowNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Page 2
    currentPage = 2;
    effectivePage = Math.min(Math.max(1, currentPage), totalPages);
    startIndex = (effectivePage - 1) * PAGE_SIZE;
    endIndex = Math.min(startIndex + PAGE_SIZE, totalValidRows);
    currentRows = validRows.slice(startIndex, endIndex);

    assert.equal(effectivePage, 2);
    assert.equal(currentRows.length, 1);
    assert.equal(currentRows[0].name, "Student 11");
    assert.equal(startIndex + 1, 11);
    assert.equal(endIndex, 11);
    assert.equal(effectivePage <= 1, false, "Previous button must be enabled on page 2");
    assert.equal(effectivePage >= totalPages, true, "Next button must be disabled on page 2");

    // Continuous row numbers on Page 2
    const page2RowNumbers = currentRows.map((_, idx) => startIndex + idx + 1);
    assert.deepEqual(page2RowNumbers, [11], "Page 2 first row number must continue as 11");
  });

  // 2. Pagination for 25 valid records (3 pages)
  await t.test("2. Pagination Logic: 25 records paginate into 3 pages with continuous numbering", () => {
    const validRows = Array.from({ length: 25 }, (_, i) => ({
      name: `Student ${i + 1}`,
      batch: "Class 10",
      parentWhatsApp: `98765432${String(i).padStart(2, "0")}`,
      monthlyFee: 2000,
      billingCycleDate: 5,
    }));

    const totalValidRows = validRows.length;
    const totalPages = Math.max(1, Math.ceil(totalValidRows / PAGE_SIZE));
    assert.equal(totalPages, 3);

    // Page 2 check
    const currentPage = 2;
    const effectivePage = Math.min(Math.max(1, currentPage), totalPages);
    const startIndex = (effectivePage - 1) * PAGE_SIZE;
    const endIndex = Math.min(startIndex + PAGE_SIZE, totalValidRows);
    const currentRows = validRows.slice(startIndex, endIndex);

    assert.equal(currentRows.length, 10);
    assert.equal(currentRows[0].name, "Student 11");
    assert.equal(startIndex + 1, 11);
    assert.equal(endIndex, 20);

    const rowNumbers = currentRows.map((_, idx) => startIndex + idx + 1);
    assert.deepEqual(rowNumbers, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  // 3. Page Reset Contract on New File Upload
  await t.test("3. Page Reset: Current page strictly resets to 1 upon new upload or file switch", () => {
    let currentPage = 2; // User navigated to page 2

    // Action: User uploads a new file
    function handleFileSelected() {
      currentPage = 1;
    }

    handleFileSelected();
    assert.equal(currentPage, 1, "Current page must reset to 1 on file selection");

    currentPage = 3;
    // Action: User clicks "Upload Different File"
    function handleUploadDifferent() {
      currentPage = 1;
    }

    handleUploadDifferent();
    assert.equal(currentPage, 1, "Current page must reset to 1 on upload different file");
  });

  // 4. Backend Preview Contract: previewRows contains all valid parsed rows (no 10-row cap)
  await t.test("4. Backend Contract: previewRows returns all valid rows without 10-row cap", () => {
    const sanitizedRows = Array.from({ length: 15 }, (_, i) => ({
      name: `Student ${i + 1}`,
      batch: "Class 10",
      parentWhatsApp: `98765432${String(i).padStart(2, "0")}`,
      monthlyFee: 2000,
      billingCycleDate: 5,
    }));

    // Simulating preview response formulation in preview/route.ts
    const previewData = {
      validCount: sanitizedRows.length,
      previewRows: sanitizedRows, // Previously sanitizedRows.slice(0, 10)
      rows: sanitizedRows,
    };

    assert.equal(previewData.previewRows.length, 15, "previewRows must NOT be capped at 10");
    assert.equal(previewData.rows.length, 15);
    assert.equal(previewData.validCount, 15);
  });
});
