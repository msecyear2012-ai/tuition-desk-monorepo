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

test("Bug 03 – Payment Collector Attribution & Fee History Access Control Specification Suite", async (t) => {
  // Connect to database
  await mongoose.connect(mongoUri, {
    bufferCommands: false,
    autoIndex: false,
    readPreference: "primaryPreferred",
  });

  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { GET: feesRoute } = await import(
    "../tution-desk-be/src/app/api/fees/route.ts"
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
    // Group 1: Owner Paid Fee History (Institute-wide & Financial Accuracy)
    // ------------------------------------------------------------------------
    await t.test("1.1 Owner retrieves institute-wide paid history with actual paid amounts summing to ₹6,500", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { status: "Paid,Partial Paid" },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(Array.isArray(json.data));
      assert.equal(json.data.length, 2, "Owner must see both paid records across institute");

      // Verify records and sum of actual paid amounts
      const t1Fee = json.data.find(
        (f) => String(f._id) === "6af100000000000000000007"
      );
      const t2Fee = json.data.find(
        (f) => String(f._id) === "6af100000000000000000009"
      );

      assert.ok(t1Fee, "TEST_E2E_Student_T1 fee record must be present");
      assert.ok(t2Fee, "TEST_E2E_Student_T2 fee record must be present");

      // Financial accuracy check: T1 fee has paidAmount 3000 (not 0) despite amountDue being 0!
      assert.equal(t1Fee.paidAmount, 3000, "T1 fee actual paidAmount must be 3000 (never 0)");
      assert.equal(t1Fee.amountDue, 0, "T1 fee amountDue is 0 because settled");
      assert.equal(t2Fee.paidAmount, 3500, "T2 fee actual paidAmount must be 3500");

      const totalCollection = json.data.reduce(
        (sum, f) => sum + (Number(f.paidAmount || f.amountDue) || 0),
        0
      );
      assert.equal(totalCollection, 6500, "Overall collection must be exactly ₹6,500 (3000 + 3500)");
    });

    await t.test("1.2 Owner sees complete snapshot details: Receipt, Mode, Date, Collector and Academic Faculty", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { status: "Paid,Partial Paid" },
      });
      const res = await feesRoute(req);
      const json = await res.json();

      const t1Fee = json.data.find((f) => String(f._id) === "6af100000000000000000007");
      assert.ok(t1Fee);

      // Student name (populated)
      assert.equal(t1Fee.studentId.name, "TEST_E2E_Student_T1");
      // Payment details
      assert.equal(t1Fee.paymentMode, "Cash");
      assert.equal(t1Fee.receiptNumber, "RCPT-TYZGGP");
      assert.ok(t1Fee.paidDate || t1Fee.paymentDate || t1Fee.paidAt, "Payment date must be populated");
      // Collector attribution (receivedBy: Jitender Kumar, teacher)
      assert.equal(t1Fee.receivedByName, "Jitender Kumar");
      assert.equal(t1Fee.receivedByRole, "teacher");
      // Academic Teacher at payment time
      assert.equal(t1Fee.assignedTeacherName, "Jitender Kumar");

      const t2Fee = json.data.find((f) => String(f._id) === "6af100000000000000000009");
      assert.ok(t2Fee);
      assert.equal(t2Fee.studentId.name, "TEST_E2E_Student_T2");
      assert.equal(t2Fee.paymentMode, "UPI");
      assert.equal(t2Fee.receiptNumber, "RCPT-MSEC-E2E01");
      assert.equal(t2Fee.receivedByName, "TEST_E2E_Teacher_Sharma");
      assert.equal(t2Fee.receivedByRole, "teacher");
      assert.equal(t2Fee.assignedTeacherName, "TEST_E2E_Teacher_Sharma");
    });

    await t.test("1.3 Owner faculty filtering: filter by Teacher 1 returns only Teacher 1 paid record", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { status: "Paid,Partial Paid", assignedTeacher: TEACHER_1_ID.toString() },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.length, 1);
      assert.equal(String(json.data[0]._id), "6af100000000000000000007");
      assert.equal(json.data[0].paidAmount, 3000);
    });

    await t.test("1.4 Owner faculty filtering: filter by Teacher 2 returns only Teacher 2 paid record", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { status: "Paid,Partial Paid", assignedTeacher: TEACHER_2_ID.toString() },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.length, 1);
      assert.equal(String(json.data[0]._id), "6af100000000000000000009");
      assert.equal(json.data[0].paidAmount, 3500);
    });

    await t.test("1.5 Owner faculty filtering: filter by Myself/Owner returns 0 paid records (fee is Pending)", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { status: "Paid,Partial Paid", assignedTeacher: "owner" },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.length, 0, "Owner has no paid records currently (Owner student fee is Pending)");
    });

    // ------------------------------------------------------------------------
    // Group 2: Teacher 1 Paid Fee History Scoping & Isolation
    // ------------------------------------------------------------------------
    await t.test("2.1 Teacher 1 sees payment history strictly for assigned students (Student T1: ₹3000 Settled)", async () => {
      const req = createMockRequest({
        token: teacher1Token,
        searchParams: { status: "Paid,Partial Paid" },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.length, 1, "Teacher 1 must see exactly 1 paid record");
      assert.equal(String(json.data[0]._id), "6af100000000000000000007");
      assert.equal(json.data[0].paidAmount, 3000);
      assert.equal(json.data[0].studentId.name, "TEST_E2E_Student_T1");
      assert.equal(json.data[0].receivedByName, "Jitender Kumar");
      assert.equal(json.data[0].assignedTeacherName, "Jitender Kumar");
    });

    // ------------------------------------------------------------------------
    // Group 3: Teacher 2 Paid Fee History Scoping & Isolation
    // ------------------------------------------------------------------------
    await t.test("3.1 Teacher 2 sees payment history strictly for assigned students (Student T2: ₹3500 Settled)", async () => {
      const req = createMockRequest({
        token: teacher2Token,
        searchParams: { status: "Paid,Partial Paid" },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.length, 1, "Teacher 2 must see exactly 1 paid record");
      assert.equal(String(json.data[0]._id), "6af100000000000000000009");
      assert.equal(json.data[0].paidAmount, 3500);
      assert.equal(json.data[0].studentId.name, "TEST_E2E_Student_T2");
      assert.equal(json.data[0].receivedByName, "TEST_E2E_Teacher_Sharma");
      assert.equal(json.data[0].assignedTeacherName, "TEST_E2E_Teacher_Sharma");
    });

    // ------------------------------------------------------------------------
    // Group 4: Cross-Teacher Collection & IDOR Isolation
    // ------------------------------------------------------------------------
    await t.test("4.1 Collector attribution vs Academic Faculty separation: Collector is NEVER inferred from student assignment", async () => {
      // In record 6af100000000000000000009 (Student T2):
      // The collector was Teacher 2 Sharma (receivedBy: TEACHER_2_ID).
      // If Teacher 1 had collected it, receivedBy would be TEACHER_1_ID.
      // Verify that backend returns distinct fields: receivedByName and assignedTeacherName.
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { status: "Paid" },
      });
      const res = await feesRoute(req);
      const json = await res.json();
      const t2Fee = json.data.find((f) => String(f._id) === "6af100000000000000000009");

      assert.ok("receivedByName" in t2Fee, "Must have explicit receivedByName");
      assert.ok("receivedByRole" in t2Fee, "Must have explicit receivedByRole");
      assert.ok("assignedTeacherName" in t2Fee, "Must have explicit assignedTeacherName");
      assert.ok("batchAtPayment" in t2Fee, "Must have explicit batchAtPayment");
    });

    await t.test("4.2 Teacher cannot access other teachers' student records by passing assignedTeacher query parameter", async () => {
      const req = createMockRequest({
        token: teacher1Token,
        searchParams: { status: "Paid,Partial Paid", assignedTeacher: "owner" },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      // Must still return only Teacher 1's record, ignoring the query parameter override
      assert.equal(json.data.length, 1);
      assert.equal(String(json.data[0]._id), "6af100000000000000000007");
    });

    await t.test("4.3 Unauthenticated request to /api/fees returns 401 Unauthorized", async () => {
      const req = createMockRequest({ token: null });
      const res = await feesRoute(req);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.error, /authentication required/i);
    });

    await t.test("4.4 Owner passing invalid assignedTeacher parameter receives 400 Bad Request", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: "invalid_id_format" },
      });
      const res = await feesRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.error, /invalid assignedteacher query parameter/i);
    });
  } finally {
    await mongoose.disconnect();
  }
});
