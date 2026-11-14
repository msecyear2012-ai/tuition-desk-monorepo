/**
 * studentPhoneMasked.ts
 *
 * Core pure helper for REQ-02 student contact masking and DOM link security.
 */

export interface StudentPhoneRenderInfo {
  displayText: string;
  isMasked: boolean;
  hasRawPhoneInOutput: boolean;
  hasTelLink: boolean;
  hasWaLink: boolean;
  ariaLabel: string;
  telHref?: string;
  waHref?: string;
}

/**
 * Pure masking helper: Masks all but the last 4 digits.
 * If phone already contains asterisks (e.g. from backend sanitization), preserves it.
 */
export function formatMaskedPhone(phone?: string | null): string {
  if (!phone) return "";
  const trimmed = String(phone).trim();
  if (trimmed.length === 0) return "";

  // If already masked by the server
  if (trimmed.includes("*")) {
    return trimmed;
  }

  // Extract digits only
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length <= 4) {
    return "****";
  }

  const last4 = digits.slice(-4);
  const prefixLength = Math.max(0, digits.length - 4);
  return `${"*".repeat(prefixLength)}${last4}`;
}

/**
 * Formats a clean 10-digit phone for display with country code.
 */
export function formatDisplayPhone(phone: string, showCountryCode = true): string {
  const digits = phone.replace(/\D/g, "");
  const baseDigits = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
  if (showCountryCode) {
    return `+91 ${baseDigits}`;
  }
  return baseDigits;
}

/**
 * Evaluates the contact privacy perimeter and returns safe render attributes.
 * Enforces REQ-02: Teachers must NEVER receive raw phone, tel: or wa.me links.
 */
export function evaluateStudentPhoneDisplay(
  phone?: string | null,
  userRole: "owner" | "teacher" | string = "teacher",
  showQuickActions = true,
  showCountryCode = true
): StudentPhoneRenderInfo {
  if (!phone || String(phone).trim() === "") {
    return {
      displayText: "—",
      isMasked: true,
      hasRawPhoneInOutput: false,
      hasTelLink: false,
      hasWaLink: false,
      ariaLabel: "No contact number recorded",
    };
  }

  const isTeacher = userRole === "teacher";
  const rawDigits = String(phone).replace(/\D/g, "");
  const clean10Digits = rawDigits.startsWith("91") && rawDigits.length === 12 ? rawDigits.slice(2) : rawDigits;

  if (isTeacher) {
    const masked = formatMaskedPhone(phone);
    const last4 = masked.slice(-4);
    return {
      displayText: masked,
      isMasked: true,
      hasRawPhoneInOutput: false,
      hasTelLink: false,
      hasWaLink: false,
      ariaLabel: `Parent contact number masked ending in ${last4}`,
    };
  }

  // Owner Role
  const displayFormatted = formatDisplayPhone(String(phone), showCountryCode);
  const canShowActions = showQuickActions && clean10Digits.length >= 10;

  return {
    displayText: displayFormatted,
    isMasked: false,
    hasRawPhoneInOutput: true,
    hasTelLink: canShowActions,
    hasWaLink: canShowActions,
    ariaLabel: `Parent contact +91 ${clean10Digits}`,
    telHref: canShowActions ? `tel:+91${clean10Digits}` : undefined,
    waHref: canShowActions ? `https://wa.me/91${clean10Digits}` : undefined,
  };
}
