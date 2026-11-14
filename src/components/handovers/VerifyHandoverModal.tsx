"use client";

import { useState } from "react";
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { CashHandoverRecord } from "@/types";

export interface VerifyHandoverModalProps {
  isOpen: boolean;
  onClose: () => void;
  handover: CashHandoverRecord | null;
  onSuccess: (updatedHandover: CashHandoverRecord) => void;
}

function VerifyHandoverModalContent({
  onClose,
  handover,
  onSuccess,
}: {
  onClose: () => void;
  handover: CashHandoverRecord;
  onSuccess: (updatedHandover: CashHandoverRecord) => void;
}) {
  const expectedAmount = Number(handover.submittedAmount) || 0;
  const [verifiedAmountInput, setVerifiedAmountInput] = useState<string>(
    String(expectedAmount)
  );
  const [resolutionNotes, setResolutionNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const numVerified = Number(verifiedAmountInput);
  const isValidAmount = !isNaN(numVerified) && numVerified >= 0;
  const isFullCount = isValidAmount && Math.abs(numVerified - expectedAmount) < 0.001;
  const isShortage = isValidAmount && numVerified < expectedAmount;
  const isExcess = isValidAmount && numVerified > expectedAmount;
  const discrepancy = isShortage ? expectedAmount - numVerified : 0;

  const handleVerifyFull = () => {
    setVerifiedAmountInput(String(expectedAmount));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isValidAmount) {
      setError("Please enter a valid, non-negative cash amount.");
      return;
    }

    if (numVerified > expectedAmount) {
      setError(
        `Counted cash (₹${numVerified}) cannot exceed the envelope's submitted amount of ₹${expectedAmount}.`
      );
      return;
    }

    setSubmitting(true);

    try {
      const payload: Record<string, unknown> = {
        verifiedAmount: numVerified,
        resolutionNotes: resolutionNotes.trim() || undefined,
      };

      const res = await apiClient<CashHandoverRecord>(
        `/handovers/${handover._id}/verify`,
        {
          method: "PUT",
          body: payload,
        }
      );

      if (res.success && res.data) {
        onSuccess(res.data);
        onClose();
      } else {
        throw new Error(res.error || "Failed to verify cash handover");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error verifying handover";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-fade-in">
      <div className="relative w-full max-w-lg rounded-3xl bg-white shadow-2xl border border-slate-100 flex flex-col max-h-[90vh] overflow-hidden my-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-100 text-emerald-800 rounded-xl">
              <ShieldCheck className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-black text-slate-900 leading-tight">
                Verify Cash Handover
              </h2>
              <p className="text-[11px] font-medium text-slate-500 font-mono">
                {handover.handoverNumber} • {handover.teacherName || "Faculty"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Expected Cash Header Card */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 flex items-center justify-between">
            <div>
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                Submitted Expected Cash
              </span>
              <p className="text-2xl font-black text-slate-900 font-mono">
                ₹{expectedAmount.toLocaleString("en-IN")}
              </p>
            </div>
            <div className="text-right">
              <span className="text-[11px] text-slate-400 font-mono block">
                {handover.items?.length || 0} Line Items
              </span>
              <button
                type="button"
                onClick={handleVerifyFull}
                className="mt-1 text-xs font-black text-emerald-700 hover:text-emerald-800 underline cursor-pointer"
              >
                Match Full Cash
              </button>
            </div>
          </div>

          {/* Actual Physical Cash Counted */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
                Actual Physical Cash Counted (₹)
              </label>
              <div className="flex items-center gap-1.5">
                {isFullCount && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10.5px] font-bold">
                    ✓ Full Verification
                  </span>
                )}
                {isShortage && (
                  <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 text-[10.5px] font-bold">
                    ⚠️ ₹{discrepancy.toLocaleString("en-IN")} Shortage
                  </span>
                )}
              </div>
            </div>

            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono font-bold text-slate-400">
                ₹
              </span>
              <input
                type="number"
                min="0"
                max={expectedAmount}
                step="1"
                value={verifiedAmountInput}
                onChange={(e) => setVerifiedAmountInput(e.target.value)}
                disabled={submitting}
                className="w-full pl-8 pr-4 py-2.5 rounded-xl border border-slate-200 text-base font-black text-slate-900 font-mono focus:border-emerald-500 focus:outline-hidden transition-colors"
                placeholder="0"
              />
            </div>
          </div>

          {/* Discrepancy Alert */}
          {isShortage && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-1">
              <div className="flex items-center gap-2 font-bold">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span>Partial Verification Discrepancy</span>
              </div>
              <p className="text-[11px] text-amber-800 pl-6 leading-relaxed">
                ₹{numVerified.toLocaleString("en-IN")} will transfer to Owner Verified custody. The remaining <strong>₹{discrepancy.toLocaleString("en-IN")}</strong> will be recorded as a pending physical shortage/discrepancy linked to the teacher.
              </p>
            </div>
          )}

          {/* Items Preview */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
              Enclosed Collections ({handover.items?.length || 0})
            </span>
            <div className="divide-y divide-slate-100 max-h-40 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
              {(handover.items || []).map((it, idx) => (
                <div
                  key={String(it.allocationId || idx)}
                  className="p-2.5 flex items-center justify-between text-xs"
                >
                  <div className="space-y-0.5">
                    <p className="font-bold text-slate-900">
                      {it.studentName || "Student Collection"}
                    </p>
                    <p className="text-[10px] text-slate-400 font-mono">
                      {it.receiptNumber || "RCPT"}
                    </p>
                  </div>
                  <span className="font-mono font-black text-slate-900">
                    ₹{(it.amount || 0).toLocaleString("en-IN")}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Verification Notes */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
              Verification Notes (Optional)
            </label>
            <input
              type="text"
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              placeholder="e.g. Counted and placed in institute safe..."
              disabled={submitting}
              className="w-full text-xs rounded-xl border border-slate-200 p-2.5 focus:border-emerald-500 focus:outline-hidden transition-colors"
            />
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="tap-bounce px-4 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !isValidAmount || isExcess}
              className="tap-bounce px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-600/25 transition-all disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>
                {isShortage
                  ? `Verify Partial (₹${numVerified.toLocaleString("en-IN")})`
                  : `Confirm Verification (₹${numVerified.toLocaleString("en-IN")})`}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function VerifyHandoverModal(props: VerifyHandoverModalProps) {
  if (!props.isOpen || !props.handover) return null;
  return (
    <VerifyHandoverModalContent
      key={props.handover._id}
      onClose={props.onClose}
      handover={props.handover}
      onSuccess={props.onSuccess}
    />
  );
}
