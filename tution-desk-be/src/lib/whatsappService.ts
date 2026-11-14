/**
 * WhatsApp Multi-Tenant Notification Service
 * Connects to the standalone WhatsApp automation microservice (port 3005)
 * and scopes all dispatches to the specific center's WhatsApp session.
 *
 * Implements a strict fail-closed simulation guard.
 */

import mongoose from "mongoose";
import Center, {
  DEFAULT_ADMISSION_TEMPLATE,
  DEFAULT_FEE_REMINDER_TEMPLATE,
  DEFAULT_PAYMENT_RECEIPT_TEMPLATE,
} from "../models/Center.ts";
import {
  buildPortalActivationUrl,
  getPortalAppBaseUrl,
  resolvePortalAppBaseUrl,
  isProductionEnvironment,
  isLocalhostOrLoopbackUrl,
  ProductionAppUrlError,
} from "./portalLinks.ts";
import { resolvePortalInvitationUrl } from "./parentAccessService.ts";

function getWhatsappServiceUrl(): string {
  const raw =
    process.env.WHATSAPP_SERVICE_URL ||
    process.env.WHATSAPP_SERVER_URL ||
    "http://localhost:3005";
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
  return getPortalAppBaseUrl();
}

/**
 * Builds a Parent Portal link.
 *
 * IMPORTANT: the clean URL form `/p/{studentId}` carries no credential and
 * therefore CANNOT authenticate a first-time parent (it only works once an
 * active `parent_portal_session` cookie exists). Links emitted for parents must
 * therefore use the supported activation flow:
 *
 *   with a raw token -> `${base}/portal#token=pt_...`
 *   without a token  -> `${base}/portal` (session-based entry only)
 *
 * Use buildMagicLinkForStudent() whenever the token can be recovered from the
 * ParentAccess record (preferred).
 */
export function buildMagicLink(
  studentId?: string | { toString(): string } | null,
  rawToken?: string | null
): string {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  const resolution = resolvePortalAppBaseUrl();
  if (!resolution.success) {
    if (isProductionEnvironment()) {
      console.warn(`[MAGIC LINK ERROR] ${resolution.error}`);
      return "";
    }
  }

  const baseUrl = resolution.success ? resolution.url : "http://localhost:3000";
  if (token) return buildPortalActivationUrl(token, baseUrl);

  if (!studentId) return "";
  const idStr =
    typeof studentId === "string" ? studentId.trim() : studentId.toString().trim();
  if (!idStr) return "";
  return buildPortalActivationUrl(null, baseUrl);
}

/**
 * Builds the canonical Parent Portal link for a student, recovering the
 * already-issued token (AES-256-GCM encrypted at rest) so the parent receives a
 * link that actually activates.
 *
 * Never regenerates the token: existing links delivered to the parent stay
 * valid. Falls back to the `/portal` entry URL when no recoverable token exists
 * or the database is unavailable.
 */
export async function buildMagicLinkForStudent(
  centerId: string,
  studentId?: string | { toString(): string } | null
): Promise<string> {
  if (!centerId || !studentId) return "";

  const idStr =
    typeof studentId === "string" ? studentId.trim() : studentId.toString().trim();
  if (!idStr) return "";

  const resolution = resolvePortalAppBaseUrl();
  if (!resolution.success) {
    if (isProductionEnvironment()) {
      console.warn(`[MAGIC LINK ERROR] ${resolution.error}`);
      return "";
    }
  }

  const baseUrl = resolution.success ? resolution.url : "http://localhost:3000";
  const fallback = buildPortalActivationUrl(null, baseUrl);

  // Without an active DB connection the encrypted token cannot be decrypted;
  // degrade to the session-based entry URL instead of a dead `/p/{id}` link.
  if (mongoose.connection.readyState !== 1) return fallback;

  try {
    const url = await resolvePortalInvitationUrl(centerId, idStr, {
      baseUrl,
      fallbackToPortalEntry: true,
    });
    return url || fallback;
  } catch {
    return fallback;
  }
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
 * Admission Welcome WhatsApp Live Dispatch Guard:
 * Dedicated, isolated opt-in flag for automated student admission welcome messages.
 * Strictly defaults to false (OFF).
 * Does NOT enable fee reminders, payment receipts, test results, attendance, or campaigns.
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

export function isAdmissionWelcomeLiveDispatchEnabled(
  recipientPhone?: string | number
): boolean {
  const flag = process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP?.trim().toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") {
    return isPhoneAllowedForLiveDispatch(recipientPhone);
  }
  return isLiveDispatchEnabled(recipientPhone);
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
  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  // Production URL validation guard: fail closed before dispatch
  if (isProductionEnvironment()) {
    const baseRes = resolvePortalAppBaseUrl();
    if (!baseRes.success) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        magicLink: "",
        message,
        error: `Configuration error: ${baseRes.error}`,
      };
    }
  }

  const magicLink = await buildMagicLinkForStudent(centerId, studentId);
  if (isProductionEnvironment() && magicLink && isLocalhostOrLoopbackUrl(magicLink)) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      magicLink: "",
      message,
      error:
        "Configuration error: Cannot dispatch welcome message with localhost magic link in production environment.",
    };
  }

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

export interface SendAdmissionWelcomeMessageParams {
  centerId: string;
  phone: string;
  studentName: string;
  instituteName: string;
  batchName: string;
  portalUrl?: string | null;
  isExistingActivePortal?: boolean;
}

export interface SendAdmissionWelcomeMessageResult {
  success: boolean;
  simulated: boolean;
  accepted: boolean;
  delivered: boolean;
  ambiguous?: boolean;
  centerId: string;
  phone: string;
  message: string;
  messageId?: string;
  error?: string;
}

export function formatAdmissionWelcomeMessage({
  studentName,
  instituteName,
  batchName,
  portalUrl,
  isExistingActivePortal,
  appBaseUrl,
}: {
  studentName: string;
  instituteName: string;
  batchName: string;
  portalUrl?: string | null;
  isExistingActivePortal?: boolean;
  appBaseUrl?: string;
}): string {
  let base = appBaseUrl;
  if (!base) {
    const res = resolvePortalAppBaseUrl();
    if (res.success) {
      base = res.url;
    } else if (!isProductionEnvironment()) {
      base = "http://localhost:3000";
    } else {
      throw new ProductionAppUrlError(
        res.error || "Missing public HTTPS application URL in production"
      );
    }
  }

  let portalSection = "";
  if (portalUrl) {
    portalSection = `\nAccess your secure Parent Portal here:\n${portalUrl}\n(Please keep this private to your family.)\n`;
  } else if (isExistingActivePortal) {
    portalSection = `\nYour Parent Portal account is already active. Access your student updates at:\n${base}/portal\n`;
  }

  return (
    `Namaste! Welcome to ${instituteName}.\n\n` +
    `We are pleased to confirm the admission of ${studentName} in Batch: ${batchName}.\n` +
    portalSection +
    `\nFor any academic or fee queries, please reach out to the institute administration.\n\n` +
    `Thank you for choosing ${instituteName}!`
  );
}

/**
 * Sends an automated admission welcome message.
 * Guarded by dedicated `isAdmissionWelcomeLiveDispatchEnabled()`.
 * Fails closed to simulation mode when flag is unset or false.
 * Strictly preserves accepted: true, delivered: false semantics.
 */
export async function sendAdmissionWelcomeMessage({
  centerId,
  phone,
  studentName,
  instituteName,
  batchName,
  portalUrl,
  isExistingActivePortal,
}: SendAdmissionWelcomeMessageParams): Promise<SendAdmissionWelcomeMessageResult> {
  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  // Production URL validation guard: fail closed before formatting or dispatching
  if (isProductionEnvironment()) {
    if (portalUrl && isLocalhostOrLoopbackUrl(portalUrl)) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message: "",
        error:
          "Configuration error: Cannot dispatch message with localhost portal URL in production environment.",
      };
    }
    const baseRes = resolvePortalAppBaseUrl();
    if (!baseRes.success) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message: "",
        error: `Configuration error: ${baseRes.error}`,
      };
    }
  }

  let message: string;
  try {
    message = formatAdmissionWelcomeMessage({
      studentName,
      instituteName,
      batchName,
      portalUrl,
      isExistingActivePortal,
    });
  } catch (formatErr) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message: "",
      error:
        formatErr instanceof Error
          ? formatErr.message
          : "Failed to format admission welcome message",
    };
  }

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

  // Fail-closed simulation guard: requires dedicated admission welcome dispatch opt-in
  if (!isAdmissionWelcomeLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("admission_welcome", centerId, cleanDigits, message);
    return {
      success: true,
      simulated: true,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      message,
      messageId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
      // Upstream microservice contract guarantees explicit `accepted: true` on successful dispatch.
      // Do not infer acceptance from HTTP 200 alone without explicit confirmation.
      const isExplicitlyAccepted = data.accepted === true;

      console.log(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Admission welcome dispatched! Recipient: ${maskedPhone} | ID: ${data.messageId} | Accepted: ${isExplicitlyAccepted}`
      );
      return {
        success: isExplicitlyAccepted,
        simulated: false,
        accepted: isExplicitlyAccepted,
        delivered: false, // Delivery is asynchronous via delivery receipts
        centerId,
        phone: maskedPhone,
        message,
        messageId: data.messageId || "sent",
        error: isExplicitlyAccepted
          ? undefined
          : "Microservice returned HTTP 200 but omitted explicit 'accepted: true' confirmation",
      };
    } else {
      const errorMsg =
        data?.error || `Microservice returned HTTP ${response.status}`;
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
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        err.message.toLowerCase().includes("timed out") ||
        err.message.toLowerCase().includes("timeout"));

    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      ambiguous: Boolean(isTimeout),
      centerId,
      phone: maskedPhone,
      message,
      error: errorMsg,
    };
  }
}

/**
 * Directly dispatches a pre-formatted admission welcome message.
 * Guarded by dedicated `isAdmissionWelcomeLiveDispatchEnabled()`.
 * Fails closed to simulation mode when flag is unset or false.
 */
export async function sendAdmissionWelcomeDirect(
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

  // Fail-closed simulation guard: requires dedicated admission welcome dispatch opt-in
  if (!isAdmissionWelcomeLiveDispatchEnabled()) {
    logSimulatedDispatch("admission_welcome", centerId, cleanDigits, message);
    return {
      success: true,
      simulated: true,
      accepted: false,
      delivered: false,
      messageId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
      const isExplicitlyAccepted = data.accepted === true;
      console.log(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Admission welcome dispatched! Recipient: ${maskedPhone} | ID: ${data.messageId} | Accepted: ${isExplicitlyAccepted}`
      );
      return {
        success: isExplicitlyAccepted,
        simulated: false,
        accepted: isExplicitlyAccepted,
        delivered: false,
        messageId: data.messageId || "sent",
        error: isExplicitlyAccepted
          ? undefined
          : "Microservice returned HTTP 200 but omitted explicit 'accepted: true' confirmation",
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
      error: err instanceof Error ? err.message : "WhatsApp microservice connection error",
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
 * Helper to dynamically replace placeholders in templates (e.g. {{studentName}}, {{amountDue}}).
 */
export function formatTemplate(
  template: string,
  variables: Record<string, string | number | undefined | null>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    result = result.replace(regex, value !== undefined && value !== null ? String(value) : "");
  }
  return result;
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
  magicLink?: string,
  customTemplate?: string
): Promise<SendFeeReminderResult> {
  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  // Production URL validation guard: fail closed if magic link points to localhost in production
  if (isProductionEnvironment()) {
    if (magicLink && isLocalhostOrLoopbackUrl(magicLink)) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message: "",
        error:
          "Configuration error: Cannot dispatch fee reminder with localhost magic link in production environment.",
      };
    }
  }

  let message: string;
  if (customTemplate) {
    message = formatTemplate(customTemplate, {
      studentName,
      amountDue: Number(amount).toLocaleString("en-IN"),
      dueDate,
      magicLink: magicLink || "",
    });
  } else {
    let template = DEFAULT_FEE_REMINDER_TEMPLATE;
    try {
      const center = await Center.findOne({ centerId }).select("messagingTemplates").lean();
      if (center?.messagingTemplates?.feeReminder) {
        template = center.messagingTemplates.feeReminder;
      }
    } catch {}

    if (template === DEFAULT_FEE_REMINDER_TEMPLATE && !magicLink) {
      message = `Payment Reminder 🔔\n\nDear Parent, this is a friendly reminder that the tuition fee of ₹${Number(
        amount
      ).toLocaleString("en-IN")} for ${studentName} is due on ${dueDate}.\n\nIf you have already paid, please ignore this reminder. Thank you!`;
    } else {
      message = formatTemplate(template, {
        studentName,
        amountDue: Number(amount).toLocaleString("en-IN"),
        dueDate,
        magicLink: magicLink || "",
      });
    }
  }

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

export interface SendPaymentReceiptResult {
  success: boolean;
  centerId: string;
  phone: string;
  receiptNumber: string;
  message: string;
  messageId?: string;
  simulated?: boolean;
  accepted?: boolean;
  delivered?: boolean;
  error?: string;
}

/**
 * Sends an automated payment receipt confirmation to the parent's WhatsApp upon recording a fee payment.
 */
export async function sendPaymentReceipt(
  centerId: string,
  phone: string,
  studentName: string,
  paidAmount: number | string,
  receiptNumber: string,
  studentId?: string,
  customTemplate?: string
): Promise<SendPaymentReceiptResult> {
  const cleanDigits = sanitizePhoneNumber(phone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  if (isProductionEnvironment()) {
    const baseRes = resolvePortalAppBaseUrl();
    if (!baseRes.success) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        receiptNumber,
        message: "",
        error: `Configuration error: ${baseRes.error}`,
      };
    }
  }

  const magicLink = await buildMagicLinkForStudent(centerId, studentId);
  if (isProductionEnvironment() && magicLink && isLocalhostOrLoopbackUrl(magicLink)) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      receiptNumber,
      message: "",
      error:
        "Configuration error: Cannot dispatch payment receipt with localhost magic link in production environment.",
    };
  }

  let template = customTemplate;
  if (!template) {
    try {
      const center = await Center.findOne({ centerId }).select("messagingTemplates").lean();
      if (center?.messagingTemplates?.paymentReceipt) {
        template = center.messagingTemplates.paymentReceipt;
      }
    } catch {}
  }
  if (!template) {
    template = DEFAULT_PAYMENT_RECEIPT_TEMPLATE;
  }

  const formattedPaid = Number(paidAmount).toLocaleString("en-IN");
  const message = formatTemplate(template, {
    studentName,
    paidAmount: formattedPaid,
    receiptNumber,
    magicLink,
  });

  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      receiptNumber,
      message,
      error: "Invalid recipient phone number: must contain 10 to 15 digits",
    };
  }

  // Fail-closed simulation guard: zero network requests unless explicitly opted into live mode
  if (!isLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("payment_receipt", centerId, cleanDigits, message);
    return {
      success: false,
      simulated: true,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      receiptNumber,
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
        `[WHATSAPP SERVICE] [Center: ${centerId}] Payment receipt dispatched! Recipient: ${maskedPhone} | ID: ${data.messageId}`
      );
      return {
        success: true,
        simulated: false,
        accepted: true,
        delivered: false,
        centerId,
        phone: maskedPhone,
        receiptNumber,
        message,
        messageId: data.messageId,
      };
    } else {
      const errorMsg =
        data?.error || `Microservice returned HTTP ${response.status}`;
      console.warn(
        `[WHATSAPP SERVICE] [Center: ${centerId}] Payment receipt failed (${response.status}): ${errorMsg}`
      );
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        receiptNumber,
        message,
        error: errorMsg,
      };
    }
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "WhatsApp microservice unreachable";
    console.warn(
      `[WHATSAPP SERVICE ERROR] Microservice at ${serviceUrl} unreachable for payment receipt: ${errorMsg}`
    );
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      receiptNumber,
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

  if (isProductionEnvironment()) {
    if (magicLink && isLocalhostOrLoopbackUrl(magicLink)) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        message: "",
        error:
          "Configuration error: Cannot dispatch test result with localhost magic link in production environment.",
      };
    }
  }

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


export interface SendAttendanceAlertParams {
  centerId: string;
  studentId: string;
  studentName: string;
  parentPhone: string;
  batch: string;
  date: Date | string;
  status: "Present" | "Absent";
  centerName?: string;
}

export interface SendAttendanceAlertResult {
  success: boolean;
  simulated?: boolean;
  accepted?: boolean;
  delivered?: boolean;
  centerId: string;
  phone: string;
  message?: string;
  messageId?: string;
  error?: string;
}

/**
 * Sends an automated attendance alert to the parent's WhatsApp with student status and portal link.
 */
export async function sendAttendanceAlert({
  centerId,
  studentId,
  studentName,
  parentPhone,
  batch,
  date,
  status,
  centerName = "Tuition Center",
}: SendAttendanceAlertParams): Promise<SendAttendanceAlertResult> {
  const cleanDigits = sanitizePhoneNumber(parentPhone);
  const maskedPhone = maskPhoneNumber(cleanDigits);

  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      error: "Invalid recipient phone number: must contain 10 to 15 digits",
    };
  }

  if (isProductionEnvironment()) {
    const baseRes = resolvePortalAppBaseUrl();
    if (!baseRes.success) {
      return {
        success: false,
        simulated: false,
        accepted: false,
        delivered: false,
        centerId,
        phone: maskedPhone,
        error: `Configuration error: ${baseRes.error}`,
      };
    }
  }

  const magicLink = await buildMagicLinkForStudent(centerId, studentId);
  if (isProductionEnvironment() && magicLink && isLocalhostOrLoopbackUrl(magicLink)) {
    return {
      success: false,
      simulated: false,
      accepted: false,
      delivered: false,
      centerId,
      phone: maskedPhone,
      error:
        "Configuration error: Cannot dispatch attendance alert with localhost magic link in production environment.",
    };
  }
  const formattedDate = new Date(date).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const statusEmoji = status === "Present" ? "✅" : "⚠️";

  const message = [
    `*${centerName} — Attendance Update*`,
    ``,
    `Dear Parent,`,
    `Your child *${studentName}* has been marked ${statusEmoji} *${status}* for batch *${batch}* on *${formattedDate}*.`,
    magicLink ? `\nView student attendance and academic profile:\n${magicLink}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Fail-closed simulation guard: zero network requests unless explicitly opted into live mode
  if (!isLiveDispatchEnabled(cleanDigits)) {
    logSimulatedDispatch("attendance_alert", centerId, cleanDigits, message);
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
        `[WHATSAPP SERVICE] [Center: ${centerId}] Attendance alert dispatched! Recipient: ${maskedPhone} | ID: ${data.messageId}`
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
        `[WHATSAPP SERVICE] [Center: ${centerId}] Attendance alert failed (${response.status}): ${errorMsg}`
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
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "WhatsApp microservice unreachable";
    console.warn(
      `[WHATSAPP SERVICE ERROR] Microservice at ${serviceUrl} unreachable for attendance alert: ${errorMsg}`
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
