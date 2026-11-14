import test from "node:test";
import assert from "node:assert/strict";

// Setup browser globals for Node test environment before importing client modules
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

// Dynamically import centerProfile
const { getAuthenticatedCenter, getCachedCenter, clearCachedCenter } =
  await import("../src/lib/centerProfile.ts");

// Pure helper function reflecting src/app/page.tsx greeting resolution
function resolveDashboardGreeting(centerInfo) {
  if (centerInfo?.role === "teacher") {
    return centerInfo.teacherName || "Teacher";
  }
  return centerInfo?.ownerName || "Owner";
}

test("Bug 01 – Teacher Dashboard Greeting Specification & Regression Suite", async (t) => {
  t.beforeEach(() => {
    storage.clear();
    globalThis.document.cookie = "";
    clearCachedCenter();
  });

  await t.test(
    "1. Teacher Profile: getAuthenticatedCenter correctly captures teacherName and role",
    async () => {
      globalThis.localStorage.setItem("user_center_id", "msce-8267");

      globalThis.fetch = async (url) => {
        assert.equal(url, "/api/auth/me");
        return {
          ok: true,
          json: async () => ({
            success: true,
            role: "teacher",
            teacher: {
              id: "6af100000000000000000001",
              name: "TEST_E2E_Teacher_Sharma",
            },
            center: {
              name: "MSCE",
              ownerName: "Jeet",
              centerId: "msce-8267",
            },
          }),
        };
      };

      const profile = await getAuthenticatedCenter();
      assert.ok(profile);
      assert.equal(profile.role, "teacher");
      assert.equal(profile.teacherName, "TEST_E2E_Teacher_Sharma");
      assert.equal(profile.ownerName, "Jeet");
      assert.equal(profile.name, "MSCE");
      assert.equal(profile.centerId, "msce-8267");
    }
  );

  await t.test(
    "2. Teacher Greeting: Dashboard greeting resolves to Teacher name, NEVER Owner name",
    async () => {
      const teacherInfo = {
        name: "MSCE",
        ownerName: "Jeet",
        role: "teacher",
        teacherName: "TEST_E2E_Teacher_Sharma",
      };

      const greeting = resolveDashboardGreeting(teacherInfo);
      assert.equal(
        greeting,
        "TEST_E2E_Teacher_Sharma",
        "Greeting must display Teacher name"
      );
      assert.notEqual(
        greeting,
        "Jeet",
        "Greeting must NEVER display Owner name for teacher sessions"
      );
    }
  );

  await t.test(
    "3. Teacher Greeting Fallback: When teacherName is missing, fails safe to 'Teacher' (not Owner)",
    async () => {
      const teacherInfoWithoutName = {
        name: "MSCE",
        ownerName: "Jeet",
        role: "teacher",
        teacherName: undefined,
      };

      const greeting = resolveDashboardGreeting(teacherInfoWithoutName);
      assert.equal(
        greeting,
        "Teacher",
        "Greeting must fail safe to 'Teacher'"
      );
      assert.notEqual(
        greeting,
        "Jeet",
        "Greeting must NEVER fall back to Owner name"
      );
    }
  );

  await t.test(
    "4. Owner Greeting: Owner session correctly displays Owner name",
    async () => {
      const ownerInfo = {
        name: "MSCE",
        ownerName: "Jeet",
        role: "owner",
        teacherName: undefined,
      };

      const greeting = resolveDashboardGreeting(ownerInfo);
      assert.equal(
        greeting,
        "Jeet",
        "Owner session greeting must display Owner name"
      );
    }
  );

  await t.test(
    "5. Owner Greeting Fallback: Missing ownerName fails safe to 'Owner'",
    async () => {
      const emptyOwnerInfo = {
        name: "MSCE",
        ownerName: undefined,
        role: "owner",
      };

      const greeting = resolveDashboardGreeting(emptyOwnerInfo);
      assert.equal(greeting, "Owner");
    }
  );

  await t.test(
    "6. Synchronous Cache: getCachedCenter provides immediate frame-0 profile",
    async () => {
      globalThis.localStorage.setItem("user_center_id", "msce-8267");

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          success: true,
          role: "teacher",
          teacher: {
            id: "6ae9ba93d29bd04896bac676",
            name: "Jitender Kumar",
          },
          center: {
            name: "MSCE",
            ownerName: "Jeet",
            centerId: "msce-8267",
          },
        }),
      });

      // Before fetch completes
      assert.equal(getCachedCenter(), null);

      // Fetch once to populate cache
      await getAuthenticatedCenter();

      // Synchronous access should now return cached teacher profile immediately
      const syncProfile = getCachedCenter();
      assert.ok(syncProfile);
      assert.equal(syncProfile.role, "teacher");
      assert.equal(syncProfile.teacherName, "Jitender Kumar");
      assert.equal(resolveDashboardGreeting(syncProfile), "Jitender Kumar");
    }
  );

  await t.test(
    "7. Re-login / Account Switch: Switching from Teacher to Owner updates greeting immediately",
    async () => {
      // 1. Initial login as Teacher
      globalThis.localStorage.setItem("user_center_id", "msce-8267");
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          success: true,
          role: "teacher",
          teacher: {
            id: "6af100000000000000000001",
            name: "TEST_E2E_Teacher_Sharma",
          },
          center: {
            name: "MSCE",
            ownerName: "Jeet",
            centerId: "msce-8267",
          },
        }),
      });

      const teacherProfile = await getAuthenticatedCenter();
      assert.equal(resolveDashboardGreeting(teacherProfile), "TEST_E2E_Teacher_Sharma");

      // 2. User logs out and logs in as Owner
      clearCachedCenter();
      assert.equal(getCachedCenter(), null);

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          success: true,
          role: "owner",
          center: {
            name: "MSCE",
            ownerName: "Jeet",
            centerId: "msce-8267",
          },
        }),
      });

      const ownerProfile = await getAuthenticatedCenter();
      assert.equal(resolveDashboardGreeting(ownerProfile), "Jeet");
    }
  );
});
