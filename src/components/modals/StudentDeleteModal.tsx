"use client";

import { useState, useEffect } from "react";
import {
  X,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Banknote,
  ShieldCheck,
  CreditCard,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { StudentRecord } from "@/types";

interface StudentDeleteModalProps {
  isOpen: boolean;
  student: StudentRecord | null;
  onClose: () => void;
  onSuccess: (deletedStudentName: string) => void;
}

export default function StudentDeleteModal({
  isOpen,
  student,
  onClose,
  onSuccess,
}: StudentDeleteModalProps) {
  const [checkingDues, setCheckingDues] = useState(true);
  const [unpaidAmount, setUnpaidAmount] = useState<number>(0);
  const [pendingFeesCount, setPendingFeesCount] = useState<number>(0);
  const [amountReceived, setAmountReceived] = useState<string>("0");
  const [paymentMode, setPaymentMode] = useState<string>("Cash");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch dues information whenever the modal opens for a student
  useEffect(() => {
    let isMounted = true;

    if (!isOpen || !student?._id) {
      return;
    }

    apiClient<{
      unpaidAmount?: number;
      pendingFeesCount?: number;
    }>(`/students/${student._id}?checkDues=true`)
      .then((res) => {
        if (!isMounted) return;
        const unpaid = Number(res.data?.unpaidAmount) || 0;
        const count = Number(res.data?.pendingFeesCount) || 0;
        setUnpaidAmount(unpaid);
        setPendingFeesCount(count);
        setAmountReceived(unpaid > 0 ? String(unpaid) : "0");
        setCheckingDues(false);
      })
      .catch((err: unknown) => {
        if (!isMounted) return;
        // Fallback: allow modal to load and catch settlement response on delete attempt
        setCheckingDues(false);
        if (err instanceof Error && !err.message.includes("404")) {
          setError(err.message);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, student?._id]);

  if (!isOpen || !student) return null;

  const handleExecuteDelete = async (
    settlementAction?: "mark_paid" | "waive_and_delete"
  ) => {
    if (!student?._id) return;
    setIsDeleting(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {};
      if (settlementAction) {
        payload.settlementAction = settlementAction;
        if (settlementAction === "mark_paid") {
          payload.amountReceived = Number(amountReceived) || unpaidAmount;
          payload.paymentMode = paymentMode;
        }
      }

      await apiClient(`/students/${student._id}`, {
        method: "DELETE",
        body: Object.keys(payload).length > 0 ? payload : undefined,
      });

      onSuccess(student.name);
      onClose();
    } catch (err: unknown) {
      const errorObj = err as {
        status?: number;
        data?: { unpaidAmount?: number; pendingFeesCount?: number };
        message?: string;
      };

      // 409 Conflict: pending dues detected by backend
      if (
        errorObj.status === 409 &&
        errorObj.data &&
        typeof errorObj.data.unpaidAmount === "number"
      ) {
        const detectedUnpaid = Number(errorObj.data.unpaidAmount) || 0;
        const detectedCount = Number(errorObj.data.pendingFeesCount) || 1;
        setUnpaidAmount(detectedUnpaid);
        setPendingFeesCount(detectedCount);
        setAmountReceived(String(detectedUnpaid));
        setError(
          `Unpaid dues detected (₹${detectedUnpaid.toLocaleString(
            "en-IN"
          )}). Please select a settlement option below.`
        );
      } else {
        setError(
          errorObj.message ||
            (err instanceof Error ? err.message : "Failed to delete student.")
        );
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center shadow-xs">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900">
                Delete Student
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                {student.name} • {student.batch || "No Batch"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 font-medium leading-relaxed">{error}</div>
            </div>
          )}

          {checkingDues ? (
            <div className="py-8 text-center space-y-2">
              <Loader2 className="w-7 h-7 text-blue-600 animate-spin mx-auto" />
              <p className="text-xs font-semibold text-slate-600">
                Checking pending fee records...
              </p>
            </div>
          ) : unpaidAmount === 0 ? (
            /* Clean Confirmation: 0 Unpaid Dues */
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs font-black text-emerald-900">
                    No pending dues. Delete student?
                  </p>
                  <p className="text-[11.5px] text-emerald-800/90 leading-relaxed">
                    This student has no outstanding dues. Deleting will cleanly
                    remove the student admission profile and cancel any
                    associated reminders or scheduled jobs.
                  </p>
                </div>
              </div>

              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-1">
                <div className="font-bold text-slate-800">
                  Are you sure you want to delete {student.name}?
                </div>
                <div className="text-[11px] text-slate-500">
                  This action is permanent and cannot be undone.
                </div>
              </div>
            </div>
          ) : (
            /* Unpaid Dues Detected: Highlight & Inline Settlement Form */
            <div className="space-y-4">
              {/* Highlight Banner */}
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-300 flex items-start gap-3 shadow-2xs">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="text-xs font-black text-amber-950 uppercase tracking-wider">
                    Unpaid Dues Detected
                  </div>
                  <div className="text-lg font-black text-amber-900 font-mono">
                    ₹{unpaidAmount.toLocaleString("en-IN")}
                  </div>
                  <p className="text-[11px] text-amber-800/90 leading-tight">
                    Across {pendingFeesCount} fee record(s). Settle or waive
                    these dues before deletion so no orphaned ghost dues remain
                    in the ledger.
                  </p>
                </div>
              </div>

              {/* Inline Settlement Form */}
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3.5">
                <div className="flex items-center gap-1.5 text-xs font-extrabold text-slate-800">
                  <Banknote className="w-4 h-4 text-emerald-600" />
                  <span>Settle Dues Before Deletion</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Amount Received Input */}
                  <div>
                    <label
                      htmlFor="amountReceivedInput"
                      className="block text-[11px] font-bold text-slate-600 mb-1"
                    >
                      Amount Received (₹)
                    </label>
                    <input
                      id="amountReceivedInput"
                      type="number"
                      min="0"
                      step="1"
                      value={amountReceived}
                      onChange={(e) => setAmountReceived(e.target.value)}
                      disabled={isDeleting}
                      className="w-full px-3 py-2 text-xs font-mono font-bold rounded-xl border border-slate-200 bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                      placeholder="Amount"
                    />
                  </div>

                  {/* Payment Mode Selector */}
                  <div>
                    <label
                      htmlFor="paymentModeSelect"
                      className="block text-[11px] font-bold text-slate-600 mb-1"
                    >
                      Payment Mode
                    </label>
                    <select
                      id="paymentModeSelect"
                      value={paymentMode}
                      onChange={(e) => setPaymentMode(e.target.value)}
                      disabled={isDeleting}
                      className="w-full px-3 py-2 text-xs font-semibold rounded-xl border border-slate-200 bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    >
                      <option value="Cash">Cash</option>
                      <option value="UPI">UPI</option>
                      <option value="Bank Transfer">Bank Transfer</option>
                      <option value="Cheque">Cheque</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-[10.5px] text-slate-500">
                  <ShieldCheck className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                  <span>
                    Payment will be recorded under Owner custody for financial
                    accounting.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="p-4 border-t border-slate-100 bg-slate-50/60 flex flex-col gap-2">
          {checkingDues ? (
            <button
              type="button"
              onClick={onClose}
              className="tap-bounce w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 transition-colors"
            >
              Cancel
            </button>
          ) : unpaidAmount === 0 ? (
            /* Standard Actions for 0 Dues */
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                disabled={isDeleting}
                className="tap-bounce px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleExecuteDelete()}
                disabled={isDeleting}
                className="tap-bounce px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
              >
                {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Delete Student</span>
              </button>
            </div>
          ) : (
            /* Settlement Actions for Unpaid Dues */
            <div className="space-y-2">
              {/* Primary Action: Mark Payment Received & Delete */}
              <button
                type="button"
                onClick={() => handleExecuteDelete("mark_paid")}
                disabled={isDeleting}
                className="tap-bounce w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-xs transition-colors cursor-pointer"
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4" />
                )}
                <span>Mark Payment Received &amp; Delete</span>
              </button>

              {/* Secondary Action: Waive Dues & Delete */}
              <button
                type="button"
                onClick={() => handleExecuteDelete("waive_and_delete")}
                disabled={isDeleting}
                className="tap-bounce w-full px-4 py-2 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <span>Waive Dues &amp; Delete</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                disabled={isDeleting}
                className="tap-bounce w-full py-1.5 text-center text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
