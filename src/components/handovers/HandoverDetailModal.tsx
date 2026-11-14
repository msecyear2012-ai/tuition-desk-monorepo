"use client";

import {
  X,
  Banknote,
  ShieldCheck,
  CheckCircle2,
  AlertOctagon,
  Printer,
  HelpCircle,
} from "lucide-react";
import { CashHandoverRecord } from "@/types";

export interface HandoverDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  handover: CashHandoverRecord | null;
  userRole?: "owner" | "teacher" | string;
  onVerify?: (handover: CashHandoverRecord) => void;
  onReject?: (handover: CashHandoverRecord) => void;
  onDispute?: (handover: CashHandoverRecord) => void;
  onResolveDispute?: (handover: CashHandoverRecord) => void;
}

function formatDate(dateInput?: string | Date | null): string {
  if (!dateInput) return "N/A";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "N/A";
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "N/A";
  }
}

export default function HandoverDetailModal({
  isOpen,
  onClose,
  handover,
  userRole = "teacher",
  onVerify,
  onReject,
  onDispute,
  onResolveDispute,
}: HandoverDetailModalProps) {
  if (!isOpen || !handover) return null;

  const isOwner = userRole === "owner";
  const isPending = handover.status === "pending_approval";
  const isApproved = handover.status === "approved";
  const isPartiallyApproved = handover.status === "partially_approved";
  const isRejected = handover.status === "rejected";
  const hasDiscrepancy = Number(handover.discrepancyAmount || 0) > 0;
  const isDisputed = handover.discrepancyStatus === "disputed";

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-fade-in">
      <div className="relative w-full max-w-2xl rounded-3xl bg-white shadow-2xl border border-slate-100 flex flex-col max-h-[92vh] overflow-hidden my-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-100 text-amber-800 rounded-xl">
              <Banknote className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-black text-slate-900 font-mono">
                  {handover.handoverNumber}
                </h2>
                {isApproved && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-300 text-[10.5px] font-bold">
                    ✓ Verified by Owner
                  </span>
                )}
                {isPartiallyApproved && (
                  <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 border border-blue-300 text-[10.5px] font-bold">
                    Partially Verified
                  </span>
                )}
                {isPending && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300 text-[10.5px] font-bold animate-pulse">
                    Awaiting Owner Count
                  </span>
                )}
                {isRejected && (
                  <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-800 border border-rose-300 text-[10.5px] font-bold">
                    Rejected
                  </span>
                )}
                {isDisputed && (
                  <span className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-800 border border-purple-300 text-[10.5px] font-bold">
                    Disputed
                  </span>
                )}
              </div>
              <p className="text-[11px] font-medium text-slate-500">
                Collector: <strong className="text-slate-800">{handover.teacherName || "Faculty"}</strong> • Submitted: {formatDate(handover.submittedAt)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handlePrint}
              className="p-1.5 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer"
              title="Print Summary"
            >
              <Printer className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* Top KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-2xl bg-amber-50/70 border border-amber-200/80">
              <span className="text-[10.5px] font-bold text-amber-800 uppercase tracking-wider block">
                Submitted Cash
              </span>
              <p className="text-xl font-black text-amber-950 font-mono mt-0.5">
                ₹{Number(handover.submittedAmount || 0).toLocaleString("en-IN")}
              </p>
              <span className="text-[10px] text-amber-700 font-medium">
                {handover.items?.length || 0} payment allocations
              </span>
            </div>

            <div className="p-3.5 rounded-2xl bg-emerald-50/70 border border-emerald-200/80">
              <span className="text-[10.5px] font-bold text-emerald-800 uppercase tracking-wider block">
                Verified Amount
              </span>
              <p className="text-xl font-black text-emerald-950 font-mono mt-0.5">
                ₹{Number(handover.approvedAmount || 0).toLocaleString("en-IN")}
              </p>
              <span className="text-[10px] text-emerald-700 font-medium">
                {isApproved
                  ? "100% physically cleared"
                  : isPending
                  ? "Pending count"
                  : isRejected
                  ? "₹0 credited"
                  : "Partially cleared"}
              </span>
            </div>

            <div
              className={`p-3.5 rounded-2xl border ${
                hasDiscrepancy || isRejected
                  ? "bg-rose-50/70 border-rose-200/80"
                  : "bg-slate-50 border-slate-200"
              }`}
            >
              <span className="text-[10.5px] font-bold text-slate-600 uppercase tracking-wider block">
                Discrepancy / Shortage
              </span>
              <p
                className={`text-xl font-black font-mono mt-0.5 ${
                  hasDiscrepancy || isRejected ? "text-rose-700" : "text-slate-900"
                }`}
              >
                ₹{Number(handover.discrepancyAmount || 0).toLocaleString("en-IN")}
              </p>
              <span className="text-[10px] text-slate-500 font-medium">
                {handover.discrepancyStatus === "resolved"
                  ? "Settled / Resolved"
                  : hasDiscrepancy
                  ? "Unresolved liability"
                  : "Zero discrepancy"}
              </span>
            </div>
          </div>

          {/* Submission / Rejection Alerts */}
          {handover.submissionNotes && (
            <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-700 space-y-1">
              <span className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wider">
                Submission Note from Teacher
              </span>
              <p className="text-xs text-slate-800 font-medium">
                &ldquo;{handover.submissionNotes}&rdquo;
              </p>
            </div>
          )}

          {isRejected && handover.rejectionReason && (
            <div className="p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-xs text-rose-900">
                <AlertOctagon className="w-4 h-4 text-rose-600" />
                <span>Rejection Reason from Owner</span>
              </div>
              <p className="text-xs text-rose-800 font-medium pl-5.5">
                &ldquo;{handover.rejectionReason}&rdquo;
              </p>
            </div>
          )}

          {/* Enclosed Payment Allocations */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-slate-900 text-xs uppercase tracking-wider">
                Payment-wise Allocations ({handover.items?.length || 0})
              </h3>
              <span className="text-[11px] text-slate-400 font-medium">
                Dual-rail financial records
              </span>
            </div>

            <div className="rounded-2xl border border-slate-200 overflow-hidden divide-y divide-slate-100 bg-white">
              {(handover.items || []).map((it, idx) => (
                <div
                  key={String(it.allocationId || idx)}
                  className="p-3 flex items-center justify-between hover:bg-slate-50/50 transition-colors gap-2"
                >
                  <div className="space-y-0.5 min-w-0">
                    <p className="font-bold text-slate-900 truncate">
                      {it.studentName || "Student Collection"}
                    </p>
                    <div className="flex items-center gap-1.5 text-[10.5px] text-slate-400 font-mono">
                      <span>Receipt: {it.receiptNumber || "N/A"}</span>
                      <span>•</span>
                      <span>Allocation #{idx + 1}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className="font-mono font-black text-slate-900 text-xs">
                      ₹{Number(it.amount || 0).toLocaleString("en-IN")}
                    </span>
                    <span className="block text-[10px] text-slate-400 font-medium">
                      {isApproved ? "Owner Cleared" : isPending ? "Pending Verification" : "Provisional"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Audit Timeline / Disputes */}
          {((handover.disputes && handover.disputes.length > 0) ||
            (handover.resolutions && handover.resolutions.length > 0) ||
            (handover.incrementalSettlements && handover.incrementalSettlements.length > 0)) && (
            <div className="space-y-2">
              <h3 className="font-black text-slate-900 text-xs uppercase tracking-wider">
                Audit &amp; Dispute Timeline
              </h3>
              <div className="space-y-2">
                {/* Dispute Entries */}
                {(handover.disputes || []).map((disp, dIdx) => (
                  <div
                    key={String(disp._id || dIdx)}
                    className="p-3 rounded-2xl bg-purple-50/70 border border-purple-200 text-purple-900 space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="font-bold uppercase tracking-wider">
                        Dispute Logged ({disp.initiatedByRole === "owner" ? "Owner" : "Teacher"})
                      </span>
                      <span className="text-purple-600 font-mono">
                        {formatDate(disp.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-purple-950">
                      &ldquo;{disp.notes}&rdquo;
                    </p>
                  </div>
                ))}

                {/* Resolution Entries */}
                {(handover.resolutions || []).map((res, rIdx) => (
                  <div
                    key={String(res._id || rIdx)}
                    className="p-3 rounded-2xl bg-emerald-50/70 border border-emerald-200 text-emerald-900 space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="font-bold uppercase tracking-wider">
                        Dispute Resolved: {res.resolutionType.replace(/_/g, " ")} (₹{res.amount})
                      </span>
                      <span className="text-emerald-700 font-mono">
                        {formatDate(res.resolvedAt)}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-emerald-950">
                      Reason: &ldquo;{res.reason}&rdquo;
                    </p>
                  </div>
                ))}

                {/* Incremental Settlements */}
                {(handover.incrementalSettlements || []).map((settle, sIdx) => (
                  <div
                    key={String(settle._id || sIdx)}
                    className="p-3 rounded-2xl bg-blue-50/70 border border-blue-200 text-blue-900 space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10.5px]">
                      <span className="font-bold uppercase tracking-wider">
                        Incremental Cash Recovered: ₹{settle.amountReceived}
                      </span>
                      <span className="text-blue-700 font-mono">
                        {formatDate(settle.receivedAt)}
                      </span>
                    </div>
                    <p className="text-[10.5px] text-blue-800">
                      Remaining shortage: ₹{settle.remainingDiscrepancy}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-slate-100 flex items-center justify-between gap-2.5 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            className="tap-bounce px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-100 cursor-pointer"
          >
            Close
          </button>

          <div className="flex items-center gap-2">
            {/* Owner Actions */}
            {isOwner && isPending && (
              <>
                {onReject && (
                  <button
                    type="button"
                    onClick={() => {
                      onReject(handover);
                      onClose();
                    }}
                    className="tap-bounce px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-700 text-xs font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <AlertOctagon className="w-3.5 h-3.5" />
                    <span>Reject</span>
                  </button>
                )}
                {onVerify && (
                  <button
                    type="button"
                    onClick={() => {
                      onVerify(handover);
                      onClose();
                    }}
                    className="tap-bounce px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1 shadow-xs cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Verify Cash</span>
                  </button>
                )}
              </>
            )}

            {/* Dispute Triggers */}
            {(hasDiscrepancy || isRejected) && !isDisputed && onDispute && (
              <button
                type="button"
                onClick={() => {
                  onDispute(handover);
                  onClose();
                }}
                className="tap-bounce px-3.5 py-2 rounded-xl bg-purple-50 border border-purple-200 hover:bg-purple-100 text-purple-700 text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>Log Dispute</span>
              </button>
            )}

            {isOwner && hasDiscrepancy && onResolveDispute && (
              <button
                type="button"
                onClick={() => {
                  onResolveDispute(handover);
                  onClose();
                }}
                className="tap-bounce px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center gap-1 shadow-xs cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Resolve Discrepancy</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
