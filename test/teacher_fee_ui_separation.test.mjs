import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feesClientPath = path.resolve(__dirname, "../src/app/fees/FeesClient.tsx");

test("Teacher Fee Management UI Separation & De-cluttering Suite", async (t) => {
  const content = fs.readFileSync(feesClientPath, "utf-8");

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

  await t.test("3. Cash Handover tab contains 'My Financial Activity', banner, and recent collections above the console", () => {
    const handoverStart = content.indexOf('mainTab === "handovers"');
    const handoverEnd = content.indexOf("<AddFeeModal", handoverStart);
    assert.ok(handoverStart > 0 && handoverEnd > handoverStart, "Cash handover tab block must exist");
    const handoverBlock = content.slice(handoverStart, handoverEnd);

    // Check presence of My Financial Activity
    assert.ok(
      handoverBlock.includes("My Financial Activity"),
      "Cash Handover tab must contain 'My Financial Activity'"
    );
    assert.ok(
      handoverBlock.includes("Collected By You"),
      "Cash Handover tab must contain 'Collected By You' card"
    );
    assert.ok(
      handoverBlock.includes("Cash in Hand"),
      "Cash Handover tab must contain 'Cash in Hand' card"
    );
    assert.ok(
      handoverBlock.includes("Submitted"),
      "Cash Handover tab must contain 'Submitted' card"
    );
    assert.ok(
      handoverBlock.includes("Verified"),
      "Cash Handover tab must contain 'Verified' card"
    );

    // Check presence of Physical Cash banner & Submit Handover
    assert.ok(
      handoverBlock.includes("Physical Cash in Your Custody"),
      "Cash Handover tab must contain 'Physical Cash in Your Custody' banner"
    );
    assert.ok(
      handoverBlock.includes("Submit Handover"),
      "Cash Handover tab must contain 'Submit Handover' action button"
    );

    // Check presence of Your Recent Cash Collections & Record Cash
    assert.ok(
      handoverBlock.includes("Your Recent Cash Collections"),
      "Cash Handover tab must contain 'Your Recent Cash Collections'"
    );
    assert.ok(
      handoverBlock.includes("Record Cash"),
      "Cash Handover tab must contain 'Record Cash' action button"
    );

    // Check ordering: Financial Activity must appear BEFORE TeacherHandoverConsole
    const activityIndex = handoverBlock.indexOf("My Financial Activity");
    const bannerIndex = handoverBlock.indexOf("Physical Cash in Your Custody");
    const collectionsIndex = handoverBlock.indexOf("Your Recent Cash Collections");
    const consoleIndex = handoverBlock.indexOf("<TeacherHandoverConsole");

    assert.ok(activityIndex > 0, "Activity must be present in handover block");
    assert.ok(bannerIndex > activityIndex, "Banner must follow activity cards");
    assert.ok(collectionsIndex > bannerIndex, "Collections feed must follow banner");
    assert.ok(consoleIndex > collectionsIndex, "Handover console must appear below collections feed");
  });
});
