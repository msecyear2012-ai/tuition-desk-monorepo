import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";

// Prevent connectDB from attempting live database connections
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

test("MSEC Security Regression Suite: GET /api/centers Authentication & Tenant Isolation", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
  const { GET, POST, OPTIONS } = await import("../tution-desk-be/src/app/api/centers/route.ts");

  // In-memory mock database for Center
  const mockCenters = new Map();

  const centerA = {
    _id: "center_doc_001",
    centerId: "center_alpha",
    name: "Alpha Coaching Academy",
    ownerName: "Alice Owner",
    phone: "9876543210",
    password: "$2a$10$X8O9jXexampleBcryptHashShouldNeverLeakToClients123456",
    themeColor: "#2563eb",
    upiId: "alpha@upi",
    welcomeMessageTemplate: "Welcome to Alpha!",
    isActive: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    __v: 0,
  };

  const centerB = {
    _id: "center_doc_002",
    centerId: "center_beta",
    name: "Beta Learning Center",
    ownerName: "Bob Owner",
    phone: "9123456780",
    password: "$2a$10$Y9P0kYanotherSuperSecretBcryptHashForBetaCenter654321",
    themeColor: "#10b981",
    upiId: "beta@upi",
    welcomeMessageTemplate: "Welcome to Beta!",
    isActive: true,
    createdAt: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-01"),
    __v: 0,
  };

  mockCenters.set("center_alpha", centerA);
  mockCenters.set("center_beta", centerB);

  // Mock CenterModel.findOne to simulate Mongoose query chaining (.select().lean())
  const origFindOne = CenterModel.findOne;
  CenterModel.findOne = function (query) {
    const cid = query?.centerId;
    const doc = cid ? mockCenters.get(cid) : null;

    let selectedDoc = doc ? { ...doc } : null;

    const queryObj = {
      select(fields) {
        if (selectedDoc && typeof fields === "string") {
          const exclusions = fields.split(" ").filter((f) => f.startsWith("-"));
          for (const excl of exclusions) {
            const prop = excl.substring(1);
            delete selectedDoc[prop];
          }
        }
        return queryObj;
      },
      lean() {
        return Promise.resolve(selectedDoc ? { ...selectedDoc } : null);
      },
      then(resolve, reject) {
        return queryObj.lean().then(resolve, reject);
      },
    };

    return queryObj;
  };

  t.after(() => {
    CenterModel.findOne = origFindOne;
  });

  function createMockRequest({
    method = "GET",
    url = "http://localhost:3000/api/centers",
    headers = {},
    body = null,
  } = {}) {
    const headerMap = new Map();
    for (const [k, v] of Object.entries(headers)) {
      headerMap.set(k.toLowerCase(), v);
    }

    return {
      method,
      url,
      nextUrl: new URL(url),
      headers: {
        get: (name) => headerMap.get(name.toLowerCase()) || null,
      },
      cookies: {
        get: (name) => {
          const cookieHeader = headerMap.get("cookie");
          if (!cookieHeader) return null;
          const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
          return match ? { value: decodeURIComponent(match[1]) } : null;
        },
      },
      json: async () => (body ? JSON.parse(JSON.stringify(body)) : {}),
    };
  }

  // 1. Unauthenticated Requests
  await t.test("1.1 GET /api/centers without authentication fails with HTTP 401 Unauthorized", async () => {
    const req = createMockRequest();
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /authentication required/i);
  });

  await t.test("1.2 GET /api/centers with invalid/malformed token fails with HTTP 401 Unauthorized", async () => {
    const req = createMockRequest({
      headers: { Authorization: "Bearer this.is.an.invalid.token" },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /authentication required/i);
  });

  await t.test("1.3 POST /api/centers without authentication fails with HTTP 401 Unauthorized", async () => {
    const req = createMockRequest({
      method: "POST",
      body: { name: "Rogue Center", centerId: "rogue_center" },
    });
    const res = await POST(req);
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
  });

  // 2. Authenticated Authorized Requests
  await t.test("2.1 GET /api/centers with valid Owner token returns 200 with strictly their center", async () => {
    const token = await signToken({
      userId: "user_owner_001",
      centerId: "center_alpha",
      role: "owner",
      name: "Alice Owner",
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.ok(Array.isArray(json.data));
    assert.strictEqual(json.data.length, 1);
    assert.strictEqual(json.data[0].centerId, "center_alpha");
    assert.strictEqual(json.data[0].name, "Alpha Coaching Academy");
  });

  await t.test("2.2 GET /api/centers with valid Teacher token returns 200 with strictly their center", async () => {
    const token = await signToken({
      userId: "teacher_user_001",
      centerId: "center_beta",
      teacherId: "teacher_doc_001",
      role: "teacher",
      name: "Tom Teacher",
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.ok(Array.isArray(json.data));
    assert.strictEqual(json.data.length, 1);
    assert.strictEqual(json.data[0].centerId, "center_beta");
    assert.strictEqual(json.data[0].name, "Beta Learning Center");
  });

  // 3. Unauthorized Cross-Tenant Requests
  await t.test("3.1 GET /api/centers?centerId=center_beta with center_alpha token fails with HTTP 403 Forbidden", async () => {
    const token = await signToken({
      userId: "user_owner_001",
      centerId: "center_alpha",
      role: "owner",
    });

    const req = createMockRequest({
      url: "http://localhost:3000/api/centers?centerId=center_beta",
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /cross-tenant center access is strictly forbidden/i);
  });

  await t.test("3.2 GET /api/centers with header x-center-id: center_beta with center_alpha token fails with HTTP 403 Forbidden", async () => {
    const token = await signToken({
      userId: "user_owner_001",
      centerId: "center_alpha",
      role: "owner",
    });

    const req = createMockRequest({
      headers: {
        Authorization: `Bearer ${token}`,
        "x-center-id": "center_beta",
      },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /cross-tenant center access is strictly forbidden/i);
  });

  // 4. Sensitive Field Exclusion
  await t.test("4.1 Response strictly excludes password hash and __v from output", async () => {
    const token = await signToken({
      userId: "user_owner_001",
      centerId: "center_alpha",
      role: "owner",
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.ok(json.data[0]);

    // Explicit checks on returned object
    assert.strictEqual(json.data[0].password, undefined);
    assert.strictEqual(json.data[0].__v, undefined);

    // Serialization string check to guarantee no nested or hidden password leak
    const serialized = JSON.stringify(json);
    assert.strictEqual(serialized.includes("password"), false);
    assert.strictEqual(serialized.includes("BcryptHash"), false);
  });

  // 5. Non-Existent Center
  await t.test("5.1 Returns HTTP 404 if authenticated user's center does not exist in DB", async () => {
    const token = await signToken({
      userId: "orphan_user",
      centerId: "center_nonexistent",
      role: "owner",
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await GET(req);
    const json = await res.json();

    assert.strictEqual(res.status, 404);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /center not found/i);
  });

  // 6. CORS OPTIONS Preflight
  await t.test("6.1 OPTIONS /api/centers returns HTTP 204 or appropriate CORS status", async () => {
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { Origin: "https://tution-desk-one.vercel.app" },
    });
    const res = await OPTIONS(req);
    assert.strictEqual(res.status, 204);
  });
});
