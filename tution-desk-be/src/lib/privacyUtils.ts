/**
 * privacyUtils.ts
 *
 * Centralized privacy & contact masking utilities for TuitionDesk.
 * Enforces REQ-02: Teachers must never access student or parent phone numbers.
 */

/**
 * Standard contact number masking helper.
 * Replaces leading digits with asterisks, preserving only the last 4 digits.
 * E.g., "9876543210" -> "******3210"
 * E.g., "919876543210" -> "********3210"
 * E.g., "123" -> "****"
 */
export function maskContactNumber(phone?: string | null): string {
  if (!phone) return "";
  const trimmed = String(phone).trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 4) {
    return "****";
  }
  const last4 = trimmed.slice(-4);
  const maskedPrefix = "*".repeat(Math.max(0, trimmed.length - 4));
  return `${maskedPrefix}${last4}`;
}

/**
 * Strips or masks student/parent contact numbers on a single student object
 * if the authenticated caller's role is "teacher".
 * Preserves full access for "owner" and system callers.
 */
export function sanitizeStudentForRole<T = any>(
  student: T,
  role?: string
): T {
  if (!student) return student;
  if (role !== "teacher") return student;

  const raw: any =
    typeof (student as any)?.toObject === "function"
      ? (student as any).toObject()
      : typeof student === "object"
      ? { ...student }
      : student;

  if (raw && typeof raw === "object") {
    if (raw.parentWhatsApp !== undefined && raw.parentWhatsApp !== null) {
      raw.parentWhatsApp = maskContactNumber(String(raw.parentWhatsApp));
    }
    if (raw.phone !== undefined && raw.phone !== null) {
      raw.phone = maskContactNumber(String(raw.phone));
    }
    if (raw.parentPhone !== undefined && raw.parentPhone !== null) {
      raw.parentPhone = maskContactNumber(String(raw.parentPhone));
    }
  }

  return raw as T;
}

/**
 * Batch-sanitizes an array of student documents for a given caller role.
 */
export function sanitizeStudentListForRole<T = any>(
  students: T[],
  role?: string
): T[] {
  if (!Array.isArray(students)) return students;
  if (role !== "teacher") return students;
  return students.map((s) => sanitizeStudentForRole(s, role));
}

/**
 * Sanitizes a nested populated student object on a parent document (e.g., Fee, Attendance).
 */
export function sanitizePopulatedStudentDoc<T = any>(
  doc: T,
  fieldName = "studentId",
  role?: string
): T {
  if (!doc || role !== "teacher") return doc;

  const raw: any =
    typeof (doc as any)?.toObject === "function"
      ? (doc as any).toObject()
      : typeof doc === "object"
      ? { ...doc }
      : doc;

  if (raw && typeof raw === "object" && raw[fieldName] && typeof raw[fieldName] === "object") {
    raw[fieldName] = sanitizeStudentForRole(raw[fieldName], role);
  }

  return raw as T;
}
