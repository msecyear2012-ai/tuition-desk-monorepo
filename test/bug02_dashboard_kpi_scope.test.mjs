import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// Read MONGODB_URI & JWT_SECRET from tution-desk-be/.env
const envPath = path.join(beDir, ".env");
const envContent = fs.readFileSync(envPath, "utf8");
let mongoUri = "";
let jwtSecret = "test-secret-key-for-msec-tuition-desk-32chars!";

for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed.startsWith("MONGODB_URI=")) {
    mongoUri = trimmed.slice("MONGODB_URI=".length).trim().replace(/^['\"]|['\"]$/g, "");
  }
  if (trimmed.startsWith("JWT_SECRET=")) {
    jwtSecret = trimmed.slice("JWT_SECRET=".length).trim().replace(/^['\"]|['\"]$/g, "");
  }
}

process.env.JWT_SECRET = jwtSecret;
process.env.MONGODB_URI = mongoUri;

const CENTER_ID = "msce-8267";
const OWNER_ID = new mongoose.Types.ObjectId("6ae869d9c117e0a550dcb247");
const TEACHER_1_ID = new mongoose.Types.ObjectId("6ae9ba93d29bd04896bac676");
const TEACHER_2_ID = new mongoose.Types.ObjectId("6af100000000000000000001");

const STUDENT_OWNER_ID = new mongoose.Types.ObjectId("6af100000000000000000004");
const STUDENT_T1_ID = new mongoose.Types.ObjectId("6af100000000000000000005");
const STUDENT_T2_ID = new mongoose.Types.ObjectId("6af100000000000000000006");
const STUDENT_JACK_ID = new mongoose.Types.ObjectId("6ae9bb06d29bd04896bac678");

function createMockRequest({
  method = "GET",
  token = null,
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
        if (name.toLowerCase() === "authorization" && token) return `Bearer ${token}`;
        return headers[name.toLowerCase()] || null;
      },
    },
    nextUrl: {
      searchParams: {
        get: (key) => (key in searchParams ? String(searchParams[key]) : null),
      },
    },
    json: async () => ({}),
  };
}

test("Bug 02 – Teacher Dashboard Financial Activity & KPI Scope Mismatch Specification Suite", async (t) => {
  // Connect to database
  await mongoose.connect(mongoUri, {
    bufferCommands: false,
    autoIndex: false,
    readPreference: "primaryPreferred",
  });

  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { GET: ownerDashboardRoute } = await import(
    "../tution-desk-be/src/app/api/dashboard/owner/route.ts"
  );

  // Generate verified JWT tokens
  const ownerToken = await signToken({
    userId: OWNER_ID.toString(),
    centerId: CENTER_ID,
    role: "owner",
    phone: "9999907717",
  });

  const teacher1Token = await signToken({
    userId: TEACHER_1_ID.toString(),
    centerId: CENTER_ID,
    role: "teacher",
    teacherId: TEACHER_1_ID.toString(),
    phone: "9999908820",
    name: "Jitender Kumar",
  });

  const teacher2Token = await signToken({
    userId: TEACHER_2_ID.toString(),
    centerId: CENTER_ID,
    role: "teacher",
    teacherId: TEACHER_2_ID.toString(),
    phone: "9999900002",
    name: "TEST_E2E_Teacher_Sharma",
  });

  try {
    // ------------------------------------------------------------------------
    // Group 1: Teacher 1 (Jitender Kumar) Dashboard Scoping
    // ------------------------------------------------------------------------
    await t.test("1.1 Teacher 1 dashboard returns strictly Teacher 1 student counts and batch counts", async () => {
      const req = createMockRequest({ token: teacher1Token });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      // Teacher 1 has 2 students (jack and Student T1)
      assert.equal(json.data.totalStudents, 2, "Teacher 1 should have exactly 2 assigned students");
      // Teacher 1 has assigned batches (including Class 10 - Mathematics)
      assert.ok(json.data.totalBatches >= 1, "Teacher 1 should have assigned batches");
      assert.ok(json.data.batches.some((b) => b.batchName === "Class 10 - Mathematics"), "Teacher 1 must see Class 10 - Mathematics");
      const mathBatch = json.data.batches.find((b) => b.batchName === "Class 10 - Mathematics");
      assert.ok(mathBatch, "Class 10 - Mathematics must be in batches");
      assert.equal(mathBatch.totalStudents, 2);
    });

    await t.test("1.2 Teacher 1 dashboard returns strictly Teacher 1 financial KPIs (pending fees, collected fees)", async () => {
      const req = createMockRequest({ token: teacher1Token });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      // Fee Student T1 was settled via manual collection (amountDue: 0, paidAmount: 3000)
      assert.equal(json.data.pendingFeesTotal, 0, "Teacher 1 pending fees must be 0");
      assert.equal(json.data.overdueCount, 0, "Teacher 1 overdue count must be 0");
      // Collected fees: 3000. Must NOT leak 3500 from Student T2 (which would make it 6500).
      assert.equal(json.data.collectedFeesThisMonth, 3000, "Teacher 1 collected fees must be 3000");
      // Pending tests count: 1 (TEST_E2E_T1_Math_Test). Must NOT include Owner quiz.
      assert.equal(json.data.pendingTestsCount, 1, "Teacher 1 pending tests count must be 1");
    });

    await t.test("1.3 Teacher 1 Recent Activity excludes Owner and Teacher 2 events", async () => {
      const req = createMockRequest({ token: teacher1Token });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      const activities = json.data.recentActivities || [];
      assert.ok(activities.length > 0, "Should have recent activities for Teacher 1");

      for (const act of activities) {
        // Must NOT leak Owner student or Teacher 2 student
        assert.equal(
          act.title.includes("TEST_E2E_Student_Owner"),
          false,
          `Activity '${act.title}' must not mention Student Owner`
        );
        assert.equal(
          act.title.includes("TEST_E2E_Student_T2"),
          false,
          `Activity '${act.title}' must not mention Student T2`
        );
        // Fee activities must NOT leak Owner's 2000 or Teacher 2's 3500
        if (act.type === "fee") {
          assert.notEqual(act.amount, 2000, "Must not leak Owner's fee of 2000");
          assert.notEqual(act.amount, 3500, "Must not leak Teacher 2's fee of 3500");
        }
      }
    });

    // ------------------------------------------------------------------------
    // Group 2: Teacher 2 (Sharma) Dashboard Scoping
    // ------------------------------------------------------------------------
    await t.test("2.1 Teacher 2 dashboard returns strictly Teacher 2 student counts and batch counts", async () => {
      const req = createMockRequest({ token: teacher2Token });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      // Teacher 2 has 1 student (Student T2)
      assert.equal(json.data.totalStudents, 1, "Teacher 2 should have exactly 1 assigned student");
      // Teacher 2 has 1 batch (TEST_E2E_Batch_Physics)
      assert.equal(json.data.totalBatches, 1, "Teacher 2 should have exactly 1 batch");
      assert.equal(json.data.batches.length, 1);
      assert.equal(json.data.batches[0].batchName, "TEST_E2E_Batch_Physics");
      assert.equal(json.data.batches[0].totalStudents, 1);
    });

    await t.test("2.2 Teacher 2 dashboard returns strictly Teacher 2 financial KPIs", async () => {
      const req = createMockRequest({ token: teacher2Token });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      // Pending fees: 0 (Student T2's fee is Paid)
      assert.equal(json.data.pendingFeesTotal, 0, "Teacher 2 pending fees must be 0");
      assert.equal(json.data.overdueCount, 0, "Teacher 2 overdue count must be 0");
      // Collected fees: 3500 (FEE_PAID_UTR)
      assert.equal(json.data.collectedFeesThisMonth, 3500, "Teacher 2 collected fees must be 3500");
      // Pending tests: 0 (Teacher 2 has no tests)
      assert.equal(json.data.pendingTestsCount, 0, "Teacher 2 pending tests count must be 0");
    });

    await t.test("2.3 Teacher 2 Recent Activity excludes Owner and Teacher 1 events", async () => {
      const req = createMockRequest({ token: teacher2Token });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      const activities = json.data.recentActivities || [];
      assert.ok(activities.length > 0, "Should have recent activities for Teacher 2");

      for (const act of activities) {
        assert.equal(
          act.title.includes("TEST_E2E_Student_Owner"),
          false,
          `Activity '${act.title}' must not mention Student Owner`
        );
        assert.equal(
          act.title.includes("TEST_E2E_Student_T1"),
          false,
          `Activity '${act.title}' must not mention Student T1`
        );
        assert.equal(
          act.title.includes("jack"),
          false,
          `Activity '${act.title}' must not mention Student jack`
        );
        if (act.type === "fee") {
          assert.notEqual(act.amount, 2000, "Must not leak Owner's fee of 2000");
          assert.notEqual(act.amount, 3000, "Must not leak Teacher 1's fee of 3000");
        }
      }
    });

    // ------------------------------------------------------------------------
    // Group 3: Owner Dashboard (Institute-wide & Faculty Filtering)
    // ------------------------------------------------------------------------
    await t.test("3.1 Owner dashboard (unfiltered) returns institute-wide totals", async () => {
      const req = createMockRequest({ token: ownerToken });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      // Institute-wide totals
      assert.equal(json.data.totalStudents, 4, "Owner sees all 4 students");
      assert.ok(json.data.totalBatches >= 3, "Owner sees all active batches");
      assert.equal(json.data.pendingFeesTotal, 2000, "Owner sees pending fees sum (Fee Student Owner: 2000)");
      assert.equal(json.data.overdueCount, 1, "Owner sees overdue count of 1");
      assert.equal(json.data.collectedFeesThisMonth, 6500, "Owner sees collected fees sum of 6500 (3000 + 3500)");
      assert.equal(json.data.pendingTestsCount, 2, "Owner sees all 2 tests");
      assert.ok(json.data.batches.length >= 3, "Owner sees active batches in timeline");
    });

    await t.test("3.2 Owner dashboard filtered by Myself (?assignedTeacher=owner)", async () => {
      const req = createMockRequest({ token: ownerToken, searchParams: { assignedTeacher: "owner" } });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      assert.equal(json.data.totalStudents, 1, "Owner filtered sees 1 student");
      assert.equal(json.data.totalBatches, 1, "Owner filtered sees 1 batch");
      assert.equal(json.data.pendingFeesTotal, 2000, "Owner filtered sees 2000 pending fee");
      assert.equal(json.data.overdueCount, 1, "Owner filtered sees 1 overdue fee");
      assert.equal(json.data.collectedFeesThisMonth, 0, "Owner filtered sees 0 collected fees");
      assert.equal(json.data.pendingTestsCount, 1, "Owner filtered sees 1 test");
    });

    await t.test("3.3 Owner dashboard filtered by Teacher 1 (?assignedTeacher=TEACHER_1_ID)", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: TEACHER_1_ID.toString() },
      });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      assert.equal(json.data.totalStudents, 2, "Owner filtering Teacher 1 sees 2 students");
      assert.ok(json.data.totalBatches >= 1, "Owner filtering Teacher 1 sees Teacher 1 batches");
      assert.equal(json.data.pendingFeesTotal, 0, "Owner filtering Teacher 1 sees 0 pending");
      assert.equal(json.data.collectedFeesThisMonth, 3000, "Owner filtering Teacher 1 sees 3000 collected");
    });

    // ------------------------------------------------------------------------
    // Group 4: Security, IDOR Protection & Error Handling
    // ------------------------------------------------------------------------
    await t.test("4.1 Teacher cannot bypass scoping via client query parameters", async () => {
      // Teacher 1 attempts to pass ?assignedTeacher=owner
      const req = createMockRequest({
        token: teacher1Token,
        searchParams: { assignedTeacher: "owner" },
      });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      // Scoping must remain strictly Teacher 1
      assert.equal(json.data.totalStudents, 2, "Teacher cannot expand or switch scope via query params");
      assert.equal(json.data.pendingFeesTotal, 0);
      assert.equal(json.data.collectedFeesThisMonth, 3000);
    });

    await t.test("4.2 Unauthenticated access to dashboard returns 401 Unauthorized", async () => {
      const req = createMockRequest({ token: null });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.error, /authentication required/i);
    });

    await t.test("4.3 Owner passing invalid assignedTeacher parameter receives 400 Bad Request", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: "invalid_id_not_an_object_id" },
      });
      const res = await ownerDashboardRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.error, /invalid assignedteacher query parameter/i);
    });
  } catch (err) {
    console.error("FATAL TEST ERROR:", err);
    throw err;
  } finally {
    await mongoose.disconnect();
  }
});
