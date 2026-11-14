"use client";

import { useState } from "react";
import {
  X,
  Loader2,
  AlertOctagon,
  AlertCircle,
  Info,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { CashHandoverRecord } from "@/types";

export interface RejectHandoverModalProps {
  isOpen: boolean;
  onClose: () => void;
  handover: CashHandoverRecord | null;
  onSuccess: (updatedHandover: CashHandoverRecord) => void;
}

function RejectHandoverModalContent({
  onClose,
  handover,
  onSuccess,
}: {
  onClose: () => void;
  handover: CashHandoverRecord;
  onSuccess: (updatedHandover: CashHandoverRecord) => void;
}) {
  const [rejectionReason, setRejectionReason] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = rejectionReason.trim();
    if (!trimmed) {
      setError("Please provide a mandatory reason explaining why this handover is being rejected.");
      return;
    }

    setSubmitting(true);

    try {
      const res = await apiClient<CashHandoverRecord>(
        `/handovers/${handover._id}/reject`,
        {
          method: "PUT",
          body: {
            rejectionReason: trimmed,
          },
        }
      );

      if (res.success && res.data) {
        onSuccess(res.data);
        onClose();
      } else {
        throw new Error(res.error || "Failed to reject cash handover");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error rejecting handover";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-fade-in">
      <div className="relative w-full max-w-md rounded-3xl bg-white shadow-2xl border border-slate-100 flex flex-col max-h-[90vh] overflow-hidden my-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-rose-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-rose-100 text-rose-800 rounded-xl">
              <AlertOctagon className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-black text-rose-950 leading-tight">
                Reject Cash Handover
              </h2>
              <p className="text-[11px] font-medium text-rose-600 font-mono">
                {handover.handoverNumber} • ₹{Number(handover.submittedAmount).toLocaleString("en-IN")}
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
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Rejection Consequence Notice */}
          <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2.5">
            <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="leading-relaxed text-[11px]">
              Rejecting releases all locked payment allocations. The physical cash custody returns to <strong>{handover.teacherName || "the Teacher"}</strong> In-Hand balance. Parent debt clearance remains unaffected.
            </p>
          </div>

          {/* Mandatory Reason Input */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
              Rejection Reason <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={3}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g. Physical cash envelope not received, denomination discrepancy of ₹500, etc."
              disabled={submitting}
              className="w-full text-xs rounded-xl border border-slate-200 p-2.5 focus:border-rose-500 focus:outline-hidden transition-colors"
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
              disabled={submitting || !rejectionReason.trim()}
              className="tap-bounce px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-rose-600/25 transition-all disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <AlertOctagon className="w-4 h-4" />
              )}
              <span>Reject Handover</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function RejectHandoverModal(props: RejectHandoverModalProps) {
  if (!props.isOpen || !props.handover) return null;
  return (
    <RejectHandoverModalContent
      key={props.handover._id}
      onClose={props.onClose}
      handover={props.handover}
      onSuccess={props.onSuccess}
    />
  );
}
