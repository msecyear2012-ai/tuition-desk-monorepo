import zlib from "node:zlib";
// @ts-ignore
import yauzl from "yauzl";
import { normalizeHeader, type ParsedCsvRow, type ParseCsvResult } from "./csvParser.ts";

/**
 * Checks if buffer has the PKZIP magic bytes (0x50, 0x4B, 0x03, 0x04)
 */
export function isXlsxBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  return (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/**
 * Decodes standard XML entities safely
 */
function decodeXmlEntities(text: string): string {
  if (!text) return "";
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    );
}

/**
 * Converts Excel column letter (A, B ... Z, AA, AB ...) to 0-based column index
 */
export function colLetterToIndex(colStr: string): number {
  let index = 0;
  for (let i = 0; i < colStr.length; i++) {
    index = index * 26 + (colStr.charCodeAt(i) - 64);
  }
  return index - 1;
}

/**
 * Extracts shared strings from xl/sharedStrings.xml
 */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  // Match each <si> ... </si> block
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;

  while ((siMatch = siRegex.exec(xml)) !== null) {
    const siContent = siMatch[1];
    // Gather all <t ...> ... </t> inside this <si>
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    let fullText = "";

    while ((tMatch = tRegex.exec(siContent)) !== null) {
      fullText += tMatch[1];
    }
    strings.push(decodeXmlEntities(fullText));
  }

  return strings;
}

/**
 * Extracts 2D array of string values from xl/worksheets/sheet1.xml
 */
function parseWorksheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];

  // Match each <row ...> ... </row>
  const rowRegex = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowContent = rowMatch[2];
    const cellMap: Record<number, string> = {};
    let maxColIdx = -1;

    // Match each <c r="[A-Z]+[0-9]+" ...> ... </c> or self-closing <c ... />
    const cellRegex = /<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] || "";

      // Extract cell ref: e.g. r="A1"
      const rAttrMatch = /\br="([A-Z]+)\d+"/i.exec(attrs);
      if (!rAttrMatch) continue;
      const colLetter = rAttrMatch[1].toUpperCase();
      const colIdx = colLetterToIndex(colLetter);
      if (colIdx < 0) continue;
      if (colIdx > maxColIdx) maxColIdx = colIdx;

      // Extract cell type: e.g. t="s"
      const tAttrMatch = /\bt="([^"]+)"/i.exec(attrs);
      const cellType = tAttrMatch ? tAttrMatch[1] : "";

      let cellValue = "";

      if (cellType === "s") {
        // Shared string index in <v>N</v>
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        if (vMatch) {
          const idx = parseInt(vMatch[1].trim(), 10);
          if (!isNaN(idx) && idx >= 0 && idx < sharedStrings.length) {
            cellValue = sharedStrings[idx];
          }
        }
      } else if (cellType === "inlineStr") {
        // Inline string in <is><t>...</t></is>
        const tMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        if (tMatch) {
          cellValue = decodeXmlEntities(tMatch[1]);
        }
      } else if (cellType === "b") {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        cellValue = vMatch && vMatch[1].trim() === "1" ? "TRUE" : "FALSE";
      } else {
        // Number or direct string in <v>
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        if (vMatch) {
          cellValue = decodeXmlEntities(vMatch[1].trim());
        }
      }

      cellMap[colIdx] = cellValue.trim();
    }

    if (maxColIdx >= 0) {
      const rowArr: string[] = [];
      for (let c = 0; c <= maxColIdx; c++) {
        rowArr.push(cellMap[c] || "");
      }
      rows.push(rowArr);
    }
  }

  return rows;
}

/**
 * Securely unzips and parses an Excel (.xlsx) buffer into ParseCsvResult
 */
export async function parseXlsxBuffer(buffer: Buffer): Promise<ParseCsvResult> {
  const MAX_ALLOWED_BYTES = 5 * 1024 * 1024; // 5 MB
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded Excel file is empty.");
  }
  if (buffer.length > MAX_ALLOWED_BYTES) {
    throw new Error("Excel file exceeds maximum allowed limit of 5MB.");
  }
  if (!isXlsxBuffer(buffer)) {
    throw new Error(
      "Invalid Excel file format: Expected standard OpenXML .xlsx workbook."
    );
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: true },
      (err: any, zipfile: any) => {
        if (err || !zipfile) {
          return reject(
            new Error(
              `Failed to open Excel workbook: ${err?.message || "Corrupt ZIP archive"}`
            )
          );
        }

        let sharedStringsXml = "";
        let sheetXml = "";
        let totalDecompressedBytes = 0;
        const MAX_DECOMPRESSED_LIMIT = 20 * 1024 * 1024; // 20 MB safety limit for zip bombs

        zipfile.readEntry();

        zipfile.on("entry", (entry: any) => {
          const fileName = String(entry.fileName || "");
          const isSharedStrings = fileName === "xl/sharedStrings.xml";
          const isSheet =
            fileName === "xl/worksheets/sheet1.xml" ||
            (/^xl\/worksheets\/sheet\d+\.xml$/i.test(fileName) && !sheetXml);

          if (isSharedStrings || isSheet) {
            zipfile.openReadStream(entry, (streamErr: any, readStream: any) => {
              if (streamErr || !readStream) {
                return reject(
                  new Error(`Failed to read Excel workbook part: ${fileName}`)
                );
              }

              const chunks: Buffer[] = [];
              readStream.on("data", (chunk: Buffer) => {
                totalDecompressedBytes += chunk.length;
                if (totalDecompressedBytes > MAX_DECOMPRESSED_LIMIT) {
                  readStream.destroy();
                  zipfile.close();
                  return reject(
                    new Error(
                      "Excel content exceeds decompressed safety limit (possible malformed archive)."
                    )
                  );
                }
                chunks.push(chunk);
              });

              readStream.on("end", () => {
                const content = Buffer.concat(chunks).toString("utf8");
                if (isSharedStrings) {
                  sharedStringsXml = content;
                } else if (isSheet) {
                  sheetXml = content;
                }
                zipfile.readEntry();
              });

              readStream.on("error", (e: any) => {
                reject(
                  new Error(`Error decompressing Excel workbook: ${e?.message || e}`)
                );
              });
            });
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on("end", () => {
          try {
            if (!sheetXml) {
              return reject(
                new Error(
                  "Excel workbook contains no readable worksheet data (missing sheet1.xml)."
                )
              );
            }

            const sharedStrings = sharedStringsXml
              ? parseSharedStrings(sharedStringsXml)
              : [];
            const rawRows = parseWorksheetRows(sheetXml, sharedStrings);

            // Filter out empty rows
            const nonEmptyRows = rawRows.filter((r) =>
              r.some((cell) => cell.trim() !== "")
            );

            if (nonEmptyRows.length === 0) {
              return resolve({ headers: [], rows: [], totalLines: 0 });
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

            for (let rIdx = 1; rIdx < nonEmptyRows.length; rIdx++) {
              const rawCols = nonEmptyRows[rIdx];
              const normObj: ParsedCsvRow["normalized"] = {
                name: "",
                batch: "",
                parentWhatsApp: "",
              };

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
                  const feeNum = parseFloat(rawVal.replace(/[^0-9.]/g, ""));
                  if (!isNaN(feeNum)) {
                    normObj.monthlyFee = feeNum;
                  }
                } else if (canonical === "billingCycleDate") {
                  const cycleNum = parseInt(rawVal.replace(/\D/g, ""), 10);
                  if (!isNaN(cycleNum)) {
                    normObj.billingCycleDate = cycleNum;
                  }
                } else if (canonical === "rollNumber") {
                  normObj.rollNumber = rawVal;
                } else if (canonical === "joiningDate") {
                  normObj.joiningDate = rawVal;
                }
              }

              const rawMap: Record<string, string> = {};
              for (let c = 0; c < rawCols.length; c++) {
                const h = rawHeaders[c] || `col_${c + 1}`;
                rawMap[h] = rawCols[c] || "";
              }

              // Only include if student row contains at least name or phone
              if (normObj.name || normObj.parentWhatsApp) {
                rows.push({
                  rowNumber: rIdx + 1,
                  raw: rawMap,
                  normalized: normObj,
                });
              }
            }

            resolve({
              headers: rawHeaders,
              rows,
              totalLines: nonEmptyRows.length,
            });
          } catch (processErr: unknown) {
            reject(
              new Error(
                `Failed to process Excel worksheet data: ${
                  processErr instanceof Error
                    ? processErr.message
                    : String(processErr)
                }`
              )
            );
          }
        });

        zipfile.on("error", (e: any) => {
          reject(new Error(`Corrupt or unsupported Excel workbook: ${e?.message || e}`));
        });
      }
    );
  });
}

/**
 * Minimal CRC-32 implementation for building valid PKZIP archives
 */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function calculateCrc32(buf: Buffer): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Builds a valid, standard OpenXML .xlsx buffer containing sample student data
 */
export function buildSampleXlsxBuffer(): Buffer {
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStringTable+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Students" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const sampleStrings = [
    "Name",
    "Parent WhatsApp",
    "Monthly Fee",
    "Billing Cycle Date",
    "Aarav Sharma",
    "Rohan Verma",
    "Priya Patel",
  ];

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sampleStrings.length}" uniqueCount="${sampleStrings.length}">
${sampleStrings.map((s) => `  <si><t>${s}</t></si>`).join("\n")}
</sst>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D4"/>
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>4</v></c>
      <c r="B2"><v>9876543210</v></c>
      <c r="C2"><v>2500</v></c>
      <c r="D2"><v>5</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>5</v></c>
      <c r="B3"><v>9123456780</v></c>
      <c r="C3"><v>3000</v></c>
      <c r="D3"><v>10</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>6</v></c>
      <c r="B4"><v>9988776655</v></c>
      <c r="C4"><v>2000</v></c>
      <c r="D4"><v>15</v></c>
    </row>
  </sheetData>
</worksheet>`;

  // Build standard PKZIP archive in memory
  const files: { name: string; content: Buffer }[] = [
    { name: "[Content_Types].xml", content: Buffer.from(contentTypesXml, "utf8") },
    { name: "_rels/.rels", content: Buffer.from(rootRelsXml, "utf8") },
    { name: "xl/workbook.xml", content: Buffer.from(workbookXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", content: Buffer.from(workbookRelsXml, "utf8") },
    { name: "xl/sharedStrings.xml", content: Buffer.from(sharedStringsXml, "utf8") },
    { name: "xl/worksheets/sheet1.xml", content: Buffer.from(sheetXml, "utf8") },
  ];

  const localFileHeaders: Buffer[] = [];
  const centralDirHeaders: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const uncompressedSize = f.content.length;
    const crc = calculateCrc32(f.content);
    const deflated = zlib.deflateRawSync(f.content);
    const compressedSize = deflated.length;
    const nameBuf = Buffer.from(f.name, "utf8");

    // Local file header: 30 bytes + name
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    lfh.writeUInt16LE(0, 6);          // general purpose bit flag
    lfh.writeUInt16LE(8, 8);          // compression method (deflate)
    lfh.writeUInt32LE(0, 10);         // last mod time / date
    lfh.writeUInt32LE(crc, 14);       // crc-32
    lfh.writeUInt32LE(compressedSize, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra field length
    nameBuf.copy(lfh, 30);

    localFileHeaders.push(lfh, deflated);

    // Central directory header: 46 bytes + name
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(20, 4);         // version made by
    cdh.writeUInt16LE(20, 6);         // version needed to extract
    cdh.writeUInt16LE(0, 8);          // general purpose bit flag
    cdh.writeUInt16LE(8, 10);         // compression method
    cdh.writeUInt32LE(0, 12);         // last mod time / date
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressedSize, 20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);         // extra field length
    cdh.writeUInt16LE(0, 32);         // file comment length
    cdh.writeUInt16LE(0, 34);         // disk number start
    cdh.writeUInt16LE(0, 36);         // internal file attributes
    cdh.writeUInt32LE(0, 38);         // external file attributes
    cdh.writeUInt32LE(offset, 42);    // relative offset of local header
    nameBuf.copy(cdh, 46);

    centralDirHeaders.push(cdh);

    offset += lfh.length + deflated.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralDirHeaders.reduce((sum, h) => sum + h.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // num entries on disk
  eocd.writeUInt16LE(files.length, 10); // total num entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);         // comment length

  return Buffer.concat([...localFileHeaders, ...centralDirHeaders, eocd]);
}
