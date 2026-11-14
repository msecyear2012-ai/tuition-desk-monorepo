import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// Setup mock test environment
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-parent-push-notification-32-chars";
process.env.APP_URL = "http://localhost:3000";
process.env.ALLOWED_ORIGINS = "http://localhost:3000,https://tution-desk-one.vercel.app";

// In-memory mongoose cache
global.mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };
process.env.MONGODB_URI = "mongodb://localhost:27017/test_tuitiondesk";

const { default: ParentAccess } = await import(
  "../tution-desk-be/src/models/ParentAccess.ts"
);
const { sendPushToParent, sendPushToStudentParents } = await import(
  "../tution-desk-be/src/lib/pushService.ts"
);
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: pushSubscribeRoute } = await import(
  "../tution-desk-be/src/app/api/parent/push/subscribe/route.ts"
);

function createMockRequest({
  method = "POST",
  url = "http://localhost:3001/api/parent/push/subscribe",
  headers = {},
  body = {},
  cookies = {},
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }

  return {
    method,
    nextUrl: new URL(url),
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) || null,
    },
    cookies: {
      get: (name) => (cookies[name] ? { value: cookies[name] } : undefined),
    },
    json: async () => body,
  };
}

test("Parent Portal Web Push API & PWA Architecture Specification Suite", async (t) => {
  const testCenterId = "msec-institute";
  const parentAccessId = new mongoose.Types.ObjectId().toString();
  const testStudentId = new mongoose.Types.ObjectId();

  let validParentSessionToken = "";

  t.before(async () => {
    // Generate valid parent session JWT bound to parentAccess
    validParentSessionToken = await signToken({
      userId: parentAccessId,
      parentAccessId: parentAccessId,
      centerId: testCenterId,
      role: "parent",
      tokenPrefix: "pt_test123",
    });
  });

  // =========================================================================
  // 1. MODEL SCHEMA & CAPABILITY
  // =========================================================================
  await t.test("1.1 ParentAccess model supports pushSubscriptions schema", () => {
    const parent = new ParentAccess({
      centerId: testCenterId,
      parentPhone: "+919876543210",
      parentName: "Sunita Sharma",
      linkedStudentIds: [testStudentId],
      tokenHash: "mock_hash_for_push_test",
      tokenPrefix: "pt_test123",
      status: "active",
      pushSubscriptions: [
        {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-sub-1",
          keys: {
            p256dh: "mock_p256dh_key_data",
            auth: "mock_auth_key_data",
          },
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
          subscribedAt: new Date(),
        },
      ],
    });

    assert.equal(parent.pushSubscriptions.length, 1);
    assert.equal(
      parent.pushSubscriptions[0].endpoint,
      "https://fcm.googleapis.com/fcm/send/test-sub-1"
    );
    assert.equal(parent.pushSubscriptions[0].keys.p256dh, "mock_p256dh_key_data");
    assert.equal(parent.pushSubscriptions[0].keys.auth, "mock_auth_key_data");
  });

  // =========================================================================
  // 2. DISPATCHER & SIMULATION GUARD
  // =========================================================================
  await t.test(
    "2.1 sendPushToParent handles simulated dispatch safely when VAPID keys are unconfigured",
    async () => {
      const parent = new ParentAccess({
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenHash: "mock_hash_dispatch",
        tokenPrefix: "pt_test123",
        status: "active",
        pushSubscriptions: [
          {
            endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test-1",
            keys: { p256dh: "key1", auth: "auth1" },
            subscribedAt: new Date(),
          },
        ],
      });

      const res = await sendPushToParent(parent, {
        title: "MSEC Attendance Alert",
        body: "Rahul has been marked Present today.",
        url: "/portal",
        tag: "attendance-alert",
      });

      assert.equal(res.attempted, 1);
      assert.equal(res.sent, 1);
      assert.equal(res.failed, 0);
      assert.equal(res.simulated, true);
    }
  );

  await t.test(
    "2.2 sendPushToParent fails safely with 0 attempts for revoked parents",
    async () => {
      const revokedParent = new ParentAccess({
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenHash: "mock_hash_revoked",
        tokenPrefix: "pt_test123",
        status: "revoked",
        pushSubscriptions: [
          {
            endpoint: "https://fcm.googleapis.com/fcm/send/test-sub-revoked",
            keys: { p256dh: "key", auth: "auth" },
            subscribedAt: new Date(),
          },
        ],
      });

      const res = await sendPushToParent(revokedParent, {
        title: "Test",
        body: "Test body",
      });

      assert.equal(res.attempted, 0);
      assert.equal(res.sent, 0);
    }
  );

  // =========================================================================
  // 3. API ROUTE SECURITY & VALIDATION
  // =========================================================================
  await t.test(
    "3.1 POST /api/parent/push/subscribe rejects unapproved cross-origin requests with 403 Forbidden",
    async () => {
      const req = createMockRequest({
        headers: {
          origin: "https://malicious-tracker.evil.com",
        },
        body: {
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/test",
            keys: { p256dh: "p", auth: "a" },
          },
        },
      });

      const res = await pushSubscribeRoute(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.error.includes("Origin is not authorized"));
    }
  );

  await t.test(
    "3.2 POST /api/parent/push/subscribe rejects unauthenticated requests with 401 Unauthorized",
    async () => {
      const req = createMockRequest({
        headers: {
          origin: "http://localhost:3000",
        },
        body: {
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/test",
            keys: { p256dh: "p", auth: "a" },
          },
        },
      });

      const res = await pushSubscribeRoute(req);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
    }
  );

  await t.test(
    "3.3 POST /api/parent/push/subscribe validates endpoint format (rejects non-https)",
    async () => {
      // Mock ParentAccess findOne
      const originalFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        tokenPrefix: "pt_test123",
        status: "active",
        pushSubscriptions: [],
        save: async () => {},
      });

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
          },
          body: {
            subscription: {
              endpoint: "http://insecure-endpoint.com/test",
              keys: { p256dh: "p", auth: "a" },
            },
          },
        });

        const res = await pushSubscribeRoute(req);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.ok(data.error.includes("https endpoint is required"));
      } finally {
        ParentAccess.findOne = originalFindOne;
      }
    }
  );

  await t.test(
    "3.4 POST /api/parent/push/subscribe persists new PushSubscription for authenticated parent",
    async () => {
      let savedDoc = null;

      const mockParent = {
        _id: parentAccessId,
        centerId: testCenterId,
        tokenPrefix: "pt_test123",
        status: "active",
        pushSubscriptions: [],
        save: async function () {
          savedDoc = this;
          return this;
        },
      };

      const originalFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => mockParent;

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
            "user-agent": "Mozilla/5.0 (iPhone; PWA)",
          },
          body: {
            action: "subscribe",
            subscription: {
              endpoint: "https://fcm.googleapis.com/fcm/send/valid-test-client",
              keys: {
                p256dh: "BMockP256dhEncodedPublicKeyDataString",
                auth: "MockAuthSecretData123",
              },
            },
          },
        });

        const res = await pushSubscribeRoute(req);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.deviceCount, 1);

        assert.ok(savedDoc);
        assert.equal(savedDoc.pushSubscriptions.length, 1);
        assert.equal(
          savedDoc.pushSubscriptions[0].endpoint,
          "https://fcm.googleapis.com/fcm/send/valid-test-client"
        );
        assert.equal(savedDoc.pushSubscriptions[0].userAgent, "Mozilla/5.0 (iPhone; PWA)");
      } finally {
        ParentAccess.findOne = originalFindOne;
      }
    }
  );

  await t.test(
    "3.5 POST /api/parent/push/subscribe handles action: 'unsubscribe' and removes matching endpoint",
    async () => {
      const mockParent = {
        _id: parentAccessId,
        centerId: testCenterId,
        tokenPrefix: "pt_test123",
        status: "active",
        pushSubscriptions: [
          {
            endpoint: "https://fcm.googleapis.com/fcm/send/endpoint-to-remove",
            keys: { p256dh: "p", auth: "a" },
          },
          {
            endpoint: "https://fcm.googleapis.com/fcm/send/endpoint-to-keep",
            keys: { p256dh: "p", auth: "a" },
          },
        ],
        save: async function () {
          return this;
        },
      };

      const originalFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => mockParent;

      try {
        const req = createMockRequest({
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${validParentSessionToken}`,
          },
          body: {
            action: "unsubscribe",
            subscription: {
              endpoint: "https://fcm.googleapis.com/fcm/send/endpoint-to-remove",
              keys: { p256dh: "p", auth: "a" },
            },
          },
        });

        const res = await pushSubscribeRoute(req);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);

        assert.equal(mockParent.pushSubscriptions.length, 1);
        assert.equal(
          mockParent.pushSubscriptions[0].endpoint,
          "https://fcm.googleapis.com/fcm/send/endpoint-to-keep"
        );
      } finally {
        ParentAccess.findOne = originalFindOne;
      }
    }
  );
});
