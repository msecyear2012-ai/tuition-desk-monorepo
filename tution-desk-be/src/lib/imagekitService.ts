import crypto from "node:crypto";

/**
 * ImageKit Server-Side Integration & File Validation Service
 *
 * Provides secure server-side uploading, magic-byte inspection, file size validation,
 * and orphan cleanup for payment proof screenshots.
 *
 * SECURITY INVARIANTS:
 * - IMAGEKIT_PRIVATE_KEY is NEVER exposed to the client, frontend code, or API responses.
 * - Files are uploaded exclusively through the backend API.
 * - Files must pass both size (<= 3MB) and magic-byte signature validation (JPEG, PNG, WebP).
 * - If subsequent database persistence fails, deleteFromImageKit() immediately cleans up the orphan.
 */

export type PaymentProofMimeType = "image/jpeg" | "image/png" | "image/webp";

export const MAX_UPLOAD_FILE_BYTES = 3 * 1024 * 1024; // 3 MB strictly enforced

export const SUPPORTED_MIME_TYPES: PaymentProofMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export interface ImageKitConfig {
  publicKey: string;
  privateKey: string;
  urlEndpoint: string;
}

export interface ImageKitUploadResult {
  fileId: string;
  fileUrl: string;
  thumbnailUrl: string;
  filePath: string;
  size: number;
  name: string;
}

export interface FileValidationResult {
  valid: boolean;
  mimeType?: PaymentProofMimeType;
  fileSizeBytes: number;
  error?: string;
}

/**
 * Validates actual binary file content using Magic Byte signatures.
 * Rejects disguised executables, scripts, SVGs, and PDFs even if the client
 * sent a spoofed image/jpeg Content-Type header.
 */
export function validateImageFile(
  buffer: Buffer,
  declaredMime?: string
): FileValidationResult {
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      fileSizeBytes: 0,
      error: "File is empty or missing content",
    };
  }

  const fileSizeBytes = buffer.length;

  if (fileSizeBytes > MAX_UPLOAD_FILE_BYTES) {
    return {
      valid: false,
      fileSizeBytes,
      error: `File size (${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB) exceeds the maximum allowed limit of 3 MB`,
    };
  }

  // 1. JPEG signature: starts with 0xFF 0xD8 0xFF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      valid: true,
      mimeType: "image/jpeg",
      fileSizeBytes,
    };
  }

  // 2. PNG signature: starts with 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      valid: true,
      mimeType: "image/png",
      fileSizeBytes,
    };
  }

  // 3. WebP signature: starts with "RIFF" (0-3) and "WEBP" (8-11)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  ) {
    return {
      valid: true,
      mimeType: "image/webp",
      fileSizeBytes,
    };
  }

  return {
    valid: false,
    fileSizeBytes,
    error:
      "Invalid file format: Only genuine JPEG, PNG, and WebP images are accepted. Executables, scripts, PDFs, and SVGs are strictly forbidden.",
  };
}

/**
 * Safely resolves and validates ImageKit server-side credentials from environment variables.
 * Fails closed without exposing secret values.
 */
export function getImageKitConfig(): ImageKitConfig {
  const publicKey = process.env.IMAGEKIT_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY?.trim() || "";
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT?.trim() || "";

  if (!privateKey) {
    throw new Error(
      "ImageKit configuration error: IMAGEKIT_PRIVATE_KEY is missing or empty."
    );
  }

  return {
    publicKey,
    privateKey,
    urlEndpoint: urlEndpoint.replace(/\/+$/, ""),
  };
}

/**
 * Optional mock uploader hook for testing environments without active ImageKit accounts.
 */
let mockImageKitHandler:
  | ((options: {
      fileBuffer: Buffer;
      fileName: string;
      folder: string;
      tags?: string[];
    }) => Promise<ImageKitUploadResult>)
  | null = null;

let mockImageKitDeleteHandler: ((fileId: string) => Promise<boolean>) | null =
  null;

export function setMockImageKitHandler(
  uploader: typeof mockImageKitHandler,
  deleter: typeof mockImageKitDeleteHandler = null
): void {
  mockImageKitHandler = uploader;
  mockImageKitDeleteHandler = deleter;
}

/**
 * Uploads a validated payment proof buffer to ImageKit using server-side Basic Auth.
 * Never exposes the private key in requests or logs.
 */
export async function uploadProofToImageKit(options: {
  fileBuffer: Buffer;
  fileName: string;
  folder: string;
  tags?: string[];
}): Promise<ImageKitUploadResult> {
  // If mock handler is active (e.g. in automated regression tests)
  if (mockImageKitHandler) {
    return await mockImageKitHandler(options);
  }

  const { privateKey } = getImageKitConfig();

  const authHeader = `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`;

  const formData = new FormData();
  const fileBlob = new Blob([new Uint8Array(options.fileBuffer)]);
  formData.append("file", fileBlob, options.fileName);
  formData.append("fileName", options.fileName);
  formData.append("folder", options.folder);
  formData.append("useUniqueFileName", "true");
  formData.append("isPrivateFile", "true");

  if (options.tags && options.tags.length > 0) {
    formData.append("tags", options.tags.join(","));
  }

  const uploadEndpoint = "https://upload.imagekit.io/api/v1/files/upload";

  let response: Response;
  try {
    response = await fetch(uploadEndpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
      },
      body: formData,
      signal: AbortSignal.timeout(15000), // 15-second timeout
    });
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Network error during upload";
    throw new Error(`Failed to connect to ImageKit upload service: ${errorMsg}`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.message || data?.help || `HTTP ${response.status}`;
    throw new Error(`ImageKit upload rejected: ${detail}`);
  }

  if (!data.fileId || !data.url) {
    throw new Error("ImageKit upload response missing required fileId or url");
  }

  return {
    fileId: String(data.fileId),
    fileUrl: String(data.url),
    thumbnailUrl: String(data.thumbnailUrl || data.url),
    filePath: String(data.filePath || ""),
    size: Number(data.size || options.fileBuffer.length),
    name: String(data.name || options.fileName),
  };
}

/**
 * Deletes a file from ImageKit by fileId.
 * Used for safe cleanup / reconciliation when database persistence fails after upload,
 * preventing orphaned files in ImageKit.
 */
export async function deleteFromImageKit(fileId: string): Promise<boolean> {
  if (!fileId || typeof fileId !== "string" || !fileId.trim()) {
    return false;
  }

  if (mockImageKitDeleteHandler) {
    return await mockImageKitDeleteHandler(fileId);
  }

  try {
    const { privateKey } = getImageKitConfig();
    const authHeader = `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`;
    const deleteEndpoint = `https://api.imagekit.io/v1/files/${encodeURIComponent(fileId.trim())}`;

    const response = await fetch(deleteEndpoint, {
      method: "DELETE",
      headers: {
        Authorization: authHeader,
      },
      signal: AbortSignal.timeout(10000),
    });

    return response.status === 204 || response.status === 200;
  } catch (err: unknown) {
    console.warn(
      `[ImageKit] Orphan cleanup notice: failed to delete file ${fileId}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Generates an expiring HMAC-SHA1 signed URL for an ImageKit asset.
 * Enforces restricted delivery so raw assets cannot be viewed without a valid signature.
 *
 * Formula based on ImageKit security specification:
 * - ik-t: Unix timestamp in seconds when the URL expires.
 * - canonicalString: URL path (including endpoint path if any) + existing query params + ik-t parameter.
 * - ik-s: HMAC-SHA1(privateKey, canonicalString) hex encoded (lowercase).
 */
/**
 * Helper to extract relative asset path from an ImageKit URL (excluding endpoint ID).
 */
export function extractRelativeImagePath(parsedUrl: URL, urlEndpoint?: string): string {
  let relativePath = parsedUrl.pathname;
  if (urlEndpoint) {
    try {
      const endpointPath = new URL(urlEndpoint).pathname.replace(/\/+$/, "");
      if (endpointPath && relativePath.startsWith(endpointPath)) {
        return relativePath.slice(endpointPath.length).replace(/^\/+/, "");
      }
    } catch {
      // Fallback
    }
  }
  // For standard ImageKit hosts (e.g. ik.imagekit.io/<id>/...), first segment is endpoint ID
  if (parsedUrl.hostname.endsWith("imagekit.io")) {
    const segments = relativePath.replace(/^\/+/, "").split("/");
    if (segments.length > 1) {
      return segments.slice(1).join("/");
    }
  }
  return relativePath.replace(/^\/+/, "");
}

/**
 * Generates an expiring HMAC-SHA1 signed URL for an ImageKit asset.
 * Enforces restricted delivery so raw assets cannot be viewed without a valid signature.
 *
 * Formula based on ImageKit security specification:
 * - ik-t: Unix timestamp in seconds when the URL expires.
 * - canonicalString: relativePathWithoutEndpointId + ik-t parameter.
 * - ik-s: HMAC-SHA1(privateKey, canonicalString) hex encoded (lowercase).
 */
export function generateSignedImageUrl(
  rawUrl: string,
  expireSeconds: number = 3600,
  customPrivateKey?: string
): { signedUrl: string; expiresAt: number; signature: string } {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Invalid rawUrl provided for URL signing");
  }

  let privateKey = customPrivateKey;
  let urlEndpoint = "";
  try {
    const config = getImageKitConfig();
    if (!privateKey) privateKey = config.privateKey;
    urlEndpoint = config.urlEndpoint;
  } catch {
    if (!privateKey) {
      privateKey = process.env.IMAGEKIT_PRIVATE_KEY?.trim() || "test_fallback_signing_key";
    }
    urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT?.trim() || "";
  }

  const parsed = new URL(rawUrl);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + expireSeconds;

  // Extract relative path without endpoint ID and without leading slash
  const relativePath = extractRelativeImagePath(parsed, urlEndpoint);

  // ImageKit canonical string for signed URLs: relative path + expiry timestamp
  const stringToSign = `${relativePath}${expiresAt}`;

  const signature = crypto
    .createHmac("sha1", privateKey)
    .update(stringToSign)
    .digest("hex");

  const searchParams = new URLSearchParams(parsed.search);
  searchParams.set("ik-t", String(expiresAt));
  searchParams.set("ik-s", signature);

  const signedUrl = `${parsed.origin}${parsed.pathname}?${searchParams.toString()}`;

  return {
    signedUrl,
    expiresAt,
    signature,
  };
}

/**
 * Verifies an ImageKit signed URL for authenticity and expiration.
 */
export function verifySignedUrl(
  signedUrlString: string,
  customPrivateKey?: string
): { valid: boolean; reason?: string; expiresAt?: Date | null } {
  try {
    const parsed = new URL(signedUrlString);
    const ikSignature = parsed.searchParams.get("ik-s");
    const ikTime = parsed.searchParams.get("ik-t");

    if (!ikSignature) {
      return { valid: false, reason: "MISSING_SIGNATURE" };
    }

    let expiryTimestamp: number | null = null;
    if (ikTime) {
      expiryTimestamp = Number(ikTime);
      const currentTimestamp = Math.floor(Date.now() / 1000);
      if (isNaN(expiryTimestamp) || expiryTimestamp < currentTimestamp) {
        return {
          valid: false,
          reason: "EXPIRED",
          expiresAt: !isNaN(expiryTimestamp) ? new Date(expiryTimestamp * 1000) : null,
        };
      }
    }

    let privateKey = customPrivateKey;
    let urlEndpoint = "";
    try {
      const config = getImageKitConfig();
      if (!privateKey) privateKey = config.privateKey;
      urlEndpoint = config.urlEndpoint;
    } catch {
      if (!privateKey) {
        privateKey = process.env.IMAGEKIT_PRIVATE_KEY?.trim() || "test_fallback_signing_key";
      }
      urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT?.trim() || "";
    }

    const relativePath = extractRelativeImagePath(parsed, urlEndpoint);
    const stringToSign = `${relativePath}${ikTime || ""}`;

    const expectedSignature = crypto
      .createHmac("sha1", privateKey)
      .update(stringToSign)
      .digest("hex");

    const sigBuf = Buffer.from(ikSignature.toLowerCase(), "hex");
    const expBuf = Buffer.from(expectedSignature.toLowerCase(), "hex");

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: "INVALID_SIGNATURE" };
    }

    return {
      valid: true,
      expiresAt: expiryTimestamp ? new Date(expiryTimestamp * 1000) : null,
    };
  } catch {
    return { valid: false, reason: "MALFORMED_URL" };
  }
}
