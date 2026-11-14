"use client";

import { useState } from "react";
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Banknote,
  Info,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { EligibleCollectionItem, CashHandoverRecord } from "@/types";

export interface SelectedHandoverItem {
  item: EligibleCollectionItem;
  allocatedAmount: number;
}

export interface CreateHandoverModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedItems: SelectedHandoverItem[];
  onSuccess: (newHandover: CashHandoverRecord) => void;
}

export default function CreateHandoverModal({
  isOpen,
  onClose,
  selectedItems,
  onSuccess,
}: CreateHandoverModalProps) {
  const [submissionNotes, setSubmissionNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || selectedItems.length === 0) return null;

  const totalAmount = selectedItems.reduce(
    (sum, s) => sum + (Number(s.allocatedAmount) || 0),
    0
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (totalAmount <= 0) {
      setError("Total handover amount must be greater than ₹0.");
      return;
    }

    // Validate each allocation
    for (const entry of selectedItems) {
      if (entry.allocatedAmount <= 0) {
        setError(`Allocation for ${entry.item.studentName} must be greater than ₹0.`);
        return;
      }
      if (entry.allocatedAmount > entry.item.availableAmount + 0.001) {
        setError(
          `Allocation of ₹${entry.allocatedAmount} for ${entry.item.studentName} exceeds available balance of ₹${entry.item.availableAmount}.`
        );
        return;
      }
    }

    setSubmitting(true);

    try {
      const payload = {
        items: selectedItems.map((s) => ({
          feeId: s.item.feeId,
          paymentId: s.item.paymentId,
          amount: s.allocatedAmount,
          studentId: s.item.studentId,
          studentName: s.item.studentName,
          receiptNumber: s.item.receiptNumber,
        })),
        submissionNotes: submissionNotes.trim() || undefined,
      };

      const res = await apiClient<CashHandoverRecord>("/handovers", {
        method: "POST",
        body: payload,
      });

      if (res.success && res.data) {
        onSuccess(res.data);
        onClose();
      } else {
        throw new Error(res.error || "Failed to submit cash handover");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error submitting handover";
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
            <div className="p-2 bg-amber-100 text-amber-800 rounded-xl">
              <Banknote className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-black text-slate-900 leading-tight">
                Submit Cash Handover Envelope
              </h2>
              <p className="text-[11px] font-medium text-slate-500">
                Bundle collected physical cash for Institute Owner verification
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

          {/* Envelope Summary Badge */}
          <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200/80 flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wider">
                Total Physical Cash in Envelope
              </span>
              <p className="text-2xl font-black text-amber-950 font-mono">
                ₹{totalAmount.toLocaleString("en-IN")}
              </p>
            </div>
            <div className="text-right">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-200/70 text-amber-900 text-[10.5px] font-black font-mono">
                {selectedItems.length} Payment{selectedItems.length > 1 ? "s" : ""}
              </span>
            </div>
          </div>

          {/* Allocation Breakdown List */}
          <div className="space-y-2">
            <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
              Allocated Collections ({selectedItems.length})
            </label>
            <div className="divide-y divide-slate-100 max-h-52 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
              {selectedItems.map((s, idx) => (
                <div
                  key={`${s.item.feeId}_${s.item.paymentId}_${idx}`}
                  className="p-3 flex items-center justify-between text-xs hover:bg-slate-50/50"
                >
                  <div className="space-y-0.5 min-w-0 pr-2">
                    <p className="font-bold text-slate-900 truncate">
                      {s.item.studentName}
                    </p>
                    <div className="flex items-center gap-1.5 text-[10.5px] text-slate-400 font-mono">
                      <span>{s.item.receiptNumber}</span>
                      <span>•</span>
                      <span>{s.item.studentBatch || "Batch"}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className="font-mono font-black text-slate-900 text-xs">
                      ₹{s.allocatedAmount.toLocaleString("en-IN")}
                    </span>
                    {s.allocatedAmount < s.item.availableAmount && (
                      <span className="block text-[10px] text-amber-700 font-semibold">
                        Partial (of ₹{s.item.availableAmount})
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Notes Input */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
              Handover Note (Optional)
            </label>
            <textarea
              rows={2}
              value={submissionNotes}
              onChange={(e) => setSubmissionNotes(e.target.value)}
              placeholder="e.g. Delivered cash in blue envelope to front desk office..."
              disabled={submitting}
              className="w-full text-xs rounded-xl border border-slate-200 p-2.5 focus:border-amber-500 focus:outline-hidden transition-colors"
            />
          </div>

          {/* Financial Custody Notice */}
          <div className="p-3 rounded-2xl bg-blue-50/70 border border-blue-200/80 flex items-start gap-2.5 text-[11px] text-blue-900">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Submitting locks these collections in <strong>Pending Verification</strong> status. Cash custody officially transfers to the Owner only upon Owner count and approval. Parent payment credit is already settled.
            </p>
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
              disabled={submitting || totalAmount <= 0}
              className="tap-bounce px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-amber-600/25 transition-all disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>Submit Envelope (₹{totalAmount.toLocaleString("en-IN")})</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
