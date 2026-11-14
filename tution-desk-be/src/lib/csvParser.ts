/**
 * MSEC Bulk Student Import - RFC-4180 Compliant CSV Parser & Generator
 *
 * Implements pure TypeScript CSV parsing and formatting without external dependencies:
 * - Handles comma separation with quoted fields containing commas, newlines, and escaped quotes ("").
 * - Supports CRLF (\r\n) and LF (\n) line endings.
 * - Strips UTF-8 Byte Order Mark (\uFEFF) if present.
 * - Normalizes column headers across common variations.
 * - Generates downloadable error CSV reports.
 */

export interface ParsedCsvRow {
  rowNumber: number; // 1-indexed line number in original file (header is row 1)
  raw: Record<string, string>;
  normalized: {
    name: string;
    batch: string;
    parentWhatsApp: string;
    monthlyFee?: number;
    billingCycleDate?: number;
    rollNumber?: string;
    joiningDate?: string;
  };
}

export interface ParseCsvResult {
  headers: string[];
  rows: ParsedCsvRow[];
  totalLines: number;
}

/**
 * Standardizes common header variations to internal canonical field names
 */
export function normalizeHeader(rawHeader: string): string | null {
  const clean = rawHeader
    .toLowerCase()
    .trim()
    .replace(/[\s_\-]+/g, "");

  // Student Name
  if (
    clean === "name" ||
    clean === "studentname" ||
    clean === "student" ||
    clean === "fullname"
  ) {
    return "name";
  }

  // Batch
  if (
    clean === "batch" ||
    clean === "batchname" ||
    clean === "class" ||
    clean === "section"
  ) {
    return "batch";
  }

  // Parent WhatsApp / Phone
  if (
    clean === "parentwhatsapp" ||
    clean === "whatsapp" ||
    clean === "parentphone" ||
    clean === "phone" ||
    clean === "mobile" ||
    clean === "parentmobile" ||
    clean === "contact" ||
    clean === "parentcontact"
  ) {
    return "parentWhatsApp";
  }

  // Monthly Fee
  if (
    clean === "monthlyfee" ||
    clean === "fee" ||
    clean === "fees" ||
    clean === "amount"
  ) {
    return "monthlyFee";
  }

  // Billing Cycle Date
  if (
    clean === "billingcycledate" ||
    clean === "billingcycle" ||
    clean === "cycledate" ||
    clean === "cycle" ||
    clean === "billingdate" ||
    clean === "duedate"
  ) {
    return "billingCycleDate";
  }

  // Roll Number
  if (
    clean === "rollnumber" ||
    clean === "rollno" ||
    clean === "roll"
  ) {
    return "rollNumber";
  }

  // Joining Date / Admission Date
  if (
    clean === "joiningdate" ||
    clean === "admissiondate" ||
    clean === "enrolldate" ||
    clean === "dateofadmission" ||
    clean === "doj"
  ) {
    return "joiningDate";
  }

  return null;
}

/**
 * Tokenizes a CSV string according to RFC-4180 rules into a 2D array of strings.
 */
export function parseCsvTokens(text: string): string[][] {
  // Strip UTF-8 BOM if present
  let cleanText = text;
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
  }

  const result: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;
  const len = cleanText.length;

  while (i < len) {
    const char = cleanText[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && cleanText[i + 1] === '"') {
          // Escaped quote: "" -> "
          currentField += '"';
          i += 2;
          continue;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
        i++;
        continue;
      } else if (char === "\r") {
        if (i + 1 < len && cleanText[i + 1] === "\n") {
          i += 2;
        } else {
          i++;
        }
        currentRow.push(currentField);
        currentField = "";
        result.push(currentRow);
        currentRow = [];
        continue;
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        result.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Push final field and row if any content remains
  if (inQuotes) {
    // Unterminated quote - still append what we have
    currentRow.push(currentField);
    result.push(currentRow);
  } else if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField);
    result.push(currentRow);
  }

  return result;
}

/**
 * Parses CSV text into normalized row objects with row-number tracking.
 */
export function parseCsvText(csvText: string): ParseCsvResult {
  const rawRows = parseCsvTokens(csvText);

  // Filter out completely empty rows
  const nonEmptyRows = rawRows.filter((r) =>
    r.some((field) => field.trim() !== "")
  );

  if (nonEmptyRows.length === 0) {
    return { headers: [], rows: [], totalLines: 0 };
  }

  const rawHeaders = nonEmptyRows[0];
  const headerMap: { index: number; canonical: string }[] = [];

  for (let idx = 0; idx < rawHeaders.length; idx++) {
    const canon = normalizeHeader(rawHeaders[idx]);
    if (canon) {
      headerMap.push({ index: idx, canonical: canon });
    }
  }

  const rows: ParsedCsvRow[] = [];

  // Data rows start from line 2 (1-indexed)
  for (let rIdx = 1; rIdx < nonEmptyRows.length; rIdx++) {
    const rawCols = nonEmptyRows[rIdx];
    const rawObj: Record<string, string> = {};
    const normObj: ParsedCsvRow["normalized"] = {
      name: "",
      batch: "",
      parentWhatsApp: "",
    };

    for (let cIdx = 0; cIdx < rawCols.length; cIdx++) {
      const headerName = rawHeaders[cIdx] ? rawHeaders[cIdx].trim() : `Col${cIdx + 1}`;
      const val = rawCols[cIdx].trim();
      rawObj[headerName] = val;
    }

    for (const { index, canonical } of headerMap) {
      const rawVal = rawCols[index] ? rawCols[index].trim() : "";
      if (!rawVal) continue;

      if (canonical === "name") {
        normObj.name = rawVal;
      } else if (canonical === "batch") {
        normObj.batch = rawVal;
      } else if (canonical === "parentWhatsApp") {
        normObj.parentWhatsApp = rawVal;
      } else if (canonical === "monthlyFee") {
        // Strip comma grouping e.g. "1,500" -> 1500
        const cleanFee = rawVal.replace(/,/g, "");
        const num = parseFloat(cleanFee);
        if (!isNaN(num)) normObj.monthlyFee = num;
      } else if (canonical === "billingCycleDate") {
        const num = parseInt(rawVal, 10);
        if (!isNaN(num)) normObj.billingCycleDate = num;
      } else if (canonical === "rollNumber") {
        normObj.rollNumber = rawVal;
      } else if (canonical === "joiningDate") {
        normObj.joiningDate = rawVal;
      }
    }

    rows.push({
      rowNumber: rIdx + 1,
      raw: rawObj,
      normalized: normObj,
    });
  }

  return {
    headers: rawHeaders.map((h) => h.trim()),
    rows,
    totalLines: nonEmptyRows.length,
  };
}

/**
 * Sanitizes a cell value to prevent CSV Formula Injection (CWE-1236).
 * Prepends a single quote (') if the value starts with formula triggers (=, +, -, @, \t, \r, %, |),
 * even when preceded by leading whitespace.
 * Escapes double quotes per RFC-4180.
 */
export function sanitizeCsvCell(rawVal: string | undefined | null): string {
  const str = rawVal !== undefined && rawVal !== null ? String(rawVal) : "";
  const escaped = str.replace(/"/g, '""');

  const trimmed = escaped.trimStart();
  if (/^[=+\-@\t\r%|]/.test(trimmed)) {
    return `'${escaped}`;
  }

  return escaped;
}

/**
 * Generates an RFC-4180 compliant CSV string for failed import rows,
 * with strict formula injection protection on all user-controlled columns.
 */
export function generateErrorCsv(
  errors: Array<{ row: number; name?: string; reason: string }>
): string {
  const header = '"Row","Student Name","Reason"\r\n';
  const lines = errors.map((err) => {
    const rowNum = String(err.row);
    const safeName = sanitizeCsvCell(err.name);
    const safeReason = sanitizeCsvCell(err.reason);
    return `"${rowNum}","${safeName}","${safeReason}"`;
  });
  return header + lines.join("\r\n");
}

