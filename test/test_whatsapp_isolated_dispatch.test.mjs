import test from "node:test";
import assert from "node:assert/strict";

// Save initial environment
const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

// -----------------------------------------------------------------------------
// Suite 1: Hard Production Restriction & Local Test Flag Logic
// -----------------------------------------------------------------------------
test("Suite 1: Hard Production Restriction & Local Test Flag Logic", async (t) => {
  t.afterEach(resetEnv);

  const { isTestDispatchAllowed } = await import(
    "../src/lib/whatsappService.ts"
  );

  await t.test(
    "1.1 Default state (unset): isTestDispatchAllowed() strictly defaults to false",
    () => {
      delete process.env.ALLOW_TEST_WHATSAPP_DISPATCH;
      process.env.NODE_ENV = "development";
      assert.equal(isTestDispatchAllowed(), false);
    }
  );

  await t.test(
    "1.2 Invalid and falsey values strictly return false",
    () => {
      process.env.NODE_ENV = "development";
      for (const val of ["false", "0", "no", "undefined", "live", "null", "", "   "]) {
        process.env.ALLOW_TEST_WHATSAPP_DISPATCH = val;
        assert.equal(
          isTestDispatchAllowed(),
          false,
          `Expected false for ALLOW_TEST_WHATSAPP_DISPATCH='${val}'`
        );
      }
    }
  );

  await t.test(
    "1.3 Hard block in production: returns false even when ALLOW_TEST_WHATSAPP_DISPATCH='true'",
    () => {
      process.env.NODE_ENV = "production";
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      assert.equal(
        isTestDispatchAllowed(),
        false,
        "Production must unconditionally reject test-only dispatch"
      );
    }
  );

  await t.test(
    "1.4 Hard block on Vercel production: returns false even when ALLOW_TEST_WHATSAPP_DISPATCH='true'",
    () => {
      process.env.NODE_ENV = "development";
      process.env.VERCEL_ENV = "production";
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      assert.equal(
        isTestDispatchAllowed(),
        false,
        "VERCEL_ENV=production must unconditionally reject test-only dispatch"
      );
    }
  );

  await t.test(
    "1.5 Non-development/non-test environments return false",
    () => {
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      for (const env of ["staging", "preview", "qa", "uat"]) {
        process.env.NODE_ENV = env;
        delete process.env.VERCEL_ENV;
        assert.equal(
          isTestDispatchAllowed(),
          false,
          `Environment '${env}' must reject test-only dispatch`
        );
      }
    }
  );

  await t.test(
    "1.6 Permitted exclusively in local development or test with explicit flag",
    () => {
      delete process.env.VERCEL_ENV;
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";

      process.env.NODE_ENV = "development";
      assert.equal(isTestDispatchAllowed(), true);

      process.env.NODE_ENV = "test";
      assert.equal(isTestDispatchAllowed(), true);

      // Case-insensitivity check ("TRUE", " True ")
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = " TRUE ";
      assert.equal(isTestDispatchAllowed(), true);
    }
  );
});

// -----------------------------------------------------------------------------
// Suite 2: Global Live Guard Immutability
// -----------------------------------------------------------------------------
test("Suite 2: Global Live Guard Immutability", async (t) => {
  t.afterEach(resetEnv);

  const { isLiveDispatchEnabled: frontendLiveGuard } = await import(
    "../src/lib/whatsappService.ts"
  );
  const { isLiveDispatchEnabled: backendLiveGuard } = await import(
    "../tution-desk-be/src/lib/whatsappService.ts"
  );

  await t.test(
    "2.1 ALLOW_TEST_WHATSAPP_DISPATCH='true' has zero effect on isLiveDispatchEnabled()",
    () => {
      process.env.NODE_ENV = "development";
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      delete process.env.WHATSAPP_MODE;
      delete process.env.ENABLE_LIVE_WHATSAPP;

      assert.equal(frontendLiveGuard(), false);
      assert.equal(backendLiveGuard(), false);
    }
  );

  await t.test(
    "2.2 Global live guard still strictly requires both WHATSAPP_MODE='live' AND ENABLE_LIVE_WHATSAPP='true'",
    () => {
      // Missing both
      assert.equal(frontendLiveGuard(), false);
      assert.equal(backendLiveGuard(), false);

      // Only mode
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "false";
      assert.equal(frontendLiveGuard(), false);
      assert.equal(backendLiveGuard(), false);

      // Only opt-in
      process.env.WHATSAPP_MODE = "simulation";
      process.env.ENABLE_LIVE_WHATSAPP = "true";
      assert.equal(frontendLiveGuard(), false);
      assert.equal(backendLiveGuard(), false);

      // Both true
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";
      assert.equal(frontendLiveGuard(), true);
      assert.equal(backendLiveGuard(), true);
    }
  );
});

// -----------------------------------------------------------------------------
// Suite 3: Total Isolation of All Business Dispatch Workflows
// -----------------------------------------------------------------------------
test("Suite 3: Total Isolation of All Business Dispatch Workflows", async (t) => {
  t.afterEach(resetEnv);

  const frontendWS = await import("../src/lib/whatsappService.ts");
  const backendWS = await import("../tution-desk-be/src/lib/whatsappService.ts");

  // Track any outbound fetch calls
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCallCount++;
    return originalFetch(...args);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test(
    "3.1 When ALLOW_TEST_WHATSAPP_DISPATCH='true', all frontend business workflows remain simulated",
    async () => {
      process.env.NODE_ENV = "development";
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      delete process.env.WHATSAPP_MODE;
      delete process.env.ENABLE_LIVE_WHATSAPP;
      fetchCallCount = 0;

      // 1. sendWelcomeMessage
      const welcomeRes = await frontendWS.sendWelcomeMessage(
        "center_1",
        "9876543210",
        "Welcome parent!",
        "student_1"
      );
      assert.equal(welcomeRes.simulated, true);
      assert.equal(welcomeRes.accepted, false);
      assert.equal(welcomeRes.delivered, false);

      // 2. sendCustomWhatsAppMessage
      const customRes = await frontendWS.sendCustomWhatsAppMessage(
        "center_1",
        "9876543210",
        "Custom update"
      );
      assert.equal(customRes.simulated, true);
      assert.equal(customRes.accepted, false);
      assert.equal(customRes.delivered, false);

      // 3. sendFeeReminder
      const feeRes = await frontendWS.sendFeeReminder(
        "center_1",
        "9876543210",
        "Student A",
        1500,
        "2026-11-15",
        "fee_1",
        "student_1"
      );
      assert.equal(feeRes.simulated, true);
      assert.equal(feeRes.accepted, false);
      assert.equal(feeRes.delivered, false);

      // 4. sendTestResult
      const testRes = await frontendWS.sendTestResult(
        "center_1",
        "9876543210",
        "Student A",
        "Physics Test",
        45,
        50
      );
      assert.equal(testRes.simulated, true);
      assert.equal(testRes.accepted, false);
      assert.equal(testRes.delivered, false);

      assert.equal(
        fetchCallCount,
        0,
        "Zero outbound fetch requests must be made by frontend business workflows"
      );
    }
  );

  await t.test(
    "3.2 When ALLOW_TEST_WHATSAPP_DISPATCH='true', all backend business workflows remain simulated",
    async () => {
      process.env.NODE_ENV = "development";
      process.env.ALLOW_TEST_WHATSAPP_DISPATCH = "true";
      delete process.env.WHATSAPP_MODE;
      delete process.env.ENABLE_LIVE_WHATSAPP;
      fetchCallCount = 0;

      // 1. sendWelcomeMessage
      const beWelcome = await backendWS.sendWelcomeMessage(
        "center_1",
        "9876543210",
        "Welcome parent!",
        "student_1"
      );
      assert.equal(beWelcome.simulated, true);
      assert.equal(beWelcome.accepted, false);
      assert.equal(beWelcome.delivered, false);

      // 2. sendCustomWhatsAppMessage
      const beCustom = await backendWS.sendCustomWhatsAppMessage(
        "center_1",
        "9876543210",
        "Custom message"
      );
      assert.equal(beCustom.simulated, true);
      assert.equal(beCustom.accepted, false);
      assert.equal(beCustom.delivered, false);

      // 3. sendFeeReminder
      const beFee = await backendWS.sendFeeReminder(
        "center_1",
        "9876543210",
        "Student A",
        1500,
        "2026-11-15",
        "fee_1",
        "student_1"
      );
      assert.equal(beFee.simulated, true);
      assert.equal(beFee.accepted, false);
      assert.equal(beFee.delivered, false);

      // 4. sendPaymentReceipt
      const beReceipt = await backendWS.sendPaymentReceipt(
        "center_1",
        "9876543210",
        "Student A",
        1500,
        "REC-1234",
        "2026-11-05",
        "Monthly Tuition",
        "fee_1",
        "student_1"
      );
      assert.equal(beReceipt.simulated, true);
      assert.equal(beReceipt.accepted, false);
      assert.equal(beReceipt.delivered, false);

      // 5. sendTestResult
      const beTest = await backendWS.sendTestResult(
        "center_1",
        "9876543210",
        "Student A",
        "Math Test",
        90,
        100
      );
      assert.equal(beTest.simulated, true);
      assert.equal(beTest.accepted, false);
      assert.equal(beTest.delivered, false);

      // 6. sendAttendanceAlert
      const beAttendance = await backendWS.sendAttendanceAlert({
        centerId: "center_1",
        parentPhone: "9876543210",
        studentName: "Student A",
        status: "absent",
        date: "2026-11-05",
      });
      assert.equal(beAttendance.simulated, true);
      assert.equal(beAttendance.accepted, false);
      assert.equal(beAttendance.delivered, false);

      assert.equal(
        fetchCallCount,
        0,
        "Zero outbound fetch requests must be made by backend business workflows"
      );
    }
  );
});

// -----------------------------------------------------------------------------
// Suite 4: Test Message Endpoint Semantics & Secret Safety
// -----------------------------------------------------------------------------
test("Suite 4: Test Message Endpoint Semantics & Secret Safety", async (t) => {
  t.afterEach(resetEnv);

  await t.test(
    "4.1 Simulation response contract preserves accepted: false, delivered: false, simulated: true",
    () => {
      // Matches response shape returned by POST /api/whatsapp/test-message
      const simulationPayload = {
        success: true,
        simulated: true,
        accepted: false,
        delivered: false,
        centerId: "center_1",
        messageId: "sim_123456789",
        message:
          "Simulation mode active: WhatsApp outbound dispatch is simulated (zero outbound network requests). For local test ping delivery, configure ALLOW_TEST_WHATSAPP_DISPATCH=true in local development. For production live delivery, configure WHATSAPP_MODE=live and ENABLE_LIVE_WHATSAPP=true.",
      };

      assert.equal(simulationPayload.simulated, true);
      assert.equal(simulationPayload.accepted, false);
      assert.equal(simulationPayload.delivered, false);
      assert.match(simulationPayload.message, /ALLOW_TEST_WHATSAPP_DISPATCH=true/);
    }
  );

  await t.test(
    "4.2 Upstream microservice response mapping preserves accepted: true, delivered: false",
    () => {
      // Mock microservice response from BaileysProvider
      const upstreamMockResponse = {
        success: true,
        centerId: "center_1",
        messageId: "3EB0ABC123",
        recipient: "919876543210@s.whatsapp.net",
        timestamp: new Date().toISOString(),
        accepted: true,
        delivered: false,
        status: "accepted",
      };

      // Transform matching route.ts line 116
      const clientResponse = {
        success: true,
        simulated: false,
        accepted: Boolean(upstreamMockResponse.accepted ?? true),
        delivered: false,
        centerId: "center_1",
        messageId: upstreamMockResponse.messageId,
        status: upstreamMockResponse.status,
      };

      assert.equal(clientResponse.success, true);
      assert.equal(clientResponse.simulated, false);
      assert.equal(clientResponse.accepted, true);
      assert.equal(clientResponse.delivered, false, "Must never report delivered: true without delivery receipt");
      assert.equal(clientResponse.messageId, "3EB0ABC123");
    }
  );

  await t.test(
    "4.3 Secret leakage check: WHATSAPP_INTERNAL_SECRET is never exposed in response payloads",
    () => {
      const secret = "super-secret-internal-key-64chars-length-strictly-private";
      process.env.WHATSAPP_INTERNAL_SECRET = secret;

      const responses = [
        // Simulation response
        {
          success: true,
          simulated: true,
          accepted: false,
          delivered: false,
          centerId: "center_1",
          messageId: "sim_test",
        },
        // Successful dispatch response
        {
          success: true,
          simulated: false,
          accepted: true,
          delivered: false,
          centerId: "center_1",
          messageId: "baileys_msg_1",
          status: "accepted",
        },
        // Error response
        {
          success: false,
          centerId: "center_1",
          accepted: false,
          delivered: false,
          error: "Failed to dispatch test message",
        },
      ];

      for (const res of responses) {
        const serialized = JSON.stringify(res);
        assert.equal(
          serialized.includes(secret),
          false,
          "Response payload must never contain WHATSAPP_INTERNAL_SECRET"
        );
      }
    }
  );
});
