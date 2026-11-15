"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  IndianRupee,
  Calendar,
  User,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Search,
  ShieldCheck,
  GraduationCap,
  CreditCard,
  Hash,
} from "lucide-react";
import { apiClient, getCurrentCenterId, invalidateApiCache } from "@/lib/apiClient";
import { getAuthenticatedCenter } from "@/lib/centerProfile";

export interface AddFeeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  initialMode?: "collect" | "generate";
}

export interface StudentOption {
  _id: string;
  name: string;
  batch: string;
}

export interface LookupStudent {
  _id: string;
  name: string;
  rollNumber: string;
  batch: string;
  assignedTeacherName: string;
  pendingDues: number;
}

export interface ManualCollectionResponse {
  success: boolean;
  settledExisting?: boolean;
  message?: string;
  data?: unknown;
  error?: string;
  code?: string;
}

/**
 * Returns current date in IST (Asia/Kolkata UTC+5:30) as YYYY-MM-DD
 */
export function getTodayIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffset);
  return istDate.toISOString().slice(0, 10);
}

function getCanonicalBillingMonth(monthStr: string, dueDateStr: string): string {
  const trimmed = monthStr.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const parsed = Date.parse(trimmed + " 1");
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  if (dueDateStr && /^\d{4}-\d{2}/.test(dueDateStr)) {
    return dueDateStr.slice(0, 7);
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function AddFeeModal({
  isOpen,
  onClose,
  onSuccess,
  initialMode = "collect",
}: AddFeeModalProps) {
  // Top-level modal mode: "collect" (Cross-Batch Payment Collection) vs "generate" (Create Fee Due)
  const [modalMode, setModalMode] = useState<"collect" | "generate">(initialMode);

  // Authenticated Collector Identity (DEC-MSEC-01)
  const [collectorIdentity, setCollectorIdentity] = useState<string>("Loading...");

  // ---------------------------------------------------------------------------
  // STATE: MODE 1 - Cross-Batch Payment Collection
  // ---------------------------------------------------------------------------
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LookupStudent[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<LookupStudent | null>(null);

  const [collectAmount, setCollectAmount] = useState("1500");
  const [paymentMode, setPaymentMode] = useState<string>("Cash");
  const [paymentDate, setPaymentDate] = useState<string>(getTodayIST());
  const [utrNumber, setUtrNumber] = useState("");
  const [collectNotes, setCollectNotes] = useState("");

  const [utrError, setUtrError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // STATE: MODE 2 - Generate Fee Due (Existing Roster Mode)
  // ---------------------------------------------------------------------------
  const [rosterStudents, setRosterStudents] = useState<StudentOption[]>([]);
  const [loadingRoster, setLoadingRoster] = useState(false);

  const [generateStudentId, setGenerateStudentId] = useState("");
  const [feeType, setFeeType] = useState<"monthly_recurring" | "adhoc" | "registration">("monthly_recurring");
  const [generateTitle, setGenerateTitle] = useState("");
  const [generateMonth, setGenerateMonth] = useState("November 2026");
  const [generateAmountDue, setGenerateAmountDue] = useState("1500");
  const [generateDueDate, setGenerateDueDate] = useState("2026-11-10");

  // Shared status states
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Fetch logged-in user profile identity on mount
  useEffect(() => {
    if (!isOpen) return;
    getAuthenticatedCenter().then((center) => {
      if (!center) {
        setCollectorIdentity("Authenticated User");
        return;
      }
      if (center.role === "teacher") {
        setCollectorIdentity(`${center.teacherName || "Teacher"} (Teacher)`);
      } else {
        const ownerName = center.ownerName || center.name || "Institute Owner";
        setCollectorIdentity(`${ownerName} (Owner)`);
      }
    });
  }, [isOpen]);

  // Reset forms helper
  const resetCollectForm = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSelectedStudent(null);
    setCollectAmount("1500");
    setPaymentMode("Cash");
    setPaymentDate(getTodayIST());
    setUtrNumber("");
    setCollectNotes("");
    setUtrError(null);
    setError(null);
  }, []);

  const resetGenerateForm = useCallback(() => {
    setFeeType("monthly_recurring");
    setGenerateTitle("");
    setGenerateMonth("November 2026");
    setGenerateAmountDue("1500");
    setGenerateDueDate("2026-11-10");
    setError(null);
  }, []);

  // Sync initialMode on open
  useEffect(() => {
    if (isOpen) {
      setModalMode(initialMode);
      setPaymentDate(getTodayIST());
      setError(null);
      setUtrError(null);
    }
  }, [isOpen, initialMode]);

  // ---------------------------------------------------------------------------
  // Debounced Student Lookup for Cross-Batch Payment Mode (GET /api/students/lookup)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (modalMode !== "collect" || selectedStudent) {
      return;
    }

    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await apiClient<LookupStudent[]>("/students/lookup", {
          params: {
            q: trimmedQuery,
            centerId: getCurrentCenterId(),
          },
          skipCache: true,
        });

        const raw = res as unknown as { data?: LookupStudent[] | { data?: LookupStudent[] } };
        let list: LookupStudent[] = [];
        if (Array.isArray(res.data)) {
          list = res.data;
        } else if (raw.data && typeof raw.data === "object" && "data" in raw.data && Array.isArray(raw.data.data)) {
          list = raw.data.data;
        } else if (Array.isArray(raw.data)) {
          list = raw.data as LookupStudent[];
        }

        setSearchResults(list);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Lookup failed";
        setSearchError(msg);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery, modalMode, selectedStudent]);

  // Load roster students for "Generate Fee Due" mode
  useEffect(() => {
    if (!isOpen || modalMode !== "generate") return;

    async function loadRosterStudents() {
      setLoadingRoster(true);
      setError(null);
      try {
        const res = await apiClient<StudentOption[]>("/students", {
          params: { centerId: getCurrentCenterId() },
        });

        const list = res.data || [];
        setRosterStudents(list);

        if (list.length > 0 && !generateStudentId) {
          setGenerateStudentId(list[0]._id);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load students.";
        setError(msg);
      } finally {
        setLoadingRoster(false);
      }
    }

    loadRosterStudents();
  }, [isOpen, modalMode, generateStudentId]);

  if (!isOpen) return null;

  // ---------------------------------------------------------------------------
  // HANDLER: Submit Cross-Batch Payment (POST /api/fees/manual-collection)
  // ---------------------------------------------------------------------------
  const handleCollectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUtrError(null);

    if (!selectedStudent) {
      setError("Please search and select a student to record payment.");
      return;
    }

    const numAmount = Number(collectAmount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setError("Please enter a valid payment amount greater than ₹0.");
      return;
    }

    if (!paymentDate) {
      setError("Please choose a payment date.");
      return;
    }

    setSubmitting(true);

    try {
      const payload: Record<string, unknown> = {
        centerId: getCurrentCenterId(),
        studentId: selectedStudent._id,
        amount: numAmount,
        paymentMode,
        paymentDate: new Date(paymentDate).toISOString(),
      };

      if (utrNumber.trim()) {
        payload.utrNumber = utrNumber.trim();
      }
      if (collectNotes.trim()) {
        payload.notes = collectNotes.trim();
      }

      const res = await apiClient<ManualCollectionResponse>("/fees/manual-collection", {
        method: "POST",
        body: payload,
      });

      if (!res.success) {
        throw new Error(res.error || "Failed to record payment collection.");
      }

      const successMsg = `Payment of ₹${numAmount.toLocaleString("en-IN")} recorded successfully for ${selectedStudent.name}!`;
      setSuccessToast(successMsg);

      setTimeout(() => {
        setSuccessToast(null);
        resetCollectForm();
        onClose();
        if (onSuccess) {
          onSuccess();
        } else {
          window.location.reload();
        }
      }, 1200);
    } catch (err: unknown) {
      setSubmitting(false);
      const errObj = err as { code?: string; message?: string; status?: number };
      const msg = errObj?.message || "Failed to record payment collection.";

      if (
        errObj?.code === "FEE_ALREADY_PAID" ||
        /already paid/i.test(msg)
      ) {
        invalidateApiCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("msec:fee-already-paid", {
              detail: {
                studentId: selectedStudent._id,
                message: "This fee is already Paid in full. The pending dues list has been updated.",
              },
            })
          );
        }
        setError("Monthly fee is already Paid in full. The pending dues list has been updated.");
      } else if (
        errObj?.code === "DUPLICATE_UTR" ||
        errObj?.status === 409 ||
        /duplicate.*utr|transaction reference.*already exists|duplicate upi/i.test(msg)
      ) {
        setUtrError(
          "A payment record with this transaction reference (UTR) already exists in this institute. Duplicate UPI/UPI-gateway references are blocked."
        );
      } else {
        setError(msg);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // HANDLER: Submit Generate Fee Due (POST /api/fees)
  // ---------------------------------------------------------------------------
  const handleGenerateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!generateStudentId) {
      setError("Please select a student.");
      return;
    }

    const cleanMonth = generateMonth.trim();
    if (!cleanMonth) {
      setError("Please specify the fee month / label.");
      return;
    }

    const numAmount = Number(generateAmountDue);
    if (isNaN(numAmount) || numAmount <= 0) {
      setError("Please enter a valid amount greater than ₹0.");
      return;
    }

    if (!generateDueDate) {
      setError("Please choose a payment due date.");
      return;
    }

    setSubmitting(true);

    try {
      const payload: Record<string, unknown> = {
        centerId: getCurrentCenterId(),
        studentId: generateStudentId,
        feeType,
        month: cleanMonth,
        amountDue: numAmount,
        dueDate: new Date(generateDueDate).toISOString(),
        status: "Pending",
      };

      if (feeType === "monthly_recurring") {
        payload.billingMonth = getCanonicalBillingMonth(cleanMonth, generateDueDate);
      } else {
        payload.title =
          generateTitle.trim() || (feeType === "registration" ? "Registration Fee" : "Ad-hoc Fee");
      }

      const res = await apiClient("/fees", {
        method: "POST",
        body: payload,
      });

      if (!res.success) {
        throw new Error(res.error || "Failed to generate fee record.");
      }

      setSuccessToast("Fee record created successfully! Refreshing...");

      setTimeout(() => {
        setSuccessToast(null);
        resetGenerateForm();
        onClose();
        if (onSuccess) {
          onSuccess();
        } else {
          window.location.reload();
        }
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate fee.";
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4 backdrop-blur-xs animate-fade-in overflow-y-auto">
      {/* Modal Container */}
      <div className="rounded-3xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-2xl w-full max-w-md relative transition-all max-h-[calc(100dvh-2rem)] overflow-y-auto my-auto">
        {/* Top Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div
              className={`h-10 w-10 rounded-2xl flex items-center justify-center border ${
                modalMode === "collect"
                  ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                  : "bg-blue-50 text-blue-600 border-blue-100"
              }`}
            >
              <IndianRupee className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900 tracking-tight leading-snug">
                {modalMode === "collect" ? "Collect Payment" : "Generate Fee Due"}
              </h2>
              <p className="text-[11px] text-slate-400 font-medium">
                {modalMode === "collect"
                  ? "Cross-batch payment receipt (any student)"
                  : "Create monthly or ad-hoc fee due"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="tap-bounce h-8 w-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Selector Tabs */}
        <div className="mt-3.5 p-1 rounded-2xl bg-slate-100/90 border border-slate-200/80 flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setModalMode("collect");
              setError(null);
              setUtrError(null);
            }}
            className={`tap-bounce flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
              modalMode === "collect"
                ? "bg-white text-emerald-700 shadow-xs"
                : "text-slate-500 hover:text-slate-900"
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Collect Payment</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setModalMode("generate");
              setError(null);
              setUtrError(null);
            }}
            className={`tap-bounce flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
              modalMode === "generate"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-slate-500 hover:text-slate-900"
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Generate Due</span>
          </button>
        </div>

        {/* Read-Only Collector Identity Banner (DEC-MSEC-01) */}
        {modalMode === "collect" && (
          <div className="mt-3.5 p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-slate-600">
              <ShieldCheck className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span className="text-[11px] font-bold">Recording &amp; Receiving as:</span>
            </div>
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-black bg-white border border-slate-200 text-slate-800 shadow-2xs truncate max-w-[170px]">
              {collectorIdentity}
            </span>
          </div>
        )}

        {/* Success Alert */}
        {successToast && (
          <div className="my-3 rounded-2xl bg-emerald-50 border border-emerald-200 p-3 text-emerald-800 flex items-center gap-2.5 text-xs animate-fade-in">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />
            <span className="font-bold">{successToast}</span>
          </div>
        )}

        {/* General Error Alert */}
        {error && (
          <div className="my-3 rounded-2xl bg-rose-50 border border-rose-200 p-3 text-rose-800 flex items-start gap-2.5 text-xs">
            <AlertCircle className="h-4 w-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <span className="font-semibold">{error}</span>
          </div>
        )}

        {/* Duplicate UTR Error Alert */}
        {utrError && (
          <div className="my-3 rounded-2xl bg-amber-50 border border-amber-300 p-3 text-amber-900 text-xs space-y-1 animate-fade-in">
            <div className="flex items-center gap-1.5 font-bold">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span>Duplicate Transaction Reference (UTR)</span>
            </div>
            <p className="text-[11px] text-amber-800 leading-relaxed font-medium">
              {utrError}
            </p>
          </div>
        )}

        {/* ================================================================= */}
        {/* MODE 1: COLLECT PAYMENT FOR ANY STUDENT (CROSS-BATCH)             */}
        {/* ================================================================= */}
        {modalMode === "collect" && (
          <form onSubmit={handleCollectSubmit} className="space-y-3.5 pt-3">
            {/* 1. Student Search & Selection */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Student Lookup (Cross-Batch)
              </label>

              {!selectedStudent ? (
                <div className="space-y-2">
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                      <Search className="h-4 w-4" />
                    </div>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by student name or roll number..."
                      className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-9 py-2.5 text-xs font-semibold text-slate-900 focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-500/20 transition-all"
                    />
                    {searching && (
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-emerald-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    )}
                  </div>

                  {/* Search Results Dropdown List */}
                  {searchQuery.trim() && !searching && searchResults.length > 0 && (
                    <div className="max-h-48 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-lg p-1 space-y-1">
                      {searchResults.map((st) => (
                        <button
                          key={st._id}
                          type="button"
                          onClick={() => {
                            setSelectedStudent(st);
                            if (st.pendingDues > 0) {
                              setCollectAmount(String(st.pendingDues));
                            }
                            setSearchQuery("");
                            setSearchResults([]);
                          }}
                          className="w-full text-left p-2.5 rounded-xl hover:bg-emerald-50/80 transition-all flex items-center justify-between gap-2 group"
                        >
                          <div>
                            <div className="text-xs font-bold text-slate-900 group-hover:text-emerald-700">
                              {st.name}
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mt-0.5">
                              {st.rollNumber && <span>Roll: {st.rollNumber}</span>}
                              {st.rollNumber && <span>•</span>}
                              <span>Batch: {st.batch || "General"}</span>
                              <span>•</span>
                              <span>Teacher: {st.assignedTeacherName}</span>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <span
                              className={`text-[11px] font-black ${
                                st.pendingDues > 0 ? "text-rose-600" : "text-emerald-600"
                              }`}
                            >
                              ₹{st.pendingDues.toLocaleString("en-IN")}
                            </span>
                            <span className="block text-[9px] font-bold text-slate-400">
                              {st.pendingDues > 0 ? "Due" : "No Due"}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Empty Search Results Notice */}
                  {searchQuery.trim() && !searching && searchResults.length === 0 && (
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center text-xs text-slate-500 font-medium">
                      No matching students found in this institute.
                    </div>
                  )}

                  {searchError && (
                    <div className="text-xs text-rose-600 font-medium px-1">
                      {searchError}
                    </div>
                  )}
                </div>
              ) : (
                /* Selected Student Sanitized Card */
                <div className="p-3.5 rounded-2xl bg-gradient-to-r from-emerald-50/60 to-white border border-emerald-200/90 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-xs sm:text-sm font-bold text-slate-900">
                        {selectedStudent.name}
                      </h4>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500 flex-wrap">
                        {selectedStudent.rollNumber && (
                          <span className="font-semibold text-slate-700">
                            Roll: {selectedStudent.rollNumber}
                          </span>
                        )}
                        {selectedStudent.rollNumber && <span className="text-slate-300">•</span>}
                        <span>
                          Batch: <span className="font-semibold text-slate-700">{selectedStudent.batch || "General"}</span>
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedStudent(null);
                        setCollectAmount("1500");
                      }}
                      className="tap-bounce text-[11px] font-bold text-emerald-700 hover:text-emerald-900 underline px-1"
                    >
                      Change
                    </button>
                  </div>

                  <div className="flex items-center justify-between pt-1.5 border-t border-emerald-100 text-[11px]">
                    <div className="flex items-center gap-1 text-slate-600">
                      <GraduationCap className="w-3.5 h-3.5 text-emerald-600" />
                      <span>
                        Teacher: <span className="font-bold text-slate-800">{selectedStudent.assignedTeacherName}</span>
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-slate-500">Pending Dues: </span>
                      <span
                        className={`font-black ${
                          selectedStudent.pendingDues > 0 ? "text-rose-600" : "text-emerald-600"
                        }`}
                      >
                        ₹{selectedStudent.pendingDues.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 2. Amount Collected */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="collect-amount"
                  className="block text-[11px] font-bold uppercase tracking-wider text-slate-500"
                >
                  Amount Collected (₹)
                </label>
                {selectedStudent && selectedStudent.pendingDues > 0 && (
                  <button
                    type="button"
                    onClick={() => setCollectAmount(String(selectedStudent.pendingDues))}
                    className="text-[10px] font-bold text-emerald-700 hover:underline"
                  >
                    Set Full Due (₹{selectedStudent.pendingDues})
                  </button>
                )}
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 font-bold text-xs">
                  <span>₹</span>
                </div>
                <input
                  id="collect-amount"
                  type="number"
                  value={collectAmount}
                  onChange={(e) => setCollectAmount(e.target.value)}
                  placeholder="1500"
                  min="1"
                  step="any"
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-8 pr-3.5 py-2.5 text-xs font-bold text-slate-900 font-mono focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-500/20 transition-all"
                />
              </div>
            </div>

            {/* 3. Payment Mode Selection */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Payment Mode
              </label>
              <div className="grid grid-cols-4 gap-1 p-1 rounded-2xl bg-slate-100 border border-slate-200 text-center">
                {["Cash", "Online/UPI", "Cheque", "Bank Transfer"].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPaymentMode(mode)}
                    className={`py-1.5 px-1 rounded-xl text-[10px] font-bold transition-all truncate ${
                      paymentMode === mode
                        ? "bg-white text-emerald-700 shadow-xs"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            {/* 4. Payment Date */}
            <div>
              <label
                htmlFor="collect-date"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Payment Date
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Calendar className="h-4 w-4" />
                </div>
                <input
                  id="collect-date"
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-3.5 py-2.5 text-xs font-bold text-slate-900 focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-500/20 transition-all"
                />
              </div>
            </div>

            {/* 5. Transaction Reference / UTR */}
            <div>
              <label
                htmlFor="collect-utr"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Transaction Reference / UTR
                {paymentMode === "Online/UPI" && (
                  <span className="text-amber-700 font-semibold lowercase ml-1">
                    (recommended for UPI)
                  </span>
                )}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Hash className="h-4 w-4" />
                </div>
                <input
                  id="collect-utr"
                  type="text"
                  value={utrNumber}
                  onChange={(e) => {
                    setUtrNumber(e.target.value);
                    if (utrError) setUtrError(null);
                  }}
                  placeholder="e.g. 12-digit UTR, Cheque No, or Bank Ref"
                  className={`w-full rounded-2xl border bg-slate-50/50 pl-10 pr-3.5 py-2.5 text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-4 transition-all ${
                    utrError
                      ? "border-amber-400 focus:border-amber-500 focus:ring-amber-200"
                      : "border-slate-200 focus:border-emerald-500 focus:ring-emerald-500/20"
                  }`}
                />
              </div>
            </div>

            {/* 6. Notes (Optional) */}
            <div>
              <label
                htmlFor="collect-notes"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Payment Notes (Optional)
              </label>
              <input
                id="collect-notes"
                type="text"
                value={collectNotes}
                onChange={(e) => setCollectNotes(e.target.value)}
                placeholder="e.g. Advance payment / Collected at reception"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-3.5 py-2 text-xs font-semibold text-slate-900 focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-500/20 transition-all"
              />
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="tap-bounce flex-1 h-11 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={submitting || !selectedStudent || Boolean(successToast)}
                className="tap-bounce flex-1 h-11 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/25 transition-all disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Recording...</span>
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" />
                    <span>Record Payment</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}

        {/* ================================================================= */}
        {/* MODE 2: GENERATE FEE DUE (EXISTING ROSTER FLOW)                   */}
        {/* ================================================================= */}
        {modalMode === "generate" && (
          <form onSubmit={handleGenerateSubmit} className="space-y-3.5 pt-3">
            {/* Select Student */}
            <div>
              <label
                htmlFor="fee-student"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Select Student
              </label>

              {loadingRoster ? (
                <div className="h-10 rounded-2xl bg-slate-100 flex items-center px-3.5 text-xs text-slate-400 gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                  <span>Loading students...</span>
                </div>
              ) : rosterStudents.length > 0 ? (
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <User className="h-4 w-4" />
                  </div>
                  <select
                    id="fee-student"
                    value={generateStudentId}
                    onChange={(e) => setGenerateStudentId(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-3.5 py-2.5 text-xs font-bold text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all cursor-pointer"
                  >
                    {rosterStudents.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name} ({s.batch})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                  No students enrolled yet. Please add a student first!
                </div>
              )}
            </div>

            {/* Fee Type Selection */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Fee Type
              </label>
              <div className="grid grid-cols-3 gap-1.5 p-1 rounded-2xl bg-slate-100 border border-slate-200">
                <button
                  type="button"
                  onClick={() => setFeeType("monthly_recurring")}
                  className={`py-1.5 px-2 rounded-xl text-[11px] font-bold transition-all text-center ${
                    feeType === "monthly_recurring"
                      ? "bg-white text-blue-600 shadow-xs"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  Monthly
                </button>
                <button
                  type="button"
                  onClick={() => setFeeType("adhoc")}
                  className={`py-1.5 px-2 rounded-xl text-[11px] font-bold transition-all text-center ${
                    feeType === "adhoc"
                      ? "bg-white text-blue-600 shadow-xs"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  Ad-hoc
                </button>
                <button
                  type="button"
                  onClick={() => setFeeType("registration")}
                  className={`py-1.5 px-2 rounded-xl text-[11px] font-bold transition-all text-center ${
                    feeType === "registration"
                      ? "bg-white text-blue-600 shadow-xs"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  Registration
                </button>
              </div>
            </div>

            {/* Title (for Ad-hoc or Registration) */}
            {feeType !== "monthly_recurring" && (
              <div>
                <label
                  htmlFor="fee-title"
                  className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
                >
                  Fee Description / Purpose
                </label>
                <input
                  id="fee-title"
                  type="text"
                  value={generateTitle}
                  onChange={(e) => setGenerateTitle(e.target.value)}
                  placeholder={feeType === "registration" ? "e.g. Admission Fee" : "e.g. Study Material / Exam Fee"}
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-xs font-bold text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            )}

            {/* Month */}
            <div>
              <label
                htmlFor="fee-month"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                {feeType === "monthly_recurring" ? "Billing Cycle Month" : "Billing Month Reference"}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Calendar className="h-4 w-4" />
                </div>
                <input
                  id="fee-month"
                  type="text"
                  value={generateMonth}
                  onChange={(e) => setGenerateMonth(e.target.value)}
                  placeholder="e.g. November 2026"
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-3.5 py-2.5 text-xs font-bold text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            </div>

            {/* Amount Due */}
            <div>
              <label
                htmlFor="fee-amount"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Amount Due (₹)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 font-bold text-xs">
                  <span>₹</span>
                </div>
                <input
                  id="fee-amount"
                  type="number"
                  value={generateAmountDue}
                  onChange={(e) => setGenerateAmountDue(e.target.value)}
                  placeholder="1500"
                  min="1"
                  step="any"
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-8 pr-3.5 py-2.5 text-xs font-bold text-slate-900 font-mono focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            </div>

            {/* Due Date */}
            <div>
              <label
                htmlFor="fee-due-date"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Payment Due Date
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Clock className="h-4 w-4" />
                </div>
                <input
                  id="fee-due-date"
                  type="date"
                  value={generateDueDate}
                  onChange={(e) => setGenerateDueDate(e.target.value)}
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-3.5 py-2.5 text-xs font-bold text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="tap-bounce flex-1 h-11 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={submitting || Boolean(successToast) || rosterStudents.length === 0}
                className="tap-bounce flex-1 h-11 rounded-2xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-blue-600/25 transition-all disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Generating...</span>
                  </>
                ) : (
                  <>
                    <IndianRupee className="h-4 w-4" />
                    <span>Generate Fee</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
