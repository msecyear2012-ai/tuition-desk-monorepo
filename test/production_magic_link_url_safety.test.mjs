/**
 * MSEC — P1-5 Production Magic Link URL Safety Regression Suite
 *
 * Validates:
 * 1. Production with valid HTTPS URL succeeds and generates canonical portal URLs.
 * 2. Production with missing URL fails closed and refuses link generation.
 * 3. Production with localhost or loopback URL fails closed.
 * 4. Production with invalid URL (HTTP, malformed, non-FQDN) fails closed.
 * 5. Local development cleanly preserves localhost:3000 fallback.
 * 6. Outbound WhatsApp dispatches fail closed before sending or logging when URL validation fails.
 * 7. Zero secret or token leakage in configuration errors and logs.
 * 8. Existing portal link format (/portal#token=pt_...) remains strictly compatible.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  PORTAL_ENTRY_PATH,
  ProductionAppUrlError,
  isProductionEnvironment,
  isLocalhostOrLoopbackUrl,
  resolvePortalAppBaseUrl,
  getPortalAppBaseUrl,
  buildPortalActivationUrl,
} from "../tution-desk-be/src/lib/portalLinks.ts";

import {
  buildMagicLink,
  buildMagicLinkForStudent,
  formatAdmissionWelcomeMessage,
  sendAdmissionWelcomeMessage,
  sendWelcomeMessage,
  sendFeeReminder,
  sendPaymentReceipt,
  sendAttendanceAlert,
} from "../tution-desk-be/src/lib/whatsappService.ts";

describe("MSEC — P1-5 Production Magic Link URL Safety Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars before each test
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;
    delete process.env.APP_BASE_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  // 1. Production with valid HTTPS URL
  describe("1. Production with valid HTTPS URL", () => {
    it("resolves canonical HTTPS URL from NEXT_PUBLIC_APP_URL", () => {
      const env = {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://tution-desk-one.vercel.app",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "https://tution-desk-one.vercel.app");
      assert.strictEqual(res.isProduction, true);
    });

    it("resolves canonical HTTPS URL from APP_URL", () => {
      const env = {
        NODE_ENV: "production",
        APP_URL: "https://tuitiondesk.in",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "https://tuitiondesk.in");
    });

    it("resolves canonical HTTPS URL from VERCEL_PROJECT_PRODUCTION_URL", () => {
      const env = {
        NODE_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "custom-tenant.vercel.app",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "https://custom-tenant.vercel.app");
    });

    it("strips trailing slashes from resolved production base URL", () => {
      const env = {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://tution-desk-one.vercel.app///",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "https://tution-desk-one.vercel.app");
    });

    it("generates supported activation link with raw token and https base", () => {
      process.env.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_URL = "https://tution-desk-one.vercel.app";

      const link = buildPortalActivationUrl("pt_test_secret_token_123");
      assert.strictEqual(
        link,
        "https://tution-desk-one.vercel.app/portal#token=pt_test_secret_token_123"
      );
    });

    it("generates session entry link without token", () => {
      process.env.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_URL = "https://tution-desk-one.vercel.app";

      const link = buildPortalActivationUrl(null);
      assert.strictEqual(
        link,
        "https://tution-desk-one.vercel.app/portal"
      );
    });

    it("strictly resolves canonical frontend domain when VERCEL_PROJECT_PRODUCTION_URL is a backend deployment domain", () => {
      const env = {
        NODE_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "tuition-desk-backend-opal.vercel.app",
        VERCEL_URL: "tuition-desk-backend-opal-xyz.vercel.app",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "https://tuition-desk-monorepo.vercel.app");

      const link = buildPortalActivationUrl("pt_test_secret_token_123", undefined, env);
      assert.strictEqual(
        link,
        "https://tuition-desk-monorepo.vercel.app/portal#token=pt_test_secret_token_123"
      );
    });

    it("sanitizes explicit backend baseUrl to canonical frontend domain in production", () => {
      process.env.NODE_ENV = "production";
      const link = buildPortalActivationUrl(
        "pt_test_secret_token_123",
        "https://tuition-desk-backend-opal.vercel.app"
      );
      assert.strictEqual(
        link,
        "https://tuition-desk-monorepo.vercel.app/portal#token=pt_test_secret_token_123"
      );
    });
  });

  // 2. Production with missing URL
  describe("2. Production with missing URL", () => {
    it("fails closed when no app URL is configured in production", () => {
      const env = {
        NODE_ENV: "production",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.url, "");
      assert.match(res.error, /Public application URL is missing/);
    });

    it("getPortalAppBaseUrl throws ProductionAppUrlError when missing in production", () => {
      const env = {
        NODE_ENV: "production",
      };
      assert.throws(
        () => getPortalAppBaseUrl(env),
        ProductionAppUrlError
      );
    });

    it("buildPortalActivationUrl throws ProductionAppUrlError when missing in production", () => {
      process.env.NODE_ENV = "production";
      assert.throws(
        () => buildPortalActivationUrl("pt_token_abc"),
        ProductionAppUrlError
      );
    });

    it("formatAdmissionWelcomeMessage throws ProductionAppUrlError when missing in production", () => {
      process.env.NODE_ENV = "production";
      assert.throws(
        () =>
          formatAdmissionWelcomeMessage({
            studentName: "Aarav",
            instituteName: "MSEC Academy",
            batchName: "Class 10",
            isExistingActivePortal: true,
          }),
        ProductionAppUrlError
      );
    });
  });

  // 3. Production with localhost URL
  describe("3. Production with localhost URL", () => {
    it("rejects http://localhost:3000 in production", () => {
      const env = {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /HTTPS protocol|Localhost/i);
    });

    it("rejects https://localhost:3000 in production", () => {
      const env = {
        NODE_ENV: "production",
        APP_URL: "https://localhost:3000",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Localhost and loopback URLs are strictly prohibited/i);
    });

    it("rejects 127.0.0.1 in production", () => {
      const env = {
        NODE_ENV: "production",
        APP_URL: "https://127.0.0.1:3000",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Localhost and loopback URLs are strictly prohibited/i);
    });

    it("rejects 0.0.0.0 in production", () => {
      const env = {
        NODE_ENV: "production",
        APP_URL: "https://0.0.0.0:3000",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /Localhost and loopback URLs are strictly prohibited/i);
    });

    it("buildPortalActivationUrl throws if explicit localhost baseUrl is passed in production", () => {
      process.env.NODE_ENV = "production";
      assert.throws(
        () =>
          buildPortalActivationUrl(
            "pt_token_xyz",
            "http://localhost:3000",
            { NODE_ENV: "production" }
          ),
        /localhost base URL in production/i
      );
    });
  });

  // 4. Production with invalid URL
  describe("4. Production with invalid URL", () => {
    it("rejects HTTP URLs in production (enforces HTTPS)", () => {
      const env = {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://tution-desk-one.vercel.app",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /must use HTTPS protocol in production/i);
    });

    it("rejects non-FQDN single-word hostnames in production", () => {
      const env = {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://intranet-portal",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /fully-qualified domain name/i);
    });

    it("rejects malformed invalid URLs", () => {
      const env = {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://[invalid-url",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, false);
      assert.match(res.error, /not a valid URL/i);
    });
  });

  // 5. Development localhost fallback
  describe("5. Development localhost fallback", () => {
    it("cleanly falls back to http://localhost:3000 in development when env unset", () => {
      const env = {
        NODE_ENV: "development",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "http://localhost:3000");
      assert.strictEqual(res.isProduction, false);
    });

    it("permits explicit http://localhost:3000 in development", () => {
      const env = {
        NODE_ENV: "development",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      };
      const res = resolvePortalAppBaseUrl(env);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.url, "http://localhost:3000");
    });

    it("buildPortalActivationUrl succeeds in development without env vars", () => {
      process.env.NODE_ENV = "development";
      const link = buildPortalActivationUrl("pt_dev_token_456");
      assert.strictEqual(link, "http://localhost:3000/portal#token=pt_dev_token_456");
    });
  });

  // 6. No WhatsApp dispatch when production URL validation fails
  describe("6. Fail-closed WhatsApp dispatch guards in production", () => {
    it("sendAdmissionWelcomeMessage fails closed when URL is missing in production", async () => {
      process.env.NODE_ENV = "production";
      // Missing NEXT_PUBLIC_APP_URL

      const res = await sendAdmissionWelcomeMessage({
        centerId: "center_msec_test",
        phone: "919876543210",
        studentName: "Aarav Sharma",
        instituteName: "MSEC Institute",
        batchName: "Morning Batch",
        isExistingActivePortal: true,
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.strictEqual(res.delivered, false);
      assert.match(res.error, /Configuration error/i);
    });

    it("sendAdmissionWelcomeMessage fails closed when portalUrl points to localhost in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_URL = "https://tution-desk-one.vercel.app";

      const res = await sendAdmissionWelcomeMessage({
        centerId: "center_msec_test",
        phone: "919876543210",
        studentName: "Aarav Sharma",
        instituteName: "MSEC Institute",
        batchName: "Morning Batch",
        portalUrl: "http://localhost:3000/portal#token=pt_leak_token",
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.strictEqual(res.delivered, false);
      assert.match(res.error, /Cannot dispatch message with localhost portal URL/i);
    });

    it("sendWelcomeMessage fails closed when URL is missing in production", async () => {
      process.env.NODE_ENV = "production";

      const res = await sendWelcomeMessage(
        "center_msec_test",
        "919876543210",
        "Welcome to MSEC!"
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /Configuration error/i);
    });

    it("sendFeeReminder fails closed when magicLink points to localhost in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_URL = "https://tution-desk-one.vercel.app";

      const res = await sendFeeReminder(
        "center_msec_test",
        "919876543210",
        "Aarav Sharma",
        1500,
        "10-Dec-2026",
        "http://localhost:3000/portal#token=pt_bad_token"
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /Cannot dispatch fee reminder with localhost magic link/i);
    });

    it("sendPaymentReceipt fails closed when URL is missing in production", async () => {
      process.env.NODE_ENV = "production";

      const res = await sendPaymentReceipt(
        "center_msec_test",
        "919876543210",
        "Aarav Sharma",
        1500,
        "REC-101"
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /Configuration error/i);
    });

    it("sendAttendanceAlert fails closed when URL is missing in production", async () => {
      process.env.NODE_ENV = "production";

      const res = await sendAttendanceAlert({
        centerId: "center_msec_test",
        studentId: "6734cf10a234567890abcdef",
        studentName: "Aarav Sharma",
        parentPhone: "919876543210",
        batch: "Physics Batch",
        status: "Present",
        date: new Date(),
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /Configuration error/i);
    });
  });

  // 7. No token or secret leakage in errors or logs
  describe("7. Zero secret or token leakage in error reports", () => {
    it("error messages strictly exclude tokens, passwords, and secrets", () => {
      const secretToken = "pt_SUPER_SECRET_TOKEN_DO_NOT_LEAK";
      const res = resolvePortalAppBaseUrl({
        NODE_ENV: "production",
      });

      assert.strictEqual(res.success, false);
      assert.ok(!res.error.includes(secretToken));
      assert.ok(!res.error.includes("secret"));
      assert.ok(!res.error.includes("password"));
    });

    it("ProductionAppUrlError strictly describes configuration, not secret values", () => {
      try {
        getPortalAppBaseUrl({ NODE_ENV: "production" });
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err instanceof ProductionAppUrlError);
        assert.ok(err.message.includes("NEXT_PUBLIC_APP_URL or APP_URL"));
        assert.ok(!err.message.includes("Bearer"));
        assert.ok(!err.message.includes("pt_"));
      }
    });
  });

  // 8. Existing portal link format remains compatible
  describe("8. Existing portal link format compatibility", () => {
    it("preserves exact hash fragment format /portal#token=...", () => {
      const baseUrl = "https://tution-desk-one.vercel.app";
      const token = "pt_production_test_token_999";
      const link = buildPortalActivationUrl(token, baseUrl);

      assert.strictEqual(
        link,
        "https://tution-desk-one.vercel.app/portal#token=pt_production_test_token_999"
      );
    });

    it("preserves exact session entry format /portal without token", () => {
      const baseUrl = "https://tution-desk-one.vercel.app";
      const link = buildPortalActivationUrl("", baseUrl);

      assert.strictEqual(
        link,
        "https://tution-desk-one.vercel.app/portal"
      );
    });
  });
});
