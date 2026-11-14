/**
 * WhatsApp Multi-Tenant Notification Service
 * Connects to the standalone WhatsApp automation microservice (port 3005)
 * and scopes all dispatches to the specific center's WhatsApp session.
 *
 * Implements a strict fail-closed simulation guard.
 */

function getWhatsappServiceUrl(): string {
  const raw = process.env.WHATSAPP_SERVICE_URL || "http://localhost:3005";
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Resolves the canonical public frontend application base URL for parent magic links.
 * Priority order:
 * 1. process.env.NEXT_PUBLIC_APP_URL
 * 2. process.env.APP_URL
 * 3. process.env.FRONTEND_URL
 * 4. Vercel deployment variables (VERCEL_PROJECT_PRODUCTION_URL, VERCEL_URL)
 * 5. Fallback: http://localhost:3000 (local development default only)
 */
export function getAppBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : null) ||
    "http://localhost:3000";

  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Builds a Parent Portal link.
 *
 * IMPORTANT: `/p/{studentId}` carries no credential and cannot authenticate a
 * first-time parent (it requires an existing `parent_portal_session`), so the
 * frontend must never emit it as a shared/invitation link. Tokens are only ever
 * minted server-side; without one we fall back to the `/portal` entry page.
 */
export function buildMagicLink(
  studentId?: string | { toString(): string } | null
): string {
  if (!studentId) return "";
  const idStr =
    typeof studentId === "string" ? studentId.trim() : studentId.toString().trim();
  if (!idStr) return "";
  const baseUrl = getAppBaseUrl().replace(/\/+$/, "");
  return `${baseUrl}/portal`;
}

/**
 * Strict fail-closed guard for live WhatsApp dispatches.
 * Real outbound dispatch requires BOTH:
 * 1. WHATSAPP_MODE === "live" (explicitly configured)
 * 2. ENABLE_LIVE_WHATSAPP === "true" (explicit dual opt-in flag)
 *
 * Any missing, empty, invalid, or non-matching configuration strictly defaults to simulation.
 * NODE_ENV=production is NOT sufficient authorization for live dispatch.
 */
/**
 * Normalizes Indian phone numbers consistently:
 * - Strips all non-digit characters.
 * - Converts 10-digit Indian numbers (e.g. 9999900011) to canonical 12-digit format (919999900011).
 * - Converts 11-digit numbers starting with 0 (e.g. 09999900011) to canonical 12-digit format (919999900011).
 * - Leaves existing 12-digit numbers starting with 91 intact.
 */
export function normalizeIndianPhone(phone: string | number): string {
  const cleaned = String(phone || "").replace(/\D/g, "");
  if (cleaned.length === 10) {
    return `91${cleaned}`;
  }
  if (cleaned.length === 11 && cleaned.startsWith("0")) {
    return `91${cleaned.slice(1)}`;
  }
  return cleaned;
}

/**
 * Strict QA Live-Recipient Allowlist Guard:
 * - If QA_LIVE_MODE is active, a missing, empty, or invalid allowlist MUST fail closed (rejects live send).
 * - If QA_LIVE_RECIPIENT_ALLOWLIST is configured, only explicitly allowlisted numbers may proceed live.
 * - Non-allowlisted numbers fail closed and revert to simulation mode.
 */
export function isPhoneAllowedForLiveDispatch(phone?: string | number): boolean {
  const isQaLiveMode = process.env.QA_LIVE_MODE?.trim().toLowerCase() === "true";
  const allowlistRaw = process.env.QA_LIVE_RECIPIENT_ALLOWLIST?.trim();

  // In QA live mode, missing or empty allowlist must fail closed
  if (isQaLiveMode && (!allowlistRaw || allowlistRaw.length === 0)) {
    console.warn(
      "[QA SAFETY GUARD] QA_LIVE_MODE is active but QA_LIVE_RECIPIENT_ALLOWLIST is missing/empty. Failing closed into simulation."
    );
    return false;
  }

  // If an allowlist is provided (whether QA_LIVE_MODE is set or not)
  if (allowlistRaw) {
    if (!phone) return false;
    const normRecipient = normalizeIndianPhone(phone);
    const allowedList = allowlistRaw
      .split(",")
      .map((p) => normalizeIndianPhone(p.trim()))
      .filter(Boolean);

    if (allowedList.length === 0) {
      console.warn(
        "[QA SAFETY GUARD] QA_LIVE_RECIPIENT_ALLOWLIST contains no valid numbers. Failing closed into simulation."
      );
      return false;
    }

    const isMatch = allowedList.includes(normRecipient);
    if (!isMatch) {
      const masked =
        normRecipient.length >= 4 ? `***${normRecipient.slice(-4)}` : "****";
      console.log(
        `[QA SAFETY GUARD] Recipient ${masked} is NOT in QA_LIVE_RECIPIENT_ALLOWLIST. Diverting to simulation.`
      );
      return false;
    }
  }

  return true;
}

export function isLiveDispatchEnabled(
  recipientPhone?: string | number
): boolean {
  const mode = process.env.WHATSAPP_MODE?.trim().toLowerCase();
  const liveOptIn = process.env.ENABLE_LIVE_WHATSAPP?.trim().toLowerCase();
  if (mode !== "live" || liveOptIn !== "true") {
    return false;
  }
  return isPhoneAllowedForLiveDispatch(recipientPhone);
}

/**
 * Test-Only WhatsApp Live Dispatch Guard:
 * Allows ONLY explicit test pings from the authenticated Owner Settings page
 * (POST /api/whatsapp/test-message) to dispatch to the WhatsApp microservice.
 *
 * HARD PRODUCTION RESTRICTION:
 * - Test-only dispatch is permitted ONLY in local development or test environments.
 * - In production (NODE_ENV === "production" or VERCEL_ENV === "production"),
 *   this function unconditionally returns FALSE regardless of whether
 *   ALLOW_TEST_WHATSAPP_DISPATCH is set to true.
 * - Defaults strictly to FALSE (OFF).
 *
 * CRITICAL WORKFLOW ISOLATION:
 * This function MUST NEVER be used by any standard business workflow
 * (fees, admissions, receipts, test results, attendance, or campaigns).
 */
export function isTestDispatchAllowed(
  recipientPhone?: string | number
): boolean {
  // 1. Hard unconditional production block: reject immediately
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  ) {
    return false;
  }

  // 2. Explicitly allow ONLY local development or automated test environments
  const env = process.env.NODE_ENV?.trim().toLowerCase();
  if (env !== "development" && env !== "test") {
    return false;
  }

  // 3. Require explicit opt-in flag; default OFF
  const testOptIn = process.env.ALLOW_TEST_WHATSAPP_DISPATCH?.trim().toLowerCase();
  if (testOptIn !== "true") {
    return false;
  }

  // 4. Strict allowlist guard
  return isPhoneAllowedForLiveDispatch(recipientPhone);
}

/**
 * Emits strictly sanitized metadata logs in simulation mode.
 * Never logs raw message text, full phone numbers, student/parent names, or tokens.
 */
function logSimulatedDispatch(
  eventType: string,
  centerId: string,
  phone: string,
  message: string
): void {
  const maskedPhone =
    phone && phone.length >= 4 ? `***${phone.slice(-4)}` : "****";
  console.log(
    `[WHATSAPP SIMULATION] Event: ${eventType} | Center: ${centerId} | Recipient: ${maskedPhone} | Length: ${message.length} chars`
  );
}

/**
 * Returns required internal headers for WhatsApp microservice dispatches.
 * Fails closed if WHATSAPP_INTERNAL_SECRET is missing.
 */
function getInternalHeaders(): Record<string, string> {
  const secret = process.env.WHATSAPP_INTERNAL_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error(
      "Configuration error: WHATSAPP_INTERNAL_SECRET is missing or empty"
    );
  }
  return {
    "Content-Type": "application/json",
    "x-internal-secret": secret.trim(),
  };
}

function sanitizePhoneNumber(phone: string | number): string {
  return String(phone || "").replace(/\D/g, "");
}

function maskPhoneNumber(phone: string): string {
  return phone && phone.length >= 4 ? `***${phone.slice(-4)}` : "****";
}

export interface SendWelcomeMessageResult {
  success: boolean;
  centerId: string;
  phone: string;
  magicLink: string;
  message: string;
  messageId?: string;
  simulated?: boolean;
  accepted?: boolean;
  delivered?: boolean;
  error?: string;
}

/**
 * Sends an automated welcome message to the parent's WhatsApp upon new student admission.
 * Accepts the pre-formatted custom message directly.
 */
export async function sendWelcomeMessage(
  centerId: string,
  phone: string,
  message: string,
  studentId?: string
): Promise<SendWelcomeMessageResult> {
  const magicLink = buildMagicLink(studentId);
  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      magicLink,
      message,
      error: "Invalid recipient phone number: must contain 10 to 15 digits",
    };
  }

  // Fail-closed simulation guard: zero network requests unless explicitly opted into live mode
  if (!isLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("welcome_message", centerId, cleanDigits, message);
    return {
      success: false,
      simulated: true,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      magicLink,
      message,
      messageId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      error:
        "Simulation mode active: outbound live WhatsApp dispatch disabled. Set WHATSAPP_MODE=live and ENABLE_LIVE_WHATSAPP=true to enable live delivery.",
    };
  }

  const serviceUrl = getWhatsappServiceUrl();
  try {
    const response = await fetch(`${serviceUrl}/send-message`, {
      method: "POST",
      headers: getInternalHeaders(),
      body: JSON.stringify({
        centerId,
        phone: cleanDigits,
        message,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json().catch(() => null);

    if (response.ok && data?.success) {
      console.log(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Dispatched message! Recipient: ${maskedPhone} | ID: ${data.messageId}`
      );
      return {
        success: true,
        simulated: false,
        accepted: true,
        delivered: false,
        centerId,
        phone: maskedPhone,
        magicLink,
        message,
        messageId: data.messageId,
      };
    } else {
      const errorMsg =
        data?.error || `Microservice returned HTTP ${response.status}`;
      console.warn(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Microservice send failed (${response.status}): ${errorMsg}`
      );
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        magicLink,
        message,
        error: errorMsg,
      };
    }
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "WhatsApp microservice unreachable";
    console.warn(
      `[WHATSAPP SERVICE ERROR] Microservice at ${serviceUrl} unreachable for welcome message: ${errorMsg}`
    );
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      magicLink,
      message,
      error: errorMsg,
    };
  }
}

export interface SendCustomMessageResult {
  success: boolean;
  simulated?: boolean;
  accepted?: boolean;
  delivered?: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Generic helper to send any custom WhatsApp message via microservice for a given center
 */
export async function sendCustomWhatsAppMessage(
  centerId: string,
  phone: string,
  message: string
): Promise<SendCustomMessageResult> {
  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      error: "Invalid recipient phone number: must contain 10 to 15 digits",
    };
  }

  // Fail-closed simulation guard
  if (!isLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("custom_message", centerId, cleanDigits, message);
    return {
      success: false,
      simulated: true,
      accepted: false,
      delivered: false,
      error:
        "Simulation mode active: outbound live WhatsApp dispatch disabled. Set WHATSAPP_MODE=live and ENABLE_LIVE_WHATSAPP=true to enable live delivery.",
    };
  }

  const serviceUrl = getWhatsappServiceUrl();
  try {
    const response = await fetch(`${serviceUrl}/send-message`, {
      method: "POST",
      headers: getInternalHeaders(),
      body: JSON.stringify({ centerId, phone: cleanDigits, message }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json().catch(() => null);
    if (response.ok && data?.success) {
      return {
        success: true,
        simulated: false,
        accepted: true,
        delivered: false,
        messageId: data.messageId,
      };
    }
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      error: data?.error || `Microservice returned HTTP ${response.status}`,
    };
  } catch (err: unknown) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      error:
        err instanceof Error ? err.message : "WhatsApp microservice unreachable",
    };
  }
}

export interface SendFeeReminderResult {
  success: boolean;
  centerId: string;
  phone: string;
  message: string;
  messageId?: string;
  simulated?: boolean;
  accepted?: boolean;
  delivered?: boolean;
  error?: string;
}

/**
 * Sends an automated fee reminder to the parent's WhatsApp with due date, amount, and payment portal link.
 */
export async function sendFeeReminder(
  centerId: string,
  phone: string,
  studentName: string,
  amount: number | string,
  dueDate: string,
  magicLink?: string
): Promise<SendFeeReminderResult> {
  const portalText = magicLink
    ? `\n\n💳 Pay or view fee receipt online directly via your VIP Parent Portal:\n🔗 ${magicLink}`
    : "";

  const message = `Payment Reminder 🔔\n\nDear Parent, this is a friendly reminder that the tuition fee of ₹${Number(
    amount
  ).toLocaleString("en-IN")} for ${studentName} is due on ${dueDate}.${portalText}\n\nIf you have already paid, please ignore this reminder. Thank you!`;

  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      error: "Invalid recipient phone number: must contain 10 to 15 digits",
    };
  }

  // Fail-closed simulation guard: zero network requests unless explicitly opted into live mode
  if (!isLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("fee_reminder", centerId, cleanDigits, message);
    return {
      success: false,
      simulated: true,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      messageId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      error:
        "Simulation mode active: outbound live WhatsApp dispatch disabled. Set WHATSAPP_MODE=live and ENABLE_LIVE_WHATSAPP=true to enable live delivery.",
    };
  }

  const serviceUrl = getWhatsappServiceUrl();
  try {
    const response = await fetch(`${serviceUrl}/send-message`, {
      method: "POST",
      headers: getInternalHeaders(),
      body: JSON.stringify({ centerId, phone: cleanDigits, message }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json().catch(() => null);

    if (response.ok && data?.success) {
      console.log(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Fee reminder dispatched! Recipient: ${maskedPhone} | ID: ${data.messageId}`
      );
      return {
        success: true,
        simulated: false,
        accepted: true,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message,
        messageId: data.messageId,
      };
    } else {
      const errorMsg =
        data?.error || `Microservice returned HTTP ${response.status}`;
      console.warn(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Fee reminder failed (${response.status}): ${errorMsg}`
      );
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message,
        error: errorMsg,
      };
    }
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "WhatsApp microservice unreachable";
    console.warn(
      `[WHATSAPP SERVICE ERROR] Microservice at ${serviceUrl} unreachable for fee reminder: ${errorMsg}`
    );
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      error: errorMsg,
    };
  }
}

export interface SendTestResultResult {
  success: boolean;
  centerId: string;
  phone: string;
  message: string;
  messageId?: string;
  simulated?: boolean;
  accepted?: boolean;
  delivered?: boolean;
  error?: string;
}

/**
 * Sends a test marks alert to the parent's WhatsApp with score breakdown and student progress link.
 */
export async function sendTestResult(
  centerId: string,
  phone: string,
  studentName: string,
  testName: string,
  marks: number | string,
  maxMarks: number | string,
  magicLink?: string
): Promise<SendTestResultResult> {
  const numMarks = Number(marks);
  const numMax = Number(maxMarks);
  const percentage =
    !isNaN(numMarks) && !isNaN(numMax) && numMax > 0
      ? ` (${((numMarks / numMax) * 100).toFixed(1)}%)`
      : "";

  const portalText = magicLink
    ? `\n\n📊 Review detailed subject-wise insights & rank analytics on your VIP portal:\n🔗 ${magicLink}`
    : "";

  const message = `Test Result Announced 📝\n\nDear Parent, ${studentName}'s result for "${testName}" has been evaluated.\n\nScore: ${marks} / ${maxMarks}${percentage}${portalText}\n\nKeep encouraging ${studentName} for continuous improvement! 🌟`;

  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      error: "Invalid recipient phone number: must contain 10 to 15 digits",
    };
  }

  // Fail-closed simulation guard: zero network requests unless explicitly opted into live mode
  if (!isLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("test_result", centerId, cleanDigits, message);
    return {
      success: false,
      simulated: true,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      messageId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      error:
        "Simulation mode active: outbound live WhatsApp dispatch disabled. Set WHATSAPP_MODE=live and ENABLE_LIVE_WHATSAPP=true to enable live delivery.",
    };
  }

  const serviceUrl = getWhatsappServiceUrl();
  try {
    const response = await fetch(`${serviceUrl}/send-message`, {
      method: "POST",
      headers: getInternalHeaders(),
      body: JSON.stringify({ centerId, phone: cleanDigits, message }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json().catch(() => null);

    if (response.ok && data?.success) {
      console.log(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Test result dispatched! Recipient: ${maskedPhone} | ID: ${data.messageId}`
      );
      return {
        success: true,
        simulated: false,
        accepted: true,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message,
        messageId: data.messageId,
      };
    } else {
      const errorMsg =
        data?.error || `Microservice returned HTTP ${response.status}`;
      console.warn(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Test result failed (${response.status}): ${errorMsg}`
      );
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message,
        error: errorMsg,
      };
    }
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "WhatsApp microservice unreachable";
    console.warn(
      `[WHATSAPP SERVICE ERROR] Microservice at ${serviceUrl} unreachable for test result: ${errorMsg}`
    );
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      error: errorMsg,
    };
  }
}
