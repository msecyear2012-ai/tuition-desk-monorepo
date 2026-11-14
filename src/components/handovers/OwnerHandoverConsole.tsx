"use client";

import { useState, useEffect } from "react";
import {
  Banknote,
  ShieldCheck,
  CheckCircle2,
  AlertOctagon,
  Clock,
  RefreshCw,
  Search,
  AlertCircle,
  Eye,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { CenterInfo } from "@/lib/centerProfile";
import { CashHandoverRecord, TeacherRecord } from "@/types";
import VerifyHandoverModal from "./VerifyHandoverModal";
import RejectHandoverModal from "./RejectHandoverModal";
import DisputeModal from "./DisputeModal";
import HandoverDetailModal from "./HandoverDetailModal";

interface OwnerHandoverConsoleProps {
  userProfile: CenterInfo;
}

function formatDate(dateInput?: string | Date | null): string {
  if (!dateInput) return "N/A";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "N/A";
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "N/A";
  }
}

export default function OwnerHandoverConsole({ userProfile }: OwnerHandoverConsoleProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState<number>(0);

  // Data
  const [handovers, setHandovers] = useState<CashHandoverRecord[]>([]);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);

  // Filters
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("pending_approval");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Modals
  const [activeVerifyHandover, setActiveVerifyHandover] = useState<CashHandoverRecord | null>(null);
  const [activeRejectHandover, setActiveRejectHandover] = useState<CashHandoverRecord | null>(null);
  const [activeDetailHandover, setActiveDetailHandover] = useState<CashHandoverRecord | null>(null);
  const [activeResolveHandover, setActiveResolveHandover] = useState<CashHandoverRecord | null>(null);
  const [activeDisputeHandover, setActiveDisputeHandover] = useState<CashHandoverRecord | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Reload action triggered by user events
  const refreshData = () => {
    setLoading(true);
    setRefreshCount((prev) => prev + 1);
  };

  // Load Handovers & Faculty list
  useEffect(() => {
    let ignore = false;

    async function run() {
      try {
        const teacherParam = selectedTeacherId !== "all" ? { teacherId: selectedTeacherId } : {};

        const [handoversRes, teachersRes] = await Promise.allSettled([
          apiClient<CashHandoverRecord[]>("/handovers", {
            params: teacherParam,
            skipCache: true,
          }),
          apiClient<TeacherRecord[]>("/teachers"),
        ]);

        if (ignore) return;

        if (
          handoversRes.status === "fulfilled" &&
          handoversRes.value.success &&
          Array.isArray(handoversRes.value.data)
        ) {
          setHandovers(handoversRes.value.data);
        } else {
          setHandovers([]);
        }

        if (
          teachersRes.status === "fulfilled" &&
          teachersRes.value.success &&
          Array.isArray(teachersRes.value.data)
        ) {
          setTeachers(teachersRes.value.data.filter((t) => t.isActive !== false));
        }
        setError(null);
      } catch (err: unknown) {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : "Error loading handovers";
          setError(msg);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    void run();

    return () => {
      ignore = true;
    };
  }, [selectedTeacherId, refreshCount]);

  // KPIs
  const pendingHandovers = handovers.filter((h) => h.status === "pending_approval");
  const pendingCount = pendingHandovers.length;
  const pendingAmount = pendingHandovers.reduce(
    (sum, h) => sum + (Number(h.submittedAmount) || 0),
    0
  );

  const verifiedAmount = handovers
    .filter((h) => h.status === "approved" || h.status === "partially_approved")
    .reduce((sum, h) => sum + (Number(h.approvedAmount) || 0), 0);

  const totalDiscrepancies = handovers.reduce(
    (sum, h) => sum + (Number(h.discrepancyAmount) || 0),
    0
  );

  // Filtered list computed directly on render
  let filteredHandovers = handovers;
  if (selectedStatus !== "all") {
    filteredHandovers = filteredHandovers.filter((h) => h.status === selectedStatus);
  }
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    filteredHandovers = filteredHandovers.filter(
      (h) =>
        h.handoverNumber.toLowerCase().includes(q) ||
        (h.teacherName && h.teacherName.toLowerCase().includes(q))
    );
  }

  const handleVerifySuccess = (updated: CashHandoverRecord) => {
    setToastMessage(
      `Handover ${updated.handoverNumber} verified for ₹${Number(updated.approvedAmount || 0).toLocaleString("en-IN")}!`
    );
    setTimeout(() => setToastMessage(null), 4500);
    refreshData();
  };

  const handleRejectSuccess = (updated: CashHandoverRecord) => {
    setToastMessage(`Handover ${updated.handoverNumber} rejected and returned to teacher.`);
    setTimeout(() => setToastMessage(null), 4500);
    refreshData();
  };

  const handleResolveSuccess = (updated: CashHandoverRecord) => {
    setToastMessage(`Discrepancy resolved on ${updated.handoverNumber}.`);
    setTimeout(() => setToastMessage(null), 4500);
    refreshData();
  };

  const handleDisputeSuccess = (updated: CashHandoverRecord) => {
    setToastMessage(`Dispute logged on ${updated.handoverNumber}.`);
    setTimeout(() => setToastMessage(null), 4500);
    refreshData();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Toast Feedback */}
      {toastMessage && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-2xl bg-slate-900 text-white text-xs font-bold shadow-xl flex items-center gap-2 animate-bounce">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header Profile Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
            <span>Faculty Cash Handover Verification</span>
            {pendingCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10.5px] font-black uppercase animate-pulse">
                {pendingCount} Pending Count
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Audit and verify physical cash delivered by faculty collectors to {userProfile?.name || "institute"} custody
          </p>
        </div>

        <button
          type="button"
          onClick={refreshData}
          disabled={loading}
          className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 shadow-2xs cursor-pointer self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-emerald-600" : ""}`} />
          <span>Refresh List</span>
        </button>
      </div>

      {/* 4 Financial KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-amber-500 text-white shadow-md shadow-amber-500/15 space-y-1">
          <div className="flex items-center justify-between text-amber-100 text-[11px] font-bold uppercase tracking-wider">
            <span>Pending Envelopes</span>
            <Clock className="w-4 h-4" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black font-mono">
            ₹{pendingAmount.toLocaleString("en-IN")}
          </p>
          <span className="text-[10px] text-amber-100/90 block truncate">
            {pendingCount} envelope{pendingCount !== 1 ? "s" : ""} awaiting count
          </span>
        </div>

        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-white border border-slate-200 shadow-xs space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-bold uppercase tracking-wider">
            <span>Verified to Date</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black text-emerald-700 font-mono">
            ₹{verifiedAmount.toLocaleString("en-IN")}
          </p>
          <span className="text-[10px] text-slate-500 block truncate">
            Cleared to Institute safe
          </span>
        </div>

        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-white border border-slate-200 shadow-xs space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-bold uppercase tracking-wider">
            <span>Active Shortages</span>
            <AlertOctagon className="w-4 h-4 text-rose-500" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black text-rose-700 font-mono">
            ₹{totalDiscrepancies.toLocaleString("en-IN")}
          </p>
          <span className="text-[10px] text-slate-500 block truncate">
            Unresolved discrepancies
          </span>
        </div>

        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-white border border-slate-200 shadow-xs space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-bold uppercase tracking-wider">
            <span>Total Envelopes</span>
            <Banknote className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black text-slate-900 font-mono">
            {handovers.length}
          </p>
          <span className="text-[10px] text-slate-500 block truncate">
            All historical submissions
          </span>
        </div>
      </div>

      {/* Main Container */}
      <div className="rounded-2xl sm:rounded-3xl border border-slate-200 bg-white p-3.5 sm:p-5 shadow-xs space-y-4">
        {/* Filters Header */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-bold text-slate-600 overflow-x-auto no-scrollbar w-full lg:w-auto max-w-full touch-pan-x">
            <button
              type="button"
              onClick={() => setSelectedStatus("pending_approval")}
              className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 ${
                selectedStatus === "pending_approval"
                  ? "bg-white text-amber-700 shadow-2xs font-black"
                  : "hover:text-slate-900"
              }`}
            >
              <span>Pending Count</span>
              {pendingCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-mono">
                  {pendingCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setSelectedStatus("approved")}
              className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                selectedStatus === "approved"
                  ? "bg-white text-emerald-700 shadow-2xs font-black"
                  : "hover:text-slate-900"
              }`}
            >
              Fully Verified
            </button>
            <button
              type="button"
              onClick={() => setSelectedStatus("partially_approved")}
              className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                selectedStatus === "partially_approved"
                  ? "bg-white text-blue-700 shadow-2xs font-black"
                  : "hover:text-slate-900"
              }`}
            >
              Partial
            </button>
            <button
              type="button"
              onClick={() => setSelectedStatus("rejected")}
              className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                selectedStatus === "rejected"
                  ? "bg-white text-rose-700 shadow-2xs font-black"
                  : "hover:text-slate-900"
              }`}
            >
              Rejected
            </button>
            <button
              type="button"
              onClick={() => setSelectedStatus("all")}
              className={`px-3 py-1.5 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                selectedStatus === "all"
                  ? "bg-white text-slate-900 shadow-2xs font-black"
                  : "hover:text-slate-900"
              }`}
            >
              All ({handovers.length})
            </button>
          </div>

          {/* Search & Faculty Dropdown */}
          <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto">
            {teachers.length > 0 && (
              <select
                value={selectedTeacherId}
                onChange={(e) => setSelectedTeacherId(e.target.value)}
                className="w-full min-[480px]:w-auto px-2.5 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 focus:border-emerald-500 focus:outline-hidden"
              >
                <option value="all">All Faculty</option>
                {teachers.map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            <div className="relative w-full min-[480px]:w-auto min-[480px]:flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search envelope or faculty..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs focus:border-emerald-500 focus:outline-hidden"
              />
            </div>
          </div>
        </div>

        {/* Handover List */}
        {loading ? (
          <div className="py-12 text-center text-slate-400 space-y-2">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-600" />
            <p className="font-semibold text-xs">Loading cash handovers...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : filteredHandovers.length === 0 ? (
          <div className="py-12 text-center text-slate-400 space-y-2">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
            <p className="font-bold text-xs text-slate-700">No Envelopes in this Filter</p>
            <p className="text-[11px] text-slate-400 max-w-sm mx-auto">
              {selectedStatus === "pending_approval"
                ? "Zero pending envelopes awaiting physical count. Great job!"
                : "No handover records match the active status or teacher filter."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredHandovers.map((h) => {
              const isPending = h.status === "pending_approval";
              const isApproved = h.status === "approved";
              const isPartiallyApproved = h.status === "partially_approved";
              const isRejected = h.status === "rejected";
              const hasDiscrepancy = Number(h.discrepancyAmount || 0) > 0;
              const isDisputed = h.discrepancyStatus === "disputed";

              return (
                <div
                  key={h._id}
                  className="p-3.5 sm:p-4 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50/60 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-black text-slate-900 text-xs">
                        {h.handoverNumber}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold text-[10.5px]">
                        Faculty: {h.teacherName || "Teacher"}
                      </span>
                      {isApproved && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-300 text-[10.5px] font-bold">
                          ✓ Fully Verified
                        </span>
                      )}
                      {isPartiallyApproved && (
                        <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 border border-blue-300 text-[10.5px] font-bold">
                          Partially Verified
                        </span>
                      )}
                      {isPending && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300 text-[10.5px] font-bold animate-pulse">
                          Pending Physical Count
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

                    <p className="text-[11px] text-slate-400">
                      Submitted on {formatDate(h.submittedAt)} • {h.items?.length || 0} student collections
                      {h.submissionNotes && <span> • &ldquo;{h.submissionNotes}&rdquo;</span>}
                    </p>

                    {isRejected && h.rejectionReason && (
                      <p className="text-[11px] text-rose-700 font-medium">
                        Rejection Reason: &ldquo;{h.rejectionReason}&rdquo;
                      </p>
                    )}
                  </div>

                  {/* Financial Values & Verification Triggers */}
                  <div className="flex items-center justify-between sm:justify-end gap-2.5 sm:gap-3 w-full sm:w-auto pt-2.5 sm:pt-0 border-t sm:border-t-0 border-slate-100 flex-wrap">
                    <div className="text-left sm:text-right">
                      <span className="font-mono font-black text-slate-900 text-xs block">
                        ₹{Number(h.submittedAmount || 0).toLocaleString("en-IN")}
                      </span>
                      {isPartiallyApproved && (
                        <span className="block text-[10px] text-blue-700 font-medium">
                          Verified: ₹{Number(h.approvedAmount || 0).toLocaleString("en-IN")}
                        </span>
                      )}
                      {hasDiscrepancy && (
                        <span className="block text-[10px] text-rose-600 font-bold">
                          Shortage: ₹{Number(h.discrepancyAmount || 0).toLocaleString("en-IN")}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                      {isPending ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setActiveRejectHandover(h)}
                            className="tap-bounce px-2.5 py-1.5 rounded-xl bg-rose-50 border border-rose-200 hover:bg-rose-100 text-[11px] font-bold text-rose-700 flex items-center gap-1 cursor-pointer"
                          >
                            <AlertOctagon className="w-3.5 h-3.5" />
                            <span>Reject</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setActiveVerifyHandover(h)}
                            className="tap-bounce px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-[11px] font-bold text-white flex items-center gap-1 shadow-2xs cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Verify Cash</span>
                          </button>
                        </>
                      ) : hasDiscrepancy ? (
                        <button
                          type="button"
                          onClick={() => setActiveResolveHandover(h)}
                          className="tap-bounce px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-[11px] font-bold text-indigo-700 flex items-center gap-1 cursor-pointer"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>Resolve</span>
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => setActiveDetailHandover(h)}
                        className="tap-bounce px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-[11px] font-bold text-slate-700 flex items-center gap-1 shadow-2xs cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5 text-slate-500" />
                        <span>Details</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      <VerifyHandoverModal
        isOpen={Boolean(activeVerifyHandover)}
        onClose={() => setActiveVerifyHandover(null)}
        handover={activeVerifyHandover}
        onSuccess={handleVerifySuccess}
      />

      <RejectHandoverModal
        isOpen={Boolean(activeRejectHandover)}
        onClose={() => setActiveRejectHandover(null)}
        handover={activeRejectHandover}
        onSuccess={handleRejectSuccess}
      />

      <HandoverDetailModal
        isOpen={Boolean(activeDetailHandover)}
        onClose={() => setActiveDetailHandover(null)}
        handover={activeDetailHandover}
        userRole="owner"
        onVerify={(h) => {
          setActiveDetailHandover(null);
          setActiveVerifyHandover(h);
        }}
        onReject={(h) => {
          setActiveDetailHandover(null);
          setActiveRejectHandover(h);
        }}
        onDispute={(h) => {
          setActiveDetailHandover(null);
          setActiveDisputeHandover(h);
        }}
        onResolveDispute={(h) => {
          setActiveDetailHandover(null);
          setActiveResolveHandover(h);
        }}
      />

      <DisputeModal
        isOpen={Boolean(activeResolveHandover)}
        onClose={() => setActiveResolveHandover(null)}
        handover={activeResolveHandover}
        mode="resolve"
        userRole="owner"
        onSuccess={handleResolveSuccess}
      />

      <DisputeModal
        isOpen={Boolean(activeDisputeHandover)}
        onClose={() => setActiveDisputeHandover(null)}
        handover={activeDisputeHandover}
        mode="initiate"
        userRole="owner"
        onSuccess={handleDisputeSuccess}
      />
    </div>
  );
}
