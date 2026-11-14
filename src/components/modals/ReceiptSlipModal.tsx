"use client";

import { X, Receipt, CheckCircle2, ShieldCheck, User, Calendar, Sparkles, Banknote, IndianRupee, Printer, Layers, Clock } from "lucide-react";

export interface ReceiptSlipData {
  receiptNumber: string;
  studentName: string;
  batchName?: string;
  amount: number;
  paymentMode: string;
  paymentDate?: string | Date;
  title?: string;
  collectorName?: string;
  collectorRole?: "teacher" | "owner" | string;
  isProvisional?: boolean;
  utrNumber?: string;
  notes?: string;
  remainingBalance?: number;
}

export interface ReceiptSlipModalProps {
  isOpen: boolean;
  onClose: () => void;
  receiptData: ReceiptSlipData | null;
}

function formatDate(dateInput?: string | Date): string {
  if (!dateInput) return "Today";
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

export default function ReceiptSlipModal({
  isOpen,
  onClose,
  receiptData,
}: ReceiptSlipModalProps) {
  if (!isOpen || !receiptData) return null;

  const isProvisional = Boolean(
    receiptData.isProvisional || receiptData.collectorRole === "teacher"
  );
  const isCash = Boolean(receiptData.paymentMode && /cash/i.test(receiptData.paymentMode));
  const remainingDue = Number(receiptData.remainingBalance);
  const hasRemainingDue = !isNaN(remainingDue) && remainingDue > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="receipt-slip-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-fade-in"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden relative">
        {/* Slip Top Header */}
        <div
          className={`p-5 text-white relative ${
            isProvisional
              ? "bg-gradient-to-r from-teal-700 via-emerald-700 to-amber-700"
              : "bg-gradient-to-r from-emerald-600 via-emerald-700 to-teal-800"
          }`}
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/15 hover:bg-white/25 active:scale-90 flex items-center justify-center text-white transition-all cursor-pointer"
            aria-label="Close receipt modal"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-2 text-emerald-100 text-xs font-bold uppercase tracking-wider">
            <Receipt className="w-4 h-4" />
            <span>{isProvisional ? "Provisional Receipt" : "Official Fee Receipt"}</span>
          </div>
          <h2
            id="receipt-slip-title"
            className="text-xl font-black mt-1 tracking-tight text-white"
          >
            Tuition Center Ledger
          </h2>
          <p className="text-xs text-emerald-100/90 mt-0.5">
            {isProvisional
              ? "Provisional Offline Cash Acknowledgement"
              : "Verified Payment Acknowledgement Slip"}
          </p>
        </div>

        {/* Slip Details Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Receipt Number & Verification State */}
          <div className="flex items-center justify-between pb-3 border-b border-dashed border-slate-200">
            <div>
              <span className="text-[10px] uppercase font-extrabold tracking-wider text-slate-400 block">
                Receipt Number
              </span>
              <span className="font-mono font-black text-slate-900 text-sm select-all">
                {receiptData.receiptNumber}
              </span>
            </div>
            <div className="text-right">
              <span className="text-[10px] uppercase font-extrabold tracking-wider text-slate-400 block">
                Status
              </span>
              {isProvisional ? (
                <span className="inline-flex items-center gap-1 font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-300 text-[10.5px]">
                  <Clock className="w-3 h-3 text-amber-600" />
                  PROVISIONAL CASH
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 text-[10.5px]">
                  <ShieldCheck className="w-3 h-3" />
                  PAID &amp; CLEARED
                </span>
              )}
            </div>
          </div>

          {/* Data Grid */}
          <div className="grid grid-cols-2 gap-3 text-slate-600">
            <div className="space-y-0.5">
              <span className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
                <User className="w-3 h-3" />
                Student Name
              </span>
              <p className="font-bold text-slate-900 text-xs truncate">
                {receiptData.studentName}
              </p>
            </div>

            <div className="space-y-0.5">
              <span className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
                <Layers className="w-3 h-3" />
                Batch
              </span>
              <p className="font-bold text-slate-900 text-xs truncate">
                {receiptData.batchName || "General Batch"}
              </p>
            </div>

            <div className="space-y-0.5">
              <span className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                Fee Description
              </span>
              <p className="font-bold text-slate-900 text-xs truncate">
                {receiptData.title || "Tuition Fee"}
              </p>
            </div>

            <div className="space-y-0.5">
              <span className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Payment Date
              </span>
              <p className="font-bold text-slate-900 text-xs">
                {formatDate(receiptData.paymentDate)}
              </p>
            </div>

            <div className="space-y-0.5">
              <span className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
                <Banknote className="w-3 h-3" />
                Payment Mode
              </span>
              <p className="font-bold text-slate-900 text-xs flex items-center gap-1">
                {isCash ? (
                  <>
                    <Banknote className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Cash</span>
                  </>
                ) : (
                  <>
                    <IndianRupee className="w-3.5 h-3.5 text-blue-600" />
                    <span>{receiptData.paymentMode || "Online / UPI"}</span>
                  </>
                )}
              </p>
            </div>

            <div className="space-y-0.5">
              <span className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" />
                Collected By
              </span>
              <p className="font-bold text-slate-900 text-xs truncate">
                {receiptData.collectorName || "Staff Member"}{" "}
                <span className="text-[9.5px] uppercase font-semibold text-slate-500">
                  ({receiptData.collectorRole === "teacher" ? "Teacher" : "Owner"})
                </span>
              </p>
            </div>
          </div>

          {/* UTR / Ref Number if Online */}
          {receiptData.utrNumber && (
            <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 font-mono text-xs flex items-center justify-between">
              <span className="font-sans font-bold text-slate-400 text-[10px] uppercase">
                Bank UTR Ref:
              </span>
              <span className="font-bold text-slate-800 select-all">
                {receiptData.utrNumber}
              </span>
            </div>
          )}

          {/* Notes if provided */}
          {receiptData.notes && (
            <div className="p-2 rounded-xl bg-slate-50 border border-slate-200/70 text-[11px] text-slate-600 italic">
              &quot;{receiptData.notes}&quot;
            </div>
          )}

          {/* Highlighted Amount Received */}
          <div className="p-4 rounded-2xl bg-emerald-50/80 border border-emerald-200 text-center space-y-1">
            <span className="text-[10px] uppercase font-extrabold tracking-wider text-emerald-800">
              Amount Received
            </span>
            <div className="text-3xl font-black font-mono text-emerald-900 tracking-tight">
              ₹{(receiptData.amount || 0).toLocaleString("en-IN")}
            </div>

            {hasRemainingDue ? (
              <div className="pt-1">
                <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                  <span>Partial Payment • Remaining Due:</span>
                  <strong className="font-mono font-black">
                    ₹{remainingDue.toLocaleString("en-IN")}
                  </strong>
                </span>
              </div>
            ) : (
              <p className="text-[10px] text-emerald-700 font-medium">
                Full payment received • Parent debt cleared
              </p>
            )}
          </div>

          {/* Provisional Cash Notice Banner */}
          {isProvisional && (
            <div className="p-2.5 rounded-xl bg-amber-50/90 border border-amber-200/90 text-[10.5px] text-amber-800 leading-relaxed">
              <strong>Notice:</strong> This is a provisional receipt for offline cash collected by faculty. The student&apos;s fee balance is credited immediately; physical cash remains in faculty custody pending physical handover to Institute Owner.
            </div>
          )}

          {/* Footer Buttons */}
          <div className="pt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="tap-bounce flex-1 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-800 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Printer className="w-4 h-4 text-slate-600" />
              <span>Print Slip</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="tap-bounce flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/20 transition-all cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Done</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
