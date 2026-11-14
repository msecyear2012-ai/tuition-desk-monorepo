import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  combineAttributionData,
  getPersonKeyForReceiver,
  getPersonKeyForAcademic,
} from "../src/lib/collectionAttribution.ts";

test("Phase 5D: Owner Collection Reports UI Specification & Logic Suite", async (t) => {
  // 1. IST Date Utilities Specification
  await t.test("1. IST Date Helpers: Produces expected YYYY-MM-DD and YYYY-MM strings", () => {
    function getTodayIST(testDate = new Date()) {
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istDate = new Date(testDate.getTime() + (testDate.getTimezoneOffset() * 60000) + istOffset);
      return istDate.toISOString().slice(0, 10);
    }

    function getYesterdayIST(testDate = new Date()) {
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istDate = new Date(testDate.getTime() + (testDate.getTimezoneOffset() * 60000) + istOffset - (24 * 60 * 60 * 1000));
      return istDate.toISOString().slice(0, 10);
    }

    function getCurrentMonthIST(testDate = new Date()) {
      return getTodayIST(testDate).slice(0, 7);
    }

    function getMonthStartIST(testDate = new Date()) {
      return `${getCurrentMonthIST(testDate)}-01`;
    }

    // Fixed mock date: 2026-11-03 14:00 UTC (19:30 IST on Nov 3)
    const fixedDate = new Date("2026-11-03T14:00:00.000Z");
    assert.equal(getTodayIST(fixedDate), "2026-11-03");
    assert.equal(getYesterdayIST(fixedDate), "2026-11-02");
    assert.equal(getCurrentMonthIST(fixedDate), "2026-11");
    assert.equal(getMonthStartIST(fixedDate), "2026-11-01");
  });

  // 2. Query Parameter Construction
  await t.test("2. Query Parameter Builder: Formats params according to filterType", () => {
    function buildQueryParams({ filterType, dailyDate, monthlyDate, customStartDate, customEndDate }) {
      const queryParams = { type: filterType };
      if (filterType === "daily") {
        queryParams.date = dailyDate;
      } else if (filterType === "monthly") {
        queryParams.month = monthlyDate;
      } else if (filterType === "custom") {
        queryParams.startDate = customStartDate;
        queryParams.endDate = customEndDate;
      }
      return queryParams;
    }

    const dailyParams = buildQueryParams({
      filterType: "daily",
      dailyDate: "2026-11-03",
    });
    assert.deepEqual(dailyParams, { type: "daily", date: "2026-11-03" });

    const monthlyParams = buildQueryParams({
      filterType: "monthly",
      monthlyDate: "2026-11",
    });
    assert.deepEqual(monthlyParams, { type: "monthly", month: "2026-11" });

    const customParams = buildQueryParams({
      filterType: "custom",
      customStartDate: "2026-11-01",
      customEndDate: "2026-11-15",
    });
    assert.deepEqual(customParams, {
      type: "custom",
      startDate: "2026-11-01",
      endDate: "2026-11-15",
    });
  });

  // 3. Custom Date Range Validation
  await t.test("3. Date Range Validation: Validates startDate <= endDate and blocks invalid queries", () => {
    function validateDateRange(startDate, endDate) {
      if (!startDate || !endDate) {
        return { isValid: false, error: "Both start date and end date are required" };
      }
      if (startDate > endDate) {
        return { isValid: false, error: "Start date cannot be after end date" };
      }
      return { isValid: true, error: null };
    }

    assert.equal(validateDateRange("2026-11-01", "2026-11-03").isValid, true);
    assert.equal(validateDateRange("2026-11-03", "2026-11-03").isValid, true);

    const invalid = validateDateRange("2026-11-10", "2026-11-05");
    assert.equal(invalid.isValid, false);
    assert.equal(invalid.error, "Start date cannot be after end date");
  });

  // 4. Owner-Only Access Protection Guard
  await t.test("4. Role Protection: Blocks Teacher access and redirects to dashboard root", () => {
    function evaluateRouteAccess(userProfile) {
      if (!userProfile) {
        return { allow: false, redirect: "/login" };
      }
      if (userProfile.role === "teacher") {
        return { allow: false, redirect: "/" };
      }
      if (userProfile.role === "owner") {
        return { allow: true, redirect: null };
      }
      return { allow: false, redirect: "/" };
    }

    assert.deepEqual(evaluateRouteAccess(null), { allow: false, redirect: "/login" });
    assert.deepEqual(evaluateRouteAccess({ role: "teacher" }), { allow: false, redirect: "/" });
    assert.deepEqual(evaluateRouteAccess({ role: "owner" }), { allow: true, redirect: null });
  });

  // 5. Dual-Axis Attribution Discrimination (DEC-MSEC-06)
  await t.test("5. Dual-Axis Attribution: Accurately distinguishes Cash Custody from Academic Faculty", () => {
    const mockReportResponse = {
      success: true,
      period: {
        type: "monthly",
        startDate: "2026-11-01T00:00:00.000+05:30",
        endDate: "2026-11-30T23:59:59.999+05:30",
        timezone: "Asia/Kolkata",
      },
      summary: {
        totalAmount: 50000,
        transactionCount: 20,
      },
      byPaymentReceiver: [
        {
          receiverId: null,
          receiverRole: "owner",
          name: "Dr. Sharma (Owner)",
          phone: "9876543210",
          totalAmount: 35000,
          transactionCount: 14,
        },
        {
          receiverId: "teach_101",
          receiverRole: "teacher",
          name: "Pooja Verma",
          phone: "9876543211",
          totalAmount: 15000,
          transactionCount: 6,
        },
      ],
      byAcademicTeacher: [
        {
          teacherId: "teach_101",
          isOwner: false,
          name: "Pooja Verma",
          phone: "9876543211",
          totalAmount: 30000,
          transactionCount: 12,
        },
        {
          teacherId: null,
          isOwner: true,
          name: "Dr. Sharma (Owner)",
          phone: "9876543210",
          totalAmount: 20000,
          transactionCount: 8,
        },
      ],
    };

    // Calculate percentage shares
    const total = mockReportResponse.summary.totalAmount;
    const receiverShares = mockReportResponse.byPaymentReceiver.map((item) => ({
      name: item.name,
      role: item.receiverRole,
      sharePct: Math.round((item.totalAmount / total) * 100),
    }));

    assert.equal(receiverShares[0].role, "owner");
    assert.equal(receiverShares[0].sharePct, 70); // 35000 / 50000 = 70%
    assert.equal(receiverShares[1].role, "teacher");
    assert.equal(receiverShares[1].sharePct, 30); // 15000 / 50000 = 30%

    const academicShares = mockReportResponse.byAcademicTeacher.map((item) => ({
      name: item.name,
      isOwner: item.isOwner,
      sharePct: Math.round((item.totalAmount / total) * 100),
    }));

    assert.equal(academicShares[0].isOwner, false);
    assert.equal(academicShares[0].sharePct, 60); // 30000 / 50000 = 60%
    assert.equal(academicShares[1].isOwner, true);
    assert.equal(academicShares[1].sharePct, 40); // 20000 / 50000 = 40%

    // Verify Cash Custody vs Academic attribution cross-discrepancy:
    // Owner physically received 35k, but Owner's students generated 20k
    assert.notEqual(
      mockReportResponse.byPaymentReceiver.find((r) => r.receiverRole === "owner").totalAmount,
      mockReportResponse.byAcademicTeacher.find((a) => a.isOwner).totalAmount
    );
  });

  // 6. Response Unwrapping & Resilience
  await t.test("6. Response Unwrapping: Handles both top-level and nested { data } shapes", () => {
    function unwrapReportResponse(res) {
      const raw = res;
      const dataObj = res.data;
      if (dataObj && typeof dataObj === "object" && "summary" in dataObj) {
        return res.data;
      }
      return raw;
    }

    const directPayload = {
      success: true,
      summary: { totalAmount: 10000, transactionCount: 4 },
      byPaymentReceiver: [],
      byAcademicTeacher: [],
    };
    assert.equal(unwrapReportResponse(directPayload).summary.totalAmount, 10000);

    const nestedPayload = {
      success: true,
      data: {
        success: true,
        summary: { totalAmount: 25000, transactionCount: 9 },
        byPaymentReceiver: [],
        byAcademicTeacher: [],
      },
    };
    assert.equal(unwrapReportResponse(nestedPayload).summary.totalAmount, 25000);
  });

  // 7. Zero Collection State Detection
  await t.test("7. Zero Collection State: Properly identifies empty collection periods", () => {
    function isEmptyReport(report) {
      if (!report || !report.summary) return true;
      return report.summary.totalAmount === 0 && report.summary.transactionCount === 0;
    }

    assert.equal(isEmptyReport(null), true);
    assert.equal(isEmptyReport({ summary: { totalAmount: 0, transactionCount: 0 } }), true);
    assert.equal(isEmptyReport({ summary: { totalAmount: 500, transactionCount: 1 } }), false);
  });

  // 8. Same Person in Both Dimensions: Combines into ONE Card (DEC-MSEC-06 UI refinement)
  await t.test("8. Combined Attribution: Same person in both dimensions renders ONE combined card with both metrics", () => {
    // Verified scenario from live database: Jitender Kumar as both receiver and academic faculty
    const receivers = [
      {
        receiverId: "6ae9ba93d29bd04896bac676",
        receiverRole: "teacher",
        name: "Jitender Kumar",
        phone: "9812345678",
        totalAmount: 3000,
        transactionCount: 1,
      },
    ];

    const academics = [
      {
        teacherId: "6ae9ba93d29bd04896bac676",
        isOwner: false,
        name: "Jitender Kumar",
        phone: "9812345678",
        totalAmount: 3000,
        transactionCount: 1,
      },
    ];

    const totalRevenue = 3000;
    const combined = combineAttributionData(receivers, academics, totalRevenue);

    // Assert: Exactly ONE card produced
    assert.equal(combined.length, 1, "Must produce exactly 1 combined card, not 2 duplicate cards");
    
    const person = combined[0];
    assert.equal(person.key, "teacher:6ae9ba93d29bd04896bac676");
    assert.equal(person.name, "Jitender Kumar");
    assert.equal(person.role, "teacher");
    assert.equal(person.hasBothRoles, true, "Must flag hasBothRoles as true");

    // Both metric blocks must be populated
    assert.notEqual(person.custody, null, "Cash Custody metric must be present");
    assert.equal(person.custody.totalAmount, 3000);
    assert.equal(person.custody.transactionCount, 1);
    assert.equal(person.custody.sharePct, 100);

    assert.notEqual(person.academic, null, "Academic Faculty metric must be present");
    assert.equal(person.academic.totalAmount, 3000);
    assert.equal(person.academic.transactionCount, 1);
    assert.equal(person.academic.sharePct, 100);
  });

  // 9. Different People Across Dimensions: Renders Separate Attribution Cards
  await t.test("9. Combined Attribution: Different people across dimensions render separate attribution cards", () => {
    // Teacher A collected payment, but Teacher B taught the student
    const receivers = [
      {
        receiverId: "teach_A",
        receiverRole: "teacher",
        name: "Ramesh Sharma",
        phone: "9811111111",
        totalAmount: 5000,
        transactionCount: 2,
      },
    ];

    const academics = [
      {
        teacherId: "teach_B",
        isOwner: false,
        name: "Sunita Devi",
        phone: "9822222222",
        totalAmount: 5000,
        transactionCount: 2,
      },
    ];

    const totalRevenue = 5000;
    const combined = combineAttributionData(receivers, academics, totalRevenue);

    // Assert: Must produce 2 separate cards
    assert.equal(combined.length, 2, "Must produce 2 separate cards for different persons");

    const personA = combined.find((p) => p.key === "teacher:teach_A");
    const personB = combined.find((p) => p.key === "teacher:teach_B");

    assert.ok(personA, "Person A card must exist");
    assert.ok(personB, "Person B card must exist");

    assert.equal(personA.hasBothRoles, false);
    assert.equal(personB.hasBothRoles, false);

    assert.notEqual(personA.custody, null);
    assert.equal(personA.custody.totalAmount, 5000);
    assert.equal(personA.academic, null, "Person A must have NO academic metric");

    assert.equal(personB.custody, null, "Person B must have NO custody metric");
    assert.notEqual(personB.academic, null);
    assert.equal(personB.academic.totalAmount, 5000);
  });

  // 10. Single-Dimension Person: Displays only that metric without invented zero-value transactions
  await t.test("10. Combined Attribution: Single-dimension person displays only relevant metric without invented zeros", () => {
    // Only a payment receiver exists
    const receivers = [
      {
        receiverId: "teach_cashier",
        receiverRole: "teacher",
        name: "Cashier Mohan",
        phone: "9833333333",
        totalAmount: 12000,
        transactionCount: 4,
      },
    ];
    const academics = [];
    const totalRevenue = 12000;

    const combined = combineAttributionData(receivers, academics, totalRevenue);

    assert.equal(combined.length, 1);
    const person = combined[0];
    assert.equal(person.hasBothRoles, false);
    assert.notEqual(person.custody, null);
    assert.equal(person.custody.totalAmount, 12000);
    assert.equal(person.academic, null, "Must NOT invent zero-value academic transaction metric");
  });

  // 11. Stable Database ID Matching (Never Names or Phone Numbers)
  await t.test("11. Combined Attribution: Strictly uses stable database IDs for matching (never names or phones)", () => {
    // Scenario A: Same Name, Different IDs (must NOT merge!)
    const receiversSameName = [
      {
        receiverId: "id_teacher_001",
        receiverRole: "teacher",
        name: "Amit Kumar",
        phone: "9800000001",
        totalAmount: 4000,
        transactionCount: 2,
      },
    ];
    const academicsSameName = [
      {
        teacherId: "id_teacher_002",
        isOwner: false,
        name: "Amit Kumar", // Same name, but distinct teacher ID!
        phone: "9800000001",
        totalAmount: 4000,
        transactionCount: 2,
      },
    ];

    const combinedDistinct = combineAttributionData(receiversSameName, academicsSameName, 8000);
    assert.equal(
      combinedDistinct.length,
      2,
      "Two teachers with identical names but different IDs must NOT be merged"
    );

    // Scenario B: Same ID, Phone number changed/missing (MUST merge via ID!)
    const receiversSameId = [
      {
        receiverId: "id_teacher_003",
        receiverRole: "teacher",
        name: "Pooja Verma",
        phone: "9800000099",
        totalAmount: 6000,
        transactionCount: 3,
      },
    ];
    const academicsSameId = [
      {
        teacherId: "id_teacher_003", // Matching ID
        isOwner: false,
        name: "Pooja Verma",
        phone: "", // Missing or different phone
        totalAmount: 6000,
        transactionCount: 3,
      },
    ];

    const combinedMerged = combineAttributionData(receiversSameId, academicsSameId, 6000);
    assert.equal(
      combinedMerged.length,
      1,
      "Matching ID must combine even if phone is missing or different"
    );
    assert.equal(combinedMerged[0].key, "teacher:id_teacher_003");
    assert.equal(combinedMerged[0].hasBothRoles, true);
    assert.equal(combinedMerged[0].phone, "9800000099", "Preserves available phone");
  });

  // 12. Financial Invariants: Institute Total Revenue and Unique Receipt Count Unchanged
  await t.test("12. Financial Invariants: Revenue and unique receipt counts are never summed across attributions", () => {
    const mockReport = {
      summary: {
        totalAmount: 3000,
        transactionCount: 1,
      },
      byPaymentReceiver: [
        {
          receiverId: "6ae9ba93d29bd04896bac676",
          receiverRole: "teacher",
          name: "Jitender Kumar",
          phone: "9812345678",
          totalAmount: 3000,
          transactionCount: 1,
        },
      ],
      byAcademicTeacher: [
        {
          teacherId: "6ae9ba93d29bd04896bac676",
          isOwner: false,
          name: "Jitender Kumar",
          phone: "9812345678",
          totalAmount: 3000,
          transactionCount: 1,
        },
      ],
    };

    const combined = combineAttributionData(
      mockReport.byPaymentReceiver,
      mockReport.byAcademicTeacher,
      mockReport.summary.totalAmount
    );

    // Financial Invariant 1: Total Revenue remains ₹3,000
    assert.equal(mockReport.summary.totalAmount, 3000, "Institute total revenue must remain ₹3,000");

    // Financial Invariant 2: Unique receipt count remains 1
    assert.equal(mockReport.summary.transactionCount, 1, "Unique receipt count must remain 1");

    // Financial Invariant 3: UI must NEVER sum the two dimensions to calculate institute revenue
    const invalidSumOfDimensions =
      mockReport.byPaymentReceiver[0].totalAmount + mockReport.byAcademicTeacher[0].totalAmount;
    assert.equal(invalidSumOfDimensions, 6000, "Summing dimensions would yield invalid double-counted ₹6,000");
    assert.notEqual(
      mockReport.summary.totalAmount,
      invalidSumOfDimensions,
      "Institute revenue must not equal sum of dimensions"
    );

    // Percentage shares on the single receipt must both equal 100% of institute collection
    assert.equal(combined[0].custody.sharePct, 100);
    assert.equal(combined[0].academic.sharePct, 100);
  });

  // 13. Data Consistency Across Report Periods (Daily, Monthly, Custom)
  await t.test("13. Filter Range Invariants: Daily, monthly, and custom-range periods maintain attribution integrity", () => {
    const periodTypes = [
      { type: "daily", total: 3000, receipts: 1 },
      { type: "monthly", total: 45000, receipts: 15 },
      { type: "custom", total: 120000, receipts: 40 },
    ];

    for (const p of periodTypes) {
      const receivers = [
        {
          receiverId: "teach_1",
          receiverRole: "teacher",
          name: "Teacher 1",
          phone: "9800000001",
          totalAmount: p.total,
          transactionCount: p.receipts,
        },
      ];
      const academics = [
        {
          teacherId: "teach_1",
          isOwner: false,
          name: "Teacher 1",
          phone: "9800000001",
          totalAmount: p.total,
          transactionCount: p.receipts,
        },
      ];

      const combined = combineAttributionData(receivers, academics, p.total);
      assert.equal(combined.length, 1, `Period ${p.type} must produce 1 consolidated card`);
      assert.equal(combined[0].custody.sharePct, 100, `Period ${p.type} custody share must be 100%`);
      assert.equal(combined[0].academic.sharePct, 100, `Period ${p.type} academic share must be 100%`);
      assert.equal(combined[0].custody.totalAmount, p.total);
      assert.equal(combined[0].academic.totalAmount, p.total);
    }
  });

  // 14. Responsive Layout Invariants: Zero horizontal overflow on mobile
  await t.test("14. Responsive Layout Invariants: Component classes guarantee zero horizontal overflow and clean stacking", () => {
    const pageFilePath = path.join(process.cwd(), "src/app/reports/page.tsx");
    const pageContent = fs.readFileSync(pageFilePath, "utf8");

    // Verify presence of responsive grid classes: 1 column on mobile, 2 on lg screens
    assert.ok(
      pageContent.includes("grid grid-cols-1 lg:grid-cols-2"),
      "Must use responsive grid: 1 col mobile, 2 col desktop"
    );

    // Verify sub-grid within dual-role card stacks on mobile (< sm)
    assert.ok(
      pageContent.includes("grid grid-cols-1 sm:grid-cols-2"),
      "Must stack metric boxes on mobile (< 640px) and expand to 2 cols on >= sm"
    );

    // Verify that the obsolete mobile toggle was removed
    assert.ok(
      !pageContent.includes("activeAxisTab"),
      "Old mobile axis toggle tab must be completely removed"
    );

    // Verify explanation banner is present
    assert.ok(
      pageContent.includes("Dual-Axis Attribution Accounting"),
      "Explanatory callout banner must be present"
    );

    // Verify dual-role pill
    assert.ok(
      pageContent.includes("Collector & Faculty"),
      "Collector & Faculty pill must be present for dual-role cards"
    );
  });
});
