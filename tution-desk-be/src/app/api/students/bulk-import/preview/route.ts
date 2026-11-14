import { NextRequest, NextResponse } from "next/server.js";
import crypto from "node:crypto";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Student from "../../../../../models/Student.ts";
import Batch from "../../../../../models/Batch.ts";
import Teacher from "../../../../../models/Teacher.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";
import { maskContactNumber } from "../../../../../lib/privacyUtils.ts";
import { parseCsvText, type ParseCsvResult } from "../../../../../lib/csvParser.ts";
import { isXlsxBuffer, parseXlsxBuffer } from "../../../../../lib/xlsxParser.ts";
import {
  computeRowsHash,
  signPreviewToken,
  validateAndCategorizeRows,
  readBoundedRequestBody,
  extractCsvFromMultipartBuffer,
  extractMultipartFilePayload,
} from "../../../../../lib/bulkImport.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT before database connection
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 2. Early Content-Length check (SEC-03)
    const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          {
            success: false,
            error: "Upload size exceeds maximum allowed limit of 5MB",
          },
          { status: 413, headers: corsHeaders }
        );
      }
    }

    // 3. Bounded streaming read: aborts immediately once 5MB is exceeded
    const { exceeded, data } = await readBoundedRequestBody(
      request,
      MAX_UPLOAD_BYTES
    );

    if (exceeded) {
      return NextResponse.json(
        {
          success: false,
          error: "Upload size exceeds maximum allowed limit of 5MB",
        },
        { status: 413, headers: corsHeaders }
      );
    }

    // 4. Parse payload from bounded buffer without calling unmetered body methods
    let parseResult: ParseCsvResult | null = null;
    let selectedBatch: string | undefined =
      request.nextUrl.searchParams.get("selectedBatch")?.trim() ||
      request.headers.get("x-selected-batch")?.trim() ||
      undefined;

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const multipart = extractMultipartFilePayload(data, contentType);
      if (multipart?.selectedBatch && !selectedBatch) {
        selectedBatch = multipart.selectedBatch;
      }

      if (multipart?.isXlsx) {
        try {
          parseResult = await parseXlsxBuffer(multipart.fileBuffer);
        } catch (xlsxErr: unknown) {
          return NextResponse.json(
            {
              success: false,
              error:
                xlsxErr instanceof Error
                  ? xlsxErr.message
                  : "Failed to parse Excel workbook.",
            },
            { status: 400, headers: corsHeaders }
          );
        }
      } else {
        const rawCsvText =
          multipart?.text ||
          extractCsvFromMultipartBuffer(data, contentType) ||
          "";
        if (rawCsvText && rawCsvText.trim()) {
          parseResult = parseCsvText(rawCsvText);
        }
      }
    } else if (contentType.includes("application/json")) {
      try {
        const body = JSON.parse(data.toString("utf8"));
        if (body.selectedBatch && typeof body.selectedBatch === "string") {
          selectedBatch = body.selectedBatch.trim();
        }

        if (body.fileBase64 && typeof body.fileBase64 === "string") {
          const fileBuf = Buffer.from(body.fileBase64, "base64");
          if (isXlsxBuffer(fileBuf)) {
            parseResult = await parseXlsxBuffer(fileBuf);
          } else {
            parseResult = parseCsvText(fileBuf.toString("utf8"));
          }
        } else if (typeof body.csv === "string") {
          parseResult = parseCsvText(body.csv);
        } else if (typeof body.csvContent === "string") {
          parseResult = parseCsvText(body.csvContent);
        } else if (typeof body.fileContent === "string") {
          parseResult = parseCsvText(body.fileContent);
        } else if (Array.isArray(body.rows)) {
          // Direct rows array supplied in JSON format
          const headers =
            "Name,Batch,Parent WhatsApp,Monthly Fee,Billing Cycle Date,Roll Number,Joining Date\n";
          const lines = body.rows.map((r: Record<string, unknown>) => {
            const name = `"${String(r.name || "").replace(/"/g, '""')}"`;
            const batch = `"${String(r.batch || selectedBatch || "").replace(/"/g, '""')}"`;
            const phone = `"${String(r.parentWhatsApp || r.phone || "").replace(/"/g, '""')}"`;
            const fee = r.monthlyFee !== undefined ? String(r.monthlyFee) : "0";
            const cycle =
              r.billingCycleDate !== undefined ? String(r.billingCycleDate) : "5";
            const roll = `"${String(r.rollNumber || "").replace(/"/g, '""')}"`;
            const date = `"${String(r.joiningDate || "").replace(/"/g, '""')}"`;
            return `${name},${batch},${phone},${fee},${cycle},${roll},${date}`;
          });
          parseResult = parseCsvText(headers + lines.join("\n"));
        }
      } catch (jsonErr: unknown) {
        return NextResponse.json(
          {
            success: false,
            error:
              jsonErr instanceof Error
                ? jsonErr.message
                : "Failed to parse request JSON payload",
          },
          { status: 400, headers: corsHeaders }
        );
      }
    } else {
      // Raw body stream
      if (isXlsxBuffer(data)) {
        try {
          parseResult = await parseXlsxBuffer(data);
        } catch (xlsxErr: unknown) {
          return NextResponse.json(
            {
              success: false,
              error:
                xlsxErr instanceof Error
                  ? xlsxErr.message
                  : "Failed to parse Excel workbook.",
            },
            { status: 400, headers: corsHeaders }
          );
        }
      } else {
        const rawCsvText = data.toString("utf8");
        if (rawCsvText && rawCsvText.trim()) {
          parseResult = parseCsvText(rawCsvText);
        }
      }
    }

    if (!parseResult || parseResult.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "Uploaded file is empty or contains no data rows" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Enforce reasonable row limit
    const MAX_ALLOWED_ROWS = 500;
    if (parseResult.rows.length > MAX_ALLOWED_ROWS) {
      return NextResponse.json(
        {
          success: false,
          error: `Upload exceeds maximum allowed limit of ${MAX_ALLOWED_ROWS} rows (received ${parseResult.rows.length} rows)`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 5. Connect to database only after authentication and input parsing
    await connectDB();

    // 6. Fetch institute active batches to validate batch existence
    const activeBatches = await Batch.find({
      centerId: user.centerId,
      isActive: { $ne: false },
    }).select("name");

    const activeBatchNames = new Set<string>(
      activeBatches.map((b) => b.name.toLowerCase().trim())
    );

    let matchedBatchDoc: any = null;
    if (selectedBatch) {
      const cleanTerm = selectedBatch.trim().toLowerCase();
      matchedBatchDoc = activeBatches.find(
        (b) =>
          b._id.toString() === selectedBatch.trim() ||
          b.name.toLowerCase().trim() === cleanTerm
      );

      if (!matchedBatchDoc) {
        return NextResponse.json(
          {
            success: false,
            error: `Selected batch '${selectedBatch}' does not exist in this institute.`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // 7. Fetch existing students within the same center for duplicate check
    const existingStudents = await Student.find({
      centerId: user.centerId,
    }).select("name parentWhatsApp");

    const existingStudentsMap = new Set<string>();
    for (const s of existingStudents) {
      const cleanPhone = String(s.parentWhatsApp || "").replace(/\D/g, "");
      const cleanName = String(s.name || "").toLowerCase().trim();
      if (cleanPhone && cleanName) {
        existingStudentsMap.add(`${cleanPhone}:::${cleanName}`);
      }
    }

    const effectiveSelectedBatchName = matchedBatchDoc
      ? matchedBatchDoc.name
      : selectedBatch;

    // 8. Validate and categorize rows (with selectedBatch support)
    const {
      validRows,
      duplicateRows,
      errorRows,
      allErrors,
      errorCsv,
    } = validateAndCategorizeRows({
      parsedRows: parseResult.rows,
      activeBatchNames,
      existingStudentsMap,
      selectedBatch: effectiveSelectedBatchName,
    });

    // 9. Generate preview identifier and cryptographic anti-tamper token
    const previewId = `prev_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const rowsHash = computeRowsHash(validRows);

    const previewToken = await signPreviewToken({
      previewId,
      centerId: user.centerId,
      userId: user.userId,
      role: user.role,
      teacherId: user.teacherId || null,
      validCount: validRows.length,
      rowsHash,
      batchId: matchedBatchDoc ? matchedBatchDoc._id.toString() : undefined,
      batchName: effectiveSelectedBatchName,
    });

    // 9. Formulate assignment indicators strictly following DEC-MSEC-05
    let defaultAssignee: { id: string | null; name: string; role: string };
    let availableAssignees: Array<{ id: string | null; name: string; role: string }> | undefined;

    if (user.role === "teacher") {
      // Teacher view: read-only self assignment
      defaultAssignee = {
        id: user.teacherId!,
        name: user.name || "Teacher",
        role: "teacher",
      };
      availableAssignees = undefined;
    } else {
      // Owner view: default to Owner (null), with dropdown for active teachers in same center
      defaultAssignee = {
        id: null,
        name: user.name || "Myself (Owner)",
        role: "owner",
      };

      const activeTeachers = await Teacher.find({
        centerId: user.centerId,
        isActive: true,
      })
        .select("_id name")
        .sort({ name: 1 });

      availableAssignees = [
        { id: null, name: "Myself (Owner)", role: "owner" },
        ...activeTeachers.map((t) => ({
          id: t._id.toString(),
          name: t.name,
          role: "teacher",
        })),
      ];
    }

    // REQ-02: Sanitize parent contact numbers for teachers
    const sanitizedRows =
      user.role === "teacher"
        ? validRows.map((r) => ({
            ...r,
            parentWhatsApp: maskContactNumber(r.parentWhatsApp),
          }))
        : validRows;

    return NextResponse.json(
      {
        success: true,
        data: {
          previewId,
          previewToken,
          totalRows: parseResult.rows.length,
          validCount: validRows.length,
          duplicateCount: duplicateRows.length,
          errorCount: errorRows.length,
          previewRows: sanitizedRows.slice(0, 10),
          rows: sanitizedRows,
          defaultAssignee,
          availableAssignees,
          selectedBatch: effectiveSelectedBatchName || null,
          selectedBatchId: matchedBatchDoc ? matchedBatchDoc._id.toString() : null,
          errors: allErrors,
          errorCsv,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to process bulk import preview";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
