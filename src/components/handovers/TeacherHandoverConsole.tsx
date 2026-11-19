"use client";

import { useState, useEffect } from "react";
import {
  Banknote,
  CheckCircle2,
  AlertOctagon,
  Clock,
  RefreshCw,
  Search,
  CheckSquare,
  Square,
  AlertCircle,
  HelpCircle,
  Eye,
  Plus,
} from "lucide-react";
import { apiClient, getCurrentCenterId } from "@/lib/apiClient";
import { CenterInfo } from "@/lib/centerProfile";
import {
  EligibleCollectionItem,
  CashHandoverRecord,
  PaymentEntryItem,
  PaymentAllocationItem,
} from "@/types";
import CreateHandoverModal, { SelectedHandoverItem } from "./CreateHandoverModal";
import HandoverDetailModal from "./HandoverDetailModal";
import DisputeModal from "./DisputeModal";

interface TeacherHandoverConsoleProps {
  userProfile: CenterInfo;
  onRecordCash?: () => void;
}

interface RawFeeResponse {
  _id: string;
  centerId: string;
  studentId: { _id?: string; name?: string; batch?: string } | string;
  month: string;
  title?: string;
  amountDue: number;
  paidAmount?: number;
  paymentHistory?: PaymentEntryItem[];
  receivedBy?: string;
  receivedByRole?: string;
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

export default function TeacherHandoverConsole({
  userProfile,
  onRecordCash,
}: TeacherHandoverConsoleProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState<number>(0);

  // Data states
  const [eligibleCollections, setEligibleCollections] = useState<EligibleCollectionItem[]>([]);
  const [handovers, setHandovers] = useState<CashHandoverRecord[]>([]);

  // Selection states for creating handover
  // Map key: `${feeId}:${paymentId}` -> allocatedAmount
  const [selectedAllocations, setSelectedAllocations] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [historyTab, setHistoryTab] = useState<"all" | "pending" | "verified" | "discrepancy">("all");

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [activeDetailHandover, setActiveDetailHandover] = useState<CashHandoverRecord | null>(null);
  const [activeDisputeHandover, setActiveDisputeHandover] = useState<CashHandoverRecord | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Reload action triggered by user events
  const refreshData = () => {
    setLoading(true);
    setRefreshCount((prev) => prev + 1);
  };

  // Load Teacher's fees & submitted handovers
  useEffect(() => {
    let ignore = false;

    const centerId = userProfile.centerId || getCurrentCenterId();
    const profileRecord = userProfile as unknown as Record<string, unknown>;
    const ids: string[] = [];
    if (userProfile.teacherId) ids.push(String(userProfile.teacherId));
    if (profileRecord._id) ids.push(String(profileRecord._id));
    if (profileRecord.userId) ids.push(String(profileRecord.userId));
    if (profileRecord.id) ids.push(String(profileRecord.id));

    async function run() {
      try {
        const [feesRes, handoversRes] = await Promise.allSettled([
          apiClient<RawFeeResponse[]>("/fees", {
            params: { centerId, status: "Paid,Partial Paid", all: true },
            skipCache: true,
          }),
          apiClient<CashHandoverRecord[]>("/handovers", { skipCache: true }),
        ]);

        if (ignore) return;

        // 1. Process Eligible Collections
        const eligible: EligibleCollectionItem[] = [];

        if (feesRes.status === "fulfilled" && feesRes.value.success && Array.isArray(feesRes.value.data)) {
          for (const fee of feesRes.value.data) {
            const history = fee.paymentHistory || [];
            for (const entry of history) {
              const collectorId = String(
                entry.receivedBy ||
                (entry as unknown as { recordedBy?: unknown }).recordedBy ||
                fee.receivedBy ||
                ""
              );

              // 1. Must be collected by this authenticated teacher
              const isCollectedByThisTeacher =
                ids.length === 0 || ids.includes(collectorId);
              if (!isCollectedByThisTeacher) continue;

              // 2. Must not be an owner direct collection
              if (entry.receivedByRole === "owner") continue;

              // 3. Must be physical cash (not online/UPI/bank_transfer)
              const paymentMode = String(entry.paymentMode || "").toLowerCase();
              const isDigital = paymentMode === "upi" || paymentMode === "bank_transfer";
              if (isDigital) continue;

              // Calculate locked allocations
              const lockedAmount = (entry.allocations || []).reduce(
                (sum: number, a: PaymentAllocationItem) => {
                  if (a.status === "rejected") return sum;
                  if (a.status === "verified") {
                    return sum + (Number(a.verifiedAmount ?? a.allocatedAmount) || 0);
                  }
                  return sum + (Number(a.allocatedAmount) || 0);
                },
                0
              );

              const available = Math.max(0, (Number(entry.amount) || 0) - lockedAmount);

              if (available > 0) {
                const studentObj =
                  typeof fee.studentId === "object" && fee.studentId !== null ? fee.studentId : null;
                const studentName = studentObj?.name || "Student";
                const studentBatch = studentObj?.batch || "General";
                const sId = studentObj?._id || String(fee.studentId);
                const payId = String(entry.paymentId || entry._id || "");

                eligible.push({
                  feeId: fee._id,
                  paymentId: payId,
                  studentId: sId,
                  studentName,
                  studentBatch,
                  receiptNumber: entry.receiptNumber || `RCPT-${fee._id.slice(-6).toUpperCase()}`,
                  paymentDate: entry.paymentDate || entry.recordedAt || new Date(),
                  totalCollected: Number(entry.amount) || 0,
                  alreadyAllocated: lockedAmount,
                  availableAmount: available,
                  feeMonth: fee.month,
                  feeTitle: fee.title,
                });
              }
            }
          }
        }

        setEligibleCollections(eligible);

        // Pre-select all eligible collections by default
        const initialMap: Record<string, number> = {};
        eligible.forEach((it) => {
          initialMap[`${it.feeId}:${it.paymentId}`] = it.availableAmount;
        });
        setSelectedAllocations(initialMap);

        // 2. Process Submitted Handovers
        if (
          handoversRes.status === "fulfilled" &&
          handoversRes.value.success &&
          Array.isArray(handoversRes.value.data)
        ) {
          setHandovers(handoversRes.value.data);
        } else {
          setHandovers([]);
        }
        setError(null);
      } catch (err: unknown) {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : "Error loading handover console";
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
  }, [userProfile, refreshCount]);

  // Handle item selection toggle
  const toggleItemSelection = (item: EligibleCollectionItem) => {
    const key = `${item.feeId}:${item.paymentId}`;
    setSelectedAllocations((prev) => {
      const next = { ...prev };
      if (next[key] !== undefined) {
        delete next[key];
      } else {
        next[key] = item.availableAmount;
      }
      return next;
    });
  };

  // Filtered collections computed directly on render
  const filteredEligible = searchQuery.trim()
    ? eligibleCollections.filter((it) => {
        const q = searchQuery.toLowerCase();
        return (
          it.studentName.toLowerCase().includes(q) ||
          it.receiptNumber.toLowerCase().includes(q) ||
          (it.studentBatch && it.studentBatch.toLowerCase().includes(q))
        );
      })
    : eligibleCollections;

  const handleSelectAll = () => {
    if (Object.keys(selectedAllocations).length === filteredEligible.length) {
      // Unselect all
      setSelectedAllocations({});
    } else {
      // Select all filtered
      const next: Record<string, number> = {};
      filteredEligible.forEach((it) => {
        next[`${it.feeId}:${it.paymentId}`] = it.availableAmount;
      });
      setSelectedAllocations(next);
    }
  };

  const handleAllocationAmountChange = (item: EligibleCollectionItem, newAmountStr: string) => {
    const key = `${item.feeId}:${item.paymentId}`;
    const num = Number(newAmountStr);
    if (isNaN(num)) return;
    const clamped = Math.max(0, Math.min(item.availableAmount, num));
    setSelectedAllocations((prev) => ({
      ...prev,
      [key]: clamped,
    }));
  };

  // Selected items array for modal computed directly on render
  const selectedItemsForModal: SelectedHandoverItem[] = [];
  for (const it of eligibleCollections) {
    const key = `${it.feeId}:${it.paymentId}`;
    const amount = selectedAllocations[key];
    if (amount !== undefined && amount > 0) {
      selectedItemsForModal.push({
        item: it,
        allocatedAmount: amount,
      });
    }
  }

  const totalSelectedCash = selectedItemsForModal.reduce(
    (sum, s) => sum + s.allocatedAmount,
    0
  );

  // Financial KPIs
  const totalInHandEligible = eligibleCollections.reduce(
    (sum, it) => sum + it.availableAmount,
    0
  );

  const pendingVerificationAmount = handovers
    .filter((h) => h.status === "pending_approval")
    .reduce((sum, h) => sum + (Number(h.submittedAmount) || 0), 0);

  const verifiedAmount = handovers
    .filter((h) => h.status === "approved" || h.status === "partially_approved")
    .reduce((sum, h) => sum + (Number(h.approvedAmount) || 0), 0);

  const discrepancyAmount = handovers.reduce(
    (sum, h) => sum + (Number(h.discrepancyAmount) || 0),
    0
  );

  // Filtered History computed directly on render
  let filteredHandovers = handovers;
  if (historyTab === "pending") {
    filteredHandovers = handovers.filter((h) => h.status === "pending_approval");
  } else if (historyTab === "verified") {
    filteredHandovers = handovers.filter(
      (h) => h.status === "approved" || h.status === "partially_approved"
    );
  } else if (historyTab === "discrepancy") {
    filteredHandovers = handovers.filter(
      (h) =>
        h.status === "rejected" ||
        Number(h.discrepancyAmount || 0) > 0 ||
        h.discrepancyStatus === "disputed"
    );
  }

  const handleHandoverCreated = (newHandover: CashHandoverRecord) => {
    setToastMessage(
      `Handover ${newHandover.handoverNumber} submitted for ₹${Number(newHandover.submittedAmount).toLocaleString("en-IN")}!`
    );
    setTimeout(() => setToastMessage(null), 4500);
    refreshData();
  };

  const handleDisputeUpdated = (updated: CashHandoverRecord) => {
    setToastMessage(`Dispute logged on ${updated.handoverNumber}!`);
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
            <span>Faculty Cash Handover Console</span>
            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10.5px] font-black uppercase">
              Provisional Custody
            </span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Deliver collected student fees to the Institute Director for physical count &amp; verification
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
          {onRecordCash && (
            <button
              type="button"
              onClick={onRecordCash}
              className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-2xs cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Record Cash</span>
            </button>
          )}
          <button
            type="button"
            onClick={refreshData}
            disabled={loading}
            className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 shadow-2xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-amber-600" : ""}`} />
            <span>Refresh Console</span>
          </button>
        </div>
      </div>

      {/* 4 Financial KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-amber-500 text-white shadow-md shadow-amber-500/15 space-y-1">
          <div className="flex items-center justify-between text-amber-100 text-[11px] font-bold uppercase tracking-wider">
            <span>In-Hand Cash</span>
            <Banknote className="w-4 h-4" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black font-mono">
            ₹{totalInHandEligible.toLocaleString("en-IN")}
          </p>
          <span className="text-[10px] text-amber-100/90 block truncate">
            {eligibleCollections.length} collections ready
          </span>
        </div>

        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-white border border-slate-200 shadow-xs space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-bold uppercase tracking-wider">
            <span>Pending Count</span>
            <Clock className="w-4 h-4 text-amber-500" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black text-slate-900 font-mono">
            ₹{pendingVerificationAmount.toLocaleString("en-IN")}
          </p>
          <span className="text-[10px] text-slate-500 block truncate">
            Awaiting Owner verification
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
            Physically cleared to Owner
          </span>
        </div>

        <div className="p-3.5 sm:p-4 rounded-2xl sm:rounded-3xl bg-white border border-slate-200 shadow-xs space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-[11px] font-bold uppercase tracking-wider">
            <span>Discrepancy / Rejected</span>
            <AlertOctagon className="w-4 h-4 text-rose-500" />
          </div>
          <p className="text-xl min-[400px]:text-2xl font-black text-rose-700 font-mono">
            ₹{discrepancyAmount.toLocaleString("en-IN")}
          </p>
          <span className="text-[10px] text-slate-500 block truncate">
            Requires physical review
          </span>
        </div>
      </div>

      {/* SECTION 1: Eligible Collections for Handover */}
      <div className="rounded-2xl sm:rounded-3xl border border-slate-200 bg-white p-3.5 sm:p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h3 className="font-black text-sm text-slate-900 flex items-center gap-2">
              <span>Physical Cash Collections in Hand</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10.5px] font-black">
                {eligibleCollections.length}
              </span>
            </h3>
            <p className="text-[11px] text-slate-500">
              Select individual payments or bundle all into a handover envelope
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search student or receipt..."
                className="pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 text-xs focus:border-amber-500 focus:outline-hidden"
              />
            </div>

            {eligibleCollections.length > 0 && (
              <button
                type="button"
                onClick={handleSelectAll}
                className="tap-bounce px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-bold text-slate-700 flex items-center gap-1.5 cursor-pointer shadow-2xs"
              >
                {Object.keys(selectedAllocations).length === filteredEligible.length ? (
                  <CheckSquare className="w-3.5 h-3.5 text-amber-600" />
                ) : (
                  <Square className="w-3.5 h-3.5 text-slate-400" />
                )}
                <span>Select All</span>
              </button>
            )}
          </div>
        </div>

        {/* Collections Table / Cards */}
        {loading ? (
          <div className="py-12 text-center text-slate-400 space-y-2">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-amber-600" />
            <p className="font-semibold text-xs">Loading faculty cash collections...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : filteredEligible.length === 0 ? (
          <div className="py-12 text-center text-slate-400 space-y-2">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
            <p className="font-bold text-xs text-slate-700">All Collections Handed Over!</p>
            <p className="text-[11px] text-slate-400 max-w-sm mx-auto">
              You currently hold ₹0 unallocated cash. New collections recorded at the desk will appear here automatically.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 overflow-hidden">
            {filteredEligible.map((it) => {
              const key = `${it.feeId}:${it.paymentId}`;
              const isSelected = selectedAllocations[key] !== undefined;
              const allocatedAmount = selectedAllocations[key] ?? it.availableAmount;

              return (
                <div
                  key={key}
                  className={`p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                    isSelected ? "bg-amber-50/40" : "bg-white hover:bg-slate-50/50"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleItemSelection(it)}
                      className="mt-0.5 text-slate-400 hover:text-amber-600 cursor-pointer"
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-amber-600" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>

                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-900 text-xs">
                          {it.studentName}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-semibold">
                          {it.studentBatch}
                        </span>
                        <span className="text-slate-300">•</span>
                        <span className="font-mono text-[11px] text-slate-500">
                          {it.receiptNumber}
                        </span>
                      </div>
                      <p className="text-[10.5px] text-slate-400">
                        Paid on {formatDate(it.paymentDate)} • Total Collection: ₹
                        {it.totalCollected.toLocaleString("en-IN")}
                      </p>
                    </div>
                  </div>

                  {/* Allocation Input / Available Balance */}
                  <div className="flex items-center justify-between sm:justify-end gap-2.5 sm:gap-3 w-full sm:w-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 flex-wrap">
                    <div className="text-left sm:text-right">
                      <span className="text-[10px] text-slate-400 uppercase font-bold block">
                        Available in Hand
                      </span>
                      <span className="font-mono font-black text-slate-900 text-xs">
                        ₹{it.availableAmount.toLocaleString("en-IN")}
                      </span>
                    </div>

                    {isSelected && (
                      <div className="w-28 min-[380px]:w-32">
                        <label className="text-[9.5px] text-amber-800 font-bold uppercase block mb-0.5">
                          Allocate (₹)
                        </label>
                        <input
                          type="number"
                          min="1"
                          max={it.availableAmount}
                          step="1"
                          value={allocatedAmount}
                          onChange={(e) => handleAllocationAmountChange(it, e.target.value)}
                          className="w-full px-2 py-1 rounded-lg border border-amber-300 font-mono font-bold text-xs bg-white text-slate-900 text-right focus:border-amber-600 focus:outline-hidden"
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Action Trigger Bar */}
        {eligibleCollections.length > 0 && (
          <div className="p-3.5 sm:p-4 rounded-2xl bg-slate-900 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg">
            <div>
              <span className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider block">
                Selected for Handover Envelope
              </span>
              <p className="text-xl font-black font-mono text-amber-400">
                ₹{totalSelectedCash.toLocaleString("en-IN")}{" "}
                <span className="text-xs font-semibold text-slate-300">
                  ({selectedItemsForModal.length} selected)
                </span>
              </p>
            </div>

            <button
              type="button"
              disabled={selectedItemsForModal.length === 0 || totalSelectedCash <= 0}
              onClick={() => setIsCreateModalOpen(true)}
              className="tap-bounce px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-md shadow-amber-500/20 transition-all disabled:opacity-40 cursor-pointer"
            >
              <Banknote className="w-4 h-4 stroke-[2.2]" />
              <span>Seal &amp; Hand Over Envelope</span>
            </button>
          </div>
        )}
      </div>

      {/* SECTION 2: Submitted Handover History */}
      <div className="rounded-2xl sm:rounded-3xl border border-slate-200 bg-white p-3.5 sm:p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h3 className="font-black text-sm text-slate-900 flex items-center gap-2">
              <span>Handover Envelope History</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10.5px] font-black">
                {handovers.length}
              </span>
            </h3>
            <p className="text-[11px] text-slate-500">
              Audit trail of all physical cash envelopes delivered to the institute
            </p>
          </div>

          {/* Sub-tabs */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-bold text-slate-600 overflow-x-auto no-scrollbar w-full sm:w-auto max-w-full touch-pan-x">
            <button
              type="button"
              onClick={() => setHistoryTab("all")}
              className={`px-2.5 py-1 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                historyTab === "all" ? "bg-white text-slate-900 shadow-2xs" : "hover:text-slate-900"
              }`}
            >
              All ({handovers.length})
            </button>
            <button
              type="button"
              onClick={() => setHistoryTab("pending")}
              className={`px-2.5 py-1 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                historyTab === "pending" ? "bg-white text-amber-700 shadow-2xs" : "hover:text-slate-900"
              }`}
            >
              Pending ({handovers.filter((h) => h.status === "pending_approval").length})
            </button>
            <button
              type="button"
              onClick={() => setHistoryTab("verified")}
              className={`px-2.5 py-1 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                historyTab === "verified" ? "bg-white text-emerald-700 shadow-2xs" : "hover:text-slate-900"
              }`}
            >
              Verified
            </button>
            <button
              type="button"
              onClick={() => setHistoryTab("discrepancy")}
              className={`px-2.5 py-1 rounded-lg cursor-pointer transition-all whitespace-nowrap flex-shrink-0 ${
                historyTab === "discrepancy" ? "bg-white text-rose-700 shadow-2xs" : "hover:text-slate-900"
              }`}
            >
              Discrepancies
            </button>
          </div>
        </div>

        {/* Envelope History List */}
        {filteredHandovers.length === 0 ? (
          <div className="py-10 text-center text-slate-400 space-y-1">
            <Clock className="w-6 h-6 mx-auto text-slate-300" />
            <p className="font-medium text-xs">No handovers found in this filter.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
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

                    <p className="text-[11px] text-slate-400">
                      Submitted on {formatDate(h.submittedAt)} • {h.items?.length || 0} collections
                      {h.submissionNotes && (
                        <span> • &ldquo;{h.submissionNotes}&rdquo;</span>
                      )}
                    </p>

                    {isRejected && h.rejectionReason && (
                      <p className="text-[11px] text-rose-700 font-medium">
                        Rejection Reason: &ldquo;{h.rejectionReason}&rdquo;
                      </p>
                    )}
                  </div>

                  {/* Financials & Action Buttons */}
                  <div className="flex items-center justify-between sm:justify-end gap-2.5 sm:gap-3 w-full sm:w-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 flex-wrap">
                    <div className="text-left sm:text-right">
                      <span className="font-mono font-black text-slate-900 text-xs">
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

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setActiveDetailHandover(h)}
                        className="tap-bounce px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-[11px] font-bold text-slate-700 flex items-center gap-1 shadow-2xs cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5 text-slate-500" />
                        <span>Details</span>
                      </button>

                      {(hasDiscrepancy || isRejected) && !isDisputed && (
                        <button
                          type="button"
                          onClick={() => setActiveDisputeHandover(h)}
                          className="tap-bounce px-2.5 py-1.5 rounded-xl bg-purple-50 border border-purple-200 hover:bg-purple-100 text-[11px] font-bold text-purple-700 flex items-center gap-1 cursor-pointer"
                        >
                          <HelpCircle className="w-3.5 h-3.5" />
                          <span>Dispute</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateHandoverModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        selectedItems={selectedItemsForModal}
        onSuccess={handleHandoverCreated}
      />

      <HandoverDetailModal
        isOpen={Boolean(activeDetailHandover)}
        onClose={() => setActiveDetailHandover(null)}
        handover={activeDetailHandover}
        userRole="teacher"
        onDispute={(h) => {
          setActiveDetailHandover(null);
          setActiveDisputeHandover(h);
        }}
      />

      <DisputeModal
        isOpen={Boolean(activeDisputeHandover)}
        onClose={() => setActiveDisputeHandover(null)}
        handover={activeDisputeHandover}
        mode="initiate"
        userRole="teacher"
        onSuccess={handleDisputeUpdated}
      />
    </div>
  );
}
