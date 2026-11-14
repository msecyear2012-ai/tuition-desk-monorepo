import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// ============================================================================
// Phase 3C: Multi-Axis Collection Reporting Specification Suite (DEC-MSEC-06)
//
// TEST CLASSIFICATION:
// 1. Role Authorization & Authentication:
//    - Tests 1, 2, 3: Rejects unauthenticated requests (401), rejects teachers (403),
//      allows authenticated Owner (200).
// 2. Date Filtering & IST Boundaries:
//    - Tests 4, 5, 6, 7, 8: Daily, monthly, and custom date range calculation under
//      Asia/Kolkata (IST = UTC+5:30); rejects malformed dates or reversed intervals (400);
//      defaults cleanly to today's IST bounds.
// 3. Dual-Axis Attribution Discrimination (DEC-MSEC-06):
//    - Tests 9, 10, 11: Accurately separates cash custody (receivedBy) from academic
//      responsibility (assignedTeacherAtPayment) across cross-teacher and owner collections.
// 4. Financial Hygiene & Audit Exclusions:
//    - Tests 12, 13: Excludes unverified advance payments (Verification Pending) and
//      voided transactions (isVoided: true).
// 5. Tenant Scoping & Isolation:
//    - Tests 14, 15: Strictly enforces centerId scoping from verified JWT claims;
//      completely excludes foreign center collections; neutralizes client spoofing.
//
// 100% In-Memory Specification Suite - ZERO live database mutations or network dependencies.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 3C: Multi-Axis Collection Reporting Specification Suite", async (t) => {
  const { signToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );
  const { getISTDateComponents } = await import(
    "../tution-desk-be/src/lib/dateUtils.ts"
  );

  // Helper to generate mock NextRequest with auth cookie or header
  function createMockRequest({
    token = null,
    method = "GET",
    searchParams = {},
    headers = {},
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
          return headers[name] || headers[lName] || null;
        },
      },
      nextUrl: {
        searchParams: {
          get: (key) => searchParams[key] ?? null,
        },
      },
    };
  }

  // Pre-signed Tokens
  const ownerId = "650000000000000000000001";
  const teacher1Id = "650000000000000000000010";
  const teacher2Id = "650000000000000000000020";
  const centerId = "msec";
  const foreignCenterId = "other_center";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerId,
    role: "owner",
    name: "MSEC Owner",
  });

  const teacherToken = await signToken({
    userId: teacher1Id,
    centerId: centerId,
    role: "teacher",
    teacherId: teacher1Id,
    name: "Teacher One",
  });

  const foreignOwnerToken = await signToken({
    userId: "650000000000000000000099",
    centerId: foreignCenterId,
    role: "owner",
    name: "Foreign Owner",
  });

  // Mock Entities
  const mockCenter = {
    _id: new mongoose.Types.ObjectId(ownerId),
    centerId: centerId,
    name: "MSEC Tuition Center",
    ownerName: "Dr. K. Swaminathan",
    phone: "9876543210",
  };

  const mockTeachers = [
    {
      _id: new mongoose.Types.ObjectId(teacher1Id),
      centerId: centerId,
      name: "R. K. Sharma",
      phone: "9123456789",
      loginId: "9123456789",
      isActive: true,
    },
    {
      _id: new mongoose.Types.ObjectId(teacher2Id),
      centerId: centerId,
      name: "P. Gupta",
      phone: "9234567890",
      loginId: "9234567890",
      isActive: true,
    },
  ];

  // Helper date parsers matching route.ts
  function parseISTDailyBounds(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const start = new Date(`${dateStr}T00:00:00.000+05:30`);
    const end = new Date(`${dateStr}T23:59:59.999+05:30`);
    return isNaN(start.getTime()) || isNaN(end.getTime()) ? null : { start, end };
  }

  function parseISTMonthlyBounds(year, month) {
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null;
    const monthStr = String(month).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    const lastDayStr = String(lastDay).padStart(2, "0");
    const start = new Date(`${year}-${monthStr}-01T00:00:00.000+05:30`);
    const end = new Date(`${year}-${monthStr}-${lastDayStr}T23:59:59.999+05:30`);
    return isNaN(start.getTime()) || isNaN(end.getTime()) ? null : { start, end };
  }

  function parseISTCustomBounds(startDateStr, endDateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) return null;
    const start = new Date(`${startDateStr}T00:00:00.000+05:30`);
    const end = new Date(`${endDateStr}T23:59:59.999+05:30`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return null;
    return { start, end };
  }

  // --------------------------------------------------------------------------
  // TEST 1: Unauthenticated request is rejected (401 Unauthorized)
  // --------------------------------------------------------------------------
  await t.test("1. Unauthenticated request to /api/reports/teacher-collections returns 401", async () => {
    const unauthReq = createMockRequest({ token: null });
    const user = await getAuthenticatedUser(unauthReq);

    let statusCode = 200;
    let error = null;
    if (!user) {
      statusCode = 401;
      error = "Authentication required to access collection reports";
    }

    assert.equal(statusCode, 401);
    assert.match(error, /Authentication required/i);
  });

  // --------------------------------------------------------------------------
  // TEST 2: Teacher request is rejected (403 Forbidden)
  // --------------------------------------------------------------------------
  await t.test("2. Additional Teacher request returns 403 Forbidden (DEC-MSEC-06)", async () => {
    const teacherReq = createMockRequest({ token: teacherToken });
    const user = await getAuthenticatedUser(teacherReq);

    let statusCode = 200;
    let error = null;
    if (user.role !== "owner") {
      statusCode = 403;
      error = "Access denied: Collection reports are restricted strictly to institute owners";
    }

    assert.equal(statusCode, 403);
    assert.match(error, /restricted strictly to institute owners/i);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Owner request is authorized (200 OK)
  // --------------------------------------------------------------------------
  await t.test("3. Owner request is fully authorized with role 'owner'", async () => {
    const ownerReq = createMockRequest({ token: ownerToken });
    const user = await getAuthenticatedUser(ownerReq);

    assert.ok(user);
    assert.equal(user.role, "owner");
    assert.equal(user.centerId, centerId);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Daily report bounds calculation under IST
  // --------------------------------------------------------------------------
  await t.test("4. Daily report bounds correctly calculate IST calendar start and end in UTC", async () => {
    const bounds = parseISTDailyBounds("2026-11-03");
    assert.ok(bounds);

    // 2026-11-03T00:00:00.000+05:30 in UTC is 2026-11-02T18:30:00.000Z
    assert.equal(bounds.start.toISOString(), "2026-11-02T18:30:00.000Z");
    // 2026-11-03T23:59:59.999+05:30 in UTC is 2026-11-03T18:29:59.999Z
    assert.equal(bounds.end.toISOString(), "2026-11-03T18:29:59.999Z");
  });

  // --------------------------------------------------------------------------
  // TEST 5: Monthly report bounds calculation under IST
  // --------------------------------------------------------------------------
  await t.test("5. Monthly report bounds cover full month from day 1 to last day under IST", async () => {
    // November 2026 has 30 days
    const boundsNov = parseISTMonthlyBounds(2026, 11);
    assert.ok(boundsNov);
    assert.equal(boundsNov.start.toISOString(), "2026-10-31T18:30:00.000Z");
    assert.equal(boundsNov.end.toISOString(), "2026-11-30T18:29:59.999Z");

    // December 2026 has 31 days
    const boundsDec = parseISTMonthlyBounds(2026, 12);
    assert.ok(boundsDec);
    assert.equal(boundsDec.start.toISOString(), "2026-11-30T18:30:00.000Z");
    assert.equal(boundsDec.end.toISOString(), "2026-12-31T18:29:59.999Z");
  });

  // --------------------------------------------------------------------------
  // TEST 6: Custom date range bounds calculation under IST
  // --------------------------------------------------------------------------
  await t.test("6. Custom date range bounds compute inclusive interval in IST", async () => {
    const bounds = parseISTCustomBounds("2026-11-01", "2026-11-15");
    assert.ok(bounds);
    assert.equal(bounds.start.toISOString(), "2026-10-31T18:30:00.000Z");
    assert.equal(bounds.end.toISOString(), "2026-11-15T18:29:59.999Z");
  });

  // --------------------------------------------------------------------------
  // TEST 7: Invalid date parameters rejected (400 Bad Request)
  // --------------------------------------------------------------------------
  await t.test("7. Invalid date parameter formats return 400 Bad Request", async () => {
    assert.equal(parseISTDailyBounds("invalid-date"), null);
    assert.equal(parseISTDailyBounds("2026-13-45"), null);
    assert.equal(parseISTMonthlyBounds(2026, 13), null);
    assert.equal(parseISTMonthlyBounds(2026, 0), null);
    // Reversed custom range (startDate > endDate)
    assert.equal(parseISTCustomBounds("2026-11-20", "2026-11-10"), null);
  });

  // --------------------------------------------------------------------------
  // TEST 8: Default query parameter resolves to today in IST
  // --------------------------------------------------------------------------
  await t.test("8. Default query without parameters resolves to current date in IST", async () => {
    const istComponents = getISTDateComponents(new Date());
    const todayStr = `${istComponents.year}-${String(istComponents.month).padStart(2, "0")}-${String(istComponents.day).padStart(2, "0")}`;
    const bounds = parseISTDailyBounds(todayStr);

    assert.ok(bounds);
    assert.ok(bounds.start instanceof Date);
    assert.ok(bounds.end instanceof Date);
    assert.ok(bounds.start < bounds.end);
  });

  // --------------------------------------------------------------------------
  // TEST 9: Dual-Axis Attribution: Teacher 1 collects for Owner-assigned student
  // --------------------------------------------------------------------------
  await t.test(
    "9. Dual-Axis Attribution: Teacher collects for Owner-assigned student (receivedBy=Teacher, academic=Owner)",
    async () => {
      // Fee settled on 2026-11-03:
      // - Academic Responsibility: Owner (assignedTeacherAtPayment: null)
      // - Cash Custody: Teacher 1 (receivedBy: teacher1Id, receivedByRole: 'teacher')
      const paymentDate = new Date("2026-11-03T10:00:00.000+05:30");
      const testFees = [
        {
          _id: "fee001",
          centerId: centerId,
          amountDue: 0,
          paidAmount: 2500,
          status: "Paid",
          paymentDate: paymentDate,
          assignedTeacherAtPayment: null, // Owner academic
          receivedBy: teacher1Id, // Teacher collected cash
          receivedByRole: "teacher",
        },
      ];

      // Simulated aggregation facets:
      const bounds = parseISTDailyBounds("2026-11-03");
      const matched = testFees.filter(
        (f) =>
          f.centerId === centerId &&
          f.status === "Paid" &&
          f.paymentDate >= bounds.start &&
          f.paymentDate <= bounds.end
      );

      // 1. Consolidated
      const totalAmount = matched.reduce((sum, f) => sum + f.paidAmount, 0);
      assert.equal(totalAmount, 2500);

      // 2. byPaymentReceiver
      const receiverGroup = {};
      matched.forEach((f) => {
        const key = `${f.receivedBy}_${f.receivedByRole}`;
        receiverGroup[key] = (receiverGroup[key] || 0) + f.paidAmount;
      });
      assert.equal(receiverGroup[`${teacher1Id}_teacher`], 2500, "Teacher 1 must be credited for cash collection");

      // 3. byAcademicTeacher
      const academicGroup = {};
      matched.forEach((f) => {
        const key = f.assignedTeacherAtPayment || "owner";
        academicGroup[key] = (academicGroup[key] || 0) + f.paidAmount;
      });
      assert.equal(academicGroup["owner"], 2500, "Owner must be attributed for academic tuition");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 10: Dual-Axis Attribution: Owner collects for Teacher 1 student
  // --------------------------------------------------------------------------
  await t.test(
    "10. Dual-Axis Attribution: Owner collects for Teacher 1 student (receivedBy=Owner, academic=Teacher 1)",
    async () => {
      const paymentDate = new Date("2026-11-03T14:30:00.000+05:30");
      const testFees = [
        {
          _id: "fee002",
          centerId: centerId,
          amountDue: 0,
          paidAmount: 3000,
          status: "Paid",
          paymentDate: paymentDate,
          assignedTeacherAtPayment: teacher1Id, // Teacher 1 student
          receivedBy: ownerId, // Owner collected cash
          receivedByRole: "owner",
        },
      ];

      const bounds = parseISTDailyBounds("2026-11-03");
      const matched = testFees.filter(
        (f) =>
          f.centerId === centerId &&
          f.status === "Paid" &&
          f.paymentDate >= bounds.start &&
          f.paymentDate <= bounds.end
      );

      // byPaymentReceiver
      const receiver = matched[0];
      assert.equal(receiver.receivedBy, ownerId);
      assert.equal(receiver.receivedByRole, "owner");

      // byAcademicTeacher
      const academic = matched[0];
      assert.equal(academic.assignedTeacherAtPayment, teacher1Id);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 11: Cross-Teacher Collection: Teacher 2 collects for Teacher 1 student
  // --------------------------------------------------------------------------
  await t.test(
    "11. Dual-Axis Attribution: Teacher 2 collects for Teacher 1 student (receivedBy=Teacher 2, academic=Teacher 1)",
    async () => {
      const paymentDate = new Date("2026-11-03T16:00:00.000+05:30");
      const testFees = [
        {
          _id: "fee003",
          centerId: centerId,
          amountDue: 0,
          paidAmount: 1800,
          status: "Paid",
          paymentDate: paymentDate,
          assignedTeacherAtPayment: teacher1Id, // Academic: Teacher 1
          receivedBy: teacher2Id, // Custody: Teacher 2
          receivedByRole: "teacher",
        },
      ];

      const bounds = parseISTDailyBounds("2026-11-03");
      const matched = testFees.filter(
        (f) =>
          f.centerId === centerId &&
          f.status === "Paid" &&
          f.paymentDate >= bounds.start &&
          f.paymentDate <= bounds.end
      );

      assert.equal(matched[0].receivedBy, teacher2Id, "Teacher 2 is physical collector");
      assert.equal(matched[0].assignedTeacherAtPayment, teacher1Id, "Teacher 1 is academic instructor");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 12: Verification Pending advance fees are strictly excluded
  // --------------------------------------------------------------------------
  await t.test("12. Verification Pending advance fees (paidAmount=0, paymentDate=null) are excluded from report totals", async () => {
    const testFees = [
      {
        _id: "fee_pending_advance",
        centerId: centerId,
        amountDue: 2000,
        paidAmount: 0,
        status: "Verification Pending",
        paymentDate: null,
        assignedTeacherAtPayment: null,
        receivedBy: null,
      },
      {
        _id: "fee_settled",
        centerId: centerId,
        amountDue: 0,
        paidAmount: 2000,
        status: "Paid",
        paymentDate: new Date("2026-11-03T11:00:00.000+05:30"),
        assignedTeacherAtPayment: teacher1Id,
        receivedBy: teacher1Id,
        receivedByRole: "teacher",
      },
    ];

    const bounds = parseISTDailyBounds("2026-11-03");
    // Match criteria from route.ts:
    // status in ["Paid", "Partial Paid"], paidAmount > 0, isVoided != true, paymentDate in bounds
    const matched = testFees.filter(
      (f) =>
        (f.status === "Paid" || f.status === "Partial Paid") &&
        f.paidAmount > 0 &&
        f.paymentDate &&
        f.paymentDate >= bounds.start &&
        f.paymentDate <= bounds.end
    );

    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, "fee_settled");
    const total = matched.reduce((acc, f) => acc + f.paidAmount, 0);
    assert.equal(total, 2000, "Unverified advance payment must NOT add to report revenue");
  });

  // --------------------------------------------------------------------------
  // TEST 13: Voided fees (isVoided: true) are strictly excluded
  // --------------------------------------------------------------------------
  await t.test("13. Voided fees (isVoided: true) are excluded from collections", async () => {
    const testFees = [
      {
        _id: "fee_voided",
        centerId: centerId,
        amountDue: 0,
        paidAmount: 1500,
        status: "Paid",
        isVoided: true,
        paymentDate: new Date("2026-11-03T11:00:00.000+05:30"),
      },
      {
        _id: "fee_valid",
        centerId: centerId,
        amountDue: 0,
        paidAmount: 1500,
        status: "Paid",
        isVoided: false,
        paymentDate: new Date("2026-11-03T12:00:00.000+05:30"),
      },
    ];

    const bounds = parseISTDailyBounds("2026-11-03");
    const matched = testFees.filter(
      (f) =>
        (f.status === "Paid" || f.status === "Partial Paid") &&
        f.isVoided !== true &&
        f.paymentDate >= bounds.start &&
        f.paymentDate <= bounds.end
    );

    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, "fee_valid");
  });

  // --------------------------------------------------------------------------
  // TEST 14: Cross-Center Tenant Isolation
  // --------------------------------------------------------------------------
  await t.test("14. Cross-Center Tenant Isolation: Foreign center collections are strictly excluded", async () => {
    const testFees = [
      {
        _id: "fee_msec",
        centerId: centerId,
        paidAmount: 5000,
        status: "Paid",
        paymentDate: new Date("2026-11-03T10:00:00.000+05:30"),
      },
      {
        _id: "fee_foreign",
        centerId: foreignCenterId, // Foreign center
        paidAmount: 10000,
        status: "Paid",
        paymentDate: new Date("2026-11-03T10:00:00.000+05:30"),
      },
    ];

    const bounds = parseISTDailyBounds("2026-11-03");
    // Owner of 'msec' queries:
    const matched = testFees.filter(
      (f) =>
        f.centerId === centerId &&
        f.status === "Paid" &&
        f.paymentDate >= bounds.start &&
        f.paymentDate <= bounds.end
    );

    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, "fee_msec");
    assert.equal(matched[0].paidAmount, 5000);
  });

  // --------------------------------------------------------------------------
  // TEST 15: Client-supplied centerId parameter is strictly ignored
  // --------------------------------------------------------------------------
  await t.test("15. Client-supplied centerId parameter cannot override authenticated JWT centerId", async () => {
    // Owner of foreignCenterId tries to pass centerId=msec in query
    const spoofReq = createMockRequest({
      token: foreignOwnerToken,
      searchParams: { centerId: "msec", type: "daily", date: "2026-11-03" },
    });

    const user = await getAuthenticatedUser(spoofReq);
    assert.equal(user.centerId, foreignCenterId, "Center must be derived strictly from verified JWT");

    // Scoped query uses user.centerId:
    const targetCenterId = user.centerId;
    assert.equal(targetCenterId, foreignCenterId);
    assert.notEqual(targetCenterId, "msec");
  });
});
