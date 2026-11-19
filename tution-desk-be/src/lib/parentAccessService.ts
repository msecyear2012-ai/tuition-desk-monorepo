import crypto from "crypto";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import ParentAccess, { type IParentAccessDocument } from "../models/ParentAccess.ts";
import ParentAccessLock, {
  verifyParentAccessLockIndexIntegrity,
  type IParentAccessLockDocument,
} from "../models/ParentAccessLock.ts";
import Student from "../models/Student.ts";
import { verifyToken } from "./auth.ts";
import { encryptToken, decryptToken, type EncryptedPayload } from "./tokenCipher.ts";
import { buildPortalActivationUrl } from "./portalLinks.ts";

/**
 * Standard HTTP security headers for all parent portal and parent access endpoints.
 * Guarantees zero downstream browser/proxy caching and zero token leakage in referrers.
 */
export const portalSecurityHeaders = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  "Referrer-Policy": "no-referrer",
} as const;

export interface GeneratedTokenPair {
  rawToken: string;
  tokenHash: string;
  tokenPrefix: string;
}

/**
 * Generates a cryptographically secure, high-entropy portal access token.
 * Uses 32 random bytes (256 bits of entropy) with URL-safe base64 encoding.
 * Returns rawToken for one-time return to creator, tokenHash for persistence,
 * and tokenPrefix for audit/identification.
 */
export function generatePortalToken(): GeneratedTokenPair {
  const randomBytes = crypto.randomBytes(32).toString("base64url");
  const rawToken = `pt_${randomBytes}`;
  const tokenHash = hashPortalToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 8); // "pt_XXXXX"
  return { rawToken, tokenHash, tokenPrefix };
}

/**
 * Computes deterministic SHA-256 hash of a raw portal token.
 * Only the hash is ever queried or persisted in MongoDB.
 */
export function hashPortalToken(rawToken: string): string {
  if (!rawToken || typeof rawToken !== "string") return "";
  return crypto.createHash("sha256").update(rawToken.trim()).digest("hex");
}

/**
 * Normalizes phone numbers to clean digits.
 */
export function sanitizePhoneNumber(phone: string | number): string {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * Generates matching variants for phone numbers (raw digits, last 10 digits, +91, 91, 0 prefixes)
 * to support robust sibling detection regardless of leading country codes or formatting.
 */
export function getPhoneVariants(phone: string | number): string[] {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return [];
  const variants = new Set<string>();
  variants.add(digits);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    variants.add(last10);
    variants.add(`91${last10}`);
    variants.add(`+91${last10}`);
    variants.add(`0${last10}`);
  }
  return Array.from(variants);
}

export interface GetOrCreateParentAccessOptions {
  parentName?: string;
  parentPhone?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  models?: {
    ParentAccessLock?: any;
    ParentAccess?: any;
    Student?: any;
  };
}

/**
 * Retrieves existing active ParentAccess for a student, or creates a new one.
 * If creating, returns the rawToken (ONCE).
 * If existing, rawToken is null (since raw tokens are never stored).
 * Concurrency-safe: Coordinates via MongoDB-backed distributed lock (ParentAccessLock)
 * to prevent duplicate active records across independent Node processes and serverless instances.
 */
export async function getOrCreateParentAccess(
  centerId: string,
  studentId: string | Types.ObjectId,
  options: GetOrCreateParentAccessOptions = {}
): Promise<{
  parentAccess: IParentAccessDocument;
  rawToken: string | null;
  created: boolean;
}> {
  const cleanCenterId = String(centerId).trim();
  const studentObjectId =
    typeof studentId === "string" ? new Types.ObjectId(studentId) : studentId;

  const StudentModel = options.models?.Student || Student;
  const ParentAccessModel = options.models?.ParentAccess || ParentAccess;
  const ParentAccessLockModel =
    options.models?.ParentAccessLock || ParentAccessLock;

  // 1. Verify student exists in this center
  const student = await StudentModel.findOne({
    _id: studentObjectId,
    centerId: cleanCenterId,
  });

  if (!student) {
    throw new Error("Student not found in this tuition center");
  }

  // 2. Validate parent phone number
  const phone = sanitizePhoneNumber(
    options.parentPhone || student.parentWhatsApp
  );

  if (!phone || phone.length < 10) {
    throw new Error("Valid parent phone number (minimum 10 digits) is required");
  }

  // 3. Early check: Check if an active ParentAccess record already explicitly links this student
  let existing = await ParentAccessModel.findOne({
    centerId: cleanCenterId,
    linkedStudentIds: studentObjectId,
    status: "active",
  });

  if (existing) {
    return {
      parentAccess: existing,
      rawToken: null,
      created: false,
    };
  }

  // 3b. Sibling Auto-Linking: Check if an active Parent Portal already exists in the same centerId
  // for another student with the exact same normalized parentPhone
  const phoneVariants = getPhoneVariants(phone);
  existing = await ParentAccessModel.findOne({
    centerId: cleanCenterId,
    parentPhone: { $in: phoneVariants },
    status: "active",
  });

  if (existing) {
    await ParentAccessModel.updateOne(
      { _id: existing._id, centerId: cleanCenterId },
      { $addToSet: { linkedStudentIds: studentObjectId } }
    );
    if (existing.linkedStudentIds && typeof existing.linkedStudentIds.addToSet === "function") {
      existing.linkedStudentIds.addToSet(studentObjectId);
    } else if (!existing.linkedStudentIds.includes(studentObjectId)) {
      existing.linkedStudentIds.push(studentObjectId);
    }
    return {
      parentAccess: existing,
      rawToken: null,
      created: false,
    };
  }

  // 4. Distributed Atomic Lock Coordination
  // Lock identity binds centerId and phone for specific parent account to serialize sibling admissions
  const lockPhone = phone.slice(-10);
  const lockKey = `${cleanCenterId}:${lockPhone}:parent_access_create`;
  const lockToken = crypto.randomUUID();
  const lockTtlMs = 15000; // 15 seconds TTL
  const pollIntervalMs =
    options.pollIntervalMs !== undefined ? options.pollIntervalMs : 100;
  const maxAttempts =
    options.maxPollAttempts !== undefined ? options.maxPollAttempts : 30;

  // Step A: Index Integrity Preflight Verification (fails closed if unverified)
  const isIndexVerified = await verifyParentAccessLockIndexIntegrity(
    ParentAccessLockModel
  );
  if (!isIndexVerified) {
    throw new Error(
      "ParentAccessLock unique index on 'lockKey' is missing or unverified. Lock acquisition cannot proceed without effective uniqueness enforcement."
    );
  }

  let acquiredLock = false;

  // Attempt 1: Insert new lock
  try {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + lockTtlMs);

    await ParentAccessLockModel.create({
      lockKey,
      centerId: cleanCenterId,
      studentId: String(studentObjectId),
      holderId: lockToken,
      status: "LOCKED",
      lockedAt: now,
      expiresAt: lockExpiresAt,
    });
    acquiredLock = true;
  } catch (lockErr: any) {
    if (!lockErr || lockErr.code !== 11000) {
      throw lockErr;
    }
  }

  // Attempt 2: Takeover of expired lock (expiresAt <= now)
  if (!acquiredLock) {
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + lockTtlMs);

    const claimedDoc = await ParentAccessLockModel.findOneAndUpdate(
      {
        lockKey,
        expiresAt: { $lte: now },
      },
      {
        $set: {
          holderId: lockToken,
          lockedAt: now,
          expiresAt: newExpiresAt,
          status: "LOCKED",
        },
      },
      { new: true }
    );

    if (claimedDoc) {
      acquiredLock = true;
    }
  }

  // Attempt 3: Polling for running holder to finish or release
  if (!acquiredLock) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      // Check if ParentAccess was created by current holder
      const createdRecord = await ParentAccessModel.findOne({
        centerId: cleanCenterId,
        $or: [
          { linkedStudentIds: studentObjectId },
          { parentPhone: { $in: phoneVariants } },
        ],
        status: "active",
      });

      if (createdRecord) {
        await ParentAccessModel.updateOne(
          { _id: createdRecord._id, centerId: cleanCenterId },
          { $addToSet: { linkedStudentIds: studentObjectId } }
        );
        return {
          parentAccess: createdRecord,
          rawToken: null,
          created: false,
        };
      }

      // Check if lock expired during polling
      const nowPolling = new Date();
      const newPollExpiresAt = new Date(nowPolling.getTime() + lockTtlMs);

      const claimedExpired = await ParentAccessLockModel.findOneAndUpdate(
        {
          lockKey,
          expiresAt: { $lte: nowPolling },
        },
        {
          $set: {
            holderId: lockToken,
            lockedAt: nowPolling,
            expiresAt: newPollExpiresAt,
            status: "LOCKED",
          },
        },
        { new: true }
      );

      if (claimedExpired) {
        acquiredLock = true;
        break;
      }

      // Check if lock was released/deleted without record creation
      const currentLock = await ParentAccessLockModel.findOne({ lockKey });
      if (!currentLock) {
        try {
          await ParentAccessLockModel.create({
            lockKey,
            centerId: cleanCenterId,
            studentId: String(studentObjectId),
            holderId: lockToken,
            status: "LOCKED",
            lockedAt: nowPolling,
            expiresAt: newPollExpiresAt,
          });
          acquiredLock = true;
          break;
        } catch (err: any) {
          if (err && err.code === 11000) {
            continue;
          }
          throw err;
        }
      }
    }
  }

  // Polling exhausted and lock not acquired
  if (!acquiredLock) {
    const finalCheck = await ParentAccessModel.findOne({
      centerId: cleanCenterId,
      linkedStudentIds: studentObjectId,
      status: "active",
    });

    if (finalCheck) {
      return {
        parentAccess: finalCheck,
        rawToken: null,
        created: false,
      };
    }

    throw new Error(
      "Failed to acquire ParentAccess distributed lock: request timed out waiting for concurrent process"
    );
  }

  // 5. Critical Section: Lock successfully acquired
  try {
    // Double-checked locking: check if active record was committed right before lock acquisition
    let doubleCheck = await ParentAccessModel.findOne({
      centerId: cleanCenterId,
      linkedStudentIds: studentObjectId,
      status: "active",
    });

    if (!doubleCheck) {
      doubleCheck = await ParentAccessModel.findOne({
        centerId: cleanCenterId,
        parentPhone: { $in: phoneVariants },
        status: "active",
      });
      if (doubleCheck) {
        await ParentAccessModel.updateOne(
          { _id: doubleCheck._id, centerId: cleanCenterId },
          { $addToSet: { linkedStudentIds: studentObjectId } }
        );
        if (doubleCheck.linkedStudentIds && typeof doubleCheck.linkedStudentIds.addToSet === "function") {
          doubleCheck.linkedStudentIds.addToSet(studentObjectId);
        } else if (!doubleCheck.linkedStudentIds.includes(studentObjectId)) {
          doubleCheck.linkedStudentIds.push(studentObjectId);
        }
      }
    }

    if (doubleCheck) {
      return {
        parentAccess: doubleCheck,
        rawToken: null,
        created: false,
      };
    }

    // Query any existing active students in this center with matching parent phone to bundle them together
    const siblingStudents = await StudentModel.find({
      centerId: cleanCenterId,
      parentWhatsApp: { $in: phoneVariants },
      isActive: { $ne: false },
    }).select("_id");

    const allLinkedStudentIds = Array.from(
      new Set([
        String(studentObjectId),
        ...siblingStudents.map((s: any) => String(s._id)),
      ])
    ).map((id) => new Types.ObjectId(id));

    // Generate fresh high-entropy token pair
    const { rawToken, tokenHash, tokenPrefix } = generatePortalToken();

    // Step B: Lock Ownership & Lease Renewal immediately before persistence.
    // Atomically verifies that this instance still owns the unexpired lock and extends the lease,
    // protecting against stale holders attempting to persist records after lease expiration.
    const renewedLock = await ParentAccessLockModel.findOneAndUpdate(
      {
        lockKey,
        holderId: lockToken,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          expiresAt: new Date(Date.now() + lockTtlMs),
        },
      },
      { new: true }
    );

    if (!renewedLock) {
      throw new Error(
        "ParentAccess distributed lock lease expired or ownership was lost prior to persistence"
      );
    }

    const newParentAccess = await ParentAccessModel.create({
      centerId: cleanCenterId,
      parentPhone: phone,
      parentName: (options.parentName || student.name || "").trim(),
      linkedStudentIds: allLinkedStudentIds,
      tokenHash,
      tokenPrefix,
      // Encrypted (AES-256-GCM) copy of the raw token, so the canonical
      // invitation link can be rebuilt later WITHOUT regenerating the token
      // (regeneration would invalidate the link already sent to the parent).
      invitationTokenCipher: encryptToken(rawToken),
      status: "active",
      isPasswordProtected: false,
      failedPasswordAttempts: 0,
    });

    // Mark lock completed
    await ParentAccessLockModel.updateOne(
      { lockKey, holderId: lockToken },
      { $set: { status: "COMPLETED" } }
    ).catch(() => {});

    return {
      parentAccess: newParentAccess,
      rawToken,
      created: true,
    };
  } finally {
    // Safe release: only delete if this process instance still holds the lock
    if (acquiredLock) {
      await ParentAccessLockModel.deleteOne({
        lockKey,
        holderId: lockToken,
      }).catch(() => {});
    }
  }
}


/**
 * Regenerates the portal access token for a ParentAccess record.
 * Invalidates the previous token by replacing tokenHash and tokenPrefix.
 * Returns the fresh rawToken ONCE.
 */
export async function regenerateParentAccess(
  centerId: string,
  parentAccessId: string | Types.ObjectId
): Promise<{
  parentAccess: IParentAccessDocument;
  rawToken: string;
}> {
  const cleanCenterId = String(centerId).trim();
  const accessObjectId =
    typeof parentAccessId === "string"
      ? new Types.ObjectId(parentAccessId)
      : parentAccessId;

  const parentAccess = await ParentAccess.findOne({
    _id: accessObjectId,
    centerId: cleanCenterId,
  });

  if (!parentAccess) {
    throw new Error("Parent access record not found");
  }

  const { rawToken, tokenHash, tokenPrefix } = generatePortalToken();

  parentAccess.tokenHash = tokenHash;
  parentAccess.tokenPrefix = tokenPrefix;
  parentAccess.invitationTokenCipher = encryptToken(rawToken);
  parentAccess.status = "active";
  parentAccess.revokedAt = null;
  parentAccess.revocationReason = "";
  parentAccess.failedPasswordAttempts = 0;
  parentAccess.lockoutUntil = null;
  await parentAccess.save();

  return {
    parentAccess,
    rawToken,
  };
}

/**
 * Revokes a ParentAccess record, rendering any issued portal links invalid.
 */
export async function revokeParentAccess(
  centerId: string,
  parentAccessId: string | Types.ObjectId,
  reason = "Revoked by institute owner"
): Promise<IParentAccessDocument> {
  const cleanCenterId = String(centerId).trim();
  const accessObjectId =
    typeof parentAccessId === "string"
      ? new Types.ObjectId(parentAccessId)
      : parentAccessId;

  const parentAccess = await ParentAccess.findOne({
    _id: accessObjectId,
    centerId: cleanCenterId,
  });

  if (!parentAccess) {
    throw new Error("Parent access record not found");
  }

  parentAccess.status = "revoked";
  parentAccess.revokedAt = new Date();
  parentAccess.revocationReason = reason.trim();
  // Drop the recoverable credential so a revoked link can never be rebuilt.
  parentAccess.invitationTokenCipher = null;
  await parentAccess.save();

  return parentAccess;
}

/**
 * Explicitly links an additional student to an existing ParentAccess record.
 * Owner must explicitly trigger this; automatic merges are forbidden.
 */
export async function linkStudentToParentAccess(
  centerId: string,
  parentAccessId: string | Types.ObjectId,
  studentIdToLink: string | Types.ObjectId
): Promise<IParentAccessDocument> {
  const cleanCenterId = String(centerId).trim();
  const accessObjectId =
    typeof parentAccessId === "string"
      ? new Types.ObjectId(parentAccessId)
      : parentAccessId;
  const linkObjectId =
    typeof studentIdToLink === "string"
      ? new Types.ObjectId(studentIdToLink)
      : studentIdToLink;

  // 1. Verify student exists in this center
  const student = await Student.findOne({
    _id: linkObjectId,
    centerId: cleanCenterId,
  });

  if (!student) {
    throw new Error("Target student does not belong to this tuition center");
  }

  // 2. Fetch ParentAccess
  const parentAccess = await ParentAccess.findOne({
    _id: accessObjectId,
    centerId: cleanCenterId,
  });

  if (!parentAccess) {
    throw new Error("Parent access record not found");
  }

  if (parentAccess.status === "revoked") {
    throw new Error("Cannot link students to a revoked portal link");
  }

  // 3. Append if not already linked
  const alreadyLinked = parentAccess.linkedStudentIds.some(
    (id) => String(id) === String(linkObjectId)
  );

  if (!alreadyLinked) {
    parentAccess.linkedStudentIds.push(linkObjectId);
    await parentAccess.save();
  }

  return parentAccess;
}

/**
 * Unlinks a student from an existing ParentAccess record.
 * Fails if trying to unlink the only remaining student.
 */
export async function unlinkStudentFromParentAccess(
  centerId: string,
  parentAccessId: string | Types.ObjectId,
  studentIdToUnlink: string | Types.ObjectId
): Promise<IParentAccessDocument> {
  const cleanCenterId = String(centerId).trim();
  const accessObjectId =
    typeof parentAccessId === "string"
      ? new Types.ObjectId(parentAccessId)
      : parentAccessId;
  const unlinkObjectId =
    typeof studentIdToUnlink === "string"
      ? new Types.ObjectId(studentIdToUnlink)
      : studentIdToUnlink;

  const parentAccess = await ParentAccess.findOne({
    _id: accessObjectId,
    centerId: cleanCenterId,
  });

  if (!parentAccess) {
    throw new Error("Parent access record not found");
  }

  if (parentAccess.linkedStudentIds.length <= 1) {
    throw new Error(
      "Cannot unlink the only remaining student. Revoke the portal access instead."
    );
  }

  parentAccess.linkedStudentIds = parentAccess.linkedStudentIds.filter(
    (id) => String(id) !== String(unlinkObjectId)
  );

  await parentAccess.save();
  return parentAccess;
}

export interface ResolveTokenResult {
  valid: boolean;
  parentAccess?: IParentAccessDocument;
  reason?: "invalid" | "revoked" | "locked";
  locked?: boolean;
  lockoutUntil?: Date;
  requirePassword?: boolean;
}

/**
 * Validates a raw portal token by matching its SHA-256 hash against MongoDB.
 * Checks revocation status, rate-limited lockout, and password requirement.
 */
export async function resolvePortalToken(
  rawToken: string
): Promise<ResolveTokenResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { valid: false, reason: "invalid" };
  }

  const tokenHash = hashPortalToken(rawToken);

  const parentAccess = await ParentAccess.findOne({ tokenHash });

  if (!parentAccess) {
    return { valid: false, reason: "invalid" };
  }

  if (parentAccess.status === "revoked") {
    return { valid: false, reason: "revoked" };
  }

  // Check lockout
  if (parentAccess.lockoutUntil && parentAccess.lockoutUntil > new Date()) {
    return {
      valid: false,
      reason: "locked",
      locked: true,
      lockoutUntil: parentAccess.lockoutUntil,
    };
  }

  return {
    valid: true,
    parentAccess,
    requirePassword: parentAccess.isPasswordProtected,
  };
}

/**
 * Recovers the raw portal token from the AES-256-GCM encrypted copy stored on
 * a ParentAccess record.
 *
 * Fails closed: returns null when the record is not active, when the cipher is
 * missing/corrupt, or when the decrypted value no longer matches the stored
 * tokenHash (e.g. a stale cipher left after a rotation).
 */
export function getRecoverableInvitationToken(
  parentAccess: IParentAccessDocument | Record<string, any> | null | undefined
): string | null {
  if (!parentAccess) return null;
  if (parentAccess.status && parentAccess.status !== "active") return null;

  const cipher = parentAccess.invitationTokenCipher as
    | EncryptedPayload
    | null
    | undefined;
  if (!cipher) return null;

  const rawToken = decryptToken(cipher);
  if (!rawToken || !rawToken.startsWith("pt_")) return null;
  if (hashPortalToken(rawToken) !== parentAccess.tokenHash) return null;

  return rawToken;
}

/**
 * Builds the canonical, activation-capable Parent Portal URL for a student by
 * decrypting the token already issued to that student's ParentAccess record.
 *
 * CRITICAL: this never regenerates or rotates the token, so links already
 * delivered to the parent keep working.
 *
 * @param options.fallbackToPortalEntry  When true (message dispatch) the plain
 *   `/portal` entry URL is returned if no recoverable token exists. When false
 *   (owner UI) null is returned so the caller can prompt for an explicit link
 *   generation instead of showing a link that cannot authenticate.
 */
export async function resolvePortalInvitationUrl(
  centerId: string,
  studentId: string | Types.ObjectId,
  options: { baseUrl?: string; fallbackToPortalEntry?: boolean } = {}
): Promise<string | null> {
  const fallback = options.fallbackToPortalEntry
    ? buildPortalActivationUrl(null, options.baseUrl)
    : null;

  const cleanCenterId = String(centerId || "").trim();
  const studentIdStr =
    typeof studentId === "string" ? studentId.trim() : String(studentId || "");

  if (!cleanCenterId || !Types.ObjectId.isValid(studentIdStr)) {
    return fallback;
  }

  const parentAccess = await ParentAccess.findOne({
    centerId: cleanCenterId,
    linkedStudentIds: new Types.ObjectId(studentIdStr),
    status: "active",
  });

  const rawToken = getRecoverableInvitationToken(parentAccess);
  if (!rawToken) return fallback;

  return buildPortalActivationUrl(rawToken, options.baseUrl);
}

export interface VerifyPasswordResult {
  valid: boolean;
  locked?: boolean;
  lockoutUntil?: Date;
  remainingAttempts?: number;
}

/**
 * Validates an optional parent-selected password against bcrypt hash.
 * Enforces rate limiting: 5 failed attempts = 15 minute lockout.
 */
export async function verifyParentPassword(
  parentAccess: IParentAccessDocument,
  passwordAttempt: string
): Promise<VerifyPasswordResult> {
  if (!parentAccess.isPasswordProtected) {
    return { valid: true };
  }

  const now = new Date();
  if (parentAccess.lockoutUntil && parentAccess.lockoutUntil > now) {
    return {
      valid: false,
      locked: true,
      lockoutUntil: parentAccess.lockoutUntil,
      remainingAttempts: 0,
    };
  }

  const isMatch = await bcrypt.compare(
    passwordAttempt || "",
    parentAccess.passwordHash || ""
  );

  if (isMatch) {
    parentAccess.failedPasswordAttempts = 0;
    parentAccess.lockoutUntil = null;
    await parentAccess.save();
    return { valid: true };
  }

  // Handle failure
  const attempts = (parentAccess.failedPasswordAttempts || 0) + 1;
  parentAccess.failedPasswordAttempts = attempts;

  if (attempts >= 5) {
    const lockDurationMs = 15 * 60 * 1000; // 15 minutes
    const lockoutUntil = new Date(now.getTime() + lockDurationMs);
    parentAccess.lockoutUntil = lockoutUntil;
    await parentAccess.save();
    return {
      valid: false,
      locked: true,
      lockoutUntil,
      remainingAttempts: 0,
    };
  }

  await parentAccess.save();
  return {
    valid: false,
    locked: false,
    remainingAttempts: Math.max(0, 5 - attempts),
  };
}

/**
 * Sets or updates the optional parent password.
 */
export async function setParentPassword(
  parentAccess: IParentAccessDocument,
  newPassword: string
): Promise<IParentAccessDocument> {
  const trimmed = String(newPassword || "").trim();
  if (trimmed.length < 4 || trimmed.length > 32) {
    throw new Error("Password/PIN must be between 4 and 32 characters");
  }

  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(trimmed, saltRounds);

  parentAccess.isPasswordProtected = true;
  parentAccess.passwordHash = passwordHash;
  parentAccess.failedPasswordAttempts = 0;
  parentAccess.lockoutUntil = null;
  await parentAccess.save();

  return parentAccess;
}

/**
 * Removes the optional password protection after verifying current password.
 */
export async function removeParentPassword(
  parentAccess: IParentAccessDocument,
  currentPassword: string
): Promise<IParentAccessDocument> {
  const verification = await verifyParentPassword(parentAccess, currentPassword);
  if (!verification.valid) {
    throw new Error("Current password is incorrect");
  }

  parentAccess.isPasswordProtected = false;
  parentAccess.passwordHash = undefined;
  parentAccess.failedPasswordAttempts = 0;
  parentAccess.lockoutUntil = null;
  await parentAccess.save();

  return parentAccess;
}

export interface ParentSessionValidationResult {
  valid: boolean;
  parentAccess?: IParentAccessDocument;
  payload?: any;
  error?: string;
  statusCode: number;
}

/**
 * Centralized parent portal session validator.
 * Validates:
 * 1. Session token is present and valid JWT.
 * 2. ParentAccess record still exists.
 * 3. ParentAccess record is active (immediate revocation enforcement).
 * 4. Center matches JWT centerId.
 * 5. Credential version (tokenPrefix) matches current ParentAccess version (immediate regeneration invalidation).
 */
export async function validateParentSession(
  sessionToken: string | undefined | null
): Promise<ParentSessionValidationResult> {
  if (!sessionToken || typeof sessionToken !== "string" || !sessionToken.trim()) {
    return {
      valid: false,
      error: "Authentication required: No parent session provided",
      statusCode: 401,
    };
  }

  const payload = await verifyToken(sessionToken.trim());
  if (!payload || payload.role !== "parent" || !payload.parentAccessId) {
    return {
      valid: false,
      error: "Invalid or expired parent portal session",
      statusCode: 401,
    };
  }

  const parentAccess = await ParentAccess.findOne({ _id: payload.parentAccessId });
  if (!parentAccess) {
    return {
      valid: false,
      error: "Parent access record no longer exists",
      statusCode: 404,
    };
  }

  // 1. Immediate revocation enforcement
  if (parentAccess.status !== "active") {
    return {
      valid: false,
      error: "Portal access link has been revoked by the tuition center",
      statusCode: 403,
    };
  }

  // 2. Center tenant isolation
  if (payload.centerId && parentAccess.centerId !== payload.centerId) {
    return {
      valid: false,
      error: "Tuition center mismatch",
      statusCode: 403,
    };
  }

  // 3. Immediate token regeneration invalidation: credential version (tokenPrefix) check
  const sessionTokenPrefix = (payload as any).tokenPrefix;
  if (!sessionTokenPrefix || sessionTokenPrefix !== parentAccess.tokenPrefix) {
    return {
      valid: false,
      error: "Portal access session invalidated: A new access link was generated",
      statusCode: 401,
    };
  }

  return {
    valid: true,
    parentAccess,
    payload,
    statusCode: 200,
  };
}
