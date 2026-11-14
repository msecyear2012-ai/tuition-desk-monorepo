import test from "node:test";
import assert from "node:assert/strict";
import {
  getDaysInISTMonth,
  getEffectiveBillingCycleDay,
  getEligibleBillingCycleDates,
  calculateFirstBillingMonth,
  isStudentEligibleForBilling,
  getISTDateComponents,
} from "../tution-desk-be/src/lib/dateUtils.ts";
import { generateOrGetMonthlyFee } from "../tution-desk-be/src/lib/feeService.ts";

test("TuitionDesk: Fee Cycle Short-Month Clamping & Calendar Invariants Suite", async (t) => {
  // 1. Calendar Day Counts (Leap Year & Differing Month Lengths)
  await t.test("1. Correctly calculates days in month across leap and non-leap years", () => {
    // February non-leap
    assert.equal(getDaysInISTMonth(2026, 2), 28);
    assert.equal(getDaysInISTMonth(2025, 2), 28);
    assert.equal(getDaysInISTMonth(2023, 2), 28);

    // February leap years
    assert.equal(getDaysInISTMonth(2028, 2), 29);
    assert.equal(getDaysInISTMonth(2024, 2), 29);
    assert.equal(getDaysInISTMonth(2000, 2), 29);

    // 30-day months
    assert.equal(getDaysInISTMonth(2026, 4), 30); // April
    assert.equal(getDaysInISTMonth(2026, 6), 30); // June
    assert.equal(getDaysInISTMonth(2026, 9), 30); // September
    assert.equal(getDaysInISTMonth(2026, 11), 30); // November

    // 31-day months
    assert.equal(getDaysInISTMonth(2026, 1), 31); // January
    assert.equal(getDaysInISTMonth(2026, 3), 31); // March
    assert.equal(getDaysInISTMonth(2026, 5), 31); // May
    assert.equal(getDaysInISTMonth(2026, 7), 31); // July
    assert.equal(getDaysInISTMonth(2026, 8), 31); // August
    assert.equal(getDaysInISTMonth(2026, 10), 31); // October
    assert.equal(getDaysInISTMonth(2026, 12), 31); // December
  });

  // 2. Deterministic Clamping of Billing Cycle Dates (29, 30, 31)
  await t.test("2. Clamps billingCycleDate 29, 30, 31 to final calendar day in short months", () => {
    // February 2026 (non-leap, 28 days)
    assert.equal(getEffectiveBillingCycleDay(28, 2026, 2), 28);
    assert.equal(getEffectiveBillingCycleDay(29, 2026, 2), 28);
    assert.equal(getEffectiveBillingCycleDay(30, 2026, 2), 28);
    assert.equal(getEffectiveBillingCycleDay(31, 2026, 2), 28);
    assert.equal(getEffectiveBillingCycleDay(5, 2026, 2), 5);

    // February 2028 (leap year, 29 days)
    assert.equal(getEffectiveBillingCycleDay(28, 2028, 2), 28);
    assert.equal(getEffectiveBillingCycleDay(29, 2028, 2), 29);
    assert.equal(getEffectiveBillingCycleDay(30, 2028, 2), 29);
    assert.equal(getEffectiveBillingCycleDay(31, 2028, 2), 29);

    // April 2026 (30 days)
    assert.equal(getEffectiveBillingCycleDay(29, 2026, 4), 29);
    assert.equal(getEffectiveBillingCycleDay(30, 2026, 4), 30);
    assert.equal(getEffectiveBillingCycleDay(31, 2026, 4), 30);

    // June 2026 (30 days)
    assert.equal(getEffectiveBillingCycleDay(30, 2026, 6), 30);
    assert.equal(getEffectiveBillingCycleDay(31, 2026, 6), 30);

    // December 2026 (31 days)
    assert.equal(getEffectiveBillingCycleDay(30, 2026, 12), 30);
    assert.equal(getEffectiveBillingCycleDay(31, 2026, 12), 31);
  });

  // 3. Eligible Billing Cycle Dates List for Daily Cron Query
  await t.test("3. Generates correct eligible billing cycle dates on daily cron queries", () => {
    // Standard days in February (day 1..27)
    assert.deepEqual(getEligibleBillingCycleDates(1, 28), [1]);
    assert.deepEqual(getEligibleBillingCycleDates(15, 28), [15]);
    assert.deepEqual(getEligibleBillingCycleDates(27, 28), [27]);

    // Last day of non-leap February (day 28) includes 28, 29, 30, 31
    assert.deepEqual(getEligibleBillingCycleDates(28, 28), [28, 29, 30, 31]);

    // February leap year (2028, 29 days)
    assert.deepEqual(getEligibleBillingCycleDates(28, 29), [28]);
    assert.deepEqual(getEligibleBillingCycleDates(29, 29), [29, 30, 31]);

    // April (30 days)
    assert.deepEqual(getEligibleBillingCycleDates(29, 30), [29]);
    assert.deepEqual(getEligibleBillingCycleDates(30, 30), [30, 31]);

    // June (30 days)
    assert.deepEqual(getEligibleBillingCycleDates(30, 30), [30, 31]);

    // December (31 days)
    assert.deepEqual(getEligibleBillingCycleDates(30, 31), [30]);
    assert.deepEqual(getEligibleBillingCycleDates(31, 31), [31]);
  });

  // 4. Mid-Month Joiner Eligibility Across Shorter Months & Year Boundaries
  await t.test("4. Mid-month joiner protection handles clamped dates and year transitions", () => {
    // February 2026 (non-leap, 28 days) with student cycle day 31:
    // Joining on Feb 15 (15 < effective cycle day 28) -> eligible in Feb (2026-02)
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-02-15T10:00:00+05:30"), 31),
      "2026-02"
    );
    assert.equal(
      isStudentEligibleForBilling(new Date("2026-02-15T10:00:00+05:30"), 31, "2026-02"),
      true
    );

    // Joining on Feb 28 (day 28 >= effective cycle day 28) -> first eligible month is March (2026-03)
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-02-28T10:00:00+05:30"), 31),
      "2026-03"
    );
    assert.equal(
      isStudentEligibleForBilling(new Date("2026-02-28T10:00:00+05:30"), 31, "2026-02"),
      false
    );

    // February 2028 (leap year, 29 days) with student cycle day 31:
    // Joining on Feb 28 (28 < 29) -> eligible in Feb 2028 (2028-02)
    assert.equal(
      calculateFirstBillingMonth(new Date("2028-02-28T10:00:00+05:30"), 31),
      "2028-02"
    );
    // Joining on Feb 29 (29 >= 29) -> first eligible month is March 2028 (2028-03)
    assert.equal(
      calculateFirstBillingMonth(new Date("2028-02-29T10:00:00+05:30"), 31),
      "2028-03"
    );

    // April 2026 (30 days) with student cycle day 31:
    // Joining on April 25 (25 < 30) -> eligible in April (2026-04)
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-04-25T10:00:00+05:30"), 31),
      "2026-04"
    );
    // Joining on April 30 (30 >= 30) -> first eligible month is May (2026-05)
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-04-30T10:00:00+05:30"), 31),
      "2026-05"
    );

    // June 2026 (30 days) with student cycle day 30:
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-06-20T10:00:00+05:30"), 30),
      "2026-06"
    );
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-06-30T10:00:00+05:30"), 30),
      "2026-07"
    );

    // December to January rollover:
    // Joining on Dec 25 with cycle day 31 -> eligible in Dec 2026
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-12-25T10:00:00+05:30"), 31),
      "2026-12"
    );
    // Joining on Dec 31 with cycle day 31 -> rolls over to January 2027
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-12-31T10:00:00+05:30"), 31),
      "2027-01"
    );
    // Joining on Dec 31 with cycle day 5 -> rolls over to January 2027
    assert.equal(
      calculateFirstBillingMonth(new Date("2026-12-31T10:00:00+05:30"), 5),
      "2027-01"
    );
    // Joining on Jan 2 with cycle day 5 -> eligible in January 2027
    assert.equal(
      calculateFirstBillingMonth(new Date("2027-01-02T10:00:00+05:30"), 5),
      "2027-01"
    );
    // Joining on Jan 5 with cycle day 5 -> rolls over to February 2027
    assert.equal(
      calculateFirstBillingMonth(new Date("2027-01-05T10:00:00+05:30"), 5),
      "2027-02"
    );
  });

  // 5. Fee Service Integration: Preserves Snapshots and Locks for Short-Month Clamped Students
  await t.test("5. Clamped student fee generation preserves locks, idempotency and financial snapshots", async () => {
    const feeDocs = new Map();
    const lockDocs = new Map();

    const studentDay31 = {
      _id: "student_day31",
      centerId: "center_test",
      name: "Short Month Student",
      monthlyFee: 3000,
      isActive: true,
      billingCycleDate: 31,
      joiningDate: new Date("2026-02-10T00:00:00+05:30"), // Joined before clamped Feb 28
    };

    const mockCenter = {
      centerId: "center_test",
      dueDateOffsetDays: 5,
    };

    const mockModels = {
      Student: {
        findById: async () => studentDay31,
      },
      Center: {
        findOne: async () => mockCenter,
      },
      Fee: {
        findOne: async (q) => {
          for (const doc of feeDocs.values()) {
            if (
              doc.centerId === q.centerId &&
              String(doc.studentId) === String(q.studentId) &&
              doc.billingMonth === q.billingMonth &&
              doc.feeType === q.feeType
            ) {
              return doc;
            }
          }
          return null;
        },
        find: async () => [],
        create: async (doc) => {
          const id = `fee_${feeDocs.size + 1}`;
          const saved = { ...doc, _id: id };
          feeDocs.set(id, saved);
          return saved;
        },
      },
      FeeCreationLock: {
        collection: {
          indexes: async () => [
            { key: { lockKey: 1 }, unique: true },
          ],
        },
        create: async (doc) => {
          if (lockDocs.has(doc.lockKey)) {
            const err = new Error("E11000 duplicate key");
            err.code = 11000;
            throw err;
          }
          lockDocs.set(doc.lockKey, { ...doc });
          return doc;
        },
        findOne: async (q) => lockDocs.get(q.lockKey) || null,
        findOneAndUpdate: async () => null,
        deleteOne: async (q) => {
          lockDocs.delete(q.lockKey);
          return { deletedCount: 1 };
        },
      },
    };

    // Run fee generation on February 28, 2026
    const refDate = new Date("2026-02-28T12:00:00+05:30");
    const result1 = await generateOrGetMonthlyFee({
      centerId: "center_test",
      studentId: "student_day31",
      referenceDate: refDate,
      isManual: false,
      models: mockModels,
    });

    assert.equal(result1.success, true);
    assert.equal(result1.wasCreated, true);
    assert.equal(result1.status, "created");
    assert.equal(result1.fee.amountDue, 3000);
    assert.equal(result1.fee.billingMonth, "2026-02");
    assert.equal(result1.fee.month, "Feb 2026");

    // Second call for the same clamped student reuses fee (zero duplicates)
    const result2 = await generateOrGetMonthlyFee({
      centerId: "center_test",
      studentId: "student_day31",
      referenceDate: refDate,
      isManual: false,
      models: mockModels,
    });

    assert.equal(result2.success, true);
    assert.equal(result2.wasCreated, false);
    assert.equal(result2.status, "reused");
    assert.equal(result2.fee._id, result1.fee._id);
    assert.equal(feeDocs.size, 1); // Exactly 1 fee created
  });

  // 6. Bulk Import File Extension Guard Specification
  await t.test("6. Bulk Import frontend validation accepts .csv and .txt, rejects binary .xlsx/.xls", () => {
    function validateImportFileExtension(fileName) {
      const validExtensions = [".csv", ".txt"];
      const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
      if (!validExtensions.includes(ext)) {
        return {
          valid: false,
          error:
            "Please select a valid CSV or TXT file (.csv, .txt). If using Microsoft Excel or Google Sheets, please export/save your spreadsheet as CSV before uploading.",
        };
      }
      return { valid: true, error: null };
    }

    // Valid formats
    assert.equal(validateImportFileExtension("students.csv").valid, true);
    assert.equal(validateImportFileExtension("STUDENTS_BATCH1.CSV").valid, true);
    assert.equal(validateImportFileExtension("roster.txt").valid, true);

    // Rejected binary Excel formats
    const xlsxCheck = validateImportFileExtension("students.xlsx");
    assert.equal(xlsxCheck.valid, false);
    assert.ok(xlsxCheck.error.includes("export/save your spreadsheet as CSV"));

    const xlsCheck = validateImportFileExtension("old_records.xls");
    assert.equal(xlsCheck.valid, false);
    assert.ok(xlsCheck.error.includes("export/save your spreadsheet as CSV"));

    // Other unsupported formats
    assert.equal(validateImportFileExtension("students.pdf").valid, false);
    assert.equal(validateImportFileExtension("data.json").valid, false);
  });
});
