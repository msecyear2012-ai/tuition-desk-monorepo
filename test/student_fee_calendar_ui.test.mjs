import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const calendarComponentPath = path.resolve(
  __dirname,
  "../src/components/students/StudentFeeCalendar.tsx"
);
const studentProfilePath = path.resolve(
  __dirname,
  "../src/components/students/StudentProfile.tsx"
);

test("Student 12-Month Fee Calendar UI Contract Suite", async (t) => {
  assert.ok(
    fs.existsSync(calendarComponentPath),
    "StudentFeeCalendar.tsx must exist"
  );
  assert.ok(fs.existsSync(studentProfilePath), "StudentProfile.tsx must exist");

  const calendarContent = fs.readFileSync(calendarComponentPath, "utf-8");
  const profileContent = fs.readFileSync(studentProfilePath, "utf-8");

  // 1. Data Fetching Contract
  await t.test("1. Data Fetching: Calls /api/students/[id]/fee-summary?year=... with loading skeleton and error fallback", () => {
    assert.ok(
      calendarContent.includes("`/students/${studentId}/fee-summary?year="),
      "Component must fetch fee-summary using apiClient with year query param"
    );
    assert.ok(
      calendarContent.includes("Loading 12-month fee calendar..."),
      "Component must render clean loading skeleton text/spinner"
    );
    assert.ok(
      calendarContent.includes("Retry") && calendarContent.includes("handleRetry"),
      "Component must render retry action on error"
    );
  });

  // 2. Top Clear Picture Header (3 KPI Cards)
  await t.test("2. Top Clear Picture Header: Renders Total Due, Advance Balance, and Next Billing Date cards", () => {
    // Total Due: Red/amber styling if > 0, Green (₹0 • Cleared) if 0
    assert.ok(
      calendarContent.includes("Total Due"),
      "Must render 'Total Due' card"
    );
    assert.ok(
      calendarContent.includes("₹0 • Cleared"),
      "Must render '₹0 • Cleared' when totalDue is 0"
    );
    assert.ok(
      calendarContent.includes("summary.totalDue > 0"),
      "Must conditionally format Total Due card based on balance"
    );

    // Advance Balance: Blue styling if > 0, neutral if 0
    assert.ok(
      calendarContent.includes("Advance Balance"),
      "Must render 'Advance Balance' card"
    );
    assert.ok(
      calendarContent.includes("summary.advanceBalance > 0"),
      "Must conditionally style Advance Balance card"
    );

    // Next Billing Date: Formatted date and monthly fee
    assert.ok(
      calendarContent.includes("Next Billing Date"),
      "Must render 'Next Billing Date' card"
    );
    assert.ok(
      calendarContent.includes("Monthly Fee:"),
      "Must display Monthly Fee inside Next Billing Date card"
    );
  });

  // 3. 12-Month Visual Fee Grid & Status Indicators
  await t.test("3. 12-Month Grid: Renders Year switcher, responsive grid, and handles all 6 statuses", () => {
    // Header & Year switcher
    assert.ok(
      calendarContent.includes("Fee Calendar"),
      "Header must render 'Fee Calendar' title"
    );
    assert.ok(
      calendarContent.includes("handleYearChange(-1)") &&
        calendarContent.includes("handleYearChange(1)"),
      "Must render year switcher buttons (< Year >)"
    );

    // Responsive grid layout (4 cols desktop, 3 cols mobile)
    assert.ok(
      calendarContent.includes("grid-cols-3 sm:grid-cols-4"),
      "Grid must use responsive columns: 3 on mobile, 4 on desktop/tablet"
    );

    // Verify all 6 status handlers
    assert.ok(
      calendarContent.includes('case "paid":') &&
        calendarContent.includes("amountPaid"),
      "Must handle 'paid' status with paid amount"
    );
    assert.ok(
      calendarContent.includes('case "partial":') &&
        calendarContent.includes("amountDue"),
      "Must handle 'partial' status with remaining due amount"
    );
    assert.ok(
      calendarContent.includes('case "due":') &&
        calendarContent.includes("amountDue"),
      "Must handle 'due' status with due amount"
    );
    assert.ok(
      calendarContent.includes('case "advance":'),
      "Must handle 'advance' status"
    );
    assert.ok(
      calendarContent.includes('case "upcoming":'),
      "Must handle 'upcoming' status"
    );
    assert.ok(
      calendarContent.includes('case "pre_admission":'),
      "Must handle 'pre_admission' status"
    );
  });

  // 4. Interactive Detail Strip
  await t.test("4. Interactive Detail Strip: Displays inline breakdown on month selection", () => {
    assert.ok(
      calendarContent.includes("selectedMonth"),
      "Must track selectedMonth state for interactive details"
    );
    assert.ok(
      calendarContent.includes("Billing Date"),
      "Detail strip must display Billing Date"
    );
    assert.ok(
      calendarContent.includes("Amount Invoiced"),
      "Detail strip must display Amount Invoiced"
    );
    assert.ok(
      calendarContent.includes("Amount Paid"),
      "Detail strip must display Amount Paid"
    );
    assert.ok(
      calendarContent.includes("Balance Due"),
      "Detail strip must display Balance Due"
    );
    assert.ok(
      calendarContent.includes("Paid Date"),
      "Detail strip must display Paid Date"
    );
    assert.ok(
      calendarContent.includes("Payment Mode"),
      "Detail strip must display Payment Mode"
    );
  });

  // 5. Mounted in Student Profile View
  await t.test("5. StudentProfile Integration: StudentFeeCalendar is cleanly imported and mounted", () => {
    assert.ok(
      profileContent.includes('import StudentFeeCalendar from "./StudentFeeCalendar"'),
      "StudentProfile must import StudentFeeCalendar"
    );
    assert.ok(
      profileContent.includes("<StudentFeeCalendar studentId={student._id} />"),
      "StudentProfile must render StudentFeeCalendar passing student._id"
    );
  });
});
