import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getJwtSecretKey } from "./jwt.ts";
import { generateErrorCsv } from "./csvParser.ts";

export interface NormalizedStudentRow {
  row: number;
  name: string;
  batch: string;
  parentWhatsApp: string;
  monthlyFee: number;
  billingCycleDate: number;
  rollNumber?: string;
  joiningDate?: string;
}

export interface RowValidationError {
  row: number;
  name: string;
  reason: string;
}

export interface PreviewTokenPayload extends JWTPayload {
  previewId: string;
  centerId: string;
  userId?: string;
  role: "owner" | "teacher";
  teacherId?: string | null;
  validCount: number;
  rowsHash: string;
  batchId?: string;
  batchName?: string;
}

export interface CategorizedRowsResult {
  validRows: NormalizedStudentRow[];
  duplicateRows: RowValidationError[];
  errorRows: RowValidationError[];
  allErrors: RowValidationError[];
  errorCsv: string;
}

/**
 * Creates a deterministic, canonical representation of a student row for cryptographic hashing.
 */
export function canonicalizeRow(row: NormalizedStudentRow): Record<string, unknown> {
  return {
    name: row.name.trim(),
    batch: row.batch.trim(),
    parentWhatsApp: row.parentWhatsApp.trim(),
    monthlyFee: Number(row.monthlyFee),
    billingCycleDate: Number(row.billingCycleDate),
    rollNumber: row.rollNumber ? row.rollNumber.trim() : "",
    joiningDate: row.joiningDate ? row.joiningDate.trim() : "",
  };
}

/**
 * Computes a SHA-256 hash of the canonicalized valid rows to ensure preview-to-confirmation integrity.
 */
export function computeRowsHash(rows: NormalizedStudentRow[]): string {
  const canonical = rows.map(canonicalizeRow);
  const jsonStr = JSON.stringify(canonical);
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
}

/**
 * Signs a short-lived (30 minutes) preview token capturing the import state, tenant, and rows hash.
 */
export async function signPreviewToken(
  payload: Omit<PreviewTokenPayload, keyof JWTPayload>
): Promise<string> {
  const secretKey = getJwtSecretKey();
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(secretKey);
}

/**
 * Verifies and decodes the preview token. Fails closed and returns null if invalid or expired.
 */
export async function verifyPreviewToken(
  token: string
): Promise<PreviewTokenPayload | null> {
  const secretKey = getJwtSecretKey();
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (!payload?.previewId || !payload?.centerId || !payload?.rowsHash) {
      return null;
    }
    return payload as unknown as PreviewTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Validates raw parsed student rows, checks for intra-file and database duplicates,
 * validates against active institute batches, and categorizes rows.
 */
export function validateAndCategorizeRows(params: {
  parsedRows: Array<{
    rowNumber: number;
    normalized: {
      name: string;
      batch: string;
      parentWhatsApp: string;
      monthlyFee?: number;
      billingCycleDate?: number;
      rollNumber?: string;
      joiningDate?: string;
    };
  }>;
  activeBatchNames: Set<string>; // Lowercase set of active batch names
  existingStudentsMap: Set<string>; // Set of "cleanPhone:::lowercaseName" already in institute
  selectedBatch?: string; // Optional target batch selected by Owner/Teacher in UI
}): CategorizedRowsResult {
  const { parsedRows, activeBatchNames, existingStudentsMap, selectedBatch } = params;

  const validRows: NormalizedStudentRow[] = [];
  const duplicateRows: RowValidationError[] = [];
  const errorRows: RowValidationError[] = [];
  const seenFileKeys = new Set<string>();

  for (const item of parsedRows) {
    const rowNum = item.rowNumber;
    const {
      name,
      batch,
      parentWhatsApp,
      monthlyFee,
      billingCycleDate,
      rollNumber,
      joiningDate,
    } = item.normalized;

    const trimmedName = (name || "").trim();
    const effectiveBatch = selectedBatch && selectedBatch.trim()
      ? selectedBatch.trim()
      : (batch || "").trim();

    // 1. Mandatory Name Validation
    if (!trimmedName) {
      errorRows.push({
        row: rowNum,
        name: trimmedName,
        reason: "Student name is required and cannot be empty",
      });
      continue;
    }

    // 2. Mandatory Batch Validation & Institute Existence Check
    if (!effectiveBatch) {
      errorRows.push({
        row: rowNum,
        name: trimmedName,
        reason: "Batch name is required and cannot be empty",
      });
      continue;
    }

    if (!activeBatchNames.has(effectiveBatch.toLowerCase())) {
      errorRows.push({
        row: rowNum,
        name: trimmedName,
        reason: `Batch '${effectiveBatch}' does not exist in this institute`,
      });
      continue;
    }

    // 3. Parent WhatsApp Phone Validation
    const rawPhone = parentWhatsApp || "";
    const cleanPhone = String(rawPhone).replace(/\D/g, "");

    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      errorRows.push({
        row: rowNum,
        name: trimmedName,
        reason: `Invalid parent WhatsApp number: '${rawPhone}' (must be 10-15 digits)`,
      });
      continue;
    }

    // 4. Monthly Fee Validation
    let finalFee = 0;
    if (monthlyFee !== undefined && monthlyFee !== null) {
      if (typeof monthlyFee !== "number" || isNaN(monthlyFee) || monthlyFee < 0) {
        errorRows.push({
          row: rowNum,
          name: trimmedName,
          reason: "Monthly fee must be a non-negative number",
        });
        continue;
      }
      finalFee = monthlyFee;
    }

    // 5. Billing Cycle Date Validation
    let finalCycle = 5;
    if (billingCycleDate !== undefined && billingCycleDate !== null) {
      if (
        typeof billingCycleDate !== "number" ||
        isNaN(billingCycleDate) ||
        billingCycleDate < 1 ||
        billingCycleDate > 31
      ) {
        errorRows.push({
          row: rowNum,
          name: trimmedName,
          reason: "Billing cycle date must be an integer between 1 and 31",
        });
        continue;
      }
      finalCycle = Math.floor(billingCycleDate);
    }

    // 6. Optional Joining Date Validation
    let finalJoiningDate: string | undefined;
    if (joiningDate && joiningDate.trim()) {
      const parsedDate = new Date(joiningDate.trim());
      if (isNaN(parsedDate.getTime())) {
        errorRows.push({
          row: rowNum,
          name: trimmedName,
          reason: `Invalid joining date format: '${joiningDate}'`,
        });
        continue;
      }
      finalJoiningDate = parsedDate.toISOString();
    }

    // 7. Duplicate Detection
    const collisionKey = `${cleanPhone}:::${trimmedName.toLowerCase()}`;

    // A. Intra-file duplicate check
    if (seenFileKeys.has(collisionKey)) {
      duplicateRows.push({
        row: rowNum,
        name: trimmedName,
        reason: "Duplicate: Duplicate entry within the uploaded file",
      });
      continue;
    }
    seenFileKeys.add(collisionKey);

    // B. Database collision check
    if (existingStudentsMap.has(collisionKey)) {
      duplicateRows.push({
        row: rowNum,
        name: trimmedName,
        reason: "Duplicate: Student already enrolled in this institute",
      });
      continue;
    }

    // Row passed all checks
    validRows.push({
      row: rowNum,
      name: trimmedName,
      batch: effectiveBatch,
      parentWhatsApp: cleanPhone,
      monthlyFee: finalFee,
      billingCycleDate: finalCycle,
      rollNumber: rollNumber ? rollNumber.trim() : undefined,
      joiningDate: finalJoiningDate,
    });
  }

  // Combined errors sorted by row number
  const allErrors = [...errorRows, ...duplicateRows].sort((a, b) => a.row - b.row);
  const errorCsv = generateErrorCsv(allErrors);

  return {
    validRows,
    duplicateRows,
    errorRows,
    allErrors,
    errorCsv,
  };
}

export interface BoundedReadResult {
  exceeded: boolean;
  data: Buffer;
  bytesRead: number;
}

/**
 * Reads a NextRequest body using a bounded streaming reader.
 * Stops reading immediately once maxBytes is exceeded and cancels the stream to prevent memory exhaustion.
 */
export async function readBoundedRequestBody(
  request: NextRequest,
  maxBytes: number
): Promise<BoundedReadResult> {
  const stream = request.body;
  if (!stream) {
    // If request.body stream is unavailable (e.g. test environment or already consumed),
    // check text() with strict byte size guard if method exists
    if (typeof (request as any).text === "function") {
      const rawText = await (request as any).text();
      const byteLen = Buffer.byteLength(rawText, "utf8");
      if (byteLen > maxBytes) {
        return { exceeded: true, data: Buffer.alloc(0), bytesRead: byteLen };
      }
      return {
        exceeded: false,
        data: Buffer.from(rawText, "utf8"),
        bytesRead: byteLen,
      };
    }
    return { exceeded: false, data: Buffer.alloc(0), bytesRead: 0 };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          // Immediately cancel the reader to stop socket read
          try {
            await reader.cancel("Payload exceeded maximum allowed size");
          } catch {
            // Ignore cancel errors
          }
          return { exceeded: true, data: Buffer.alloc(0), bytesRead: totalBytes };
        }
        chunks.push(value);
      }
    }
  } catch (err: unknown) {
    if (totalBytes > maxBytes) {
      return { exceeded: true, data: Buffer.alloc(0), bytesRead: totalBytes };
    }
    throw err;
  }

  return {
    exceeded: false,
    data: Buffer.concat(chunks),
    bytesRead: totalBytes,
  };
}

import { isXlsxBuffer } from "./xlsxParser.ts";

export interface MultipartFileResult {
  fileBuffer: Buffer;
  fileName?: string;
  isXlsx: boolean;
  text?: string;
  selectedBatch?: string;
}

/**
 * Extracts binary or text file payload from an RFC-2046 multipart buffer safely.
 */
export function extractMultipartFilePayload(
  buffer: Buffer,
  contentType: string
): MultipartFileResult | null {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = (boundaryMatch[1] || boundaryMatch[2] || "").trim();
  if (!boundary) return null;

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let startIndex = buffer.indexOf(boundaryBuffer);
  let fileBuffer: Buffer | null = null;
  let fileName = "";
  let selectedBatch = "";

  while (startIndex !== -1) {
    const nextIndex = buffer.indexOf(
      boundaryBuffer,
      startIndex + boundaryBuffer.length
    );
    if (nextIndex === -1) break;

    const part = buffer.subarray(startIndex + boundaryBuffer.length, nextIndex);
    let headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    let bodyOffset = 4;
    if (headerEnd === -1) {
      headerEnd = part.indexOf(Buffer.from("\n\n"));
      bodyOffset = 2;
    }

    if (headerEnd !== -1) {
      const headerStr = part.subarray(0, headerEnd).toString("utf8");
      let bodySlice = part.subarray(headerEnd + bodyOffset);
      if (
        bodySlice.length >= 2 &&
        bodySlice[bodySlice.length - 2] === 0x0d &&
        bodySlice[bodySlice.length - 1] === 0x0a
      ) {
        bodySlice = bodySlice.subarray(0, bodySlice.length - 2);
      } else if (
        bodySlice.length >= 1 &&
        bodySlice[bodySlice.length - 1] === 0x0a
      ) {
        bodySlice = bodySlice.subarray(0, bodySlice.length - 1);
      }

      const isFileField =
        headerStr.includes('name="file"') ||
        headerStr.includes("filename=") ||
        headerStr.includes('name="csv"');

      if (isFileField && !fileBuffer) {
        const fnMatch = /filename="?([^";\r\n]+)"?/i.exec(headerStr);
        if (fnMatch) fileName = fnMatch[1];
        fileBuffer = bodySlice;
      } else if (headerStr.includes('name="selectedBatch"')) {
        selectedBatch = bodySlice.toString("utf8").trim();
      }
    }

    startIndex = nextIndex;
  }

  if (!fileBuffer) return null;

  const isXlsx = isXlsxBuffer(fileBuffer);
  return {
    fileBuffer,
    fileName,
    isXlsx,
    text: !isXlsx ? fileBuffer.toString("utf8") : undefined,
    selectedBatch: selectedBatch || undefined,
  };
}

/**
 * Extracts CSV text from an RFC-2046 compliant multipart/form-data buffer without loading external parsers.
 */
export function extractCsvFromMultipartBuffer(
  buffer: Buffer,
  contentType: string
): string | null {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = (boundaryMatch[1] || boundaryMatch[2] || "").trim();
  if (!boundary) return null;

  const text = buffer.toString("utf8");
  const delimiter = `--${boundary}`;
  const parts = text.split(delimiter);

  for (const part of parts) {
    if (part.startsWith("--")) continue; // Closing boundary delimiter
    const headerSplit = part.split(/\r?\n\r?\n/);
    if (headerSplit.length < 2) continue;

    const headers = headerSplit[0];
    const body = headerSplit.slice(1).join("\r\n\r\n").replace(/\r?\n$/, "");

    if (
      headers.includes('name="file"') ||
      headers.includes("name='file'") ||
      headers.includes('name="csv"') ||
      headers.includes("name='csv'") ||
      headers.includes(".csv") ||
      headers.includes("text/csv")
    ) {
      return body;
    }
  }

  // Fallback to first non-empty part body if explicit field name wasn't matched
  for (const part of parts) {
    if (part.startsWith("--")) continue;
    const headerSplit = part.split(/\r?\n\r?\n/);
    if (headerSplit.length >= 2) {
      const body = headerSplit.slice(1).join("\r\n\r\n").replace(/\r?\n$/, "");
      if (body.trim().length > 0) return body;
    }
  }

  return null;
}

