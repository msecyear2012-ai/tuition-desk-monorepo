"use client";

import { useState, useRef, useEffect } from "react";
import {
  X,
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Download,
  GraduationCap,
  ArrowRight,
  ArrowLeft,
  Layers,
  ChevronDown,
  FileSpreadsheet,
  Plus,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { getAuthenticatedCenter, type CenterInfo } from "@/lib/centerProfile";
import StudentPhoneMasked from "@/components/common/StudentPhoneMasked";
import CreateBatchModal from "./CreateBatchModal";
import { BatchRecord } from "@/types";

export interface PreviewAssignee {
  id: string | null;
  name: string;
  role: string;
}

export interface BulkPreviewRow {
  name: string;
  batch: string;
  parentWhatsApp: string;
  monthlyFee: number;
  billingCycleDate: number;
  rollNumber?: string;
  joiningDate?: string;
}

export interface BulkPreviewResponse {
  success: boolean;
  previewId: string;
  previewToken: string;
  totalRows: number;
  validCount: number;
  duplicateCount: number;
  errorCount: number;
  previewRows: BulkPreviewRow[];
  rows: BulkPreviewRow[];
  defaultAssignee: PreviewAssignee;
  availableAssignees?: PreviewAssignee[];
  errors: Array<{ row?: number; line?: number; reason?: string; error?: string; message?: string }>;
  errorCsv?: string | null;
}

export interface BulkImportConfirmResponse {
  success: boolean;
  totalProcessed: number;
  importedCount: number;
  skippedCount?: number;
  failedCount?: number;
  assignedTo?: {
    id: string | null;
    name: string;
    role: string;
  };
  errors?: Array<{ row?: number; name?: string; reason?: string; error?: string }>;
  errorCsv?: string | null;
}

interface BulkImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (importedCount: number) => void;
}

export default function BulkImportModal({
  isOpen,
  onClose,
  onSuccess,
}: BulkImportModalProps) {
  // Step state: "batch_select" -> "upload" -> "preview" -> "confirming" -> "complete"
  const [step, setStep] = useState<
    "batch_select" | "upload" | "preview" | "confirming" | "complete"
  >("batch_select");

  const [userProfile, setUserProfile] = useState<CenterInfo | null>(null);

  // Batch Selection States
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");
  const [selectedBatchName, setSelectedBatchName] = useState<string>("");
  const [isCreateBatchOpen, setIsCreateBatchOpen] = useState(false);

  // File & Upload States
  const [_selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  // Preview Response State
  const [previewData, setPreviewData] = useState<BulkPreviewResponse | null>(null);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string>("");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const PAGE_SIZE = 10;

  const validRows = previewData
    ? previewData.rows?.length
      ? previewData.rows
      : previewData.previewRows || []
    : [];
  const totalValidRows = validRows.length;
  const totalPages = Math.max(1, Math.ceil(totalValidRows / PAGE_SIZE));
  const effectivePage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (effectivePage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, totalValidRows);
  const currentRows = validRows.slice(startIndex, endIndex);

  // Confirmation Response State
  const [confirmResult, setConfirmResult] = useState<BulkImportConfirmResponse | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset modal state on open & fetch batches
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep("batch_select");
      setSelectedFile(null);
      setPreviewData(null);
      setConfirmResult(null);
      setGeneralError(null);
      setSelectedAssigneeId("");
      setSelectedBatchId("");
      setSelectedBatchName("");
      setIsCreateBatchOpen(false);
      setCurrentPage(1);

      getAuthenticatedCenter().then((profile) => {
        setUserProfile(profile);
      });

      setLoadingBatches(true);
      apiClient<BatchRecord[]>("/batches")
        .then((res) => {
          if (Array.isArray(res.data)) {
            const activeOnly = res.data.filter((b) => b.isActive !== false);
            setBatches(activeOnly);
            if (activeOnly.length > 0) {
              setSelectedBatchId(activeOnly[0]._id);
              setSelectedBatchName(activeOnly[0].name);
            }
          }
        })
        .catch((err) => {
          console.warn("Could not fetch batches:", err);
        })
        .finally(() => {
          setLoadingBatches(false);
        });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // 1. Download Sample CSV
  const handleDownloadSample = () => {
    const sampleHeaders = "Name,Parent WhatsApp,Monthly Fee,Billing Cycle Date\n";
    const sampleRows = [
      "Aarav Sharma,9876543210,2500,5",
      "Rohan Verma,9123456780,3000,10",
      "Priya Patel,9988776655,2000,15",
    ].join("\n");

    const blob = new Blob([sampleHeaders + sampleRows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tuitiondesk_sample_student_import.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // 2. Download Sample Excel (.xlsx)
  const handleDownloadSampleXlsx = () => {
    const a = document.createElement("a");
    a.href = "/tuitiondesk_sample_student_import.xlsx";
    a.download = "tuitiondesk_sample_student_import.xlsx";
    a.click();
  };

  // 3. Download Error CSV
  const handleDownloadErrorCsv = (csvContent: string) => {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "import_validation_errors.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // 4. File Selection & Drag-and-Drop
  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelected = (file: File) => {
    setGeneralError(null);
    setCurrentPage(1);

    // Limit check: 5MB
    if (file.size > 5 * 1024 * 1024) {
      setGeneralError("File size exceeds maximum allowed limit of 5MB.");
      return;
    }

    const validExtensions = [".csv", ".txt", ".xlsx"];
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!validExtensions.includes(ext)) {
      setGeneralError(
        "Please select a valid CSV (.csv, .txt) or Excel (.xlsx) file."
      );
      return;
    }

    setSelectedFile(file);
    uploadAndPreviewFile(file);
  };

  // 5. Send File to /api/students/bulk-import/preview
  const uploadAndPreviewFile = async (file: File) => {
    setLoadingPreview(true);
    setGeneralError(null);
    setCurrentPage(1);

    try {
      const isXlsx = file.name.toLowerCase().endsWith(".xlsx");
      let bodyPayload: Record<string, unknown>;

      if (isXlsx) {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const len = bytes.byteLength;
        const chunkSize = 8192;
        for (let i = 0; i < len; i += chunkSize) {
          const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        const fileBase64 = btoa(binary);

        bodyPayload = {
          fileBase64,
          fileName: file.name,
          selectedBatch: selectedBatchName ? selectedBatchName.trim() : undefined,
          selectedBatchId: selectedBatchId ? selectedBatchId.trim() : undefined,
        };
      } else {
        const text = await file.text();
        if (!text || !text.trim()) {
          throw new Error("Selected file is empty.");
        }
        bodyPayload = {
          csvContent: text,
          selectedBatch: selectedBatchName ? selectedBatchName.trim() : undefined,
          selectedBatchId: selectedBatchId ? selectedBatchId.trim() : undefined,
        };
      }

      const res = await apiClient<BulkPreviewResponse>(
        "/students/bulk-import/preview",
        {
          method: "POST",
          body: bodyPayload,
        }
      );

      const preview = res.data;
      if (!preview || !preview.previewToken) {
        throw new Error("Failed to generate preview from file.");
      }

      setPreviewData(preview);
      setSelectedAssigneeId(
        preview.defaultAssignee?.id ? String(preview.defaultAssignee.id) : ""
      );
      setStep("preview");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to parse file for preview.";
      setGeneralError(msg);
    } finally {
      setLoadingPreview(false);
    }
  };

  // 6. Confirm Import (Execution Step)
  const handleConfirmImport = async () => {
    if (!previewData || !previewData.previewToken) {
      setGeneralError("Preview session is invalid or has expired. Please re-upload.");
      return;
    }

    if (previewData.validCount === 0) {
      setGeneralError("No valid rows available to import. Please check errors in the file.");
      return;
    }

    setStep("confirming");
    setGeneralError(null);

    try {
      const isTeacherUser = userProfile?.role === "teacher";
      const targetTeacherId = isTeacherUser
        ? undefined
        : selectedAssigneeId && selectedAssigneeId !== "owner"
        ? selectedAssigneeId
        : null;

      const res = await apiClient<BulkImportConfirmResponse>(
        "/students/bulk-import",
        {
          method: "POST",
          body: {
            previewToken: previewData.previewToken,
            rows: previewData.rows,
            targetTeacherId,
            selectedBatch: selectedBatchName || undefined,
            selectedBatchId: selectedBatchId || undefined,
          },
        }
      );

      setConfirmResult(res.data);
      setStep("complete");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to complete bulk import.";
      setGeneralError(msg);
      setStep("preview");
    }
  };

  const handleFinish = () => {
    if (confirmResult) {
      onSuccess(confirmResult.importedCount || 0);
    }
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fade-in overflow-y-auto">
        <div className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200/90 overflow-hidden my-6">
          {/* Top Accent Gradient Bar */}
          <div className="h-1.5 w-full bg-gradient-to-r from-blue-600 via-indigo-600 to-cyan-500" />

          {/* Modal Header */}
          <div className="p-5 border-b border-slate-100 flex items-start justify-between bg-slate-50/50">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-600/25 ring-2 ring-indigo-100">
                <Upload className="w-5 h-5 stroke-[2.2]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900 leading-tight">
                    Bulk Student Import
                  </h2>
                  <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200/60">
                    {step === "batch_select"
                      ? "Step 1 of 3: Select Batch"
                      : step === "upload"
                      ? "Step 2 of 3: Upload File"
                      : step === "preview" || step === "confirming"
                      ? "Step 3 of 3: Review & Confirm"
                      : "Completed"}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5 font-medium">
                  {step === "batch_select"
                    ? "Select an active batch or create a new batch for imported students"
                    : step === "upload"
                    ? "Upload existing student records via CSV (.csv) or Excel (.xlsx)"
                    : step === "preview" || step === "confirming"
                    ? "Review parsed records & faculty assignment before confirming"
                    : "Import execution completed"}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              disabled={step === "confirming"}
              className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-800 flex items-center justify-center transition-colors disabled:opacity-50"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* General Error Alert */}
          {generalError && (
            <div className="mx-5 mt-4 p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2.5 text-xs animate-shake">
              <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 font-semibold leading-relaxed">
                {generalError}
              </div>
            </div>
          )}

          {/* STEP 1: BATCH SELECTION */}
          {step === "batch_select" && (
            <div className="p-6 space-y-5">
              <div className="p-4 rounded-2xl bg-indigo-50/60 border border-indigo-100 flex items-start gap-3">
                <Layers className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-slate-700 leading-relaxed">
                  <p className="font-bold text-slate-900 mb-0.5">
                    Assign Batch to Imported Students
                  </p>
                  All students in this upload will be enrolled into the selected batch.
                  Your file only needs student details (Name, Parent WhatsApp, Monthly Fee, Billing Cycle Date).
                </div>
              </div>

              {loadingBatches ? (
                <div className="py-12 flex flex-col items-center justify-center gap-3">
                  <Loader2 className="w-7 h-7 text-indigo-600 animate-spin" />
                  <span className="text-xs text-slate-500 font-medium">
                    Loading active batches...
                  </span>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">
                      Target Batch <span className="text-rose-500">*</span>
                    </label>

                    {batches.length > 0 ? (
                      <div className="relative">
                        <select
                          value={selectedBatchId}
                          onChange={(e) => {
                            const bId = e.target.value;
                            setSelectedBatchId(bId);
                            const found = batches.find((b) => b._id === bId);
                            if (found) setSelectedBatchName(found.name);
                          }}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 cursor-pointer shadow-xs appearance-none pr-10"
                        >
                          <option value="" disabled>
                            -- Select a Batch --
                          </option>
                          {batches.map((b) => (
                            <option key={b._id} value={b._id}>
                              {b.name}
                              {b.timing ? ` (${b.timing})` : ""}
                              {b.subject ? ` • ${b.subject}` : ""}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                      </div>
                    ) : (
                      <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium">
                        No active batches found in your institute. Please create a new batch before proceeding.
                      </div>
                    )}
                  </div>

                  {/* Owner-Only: Create New Batch Option */}
                  {userProfile?.role !== "teacher" && (
                    <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                      <span className="text-xs text-slate-500 font-medium">
                        Need a new batch for this student intake?
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsCreateBatchOpen(true)}
                        className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100/80 text-indigo-700 border border-indigo-200/80 text-xs font-bold transition-all shadow-2xs"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Create New Batch</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Step 1 Actions */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="tap-bounce px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition-colors"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={() => setStep("upload")}
                  disabled={!selectedBatchName.trim() || loadingBatches}
                  className="tap-bounce flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md shadow-indigo-600/25 transition-all disabled:opacity-50"
                >
                  <span>Continue to Upload</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: UPLOAD STATE */}
          {step === "upload" && (
            <div className="p-6 space-y-5">
              {/* Selected Batch Summary Banner */}
              <div className="p-3.5 rounded-2xl bg-indigo-50/70 border border-indigo-100 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                      Target Batch
                    </span>
                    <span className="text-xs font-bold text-slate-900">
                      {selectedBatchName}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setStep("batch_select")}
                  className="tap-bounce text-[11px] font-bold text-indigo-700 hover:text-indigo-900 px-2.5 py-1 rounded-lg bg-white border border-indigo-200 shadow-2xs hover:bg-indigo-50"
                >
                  Change Batch
                </button>
              </div>

              {/* Drag & Drop Upload Area */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleFileDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`p-8 rounded-3xl border-2 border-dashed text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-3 ${
                  isDragging
                    ? "border-indigo-600 bg-indigo-50/50 scale-[0.99]"
                    : "border-slate-200 hover:border-indigo-400 bg-slate-50/40 hover:bg-slate-50/80"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv, .txt, .xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv, text/plain"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleFileSelected(e.target.files[0]);
                    }
                  }}
                  className="hidden"
                />

                <div className="w-14 h-14 rounded-3xl bg-indigo-50 text-indigo-600 flex items-center justify-center ring-8 ring-indigo-50/50">
                  {loadingPreview ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="w-7 h-7 stroke-[2]" />
                  )}
                </div>

                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {loadingPreview
                      ? "Parsing and validating rows..."
                      : "Drop your CSV or Excel (.xlsx) file here, or click to browse"}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                    Supports CSV (.csv, .txt) and Microsoft Excel (.xlsx) workbooks up to 5MB and 500 rows.
                  </p>
                </div>

                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-slate-200 text-slate-600 shadow-2xs">
                  <span>Maximum file size: 5MB</span>
                  <span>•</span>
                  <span>Up to 500 rows</span>
                  <span>•</span>
                  <span>CSV &amp; XLSX</span>
                </div>
              </div>

              {/* Template & Helper Bar */}
              <div className="p-4 rounded-2xl bg-indigo-50/60 border border-indigo-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <FileText className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                  <div>
                    <span className="text-xs text-slate-700 font-semibold block">
                      Need the standard format? Download sample template:
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Standard columns: Name, Parent WhatsApp, Monthly Fee, Billing Cycle Date
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadSample}
                    className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-indigo-200 text-indigo-700 text-xs font-bold hover:bg-indigo-50 shadow-2xs transition-all"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Sample CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadSampleXlsx}
                    className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-emerald-300 text-emerald-800 text-xs font-bold hover:bg-emerald-50 shadow-2xs transition-all"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Sample Excel (.xlsx)</span>
                  </button>
                </div>
              </div>

              {/* Step 2 Actions */}
              <div className="pt-2 flex items-center justify-between gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setStep("batch_select")}
                  className="tap-bounce flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Batch</span>
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: PREVIEW & ADVISORY STATE */}
          {(step === "preview" || step === "confirming") && previewData && (
            <div className="p-6 space-y-5">
              {/* Selected Batch Pill */}
              <div className="p-3 rounded-2xl bg-indigo-50/70 border border-indigo-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-indigo-600" />
                  <span className="text-xs font-bold text-indigo-950">
                    Importing to Batch: {selectedBatchName || validRows[0]?.batch || "General"}
                    {_selectedFile && (
                      <span className="font-normal text-slate-500 ml-1.5">
                        ({_selectedFile.name})
                      </span>
                    )}
                  </span>
                </div>
                <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-white text-indigo-700 border border-indigo-200">
                  Batch Assigned
                </span>
              </div>

              {/* Metric Summary Cards */}
              <div className="grid grid-cols-4 gap-2.5 text-center">
                <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 shadow-2xs">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">
                    Total
                  </span>
                  <span className="text-base sm:text-xl font-black text-slate-900 mt-0.5 block">
                    {previewData.totalRows}
                  </span>
                </div>
                <div className="p-3 rounded-2xl bg-emerald-50/70 border border-emerald-100 shadow-2xs">
                  <span className="text-[10px] font-bold uppercase text-emerald-700 block">
                    Valid
                  </span>
                  <span className="text-base sm:text-xl font-black text-emerald-800 mt-0.5 block">
                    {previewData.validCount}
                  </span>
                </div>
                <div className="p-3 rounded-2xl bg-amber-50/70 border border-amber-100 shadow-2xs">
                  <span className="text-[10px] font-bold uppercase text-amber-700 block">
                    Duplicates
                  </span>
                  <span className="text-base sm:text-xl font-black text-amber-800 mt-0.5 block">
                    {previewData.duplicateCount}
                  </span>
                </div>
                <div className="p-3 rounded-2xl bg-rose-50/70 border border-rose-100 shadow-2xs">
                  <span className="text-[10px] font-bold uppercase text-rose-700 block">
                    Errors
                  </span>
                  <span className="text-base sm:text-xl font-black text-rose-800 mt-0.5 block">
                    {previewData.errorCount}
                  </span>
                </div>
              </div>

              {/* Faculty Assignee Selection */}
              {userProfile?.role === "teacher" ? (
                <div className="p-3.5 rounded-2xl bg-indigo-50/60 border border-indigo-100 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                      <GraduationCap className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                        Target Faculty Assignment
                      </span>
                      <span className="text-xs font-bold text-slate-900">
                        All imported students will be assigned to: You ({userProfile.teacherName || "Teacher"})
                      </span>
                    </div>
                  </div>
                  <span className="text-[10px] font-extrabold text-indigo-700 bg-white px-2.5 py-0.5 rounded-full border border-indigo-200 shadow-2xs">
                    LOCKED
                  </span>
                </div>
              ) : (
                <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                      <GraduationCap className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                        Assign Faculty to Imported Students
                      </span>
                      <span className="text-xs text-slate-600 font-medium">
                        Select which teacher will manage these admitted students
                      </span>
                    </div>
                  </div>

                  <div className="relative min-w-[200px]">
                    <select
                      value={selectedAssigneeId}
                      onChange={(e) => setSelectedAssigneeId(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 cursor-pointer shadow-2xs"
                    >
                      <option value="">Myself (Owner) (Default)</option>
                      {previewData.availableAssignees
                        ?.filter((a) => a.id !== null)
                        .map((a) => (
                          <option key={a.id} value={a.id!}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Error / Duplicates Advisory Details */}
              {(previewData.errorCount > 0 || previewData.duplicateCount > 0) && (
                <div className="p-3.5 rounded-2xl bg-amber-50/70 border border-amber-200/80 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                      <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                      <span>
                        {previewData.duplicateCount > 0 &&
                          `${previewData.duplicateCount} duplicate students will be skipped. `}
                        {previewData.errorCount > 0 &&
                          `${previewData.errorCount} rows contained validation errors.`}
                      </span>
                    </div>
                    {previewData.errorCsv && (
                      <button
                        type="button"
                        onClick={() => handleDownloadErrorCsv(previewData.errorCsv!)}
                        className="tap-bounce inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-amber-800 text-[11px] font-bold shadow-2xs hover:bg-amber-100/50"
                      >
                        <Download className="w-3 h-3" />
                        <span>Download Errors CSV</span>
                      </button>
                    )}
                  </div>

                  {previewData.errors && previewData.errors.length > 0 && (
                    <div className="max-h-24 overflow-y-auto space-y-1 text-[11px] text-amber-800 pr-1">
                      {previewData.errors.slice(0, 5).map((err, idx) => (
                        <div key={idx} className="flex items-center gap-1.5">
                          <span className="font-mono font-bold">
                            Row {err.row || err.line || idx + 1}:
                          </span>
                          <span>{err.reason || err.error || err.message || "Invalid row data"}</span>
                        </div>
                      ))}
                      {previewData.errors.length > 5 && (
                        <p className="text-[10px] text-amber-700 italic">
                          ...and {previewData.errors.length - 5} more errors
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Valid Rows Preview Table with Client-Side Pagination */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-800">
                    Preview Valid Records:
                  </span>
                  <span className="text-slate-500 font-medium text-[11px]">
                    {totalValidRows > 0
                      ? `Showing ${startIndex + 1}-${endIndex} of ${totalValidRows} valid rows`
                      : "0 valid rows"}
                  </span>
                </div>

                <div className="border border-slate-200 rounded-2xl overflow-hidden max-h-56 overflow-y-auto shadow-2xs">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-slate-50 text-slate-500 uppercase font-bold sticky top-0 border-b border-slate-200">
                      <tr>
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">Student Name</th>
                        <th className="px-3 py-2">Batch</th>
                        <th className="px-3 py-2">WhatsApp</th>
                        <th className="px-3 py-2">Monthly Fee</th>
                        <th className="px-3 py-2">Due Day</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                      {currentRows.map((row, idx) => {
                        const rowNumber = startIndex + idx + 1;
                        return (
                          <tr key={rowNumber} className="hover:bg-slate-50/60">
                            <td className="px-3 py-1.5 text-slate-400 font-mono">{rowNumber}</td>
                            <td className="px-3 py-1.5 font-bold text-slate-900">{row.name}</td>
                            <td className="px-3 py-1.5 text-slate-600">
                              {row.batch || selectedBatchName}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-slate-600">
                              <StudentPhoneMasked
                                phone={row.parentWhatsApp}
                                userRole={userProfile?.role}
                                showQuickActions={false}
                                textClassName="font-mono text-slate-600 text-xs"
                              />
                            </td>
                            <td className="px-3 py-1.5 font-bold text-emerald-700">₹{row.monthlyFee}</td>
                            <td className="px-3 py-1.5 font-mono">{row.billingCycleDate}th</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Compact Pagination Controls */}
                {totalValidRows > 0 && (
                  <div className="flex items-center justify-between pt-1 text-xs">
                    <div className="text-[11px] font-medium text-slate-600">
                      <span className="font-semibold text-slate-700">
                        Page {effectivePage} of {totalPages}
                      </span>
                      <span className="mx-2 text-slate-300">•</span>
                      <span>
                        Showing {startIndex + 1}-{endIndex} of {totalValidRows} valid rows
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                        disabled={effectivePage <= 1}
                        className="tap-bounce px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-700 text-[11px] font-bold shadow-2xs hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                        disabled={effectivePage >= totalPages}
                        className="tap-bounce px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-700 text-[11px] font-bold shadow-2xs hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="pt-2 flex items-center justify-between gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setStep("upload");
                    setSelectedFile(null);
                    setPreviewData(null);
                    setCurrentPage(1);
                  }}
                  disabled={step === "confirming"}
                  className="tap-bounce px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition-colors disabled:opacity-50"
                >
                  Upload Different File
                </button>

                <button
                  type="button"
                  onClick={handleConfirmImport}
                  disabled={step === "confirming" || previewData.validCount === 0}
                  className="tap-bounce flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md shadow-indigo-600/25 transition-all disabled:opacity-50"
                >
                  {step === "confirming" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Importing {previewData.validCount} Students...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Confirm &amp; Import ({previewData.validCount} Students)</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: COMPLETE STATE */}
          {step === "complete" && confirmResult && (
            <div className="p-6 space-y-5 text-center">
              <div className="w-14 h-14 mx-auto rounded-3xl bg-emerald-50 text-emerald-600 flex items-center justify-center ring-8 ring-emerald-50/50">
                <CheckCircle2 className="w-7 h-7 stroke-[2.2]" />
              </div>

              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Bulk Import Completed Successfully
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                  {confirmResult.importedCount} student records have been created in your institute roster.
                </p>
              </div>

              {/* Results Grid */}
              <div className="grid grid-cols-3 gap-3 max-w-md mx-auto">
                <div className="p-3.5 rounded-2xl bg-emerald-50/70 border border-emerald-100">
                  <span className="text-[10px] font-bold uppercase text-emerald-700 block">
                    Imported
                  </span>
                  <span className="text-2xl font-black text-emerald-900 mt-0.5 block">
                    {confirmResult.importedCount}
                  </span>
                </div>
                <div className="p-3.5 rounded-2xl bg-amber-50/70 border border-amber-100">
                  <span className="text-[10px] font-bold uppercase text-amber-700 block">
                    Skipped
                  </span>
                  <span className="text-2xl font-black text-amber-900 mt-0.5 block">
                    {confirmResult.skippedCount || 0}
                  </span>
                </div>
                <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">
                    Failed
                  </span>
                  <span className="text-2xl font-black text-slate-700 mt-0.5 block">
                    {confirmResult.failedCount || 0}
                  </span>
                </div>
              </div>

              {/* Faculty Assignment Confirmation Tag */}
              {confirmResult.assignedTo && (
                <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-indigo-50 border border-indigo-200/80 text-xs text-indigo-900 font-semibold">
                  <GraduationCap className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                  <span>Assigned to: {confirmResult.assignedTo.name}</span>
                </div>
              )}

              {/* Failed Rows / Error CSV Download */}
              {confirmResult.errorCsv && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => handleDownloadErrorCsv(confirmResult.errorCsv!)}
                    className="tap-bounce inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold hover:bg-rose-100/60 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Failed Rows Report</span>
                  </button>
                </div>
              )}

              {/* Footer Action */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={handleFinish}
                  className="tap-bounce px-6 py-2.5 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-md transition-all"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Owner-Only Create Batch Modal */}
      {isCreateBatchOpen && (
        <CreateBatchModal
          isOpen={isCreateBatchOpen}
          onClose={() => setIsCreateBatchOpen(false)}
          onSuccess={(newBatch) => {
            setBatches((prev) => [newBatch, ...prev]);
            setSelectedBatchId(newBatch._id);
            setSelectedBatchName(newBatch.name);
            setIsCreateBatchOpen(false);
          }}
        />
      )}
    </>
  );
}
