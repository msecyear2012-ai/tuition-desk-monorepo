"use client";

import { useState, useEffect } from "react";
import {
  X,
  User,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Receipt,
  Banknote,
  AlertCircle,
  RefreshCw,
  PlusCircle,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { PaymentEntryItem, CustodyBreakdownItem } from "@/types";
import { ReceiptSlipData } from "./ReceiptSlipModal";
import StudentPhoneMasked from "@/components/common/StudentPhoneMasked";

export interface FeeDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  feeId: string | null;
  userRole?: "owner" | "teacher" | string;
  onRecordPayment?: (fee: Record<string, unknown>, student: Record<string, unknown>) => void;
  onViewReceipt?: (receiptData: ReceiptSlipData) => void;
}

function formatDate(dateInput?: string | Date | null): string {
  if (!dateInput) return "N/A";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(dateInput);
  }
}

export default function FeeDetailModal({
  isOpen,
  onClose,
  feeId,
  userRole = "owner",
  onRecordPayment,
  onViewReceipt,
}: FeeDetailModalProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [feeData, setFeeData] = useState<Record<string, unknown> | null>(null);
  const [refreshIndex, setRefreshIndex] = useState<number>(0);

  useEffect(() => {
    if (!isOpen || !feeId) {
      return;
    }
    let ignore = false;

    async function load() {
      try {
        const res = await apiClient<{
          success: boolean;
          data: Record<string, unknown>;
          error?: string;
        }>(`/fees/${feeId}`, { skipCache: true });

        if (!ignore) {
          if (res.success && res.data) {
            setFeeData(res.data);
          } else {
            setError(res.error || "Failed to load fee details");
          }
        }
      } catch (err: unknown) {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : "Error fetching fee details";
          setError(msg);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      ignore = true;
    };
  }, [isOpen, feeId, refreshIndex]);

  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    setRefreshIndex((prev) => prev + 1);
  };

  if (!isOpen || !feeId) return null;

  const isTeacher = userRole === "teacher";
  const student = (feeData?.studentId as Record<string, unknown>) || null;
  const studentName = (student?.name as string) || "Student";
  const batchName = (student?.batch as string) || (feeData?.batchAtPayment as string) || "General Batch";

  const status = String(feeData?.status || "Pending");
  const isPaid = status === "Paid";
  const isPartial = status === "Partial Paid";
  const isPendingReview = status === "Verification Pending";

  const amountDue = Number(feeData?.amountDue) || 0;
  const paidAmount = Number(feeData?.paidAmount) || 0;
  const originalDue =
    Number(feeData?.originalAmountDue) || (amountDue + paidAmount);

  const paymentHistory = (feeData?.paymentHistory as PaymentEntryItem[]) || [];
  const custodyBreakdown = feeData?.custodyBreakdown as CustodyBreakdownItem | undefined;

  const handleOpenPayment = () => {
    if (onRecordPayment && feeData && student) {
      onRecordPayment(feeData, student);
      onClose();
    }
  };

  const handleOpenReceiptForEntry = (entry: PaymentEntryItem) => {
    if (!onViewReceipt) return;

    const receiptData: ReceiptSlipData = {
      receiptNumber: entry.receiptNumber,
      studentName,
      batchName,
      amount: entry.amount,
      paymentMode: entry.paymentMode || "Cash",
      paymentDate: entry.paymentDate,
      title: (feeData?.title as string) || (feeData?.month as string) || "Tuition Fee",
      collectorName: entry.receivedByName,
      collectorRole: entry.receivedByRole,
      isProvisional: entry.receivedByRole === "teacher" || entry.isProvisional,
      remainingBalance: Math.max(0, originalDue - (paidAmount)),
      notes: entry.notes,
    };

    onViewReceipt(receiptData);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fee-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-fade-in"
    >
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden relative max-h-[90vh] flex flex-col">
        {/* Modal Top Header */}
        <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 p-5 text-white relative flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/15 hover:bg-white/25 active:scale-90 flex items-center justify-center text-white transition-all cursor-pointer"
            aria-label="Close fee details"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-2 text-indigo-200 text-xs font-bold uppercase tracking-wider">
            <Receipt className="w-4 h-4" />
            <span>Student Fee Detail &amp; Payment History</span>
          </div>
          <h2
            id="fee-detail-title"
            className="text-xl font-black mt-1 tracking-tight text-white truncate"
          >
            {studentName}
          </h2>
          <p className="text-xs text-indigo-200/90 mt-0.5 truncate">
            {batchName} • {(feeData?.title as string) || (feeData?.month as string) || "Monthly Fee"}
          </p>
        </div>

        {/* Modal Scrollable Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-xs">
          {loading ? (
            <div className="py-12 text-center text-slate-400 space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-600" />
              <p className="font-semibold text-xs">Loading fee breakdown...</p>
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-700 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span className="font-semibold">{error}</span>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                className="px-2 py-1 bg-white border border-rose-300 rounded-lg text-xs font-bold hover:bg-rose-100 cursor-pointer"
              >
                Retry
              </button>
            </div>
          ) : feeData ? (
            <>
              {/* Financial Status KPI Grid */}
              <div className="grid grid-cols-3 gap-2.5 p-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-center">
                <div className="space-y-0.5">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">
                    Invoiced Due
                  </span>
                  <div className="font-mono font-black text-slate-900 text-sm">
                    ₹{originalDue.toLocaleString("en-IN")}
                  </div>
                </div>

                <div className="space-y-0.5">
                  <span className="text-[10px] uppercase font-bold text-emerald-700 block">
                    Paid to Date
                  </span>
                  <div className="font-mono font-black text-emerald-700 text-sm">
                    ₹{paidAmount.toLocaleString("en-IN")}
                  </div>
                </div>

                <div className="space-y-0.5">
                  <span className="text-[10px] uppercase font-extrabold text-rose-600 block">
                    Remaining Balance
                  </span>
                  <div className="font-mono font-black text-rose-700 text-sm">
                    ₹{amountDue.toLocaleString("en-IN")}
                  </div>
                </div>
              </div>

              {/* Status & Privacy Banner */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-100/80 border border-slate-200 flex-wrap gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500 font-semibold">Ledger Status:</span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-extrabold border ${
                      isPaid
                        ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                        : isPartial
                        ? "bg-amber-100 text-amber-900 border-amber-300"
                        : isPendingReview
                        ? "bg-amber-500 text-white border-amber-600"
                        : "bg-rose-50 text-rose-700 border-rose-200"
                    }`}
                  >
                    {isPaid ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    ) : (
                      <Clock className="w-3 h-3" />
                    )}
                    <span>{status}</span>
                  </span>
                </div>

                {Boolean(student?.parentWhatsApp) && (
                  <div className="flex items-center gap-1.5 text-slate-600">
                    <span className="text-slate-400">Parent:</span>
                    <StudentPhoneMasked
                      phone={String(student?.parentWhatsApp)}
                      userRole={userRole}
                      className="font-mono font-bold"
                    />
                  </div>
                )}
              </div>

              {/* Physical Cash Custody & Handover Breakdown */}
              {custodyBreakdown && (
                <div className="p-3.5 rounded-2xl bg-indigo-50/70 border border-indigo-200/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-indigo-950 flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-indigo-700" />
                      <span>Physical Cash Custody &amp; Handover Status</span>
                    </span>
                    <span className="text-[9.5px] uppercase font-extrabold px-1.5 py-0.5 rounded bg-white text-indigo-900 border border-indigo-200">
                      {isTeacher ? "Teacher View" : "Owner Audit"}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
                    <div className="p-2 rounded-xl bg-white border border-indigo-100">
                      <span className="text-[9.5px] uppercase font-bold text-slate-400 block">
                        Parent Paid (Cleared)
                      </span>
                      <span className="font-mono font-black text-emerald-700">
                        ₹{(paidAmount).toLocaleString("en-IN")}
                      </span>
                    </div>

                    <div className="p-2 rounded-xl bg-white border border-indigo-100">
                      <span className="text-[9.5px] uppercase font-bold text-slate-400 block">
                        {isTeacher ? "In-Hand (Provisional)" : "Cash with Teacher"}
                      </span>
                      <span className="font-mono font-black text-amber-800">
                        ₹{(custodyBreakdown.teacherInHandAmount || 0).toLocaleString("en-IN")}
                      </span>
                    </div>

                    <div className="p-2 rounded-xl bg-white border border-indigo-100">
                      <span className="text-[9.5px] uppercase font-bold text-slate-400 block">
                        {isTeacher ? "Verified by Owner" : "In Owner Possession"}
                      </span>
                      <span className="font-mono font-black text-indigo-900">
                        ₹{(custodyBreakdown.ownerVerifiedAmount || 0).toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>

                  <p className="text-[10px] text-indigo-700/90 leading-relaxed pt-0.5">
                    <strong>Rule:</strong> Handover represents physical cash transfers between staff and does NOT alter or duplicate parent debt reduction.
                  </p>
                </div>
              )}

              {/* Complete Payment Line Items History */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-extrabold text-slate-900 text-xs tracking-tight flex items-center gap-1.5">
                    <Receipt className="w-3.5 h-3.5 text-slate-500" />
                    <span>Payment History ({paymentHistory.length})</span>
                  </h3>
                  {amountDue > 0 && onRecordPayment && (
                    <button
                      type="button"
                      onClick={handleOpenPayment}
                      className="tap-bounce text-[11px] font-bold text-emerald-700 hover:text-emerald-800 flex items-center gap-1 cursor-pointer"
                    >
                      <PlusCircle className="w-3.5 h-3.5" />
                      <span>Record Collection</span>
                    </button>
                  )}
                </div>

                {paymentHistory.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-slate-400">
                    <Banknote className="w-6 h-6 mx-auto mb-1.5 text-slate-300" />
                    <p className="font-medium text-xs">No payment records yet for this fee.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {paymentHistory.map((payment, idx) => {
                      const isTeacherCollected = payment.receivedByRole === "teacher";
                      const allocations = payment.allocations || [];
                      const latestAlloc = allocations.length > 0 ? allocations[allocations.length - 1] : null;

                      // Resolve handover badge
                      let handoverBadge = null;
                      if (isTeacherCollected) {
                        if (latestAlloc?.status === "verified") {
                          handoverBadge = {
                            label: `Verified by Owner ${latestAlloc.handoverNumber ? `(${latestAlloc.handoverNumber})` : ""}`,
                            style: "bg-emerald-50 text-emerald-800 border-emerald-300",
                          };
                        } else if (latestAlloc?.status === "pending_verification") {
                          handoverBadge = {
                            label: `Submitted for Handover ${latestAlloc.handoverNumber ? `(${latestAlloc.handoverNumber})` : ""}`,
                            style: "bg-blue-50 text-blue-800 border-blue-300 animate-pulse",
                          };
                        } else if (latestAlloc?.status === "rejected") {
                          handoverBadge = {
                            label: "Handover Rejected (Cash in Teacher Custody)",
                            style: "bg-rose-50 text-rose-800 border-rose-300",
                          };
                        } else if (latestAlloc?.status === "disputed") {
                          handoverBadge = {
                            label: "Discrepancy Disputed",
                            style: "bg-purple-50 text-purple-800 border-purple-300",
                          };
                        } else {
                          handoverBadge = {
                            label: "Provisional (Teacher In-Hand)",
                            style: "bg-amber-100 text-amber-900 border-amber-300",
                          };
                        }
                      } else {
                        handoverBadge = {
                          label: "Direct Owner Custody (Cleared)",
                          style: "bg-emerald-50 text-emerald-800 border-emerald-300",
                        };
                      }

                      return (
                        <div
                          key={String(payment.paymentId || payment._id || idx)}
                          className="p-3 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50/70 transition-colors space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-mono font-black text-slate-900 text-xs">
                                  {payment.receiptNumber || `RCPT-${idx + 1}`}
                                </span>
                                <span className="text-slate-300">•</span>
                                <span className="font-mono font-black text-emerald-700 text-xs">
                                  ₹{(payment.amount || 0).toLocaleString("en-IN")}
                                </span>
                                <span className="text-slate-300">•</span>
                                <span className="font-semibold text-slate-600 text-[11px]">
                                  {payment.paymentMode || "Cash"}
                                </span>
                              </div>
                              <p className="text-[10px] text-slate-400">
                                {formatDate(payment.paymentDate || payment.recordedAt)}
                              </p>
                            </div>

                            {/* View Receipt Trigger */}
                            {onViewReceipt && (
                              <button
                                type="button"
                                onClick={() => handleOpenReceiptForEntry(payment)}
                                className="tap-bounce px-2 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 text-[10.5px] font-bold text-slate-700 flex items-center gap-1 shadow-2xs cursor-pointer"
                              >
                                <Receipt className="w-3 h-3 text-emerald-600" />
                                <span>Receipt</span>
                              </button>
                            )}
                          </div>

                          {/* Attribution & Custody Badges */}
                          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-semibold">
                              <User className="w-3 h-3 text-slate-500" />
                              <span>Collected by:</span>
                              <strong className="text-slate-900">
                                {payment.receivedByName || (isTeacherCollected ? "Teacher" : "Owner")}
                              </strong>
                              <span className="uppercase text-[9px] px-1 rounded bg-white font-extrabold border">
                                {payment.receivedByRole === "teacher" ? "Teacher" : "Owner"}
                              </span>
                            </span>

                            {handoverBadge && (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-extrabold border ${handoverBadge.style}`}
                              >
                                {handoverBadge.label}
                              </span>
                            )}
                          </div>

                          {payment.notes && (
                            <p className="text-[10.5px] text-slate-500 italic">
                              &quot;{payment.notes}&quot;
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="tap-bounce px-4 h-9 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors"
          >
            Close
          </button>

          {amountDue > 0 && onRecordPayment && feeData && student && (
            <button
              type="button"
              onClick={handleOpenPayment}
              className="tap-bounce px-4 h-9 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-600/20 transition-all cursor-pointer"
            >
              <Banknote className="w-4 h-4" />
              <span>Record Payment (Balance: ₹{amountDue.toLocaleString("en-IN")})</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
