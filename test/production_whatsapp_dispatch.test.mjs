import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

// Mock mongoose connection to avoid live DB dependency
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };
process.env.JWT_SECRET = "production-test-jwt-secret-32-characters-minimum!";
process.env.WHATSAPP_INTERNAL_SECRET = "test-internal-secret-for-microservice-32chars!";

const originalEnv = { ...process.env };
function resetEnv() {
  process.env = { ...originalEnv };
}

test("MSEC Production WhatsApp Dispatch Architecture Suite", async (suite) => {
  suite.afterEach(resetEnv);

  const backendWS = await import("../tution-desk-be/src/lib/whatsappService.ts");
  const frontendWS = await import("../src/lib/whatsappService.ts");
  const BaileysProviderModule = await import(
    "../whatsapp-server/providers/BaileysProvider.js"
  );
  const BaileysProvider = BaileysProviderModule.default || BaileysProviderModule;

  // ---------------------------------------------------------------------------
  // Test 1: Production Mode Permits Normal Recipients Without QA Allowlists
  // ---------------------------------------------------------------------------
  await suite.test(
    "1. Production Live Mode (WHATSAPP_MODE=live + ENABLE_LIVE_WHATSAPP=true) authorizes valid numbers without QA allowlist",
    () => {
      delete process.env.QA_LIVE_MODE;
      delete process.env.QA_LIVE_RECIPIENT_ALLOWLIST;
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      const validTenDigit = "9876543210";
      const validTwelveDigit = "919876543210";
      const validElevenDigit = "09876543210";

      // Backend guards
      assert.equal(backendWS.isLiveDispatchEnabled(validTenDigit), true);
      assert.equal(backendWS.isLiveDispatchEnabled(validTwelveDigit), true);
      assert.equal(backendWS.isLiveDispatchEnabled(validElevenDigit), true);
      assert.equal(backendWS.isPhoneAllowedForLiveDispatch(validTenDigit), true);

      // Frontend guards
      assert.equal(frontendWS.isLiveDispatchEnabled(validTenDigit), true);
      assert.equal(frontendWS.isLiveDispatchEnabled(validTwelveDigit), true);
      assert.equal(frontendWS.isLiveDispatchEnabled(validElevenDigit), true);
      assert.equal(frontendWS.isPhoneAllowedForLiveDispatch(validTenDigit), true);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 2: Residual QA Allowlist Inactive When QA_LIVE_MODE is Not Set
  // ---------------------------------------------------------------------------
  await suite.test(
    "2. Residual QA_LIVE_RECIPIENT_ALLOWLIST in env does NOT block production recipients when QA_LIVE_MODE is absent",
    () => {
      delete process.env.QA_LIVE_MODE;
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "919999900011"; // developer number
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      const realParentPhone = "9876543210"; // not in allowlist

      // Should be allowed in production because QA_LIVE_MODE is not true
      assert.equal(backendWS.isLiveDispatchEnabled(realParentPhone), true);
      assert.equal(frontendWS.isLiveDispatchEnabled(realParentPhone), true);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 3: QA_LIVE_MODE=true Retains Strict Safety Safeguards
  // ---------------------------------------------------------------------------
  await suite.test(
    "3. When QA_LIVE_MODE='true', allowlist enforcement remains active and fails closed if missing",
    () => {
      process.env.QA_LIVE_MODE = "true";
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      // 3.1 Missing allowlist -> fails closed
      delete process.env.QA_LIVE_RECIPIENT_ALLOWLIST;
      assert.equal(backendWS.isLiveDispatchEnabled("9876543210"), false);
      assert.equal(frontendWS.isLiveDispatchEnabled("9876543210"), false);

      // 3.2 Allowlisted number -> allowed
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "919999900011";
      assert.equal(backendWS.isLiveDispatchEnabled("9999900011"), true);
      assert.equal(frontendWS.isLiveDispatchEnabled("9999900011"), true);

      // 3.3 Non-allowlisted number -> blocked into simulation
      assert.equal(backendWS.isLiveDispatchEnabled("9876543210"), false);
      assert.equal(frontendWS.isLiveDispatchEnabled("9876543210"), false);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 4: Admission Welcome Guard Defaults Closed Until Explicitly Approved
  // ---------------------------------------------------------------------------
  await suite.test(
    "4. ENABLE_ADMISSION_WELCOME_WHATSAPP defaults strictly to false in production",
    () => {
      delete process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP;
      process.env.WHATSAPP_MODE = "live";
      process.env.ENABLE_LIVE_WHATSAPP = "true";

      assert.equal(backendWS.isAdmissionWelcomeLiveDispatchEnabled("9876543210"), false);
      assert.equal(frontendWS.isAdmissionWelcomeLiveDispatchEnabled("9876543210"), false);

      // Explicit "false" flag
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "false";
      assert.equal(backendWS.isAdmissionWelcomeLiveDispatchEnabled("9876543210"), false);
      assert.equal(frontendWS.isAdmissionWelcomeLiveDispatchEnabled("9876543210"), false);

      // Explicit "true" flag allows dispatch
      process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "true";
      assert.equal(backendWS.isAdmissionWelcomeLiveDispatchEnabled("9876543210"), true);
      assert.equal(frontendWS.isAdmissionWelcomeLiveDispatchEnabled("9876543210"), true);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 5: BaileysProvider Microservice Layer 2 Guard in Production vs QA
  // ---------------------------------------------------------------------------
  await suite.test(
    "5. BaileysProvider Layer 2 allows production dispatch and enforces allowlist only when QA_LIVE_MODE='true'",
    async () => {
      let rawSocketCalled = false;
      const mockSock = {
        sendMessage: async () => {
          rawSocketCalled = true;
          return { key: { id: "baileys_prod_msg_1" } };
        },
      };

      const provider = new BaileysProvider({
        mongooseInstance: { connection: { readyState: 0 } },
      });
      provider.sessions.set("center-prod", {
        sock: mockSock,
        isReady: true,
        status: "connected",
        generation: 1,
      });

      // 5.1 Production mode: non-allowlisted parent number passes to socket
      delete process.env.QA_LIVE_MODE;
      process.env.QA_LIVE_RECIPIENT_ALLOWLIST = "919999900011";
      rawSocketCalled = false;

      const prodResult = await provider.sendMessage({
        centerId: "center-prod",
        phone: "9876543210",
        message: "Your monthly tuition fee is due.",
      });

      assert.equal(prodResult.success, true);
      assert.equal(prodResult.simulated, false);
      assert.equal(prodResult.accepted, true);
      assert.equal(rawSocketCalled, true);

      // 5.2 QA mode: non-allowlisted parent number is intercepted before socket
      process.env.QA_LIVE_MODE = "true";
      rawSocketCalled = false;

      const qaResult = await provider.sendMessage({
        centerId: "center-prod",
        phone: "9876543210",
        message: "Your monthly tuition fee is due.",
      });

      assert.equal(qaResult.success, true);
      assert.equal(qaResult.simulated, true);
      assert.equal(qaResult.status, "simulated_blocked");
      assert.equal(rawSocketCalled, false);
    }
  );

  // ---------------------------------------------------------------------------
  // Test 6: Number Normalization and Invalid Recipient Fail-Closed
  // ---------------------------------------------------------------------------
  await suite.test(
    "6. Phone normalization formats Indian numbers and rejects malformed inputs",
    () => {
      // Valid normalizations
      assert.equal(backendWS.normalizeIndianPhone("9876543210"), "919876543210");
      assert.equal(backendWS.normalizeIndianPhone("09876543210"), "919876543210");
      assert.equal(backendWS.normalizeIndianPhone("919876543210"), "919876543210");
      assert.equal(backendWS.normalizeIndianPhone("+91 98765-43210"), "919876543210");

      // Malformed inputs fail closed
      assert.equal(backendWS.isPhoneAllowedForLiveDispatch(""), false);
      assert.equal(backendWS.isPhoneAllowedForLiveDispatch("123"), false);
      assert.equal(backendWS.isPhoneAllowedForLiveDispatch("abc"), false);
      assert.equal(backendWS.isPhoneAllowedForLiveDispatch(undefined), false);
    }
  );
});
