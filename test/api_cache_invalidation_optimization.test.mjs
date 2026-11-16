import test from "node:test";
import assert from "node:assert/strict";

// Setup browser globals for Node test environment before importing modules
const storage = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
globalThis.document = {
  cookie: "",
};

// Dynamically import apiClient utilities
const {
  apiClient,
  getApiCache,
  clearApiCache,
  invalidateApiCache,
  getCurrentCenterId,
} = await import("../src/lib/apiClient.ts");

test("Step 7 — API Cache Invalidation Optimization & Race Guard Suite", async (t) => {
  t.beforeEach(() => {
    storage.clear();
    globalThis.document.cookie = "";
    clearApiCache();
    globalThis.localStorage.setItem("user_center_id", "center-test-777");
  });

  await t.test(
    "1. Attendance mutation invalidates /attendance & /dashboard, but preserves /teachers, /tests, /fees",
    async () => {
      let networkCalls = 0;
      globalThis.fetch = async (url, options) => {
        networkCalls++;
        const method = options?.method || "GET";
        if (method === "POST") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { recorded: true } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { endpoint: url, count: networkCalls } }),
        };
      };

      // Populate cache for 5 endpoints
      await apiClient("/teachers");
      await apiClient("/tests");
      await apiClient("/fees");
      await apiClient("/dashboard/owner");
      await apiClient("/attendance?batchId=b1");

      assert.ok(getApiCache("/teachers"), "/teachers should be in cache");
      assert.ok(getApiCache("/tests"), "/tests should be in cache");
      assert.ok(getApiCache("/fees"), "/fees should be in cache");
      assert.ok(getApiCache("/dashboard/owner"), "/dashboard/owner should be in cache");
      assert.ok(getApiCache("/attendance", { batchId: "b1" }), "/attendance should be in cache");

      // Mutation: POST /attendance
      await apiClient("/attendance", {
        method: "POST",
        body: { batchId: "b1", records: [] },
      });

      // Target dependencies must be invalidated
      assert.equal(getApiCache("/attendance", { batchId: "b1" }), null, "/attendance cache must be invalidated");
      assert.equal(getApiCache("/dashboard/owner"), null, "/dashboard/owner cache must be invalidated");

      // Unrelated entries MUST be preserved (under current global invalidation, these fail!)
      assert.ok(getApiCache("/teachers"), "/teachers cache must be preserved");
      assert.ok(getApiCache("/tests"), "/tests cache must be preserved");
      assert.ok(getApiCache("/fees"), "/fees cache must be preserved");
    }
  );

  await t.test(
    "2. Fee mutation invalidates /fees, /fees/summary, /dashboard/owner, /reports/financial-summary, but preserves /teachers, /attendance",
    async () => {
      globalThis.fetch = async (url, options) => {
        const method = options?.method || "GET";
        if (method === "POST") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { paymentId: "pay_1" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { endpoint: url } }),
        };
      };

      await apiClient("/fees");
      await apiClient("/fees/summary");
      await apiClient("/dashboard/owner");
      await apiClient("/reports/financial-summary");
      await apiClient("/teachers");
      await apiClient("/attendance");

      // Mutation: POST /fees/manual-collection
      await apiClient("/fees/manual-collection", {
        method: "POST",
        body: { feeId: "fee_1", amount: 1000 },
      });

      // Dependent entries invalidated
      assert.equal(getApiCache("/fees"), null, "/fees must be invalidated");
      assert.equal(getApiCache("/fees/summary"), null, "/fees/summary must be invalidated");
      assert.equal(getApiCache("/dashboard/owner"), null, "/dashboard/owner must be invalidated");
      assert.equal(getApiCache("/reports/financial-summary"), null, "/reports/financial-summary must be invalidated");

      // Unrelated entries preserved
      assert.ok(getApiCache("/teachers"), "/teachers cache must be preserved");
      assert.ok(getApiCache("/attendance"), "/attendance cache must be preserved");
    }
  );

  await t.test(
    "3. Teacher mutation invalidates /teachers but preserves /fees, /attendance, /tests",
    async () => {
      globalThis.fetch = async (url, options) => {
        const method = options?.method || "GET";
        if (method === "PUT") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { updated: true } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { endpoint: url } }),
        };
      };

      await apiClient("/teachers");
      await apiClient("/fees");
      await apiClient("/attendance");
      await apiClient("/tests");

      // Mutation: PUT /teachers/tch_1
      await apiClient("/teachers/tch_1", {
        method: "PUT",
        body: { name: "New Name" },
      });

      assert.equal(getApiCache("/teachers"), null, "/teachers must be invalidated");
      assert.ok(getApiCache("/fees"), "/fees cache must be preserved");
      assert.ok(getApiCache("/attendance"), "/attendance cache must be preserved");
      assert.ok(getApiCache("/tests"), "/tests cache must be preserved");
    }
  );

  await t.test(
    "4. In-flight GET response started BEFORE mutation must NOT write stale results into cache when it resolves AFTER mutation",
    async () => {
      let resolveSlowGet;
      const slowGetPromise = new Promise((resolve) => {
        resolveSlowGet = resolve;
      });

      let callCount = 0;
      globalThis.fetch = async (url, options) => {
        const method = options?.method || "GET";
        if (method === "GET") {
          callCount++;
          // First GET /students is intentionally slow
          if (callCount === 1) {
            await slowGetPromise;
            return {
              ok: true,
              status: 200,
              json: async () => ({
                success: true,
                data: [{ id: "std_1", name: "Stale Student" }],
              }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: [{ id: "std_1", name: "Fresh Student" }],
            }),
          };
        }
        // Mutation POST /students
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { id: "std_new" } }),
        };
      };

      // 1. Fire slow GET /students (starts in generation 0)
      const slowGetCall = apiClient("/students");

      // 2. While GET /students is in flight, a mutation POST /students executes and completes
      await apiClient("/students", {
        method: "POST",
        body: { name: "Fresh Student" },
      });

      // At this point, the mutation has invalidated /students.
      assert.equal(getApiCache("/students"), null, "Cache must be null after mutation");

      // 3. Now the slow in-flight GET finally completes
      resolveSlowGet();
      await slowGetCall;

      // 4. CRITICAL: The stale slow GET response must NOT have written "Stale Student" back into apiCache!
      const cacheAfterStaleResolve = getApiCache("/students");
      assert.equal(
        cacheAfterStaleResolve,
        null,
        "Stale in-flight GET that started before mutation must NOT repopulate the cache"
      );
    }
  );

  await t.test(
    "5. Unknown mutation endpoints fall back to safe global invalidation",
    async () => {
      globalThis.fetch = async (url, options) => {
        const method = options?.method || "GET";
        if (method === "POST") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { done: true } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { endpoint: url } }),
        };
      };

      await apiClient("/teachers");
      await apiClient("/fees");
      await apiClient("/attendance");

      // Unknown mutation endpoint
      await apiClient("/some-unknown-feature/action", {
        method: "POST",
        body: { test: true },
      });

      // Safe fallback: all entries cleared
      assert.equal(getApiCache("/teachers"), null, "Unknown mutation must invalidate /teachers");
      assert.equal(getApiCache("/fees"), null, "Unknown mutation must invalidate /fees");
      assert.equal(getApiCache("/attendance"), null, "Unknown mutation must invalidate /attendance");
    }
  );
});
