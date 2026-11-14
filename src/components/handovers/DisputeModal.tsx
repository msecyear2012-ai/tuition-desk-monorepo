"use client";

import { useState } from "react";
import {
  X,
  Loader2,
  AlertCircle,
  HelpCircle,
  CheckCircle2,
  FileText,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { CashHandoverRecord, DisputeResolutionType } from "@/types";

export interface DisputeModalProps {
  isOpen: boolean;
  onClose: () => void;
  handover: CashHandoverRecord | null;
  mode?: "initiate" | "resolve";
  userRole?: "owner" | "teacher" | string;
  onSuccess: (updatedHandover: CashHandoverRecord) => void;
}

function DisputeModalContent({
  onClose,
  handover,
  mode = "initiate",
  userRole = "teacher",
  onSuccess,
}: {
  onClose: () => void;
  handover: CashHandoverRecord;
  mode?: "initiate" | "resolve";
  userRole?: "owner" | "teacher" | string;
  onSuccess: (updatedHandover: CashHandoverRecord) => void;
}) {
  const isOwner = userRole === "owner";
  const isResolving = mode === "resolve" && isOwner;

  // Form states
  const [reasonInput, setReasonInput] = useState<string>("");
  const [resolutionType, setResolutionType] = useState<DisputeResolutionType>("cash_received");
  const [resolutionAmount, setResolutionAmount] = useState<string>(
    String(handover.discrepancyAmount || 0)
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedReason = reasonInput.trim();
    if (!trimmedReason) {
      setError("Please provide a reason or explanation.");
      return;
    }

    setSubmitting(true);

    try {
      if (isResolving) {
        const numAmt = Number(resolutionAmount);
        if (isNaN(numAmt) || numAmt < 0) {
          throw new Error("Resolution amount must be a valid non-negative number.");
        }

        const res = await apiClient<CashHandoverRecord>(
          `/handovers/${handover._id}/resolve`,
          {
            method: "PUT",
            body: {
              resolutionType,
              amount: numAmt,
              reason: trimmedReason,
              notes: trimmedReason,
            },
          }
        );

        if (res.success && res.data) {
          onSuccess(res.data);
          onClose();
        } else {
          throw new Error(res.error || "Failed to resolve dispute");
        }
      } else {
        const res = await apiClient<CashHandoverRecord>(
          `/handovers/${handover._id}/dispute`,
          {
            method: "POST",
            body: {
              reason: trimmedReason,
              notes: trimmedReason,
            },
          }
        );

        if (res.success && res.data) {
          onSuccess(res.data);
          onClose();
        } else {
          throw new Error(res.error || "Failed to initiate dispute");
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error processing request";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-fade-in">
      <div className="relative w-full max-w-md rounded-3xl bg-white shadow-2xl border border-slate-100 flex flex-col max-h-[90vh] overflow-hidden my-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-purple-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-purple-100 text-purple-800 rounded-xl">
              <HelpCircle className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-black text-purple-950 leading-tight">
                {isResolving ? "Resolve Handover Discrepancy" : "Initiate Handover Dispute"}
              </h2>
              <p className="text-[11px] font-medium text-purple-600 font-mono">
                {handover.handoverNumber} • ₹{Number(handover.discrepancyAmount || 0).toLocaleString("en-IN")} Discrepancy
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

          {isResolving ? (
            <>
              {/* Resolution Type */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
                  Resolution Type
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setResolutionType("cash_received")}
                    className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                      resolutionType === "cash_received"
                        ? "border-emerald-500 bg-emerald-50 text-emerald-900 font-bold"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <p className="text-xs">Cash Received</p>
                    <p className="text-[10px] text-slate-400">Physical recovery</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setResolutionType("accounting_adjustment")}
                    className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                      resolutionType === "accounting_adjustment"
                        ? "border-blue-500 bg-blue-50 text-blue-900 font-bold"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <p className="text-xs">Adjustment</p>
                    <p className="text-[10px] text-slate-400">Accounting offset</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setResolutionType("shortage_confirmed")}
                    className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                      resolutionType === "shortage_confirmed"
                        ? "border-rose-500 bg-rose-50 text-rose-900 font-bold"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <p className="text-xs">Confirmed</p>
                    <p className="text-[10px] text-slate-400">Written-off loss</p>
                  </button>
                </div>
              </div>

              {/* Resolved Amount */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
                  Resolved Amount (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={resolutionAmount}
                  onChange={(e) => setResolutionAmount(e.target.value)}
                  disabled={submitting}
                  className="w-full text-xs rounded-xl border border-slate-200 p-2.5 font-mono font-bold focus:border-purple-500 focus:outline-hidden transition-colors"
                />
              </div>
            </>
          ) : (
            <div className="p-3.5 rounded-2xl bg-purple-50 border border-purple-200 text-purple-900 text-xs">
              <p className="text-[11px] leading-relaxed">
                Log a dispute if there is a disagreement regarding the physical cash counted or reason for rejection. This marks the handover as <strong>Disputed</strong> and pauses settlement.
              </p>
            </div>
          )}

          {/* Reason Input */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-black text-slate-700 uppercase tracking-wider">
              {isResolving ? "Resolution Reason" : "Dispute Reason / Explanation"}{" "}
              <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={3}
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              placeholder={
                isResolving
                  ? "Explain how the discrepancy was settled..."
                  : "Detail why you believe the physical cash amount was correct or where discrepancy occurred..."
              }
              disabled={submitting}
              className="w-full text-xs rounded-xl border border-slate-200 p-2.5 focus:border-purple-500 focus:outline-hidden transition-colors"
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
              disabled={submitting || !reasonInput.trim()}
              className="tap-bounce px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 active:scale-95 text-white font-bold text-xs flex items-center gap-1.5 shadow-md shadow-purple-600/25 transition-all disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isResolving ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <FileText className="w-4 h-4" />
              )}
              <span>{isResolving ? "Resolve Discrepancy" : "Submit Dispute"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function DisputeModal(props: DisputeModalProps) {
  if (!props.isOpen || !props.handover) return null;
  return (
    <DisputeModalContent
      key={`${props.handover._id}_${props.mode || "initiate"}`}
      onClose={props.onClose}
      handover={props.handover}
      mode={props.mode}
      userRole={props.userRole}
      onSuccess={props.onSuccess}
    />
  );
}
