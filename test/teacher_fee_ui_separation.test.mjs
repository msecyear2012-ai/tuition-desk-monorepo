import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feesClientPath = path.resolve(__dirname, "../src/app/fees/FeesClient.tsx");
const teacherConsolePath = path.resolve(
  __dirname,
  "../src/components/handovers/TeacherHandoverConsole.tsx"
);

test("Teacher Fee Management UI Separation & De-cluttering Suite", async (t) => {
  const content = fs.readFileSync(feesClientPath, "utf-8");
  const consoleContent = fs.readFileSync(teacherConsolePath, "utf-8");

  await t.test("1. Technical Jargon 'Financial Separation Invariant' is completely removed", () => {
    assert.equal(
      content.includes("Financial Separation Invariant"),
      false,
      "The blue 'Financial Separation Invariant' info box must be deleted from FeesClient.tsx"
    );
  });

  await t.test("2. Overview tab contains only 'My Students Fee Status' and its 4 KPI cards", () => {
    // Extract Overview Tab block for teacher: between isTeacher and RECENT CASH COLLECTIONS (Owner View)
    const teacherOverviewMatch = content.match(
      /\{\/\* TEACHER OVERVIEW DASHBOARD \*\/\}[\s\S]*?\{isTeacher && \([\s\S]*?\)\}[\s\S]*?\{\/\* RECENT CASH COLLECTIONS/
    );
    assert.ok(teacherOverviewMatch, "Teacher overview dashboard block must exist");
    const teacherOverviewBlock = teacherOverviewMatch[0];

    // Check presence of Students Fee Status
    assert.ok(
      teacherOverviewBlock.includes("My Students&apos; Fee Status") ||
      teacherOverviewBlock.includes("My Students' Fee Status"),
      "Overview tab must contain 'My Students Fee Status'"
    );
    assert.ok(
      teacherOverviewBlock.includes("Assigned Students"),
      "Overview tab must contain 'Assigned Students' KPI card"
    );
    assert.ok(
      teacherOverviewBlock.includes("Student Dues"),
      "Overview tab must contain 'Student Dues' KPI card"
    );
    assert.ok(
      teacherOverviewBlock.includes("Dues Pending"),
      "Overview tab must contain 'Dues Pending' KPI card"
    );
    assert.ok(
      teacherOverviewBlock.includes("Fees Cleared"),
      "Overview tab must contain 'Fees Cleared' KPI card"
    );
    assert.ok(
      teacherOverviewBlock.includes("Assigned Students&apos; Fee Status") ||
      teacherOverviewBlock.includes("Assigned Students' Fee Status"),
      "Overview tab must contain Assigned Students Fee Status table"
    );
    assert.ok(
      teacherOverviewBlock.includes("View All Pending Dues"),
      "Overview tab must contain 'View All Pending Dues' action button"
    );

    // Check ABSENCE of My Financial Activity, Physical Cash banner, and Recent Cash Collections
    assert.equal(
      teacherOverviewBlock.includes("My Financial Activity"),
      false,
      "Overview tab must NOT contain 'My Financial Activity'"
    );
    assert.equal(
      teacherOverviewBlock.includes("Physical Cash in Your Custody"),
      false,
      "Overview tab must NOT contain 'Physical Cash in Your Custody'"
    );
    assert.equal(
      teacherOverviewBlock.includes("Your Recent Cash Collections"),
      false,
      "Overview tab must NOT contain 'Your Recent Cash Collections'"
    );
  });

  await t.test("3. Cash Handover tab is deduplicated without duplicate KPI cards or recent collections", () => {
    const handoverStart = content.indexOf('mainTab === "handovers"');
    const handoverEnd = content.indexOf("<AddFeeModal", handoverStart);
    assert.ok(handoverStart > 0 && handoverEnd > handoverStart, "Cash handover tab block must exist");
    const handoverBlock = content.slice(handoverStart, handoverEnd);

    // Confirm duplicate sections are REMOVED from FeesClient Cash Handover tab
    assert.equal(
      handoverBlock.includes("My Financial Activity"),
      false,
      "Cash Handover tab must NOT contain duplicate 'My Financial Activity'"
    );
    assert.equal(
      handoverBlock.includes("Collected By You"),
      false,
      "Cash Handover tab must NOT contain duplicate 'Collected By You' card"
    );
    assert.equal(
      handoverBlock.includes("Physical Cash in Your Custody"),
      false,
      "Cash Handover tab must NOT contain duplicate 'Physical Cash in Your Custody' banner"
    );
    assert.equal(
      handoverBlock.includes("Your Recent Cash Collections"),
      false,
      "Cash Handover tab must NOT contain duplicate 'Your Recent Cash Collections'"
    );

    // Confirm compact status alerts are kept (pending / rejected / active disputes)
    assert.ok(
      handoverBlock.includes("pendingHandoverCount"),
      "Handover tab must retain pending handover status alert check"
    );
    assert.ok(
      handoverBlock.includes("rejectedHandoverCount"),
      "Handover tab must retain rejected handover status alert check"
    );
    assert.ok(
      handoverBlock.includes("activeDisputesCount"),
      "Handover tab must retain active disputes status alert check"
    );

    // Confirm TeacherHandoverConsole is passed onRecordCash
    assert.ok(
      handoverBlock.includes("onRecordCash={() => setIsAddFeeModalOpen(true)}"),
      "TeacherHandoverConsole must receive onRecordCash callback"
    );
  });

  await t.test("4. TeacherHandoverConsole renders accessible '+ Record Cash' button alongside Refresh Console", () => {
    assert.ok(
      consoleContent.includes("onRecordCash?: () => void"),
      "TeacherHandoverConsoleProps must define onRecordCash"
    );
    assert.ok(
      consoleContent.includes("onRecordCash && ("),
      "TeacherHandoverConsole must conditionally render onRecordCash button"
    );
    assert.ok(
      consoleContent.includes("Record Cash"),
      "TeacherHandoverConsole must contain 'Record Cash' button label"
    );
    assert.ok(
      consoleContent.includes("Refresh Console"),
      "TeacherHandoverConsole must contain 'Refresh Console' button label"
    );

    // Confirm TeacherHandoverConsole's native 4 handover KPI cards
    assert.ok(
      consoleContent.includes("In-Hand Cash"),
      "Console must render native 'In-Hand Cash' card"
    );
    assert.ok(
      consoleContent.includes("Pending Count"),
      "Console must render native 'Pending Count' card"
    );
    assert.ok(
      consoleContent.includes("Verified to Date"),
      "Console must render native 'Verified to Date' card"
    );
    assert.ok(
      consoleContent.includes("Discrepancy / Rejected"),
      "Console must render native 'Discrepancy / Rejected' card"
    );
  });
});
