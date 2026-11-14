import crypto from "crypto";

/**
 * Derives a 32-byte encryption key from the environment secret.
 * Key management is strictly kept outside MongoDB.
 */
function getEncryptionKey(): Buffer {
  const secret =
    process.env.TOKEN_ENCRYPTION_SECRET ||
    process.env.JWT_SECRET ||
    "msec-tuition-desk-parent-portal-key-32-chars-ok";
  return crypto.createHash("sha256").update(secret.trim()).digest();
}

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * Encrypts a high-entropy raw token using AES-256-GCM.
 * Never stores raw tokens in plaintext in MongoDB.
 */
export function encryptToken(rawToken: string): EncryptedPayload {
  if (!rawToken || typeof rawToken !== "string") {
    throw new Error("Cannot encrypt empty or invalid token");
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let ciphertext = cipher.update(rawToken, "utf8", "base64");
  ciphertext += cipher.final("base64");
  const authTag = cipher.getAuthTag().toString("base64");

  return {
    iv: iv.toString("base64"),
    authTag,
    ciphertext,
  };
}

/**
 * Decrypts an AES-256-GCM encrypted token payload.
 * Returns the raw token string in memory, or null if decryption fails.
 */
export function decryptToken(payload: EncryptedPayload | null | undefined): string | null {
  if (!payload || !payload.iv || !payload.authTag || !payload.ciphertext) {
    return null;
  }

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(payload.iv, "base64");
    const authTag = Buffer.from(payload.authTag, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(payload.ciphertext, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("[TOKEN CIPHER] Decryption failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
