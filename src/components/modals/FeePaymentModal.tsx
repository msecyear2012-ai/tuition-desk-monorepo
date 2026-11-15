"use client";

import { useState, useEffect } from "react";
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Banknote,
  ShieldCheck,
  Clock,
} from "lucide-react";
import { apiClient, getCurrentCenterId, invalidateApiCache } from "@/lib/apiClient";
import { getAuthenticatedCenter, CenterInfo } from "@/lib/centerProfile";
import { ReceiptSlipData } from "./ReceiptSlipModal";

export interface TargetFeeInfo {
  _id: string;
  month: string;
  title?: string;
  amountDue: number;
  paidAmount?: number;
  totalAmount?: number;
  originalAmountDue?: number;
  billingMonth?: string;
  feeType?: string;
  isAdvance?: boolean;
}

export interface TargetStudentInfo {
  _id: string;
  name: string;
  batch?: string;
  centerId?: string;
  monthlyFee?: number;
}

export interface FeePaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  student: TargetStudentInfo | null;
  fee?: TargetFeeInfo | null;
  onSuccess: (updatedFee: unknown, receiptData: ReceiptSlipData) => void;
}

/**
 * Returns current date in IST (Asia/Kolkata UTC+5:30) as YYYY-MM-DD
 */
function getTodayIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + istOffset);
  return istDate.toISOString().slice(0, 10);
}

interface FeePaymentModalContentProps {
  onClose: () => void;
  student: TargetStudentInfo;
  fee?: TargetFeeInfo | null;
  onSuccess: (updatedFee: unknown, receiptData: ReceiptSlipData) => void;
}

function FeePaymentModalContent({
  onClose,
  student,
  fee,
  onSuccess,
}: FeePaymentModalContentProps) {
  // Current user / collector profile
  const [userProfile, setUserProfile] = useState<CenterInfo | null>(null);

  // Form states initialized directly from props
  const [amountInput, setAmountInput] = useState<string>(() => {
    if (fee) {
      const outstanding = Number(fee.amountDue) || 0;
      return outstanding > 0 ? String(outstanding) : "";
    }
    if (student.monthlyFee) {
      return String(student.monthlyFee);
    }
    return "1500";
  });
  const [paymentMode, setPaymentMode] = useState<string>("Cash");
  const [paymentDate, setPaymentDate] = useState<string>(() => getTodayIST());
  const [notesInput, setNotesInput] = useState<string>("");
  const feeTypeChoice: "monthly_recurring" | "advance" = fee?.isAdvance ? "advance" : "monthly_recurring";

  // Status states
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isFeeAlreadyPaid, setIsFeeAlreadyPaid] = useState<boolean>(false);

  // Fetch logged-in user profile identity
  useEffect(() => {
    let ignore = false;
    getAuthenticatedCenter().then((profile) => {
      if (!ignore && profile) {
        setUserProfile(profile);
      }
    });
    return () => {
      ignore = true;
    };
  }, []);

  const isTeacher = userProfile?.role === "teacher";
  const collectorName = isTeacher
    ? userProfile?.teacherName || userProfile?.name || "Teacher"
    : userProfile?.ownerName || userProfile?.name || "Institute Owner";

  const outstandingBalance = fee ? Number(fee.amountDue) || 0 : 0;
  const originalDue = fee
    ? fee.originalAmountDue ?? (Number(fee.amountDue || 0) + Number(fee.paidAmount || 0))
    : 0;
  const currentPaid = fee ? Number(fee.paidAmount) || 0 : 0;

  const numAmount = Number(amountInput);
  const isAmountValid = !isNaN(numAmount) && numAmount > 0;
  const isOverpaying = fee && isAmountValid && numAmount > outstandingBalance;
  const isFullSettlement = fee && isAmountValid && Math.abs(numAmount - outstandingBalance) < 0.001;
  const isPartial = fee && isAmountValid && numAmount < outstandingBalance;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isAmountValid) {
      setError("Please enter a valid payment amount greater than ₹0.");
      return;
    }

    if (fee && numAmount > outstandingBalance) {
      setError(
        `Payment amount of ₹${numAmount} exceeds the remaining balance of ₹${outstandingBalance}.`
      );
      return;
    }

    if (!paymentDate) {
      setError("Please select a valid payment date.");
      return;
    }

    setSubmitting(true);

    try {
      const centerId = student.centerId || getCurrentCenterId();
      // Generate client-side UUID idempotency key to prevent double submits
      const idempotencyKey = `manual_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      const payload: Record<string, unknown> = {
        centerId,
        studentId: student._id,
        amount: numAmount,
        paymentMode: isTeacher ? "Cash" : paymentMode,
        paymentDate: new Date(paymentDate).toISOString(),
        notes: notesInput.trim(),
        idempotencyKey,
      };

      if (fee) {
        payload.feeId = fee._id;
        payload.feeType = fee.feeType || (fee.isAdvance ? "advance" : "monthly_recurring");
        payload.month = fee.month;
        if (fee.billingMonth) {
          payload.billingMonth = fee.billingMonth;
        }
      } else {
        payload.feeType = feeTypeChoice;
        if (feeTypeChoice === "advance") {
          payload.isAdvance = true;
          payload.title = "Advance Payment";
        }
      }

      const res = await apiClient<{
        success: boolean;
        message?: string;
        error?: string;
        code?: string;
        data?: Record<string, unknown>;
      }>("/fees/manual-collection", {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
        },
        body: payload,
      });

      if (!res.success || !res.data) {
        throw new Error(res.error || "Failed to record payment collection.");
      }

      const feeData = res.data as Record<string, unknown>;
      const history = (feeData.paymentHistory as Array<Record<string, unknown>>) || [];
      const latestPayment = history.length > 0 ? history[history.length - 1] : null;
      const receiptNumber = String(
        latestPayment?.receiptNumber || feeData.receiptNumber || `RCPT-${student._id.slice(-6).toUpperCase()}`
      );

      const calculatedRemaining = fee ? Math.max(0, outstandingBalance - numAmount) : 0;

      const receiptSlip: ReceiptSlipData = {
        receiptNumber,
        studentName: student.name,
        batchName: student.batch,
        amount: numAmount,
        paymentMode: isTeacher ? "Cash" : paymentMode,
        paymentDate,
        title: fee?.title || fee?.month || (feeTypeChoice === "advance" ? "Advance Fee Payment" : "Monthly Tuition Fee"),
        collectorName,
        collectorRole: isTeacher ? "teacher" : "owner",
        isProvisional: isTeacher,
        notes: notesInput.trim(),
        remainingBalance: calculatedRemaining,
      };

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("msec:collection-recorded", {
            detail: {
              feeId: String(feeData._id || fee?._id || ""),
              amount: numAmount,
            },
          })
        );
      }

      onSuccess(feeData, receiptSlip);
      onClose();
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string; status?: number; data?: unknown };
      const msg = errObj?.message || "Failed to record payment collection.";
      const isAlreadyPaid =
        errObj?.code === "FEE_ALREADY_PAID" ||
        errObj?.status === 409 ||
        /already paid/i.test(msg);

      if (isAlreadyPaid) {
        setIsFeeAlreadyPaid(true);
        const targetFeeId = String(fee?._id || "");
        invalidateApiCache();

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("msec:fee-already-paid", {
              detail: {
                feeId: targetFeeId,
                message: "This fee is already Paid in full. The pending dues list has been updated.",
              },
            })
          );
        }

        setError("Monthly fee is already Paid in full. The pending dues list has been updated.");

        setTimeout(() => {
          onClose();
        }, 1800);
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-payment-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-fade-in"
    >
      <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden relative">
        {/* Header */}
        <div
          className={`p-5 text-white relative ${
            isTeacher
              ? "bg-gradient-to-r from-emerald-600 via-teal-700 to-emerald-800"
              : "bg-gradient-to-r from-blue-600 via-indigo-700 to-blue-800"
          }`}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/15 hover:bg-white/25 active:scale-90 flex items-center justify-center text-white transition-all cursor-pointer disabled:opacity-50"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-2 text-emerald-100 text-xs font-bold uppercase tracking-wider">
            <Banknote className="w-4 h-4" />
            <span>{isTeacher ? "Teacher Cash Collection" : "Record Fee Payment"}</span>
          </div>
          <h2
            id="record-payment-title"
            className="text-xl font-black mt-1 tracking-tight text-white truncate"
          >
            {student.name}
          </h2>
          <p className="text-xs text-white/80 mt-0.5 truncate">
            {fee ? `${fee.title || fee.month} • ${student.batch || "General"}` : student.batch || "General Batch"}
          </p>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 font-semibold flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="flex-1">{error}</span>
            </div>
          )}

          {/* Fee Balance Snapshot Cards (if targeted fee exists) */}
          {fee && (
            <div className="grid grid-cols-3 gap-2 p-3 rounded-2xl bg-slate-50 border border-slate-200/80 text-center">
              <div>
                <span className="text-[10px] uppercase font-bold text-slate-400 block">
                  Invoiced
                </span>
                <span className="font-mono font-bold text-slate-800 text-xs">
                  ₹{originalDue.toLocaleString("en-IN")}
                </span>
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-slate-400 block">
                  Paid to Date
                </span>
                <span className="font-mono font-bold text-emerald-700 text-xs">
                  ₹{currentPaid.toLocaleString("en-IN")}
                </span>
              </div>
              <div>
                <span className="text-[10px] uppercase font-extrabold text-rose-500 block">
                  Balance Due
                </span>
                <span className="font-mono font-black text-rose-700 text-xs">
                  ₹{outstandingBalance.toLocaleString("en-IN")}
                </span>
              </div>
            </div>
          )}

          {/* Amount Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 block">
                Amount to Collect (₹) *
              </label>
              {fee && outstandingBalance > 0 && (
                <button
                  type="button"
                  onClick={() => setAmountInput(String(outstandingBalance))}
                  className="text-[11px] font-bold text-emerald-700 hover:text-emerald-800 hover:underline"
                >
                  Pay Full (₹{outstandingBalance.toLocaleString("en-IN")})
                </button>
              )}
            </div>

            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-400 font-bold text-sm">
                ₹
              </span>
              <input
                type="number"
                min="1"
                step="1"
                required
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder={fee ? `e.g. ${outstandingBalance}` : "e.g. 1500"}
                className={`w-full pl-8 pr-3.5 py-2.5 rounded-xl border text-sm font-mono font-bold text-slate-900 focus:outline-hidden focus:ring-2 ${
                  isOverpaying
                    ? "border-rose-300 bg-rose-50/50 focus:ring-rose-500"
                    : "border-slate-200 focus:ring-emerald-500"
                }`}
              />
            </div>

            {/* Live Partial / Full Settlement feedback */}
            {fee && isAmountValid && (
              <div className="pt-0.5">
                {isOverpaying ? (
                  <span className="text-[10.5px] font-bold text-rose-600 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    Cannot exceed remaining balance of ₹{outstandingBalance.toLocaleString("en-IN")}
                  </span>
                ) : isFullSettlement ? (
                  <span className="text-[10.5px] font-bold text-emerald-700 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    Full Settlement • Fee status will become &apos;Paid&apos;
                  </span>
                ) : isPartial ? (
                  <span className="text-[10.5px] font-bold text-amber-700 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-amber-600" />
                    Partial Payment • Remaining Balance: ₹
                    {(outstandingBalance - numAmount).toLocaleString("en-IN")}
                  </span>
                ) : null}
              </div>
            )}

            {/* Quick Presets */}
            {fee && outstandingBalance > 500 && (
              <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                {[500, 1000, 1500, 2000]
                  .filter((preset) => preset < outstandingBalance)
                  .map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAmountInput(String(preset))}
                      className="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                    >
                      ₹{preset.toLocaleString("en-IN")}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Payment Mode Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              Payment Mode *
            </label>
            {isTeacher ? (
              <div className="px-3.5 py-2 rounded-xl border border-emerald-200 bg-emerald-50/70 text-xs font-bold text-emerald-900 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Banknote className="w-4 h-4 text-emerald-700" />
                  Physical Cash Collection
                </span>
                <span className="text-[10px] uppercase font-extrabold px-1.5 py-0.5 rounded bg-emerald-200/80 text-emerald-900">
                  Cash Only
                </span>
              </div>
            ) : (
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-800 bg-white focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
              >
                <option value="Cash">Cash</option>
                <option value="UPI">UPI / Online QR</option>
                <option value="Bank Transfer">Bank Transfer / IMPS</option>
                <option value="Cheque">Cheque</option>
              </select>
            )}
          </div>

          {/* Payment Date */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              Payment Date *
            </label>
            <input
              type="date"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {/* Notes (Optional) */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              Receipt Notes / Remarks (Optional)
            </label>
            <input
              type="text"
              maxLength={100}
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
              placeholder="e.g. Paid in cash at tuition center desk"
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 placeholder:text-slate-400"
            />
          </div>

          {/* Collector Attribution Notice */}
          <div
            className={`p-3 rounded-2xl border text-xs space-y-1 ${
              isTeacher
                ? "bg-amber-50/80 border-amber-200/90 text-amber-900"
                : "bg-blue-50/80 border-blue-200/90 text-blue-900"
            }`}
          >
            <div className="flex items-center justify-between font-bold text-[11px]">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Collector Identity: {collectorName}</span>
              </span>
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded font-extrabold bg-white/80 border">
                {isTeacher ? "Teacher" : "Owner"}
              </span>
            </div>
            <p className="text-[10px] leading-relaxed opacity-90">
              {isTeacher
                ? "Provisional Custody: Cash collected will be recorded under your custody. An immutable receipt will be issued to parent immediately."
                : "Direct Owner Custody: Cash is received and verified directly by the Institute Owner."}
            </p>
          </div>

          {/* Submit Actions */}
          <div className="pt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="tap-bounce flex-1 h-10 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors disabled:opacity-50"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={Boolean(submitting || !isAmountValid || isOverpaying || isFeeAlreadyPaid)}
              className="tap-bounce flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/25 transition-all disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin text-white" />
              ) : isFeeAlreadyPaid ? (
                <CheckCircle2 className="w-4 h-4 stroke-[2.2]" />
              ) : (
                <CheckCircle2 className="w-4 h-4 stroke-[2.2]" />
              )}
              <span>{isFeeAlreadyPaid ? "Already Paid • Refreshing..." : "Record & Issue Receipt"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function FeePaymentModal(props: FeePaymentModalProps) {
  if (!props.isOpen || !props.student) return null;
  return (
    <FeePaymentModalContent
      key={`${props.student._id}_${props.fee?._id || "general"}`}
      {...props}
      student={props.student}
    />
  );
}
