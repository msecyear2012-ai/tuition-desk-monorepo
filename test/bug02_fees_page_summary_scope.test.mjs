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

test("Bug 02 Follow-up – Fees Page Summary Backend Scoping & Attribution Specification Suite", async (t) => {
  // Connect to database
  await mongoose.connect(mongoUri, {
    bufferCommands: false,
    autoIndex: false,
    readPreference: "primaryPreferred",
  });

  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const { GET: feesSummaryRoute } = await import(
    "../tution-desk-be/src/app/api/fees/summary/route.ts"
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
    // Group 1: Teacher 1 (Jitender Kumar) Fees Summary Scoping
    // ------------------------------------------------------------------------
    await t.test("1.1 Teacher 1 fees summary returns strictly Teacher 1 metrics (Pending: 0, Due: 0, Collected: 3000)", async () => {
      const req = createMockRequest({ token: teacher1Token });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      // Expected for Teacher 1 with settled fee for Student T1:
      // - Pending dues: ₹0
      // - Collected: ₹3,000 (Must NOT leak ₹3,500 from Teacher 2's student to become 6500)
      // - Students due: 0
      assert.equal(json.data.totalPendingAmount, 0, "Teacher 1 pending dues must be exactly 0");
      assert.equal(json.data.pendingStudentsCount, 0, "Teacher 1 students due count must be exactly 0");
      assert.equal(json.data.collectedAmount, 3000, "Teacher 1 collected fees must be exactly 3000");
    });

    // ------------------------------------------------------------------------
    // Group 2: Teacher 2 (Sharma) Fees Summary Scoping
    // ------------------------------------------------------------------------
    await t.test("2.1 Teacher 2 fees summary returns strictly Teacher 2 metrics (Pending: 0, Due: 0, Collected: 3500)", async () => {
      const req = createMockRequest({ token: teacher2Token });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      // Expected for Teacher 2:
      // - Pending dues: ₹0
      // - Collected: ₹3,500 (FEE_PAID_UTR for Student T2)
      // - Students due: 0
      assert.equal(json.data.totalPendingAmount, 0, "Teacher 2 pending dues must be exactly 0");
      assert.equal(json.data.pendingStudentsCount, 0, "Teacher 2 students due count must be exactly 0");
      assert.equal(json.data.collectedAmount, 3500, "Teacher 2 collected fees must be exactly 3500");
    });

    // ------------------------------------------------------------------------
    // Group 3: Owner Fees Summary (Institute-wide & Faculty Filtering)
    // ------------------------------------------------------------------------
    await t.test("3.1 Owner fees summary (unfiltered) returns institute-wide totals (Pending: 2000, Due: 1, Collected: 6500)", async () => {
      const req = createMockRequest({ token: ownerToken });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      // Expected for Owner:
      // - Pending dues: ₹2,000 (Fee Student Owner)
      // - Collected: ₹6,500 (3000 for Student T1 + 3500 for Student T2)
      // - Students due: 1
      assert.equal(json.data.totalPendingAmount, 2000, "Owner pending dues must be exactly 2000");
      assert.equal(json.data.pendingStudentsCount, 1, "Owner students due count must be exactly 1");
      assert.equal(json.data.collectedAmount, 6500, "Owner collected fees must be exactly 6500");
    });

    await t.test("3.2 Owner fees summary filtered by Myself (?assignedTeacher=owner)", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: "owner" },
      });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      assert.equal(json.data.totalPendingAmount, 2000, "Owner filtered pending dues must be 2000");
      assert.equal(json.data.pendingStudentsCount, 1, "Owner filtered students due must be 1");
      assert.equal(json.data.collectedAmount, 0, "Owner filtered collected must be 0");
    });

    await t.test("3.3 Owner fees summary filtered by Teacher 1 (?assignedTeacher=TEACHER_1_ID)", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: TEACHER_1_ID.toString() },
      });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      assert.equal(json.data.totalPendingAmount, 0, "Owner filtering Teacher 1 sees 0 pending");
      assert.equal(json.data.pendingStudentsCount, 0, "Owner filtering Teacher 1 sees 0 students due");
      assert.equal(json.data.collectedAmount, 3000, "Owner filtering Teacher 1 sees 3000 collected");
    });

    await t.test("3.4 Owner fees summary filtered by Teacher 2 (?assignedTeacher=TEACHER_2_ID)", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: TEACHER_2_ID.toString() },
      });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      assert.equal(json.data.totalPendingAmount, 0, "Owner filtering Teacher 2 sees 0 pending");
      assert.equal(json.data.pendingStudentsCount, 0, "Owner filtering Teacher 2 sees 0 students due");
      assert.equal(json.data.collectedAmount, 3500, "Owner filtering Teacher 2 sees 3500 collected");
    });

    // ------------------------------------------------------------------------
    // Group 4: Cross-Teacher Attribution & IDOR Protection
    // ------------------------------------------------------------------------
    await t.test("4.1 Cross-teacher collection attribution: receivedBy and academic assignment remain distinct", async () => {
      // Find seeded paid fee
      const paidFee = await mongoose.connection.db.collection("fees").findOne({
        _id: new mongoose.Types.ObjectId("6af100000000000000000009"),
      });
      assert.ok(paidFee);
      // Academic assignment belongs to Teacher 2
      assert.equal(paidFee.assignedTeacherId.toString(), TEACHER_2_ID.toString());

      // Query Teacher 1's summary: includes only Teacher 1's student fee (3000), NOT Teacher 2's (3500)
      const reqT1 = createMockRequest({ token: teacher1Token });
      const resT1 = await feesSummaryRoute(reqT1);
      const jsonT1 = await resT1.json();
      assert.equal(jsonT1.data.collectedAmount, 3000, "Teacher 1 summary must not leak Teacher 2's collected fee");

      // Query Teacher 2's summary: it must be included for Teacher 2 (3500)
      const reqT2 = createMockRequest({ token: teacher2Token });
      const resT2 = await feesSummaryRoute(reqT2);
      const jsonT2 = await resT2.json();
      assert.equal(jsonT2.data.collectedAmount, 3500, "Teacher 2 summary must include Teacher 2's collected fee");
    });

    await t.test("4.2 Teacher cannot bypass scoping via client query parameters", async () => {
      const req = createMockRequest({
        token: teacher1Token,
        searchParams: { assignedTeacher: "owner" },
      });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      assert.equal(json.data.totalPendingAmount, 0, "Teacher 1 cannot expand scope to Owner");
      assert.equal(json.data.collectedAmount, 3000);
    });

    await t.test("4.3 Unauthenticated access to fees summary returns 401 Unauthorized", async () => {
      const req = createMockRequest({ token: null });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.error, /authentication required/i);
    });

    await t.test("4.4 Owner passing invalid assignedTeacher parameter receives 400 Bad Request", async () => {
      const req = createMockRequest({
        token: ownerToken,
        searchParams: { assignedTeacher: "not_a_valid_id" },
      });
      const res = await feesSummaryRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.match(json.error, /invalid assignedteacher query parameter/i);
    });
  } finally {
    await mongoose.disconnect();
  }
});
