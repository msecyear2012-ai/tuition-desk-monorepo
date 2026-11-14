"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useSetHeader } from "@/components/layout/HeaderContext";
import { apiClient } from "@/lib/apiClient";
import { StudentRecord, BatchRecord } from "@/types";

const StudentBatchRequestModal = dynamic(
  () => import("@/components/modals/StudentBatchRequestModal"),
  { ssr: false }
);
const FeePaymentModal = dynamic(
  () => import("@/components/modals/FeePaymentModal"),
  { ssr: false }
);
const FeeDetailModal = dynamic(
  () => import("@/components/modals/FeeDetailModal"),
  { ssr: false }
);
const ReceiptSlipModal = dynamic(
  () => import("@/components/modals/ReceiptSlipModal"),
  { ssr: false }
);
import type { TargetFeeInfo } from "@/components/modals/FeePaymentModal";
import type { ReceiptSlipData } from "@/components/modals/ReceiptSlipModal";
import type { PaymentEntryItem, CustodyBreakdownItem } from "@/types";
import ParentAccessCard from "./ParentAccessCard";
import { openParentPortalForStudent } from "@/lib/parentPortalLink";
import StudentPhoneMasked from "@/components/common/StudentPhoneMasked";
import { getAuthenticatedCenter, getCachedCenter } from "@/lib/centerProfile";
import {
  ArrowLeft,
  Calendar,
  IndianRupee,
  Layers,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Sparkles,
  Banknote,
  Receipt,
  Clock,
  PlusCircle,
  AlertCircle,
  RefreshCw,
  User,
} from "lucide-react";

export interface StudentFeeItem {
  _id: string;
  centerId: string;
  studentId: string | Record<string, unknown>;
  month: string;
  title?: string;
  amountDue: number;
  paidAmount?: number;
  originalAmountDue?: number;
  billingMonth?: string;
  feeType?: string;
  dueDate?: string;
  status: "Pending" | "Paid" | "Verification Pending" | "Partial Paid";
  utrNumber?: string;
  paymentMode?: string;
  receiptNumber?: string;
  isAdvance?: boolean;
  notes?: string;
  paidDate?: string;
  paidAt?: string;
  paymentDate?: string;
  createdAt?: string;
  receivedByName?: string;
  receivedByRole?: "owner" | "teacher" | string;
  assignedTeacherName?: string;
  batchAtPayment?: string;
  custodyBreakdown?: CustodyBreakdownItem;
  paymentHistory?: PaymentEntryItem[];
}

interface StudentProfileProps {
  studentId: string;
  onBack?: () => void;
  userRole?: "owner" | "teacher" | string;
}

function getSettledAmount(fee: StudentFeeItem | null | undefined): number {
  if (!fee) return 0;
  const paid = Number(fee.paidAmount);
  if (!isNaN(paid) && paid > 0) {
    return paid;
  }
  const due = Number(fee.amountDue);
  if (!isNaN(due) && due > 0) {
    return due;
  }
  return 0;
}

function formatCurrency(amount: number): string {
  return "₹" + (amount || 0).toLocaleString("en-IN");
}

function formatDate(dateString?: string | null): string {
  if (!dateString) return "N/A";
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return String(dateString);
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(dateString);
  }
}

function getCycleOrdinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function getInitials(name: string): string {
  const parts = (name || "").trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return (name || "").slice(0, 2).toUpperCase();
}

export default function StudentProfile({
  studentId,
  onBack,
  userRole: initialRole,
}: StudentProfileProps) {
  const [currentUserRole, setCurrentUserRole] = useState<string>(
    () => initialRole || getCachedCenter()?.role || "teacher"
  );

  useEffect(() => {
    if (!initialRole) {
      getAuthenticatedCenter().then((c) => {
        if (c?.role) setCurrentUserRole(c.role);
      });
    }
  }, [initialRole]);
  const router = useRouter();

  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [fees, setFees] = useState<StudentFeeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeLedgerTab, setActiveLedgerTab] = useState<"all" | "paid" | "pending">("all");

  // Synchronize student profile header title and badge with persistent TopHeader
  useSetHeader({
    title: student ? `${student.name} • 360° Profile` : "Student Profile",
    subtitle: "Fee Ledger, Academic Attendance & Portal Management",
    badgeText: student?.batch || "Student",
  });

  // Modal States (Phase 5.3)
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [selectedFeeForPayment, setSelectedFeeForPayment] = useState<TargetFeeInfo | null>(null);
  const [selectedDetailFeeId, setSelectedDetailFeeId] = useState<string | null>(null);
  const [activeReceiptData, setActiveReceiptData] = useState<ReceiptSlipData | null>(null);

  // Modal: Batch Assignment Request (REQ-01)
  const [isBatchRequestOpen, setIsBatchRequestOpen] = useState(false);
  const [batches, setBatches] = useState<BatchRecord[]>([]);

  useEffect(() => {
    apiClient<BatchRecord[]>("/batches")
      .then((res) => {
        if (res.data) setBatches(res.data);
      })
      .catch(() => {});
  }, []);

  // Toast feedback
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);

  // Fetch Student Profile & Fee Ledger
  useEffect(() => {
    if (!studentId) return;
    let ignore = false;

    async function load() {
      try {
        const [studentRes, feesRes] = await Promise.allSettled([
          apiClient<StudentRecord>(`/students/${studentId}`),
          apiClient<StudentFeeItem[]>("/fees", { params: { studentId } }),
        ]);

        if (ignore) return;

        if (studentRes.status === "fulfilled" && studentRes.value.success && studentRes.value.data) {
          setStudent(studentRes.value.data);
        } else {
          throw new Error("Failed to load student details");
        }

        if (feesRes.status === "fulfilled" && feesRes.value.success && Array.isArray(feesRes.value.data)) {
          setFees(feesRes.value.data);
        } else {
          setFees([]);
        }
      } catch (err: unknown) {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : "Error loading student profile";
          setError(msg);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, [studentId, refreshTrigger]);

  const handleManualRefresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setRefreshTrigger((c) => c + 1);
  }, []);

  // Open Payment Collection Modal
  const handleOpenPayment = (feeItem?: StudentFeeItem | null) => {
    if (feeItem) {
      setSelectedFeeForPayment({
        _id: feeItem._id,
        month: feeItem.month,
        title: feeItem.title,
        amountDue: Number(feeItem.amountDue) || 0,
        paidAmount: Number(feeItem.paidAmount) || 0,
        originalAmountDue:
          feeItem.originalAmountDue ??
          (Number(feeItem.amountDue || 0) + Number(feeItem.paidAmount || 0)),
        billingMonth: feeItem.billingMonth,
        feeType: feeItem.feeType,
        isAdvance: feeItem.isAdvance,
      });
    } else {
      setSelectedFeeForPayment(null);
    }
    setIsPaymentModalOpen(true);
  };

  const handlePaymentSuccess = (updatedFee: unknown, receiptData: ReceiptSlipData) => {
    setToastMessage(
      `Payment of ₹${receiptData.amount.toLocaleString("en-IN")} recorded! (Receipt: ${receiptData.receiptNumber})`
    );
    setTimeout(() => setToastMessage(null), 4500);
    handleManualRefresh();
    setActiveReceiptData(receiptData);
  };

  const handleOpenReceiptForFee = (feeItem: StudentFeeItem) => {
    if (!student) return;
    const paidAmt = getSettledAmount(feeItem);
    setActiveReceiptData({
      receiptNumber: feeItem.receiptNumber || `RCPT-${feeItem._id.slice(-6).toUpperCase()}`,
      studentName: student.name,
      batchName: student.batch,
      amount: paidAmt,
      paymentMode: feeItem.paymentMode || "Cash",
      paymentDate: feeItem.paidAt || feeItem.paidDate || feeItem.paymentDate || feeItem.createdAt,
      title: feeItem.title || feeItem.month,
      collectorName: feeItem.receivedByName,
      collectorRole: feeItem.receivedByRole,
      isProvisional: feeItem.receivedByRole === "teacher",
      remainingBalance: Number(feeItem.amountDue) || 0,
      notes: feeItem.notes,
    });
  };

  // Ledger Metrics Calculations (accurately includes Partial Paid fees)
  const metrics = useMemo(() => {
    let totalPaid = 0;
    let pendingTotal = 0;
    let totalInvoiced = 0;

    for (const f of fees) {
      const paid = Number(f.paidAmount) || 0;
      const due = Number(f.amountDue) || 0;
      const orig = f.originalAmountDue ?? (paid + due);
      totalInvoiced += orig;

      if (f.status === "Paid") {
        totalPaid += paid > 0 ? paid : due;
      } else if (f.status === "Partial Paid") {
        totalPaid += paid;
        pendingTotal += due;
      } else {
        pendingTotal += due;
      }
    }

    const advanceCount = fees.filter(
      (f) =>
        f.isAdvance ||
        /advance/i.test(f.title || "") ||
        /advance/i.test(f.month || "")
    ).length;

    return { totalPaid, pendingTotal, totalInvoiced, advanceCount };
  }, [fees]);

  // Filtered Fees List based on active tab
  const filteredFees = useMemo(() => {
    if (activeLedgerTab === "paid") {
      return fees.filter((f) => f.status === "Paid");
    }
    if (activeLedgerTab === "pending") {
      return fees.filter(
        (f) =>
          f.status === "Pending" ||
          f.status === "Partial Paid" ||
          f.status === "Verification Pending"
      );
    }
    return fees;
  }, [fees, activeLedgerTab]);

  return (
    <div className="flex flex-col min-h-full relative bg-slate-50/50 pb-28 w-full max-w-full overflow-x-hidden">

      {/* Floating Success Toast */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 w-[92%] max-w-sm z-50 animate-bounce">
          <div className="rounded-2xl bg-slate-900 text-white p-3.5 shadow-xl flex items-center gap-2.5 border border-slate-700">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex-1 text-xs font-semibold leading-snug">
              {toastMessage}
            </div>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="w-full max-w-full overflow-x-hidden px-4 space-y-4 max-w-5xl mx-auto">
        {/* Back Link */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              if (onBack) {
                onBack();
              } else {
                router.push("/admissions");
              }
            }}
            className="tap-bounce inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-xl bg-white border border-slate-200/80 shadow-2xs transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Admissions</span>
          </button>

          <button
            type="button"
            onClick={handleManualRefresh}
            className="tap-bounce inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800 p-1.5"
            title="Refresh Ledger"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Loading State */}
        {loading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center shadow-xs space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" />
            <p className="text-xs font-bold text-slate-600">
              Loading 360° student profile and fee ledger...
            </p>
          </div>
        ) : error || !student ? (
          /* Error State */
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center space-y-3 shadow-xs">
            <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
            <div>
              <h3 className="text-sm font-bold text-rose-900">
                Failed to Load Student Profile
              </h3>
              <p className="text-xs text-rose-700 mt-1">{error || "Student not found"}</p>
            </div>
            <button
              type="button"
              onClick={handleManualRefresh}
              className="tap-bounce inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 text-white font-bold text-xs shadow-xs"
            >
              Try Again
            </button>
          </div>
        ) : (
          <>
            {/* 1. Header Profile Banner */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 w-full p-4 sm:p-5 bg-white rounded-2xl shadow-sm border border-slate-200/90">
              {/* Avatar & Core Identity */}
              <div className="flex items-start sm:items-center gap-3 sm:gap-4 min-w-0 flex-1">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-blue-100 text-blue-700 border border-blue-200 flex items-center justify-center font-black text-sm sm:text-base shadow-xs flex-shrink-0">
                  {getInitials(student.name)}
                </div>

                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-lg sm:text-xl font-black text-slate-900 tracking-tight truncate">
                      {student.name}
                    </h1>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${
                        student.isActive !== false
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : "bg-slate-100 text-slate-600 border-slate-200"
                      }`}
                    >
                      {student.isActive !== false ? "Active Student" : "Inactive"}
                    </span>
                    <span className="flex items-center gap-1 text-indigo-700 font-bold bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-100 text-xs">
                      <Layers className="w-3 h-3 text-indigo-600" />
                      {student.batch}
                    </span>
                    {currentUserRole === "teacher" && (
                      <button
                        type="button"
                        onClick={() => setIsBatchRequestOpen(true)}
                        className="text-[10px] text-indigo-600 hover:text-indigo-800 font-bold underline ml-1 cursor-pointer"
                        title="Request batch reassignment for this student"
                      >
                        Request Change
                      </button>
                    )}

                  </div>

                  {/* Group personal details neatly using a flex container with wrapping */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2 text-xs sm:text-sm text-slate-600">
                    <StudentPhoneMasked
                      phone={student.parentWhatsApp}
                      userRole={currentUserRole}
                      showQuickActions={true}
                    />
                    <span className="hidden sm:inline text-slate-300">•</span>
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <Calendar className="w-3.5 h-3.5 text-slate-400" />
                      Joined: {formatDate(student.joiningDate)}
                    </span>
                    <span className="hidden sm:inline text-slate-300">•</span>
                    <span className="text-xs text-slate-500">
                      Billing Cycle: {getCycleOrdinal(student.billingCycleDate || 5)} of month
                    </span>
                  </div>
                </div>
              </div>

              {/* Group the action buttons in their own container */}
              <div className="flex flex-wrap items-center gap-2 w-full md:w-auto pt-2 md:pt-0">
                <button
                  type="button"
                  onClick={() => handleOpenPayment(null)}
                  className="tap-bounce flex-1 md:flex-initial min-w-[140px] h-10 px-3 sm:px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-emerald-600/25 transition-all cursor-pointer whitespace-nowrap"
                >
                  <Banknote className="w-4 h-4 text-emerald-100 stroke-[2.4]" />
                  <span>Record Cash Payment</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    const result = await openParentPortalForStudent(
                      String(student._id)
                    );
                    if (!result.opened && result.message) {
                      window.alert(result.message);
                    }
                  }}
                  className="tap-bounce flex-1 md:flex-initial min-w-[110px] h-10 px-3 sm:px-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  title="Open the parent-facing VIP mobile portal using the canonical portal link"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
                  <span>Parent Portal</span>
                </button>
              </div>
            </div>

            {/* 2. Top Metric Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Metric 1: Total Invoiced */}
              <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                  Total Invoiced
                </span>
                <div className="text-xl sm:text-2xl font-black font-mono text-slate-900 mt-0.5">
                  {formatCurrency(metrics.totalInvoiced)}
                </div>
                <span className="text-[10px] font-semibold text-slate-500 block mt-0.5">
                  All Ledger Cycles
                </span>
              </div>

              {/* Metric 2: Total Collected */}
              <div className="rounded-2xl border border-emerald-100 bg-white p-3.5 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                  Total Collected
                </span>
                <div className="text-xl sm:text-2xl font-black font-mono text-emerald-700 mt-0.5">
                  {formatCurrency(metrics.totalPaid)}
                </div>
                <span className="text-[10px] font-semibold text-emerald-600 block mt-0.5">
                  Settled &amp; Cleared
                </span>
              </div>

              {/* Metric 3: Pending Dues */}
              <div className="rounded-2xl border border-rose-100 bg-white p-3.5 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                  Outstanding Balance
                </span>
                <div className="text-xl sm:text-2xl font-black font-mono text-rose-700 mt-0.5">
                  {formatCurrency(metrics.pendingTotal)}
                </div>
                <span className="text-[10px] font-semibold text-rose-600 block mt-0.5">
                  {metrics.pendingTotal > 0 ? "Balance Awaiting Payment" : "All Clear"}
                </span>
              </div>

              {/* Metric 4: Monthly Fee Rate */}
              <div className="rounded-2xl border border-blue-100 bg-white p-3.5 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                  Monthly Rate
                </span>
                <div className="text-xl sm:text-2xl font-black font-mono text-blue-700 mt-0.5">
                  {formatCurrency(student.monthlyFee || 0)}
                </div>
                <span className="text-[10px] font-semibold text-slate-500 block mt-0.5">
                  Due {getCycleOrdinal(student.billingCycleDate || 5)} monthly
                </span>
              </div>
            </div>

            {/* 2.5 Parent VIP Portal Access Management */}
            {currentUserRole === "owner" && (
              <ParentAccessCard
                studentId={student._id}
                studentName={student.name}
                parentPhone={student.parentWhatsApp}
                centerId={student.centerId}
              />
            )}

            {/* 3. Task 1: 360-Degree Fee & Payment History Ledger */}
            <div className="rounded-3xl border border-slate-200/90 bg-white p-5 shadow-xs space-y-4">
              {/* Ledger Header & Tab Navigation */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div>
                  <h2 className="text-base font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
                    <Receipt className="w-5 h-5 text-emerald-600 stroke-[2.3]" />
                    <span>Fee &amp; Payment History</span>
                  </h2>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">
                    Complete 360° financial ledger for {student.name}
                  </p>
                </div>

                {/* Sub-Tabs */}
                <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-100 self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={() => setActiveLedgerTab("all")}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      activeLedgerTab === "all"
                        ? "bg-white text-slate-900 shadow-2xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    All ({fees.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveLedgerTab("paid")}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      activeLedgerTab === "paid"
                        ? "bg-white text-emerald-700 shadow-2xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Paid ({fees.filter((f) => f.status === "Paid").length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveLedgerTab("pending")}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                      activeLedgerTab === "pending"
                        ? "bg-white text-amber-700 shadow-2xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Pending ({fees.filter((f) => f.status !== "Paid").length})
                  </button>
                </div>
              </div>

              {/* Ledger Records Table / Cards */}
              {filteredFees.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center space-y-2">
                  <Receipt className="w-8 h-8 text-slate-400 mx-auto" />
                  <p className="text-xs font-bold text-slate-700">
                    No fee records found in this category
                  </p>
                  <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                    Record offline cash collections or review online submissions for this student.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleOpenPayment(null)}
                    className="tap-bounce mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-bold shadow-2xs"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    <span>Record Cash Payment</span>
                  </button>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {filteredFees.map((fee) => {
                    const isAdvance = Boolean(
                      fee.isAdvance ||
                        /advance/i.test(fee.title || "") ||
                        /advance/i.test(fee.month || "")
                    );
                    const isCash = Boolean(
                      fee.paymentMode && /cash/i.test(fee.paymentMode)
                    );
                    const isPaid = fee.status === "Paid";
                    const isVerificationPending = fee.status === "Verification Pending";

                    const dateDisplay = formatDate(
                      fee.paidAt || fee.paidDate || fee.paymentDate || fee.dueDate || fee.createdAt
                    );

                    const receiptNo =
                      fee.receiptNumber ||
                      (isCash ? `RCPT-${fee._id.slice(-6).toUpperCase()}` : "");

                    return (
                      <div
                        key={fee._id}
                        className="py-3.5 flex flex-col sm:flex-row flex-wrap items-start sm:items-center justify-between gap-3 hover:bg-slate-50/80 px-2 rounded-2xl transition-colors w-full"
                      >
                        {/* Left: Description, Type & Date */}
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div
                            className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 border shadow-2xs ${
                              isPaid
                                ? isCash
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  : "bg-blue-50 text-blue-700 border-blue-200"
                                : "bg-amber-50 text-amber-700 border-amber-200"
                            }`}
                          >
                            {isCash ? (
                              <Banknote className="w-5 h-5 stroke-[2.2]" />
                            ) : (
                              <IndianRupee className="w-4.5 h-4.5 stroke-[2.4]" />
                            )}
                          </div>

                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-xs font-bold text-slate-900 tracking-tight">
                                {fee.title || fee.month}
                              </h3>

                              {/* Fee Type Badge: Advance vs Regular */}
                              {isAdvance ? (
                                <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-extrabold bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-2xs">
                                  <Sparkles className="w-3 h-3" />
                                  Advance
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                                  Regular Fee
                                </span>
                              )}

                              {/* Payment Mode Badge */}
                              {isCash ? (
                                <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-extrabold bg-emerald-100 text-emerald-900 border border-emerald-300">
                                  <Banknote className="w-3 h-3 text-emerald-700" />
                                  Cash
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
                                  Online / UPI
                                </span>
                              )}

                              {/* Status Badge */}
                              <span
                                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-extrabold border ${
                                  isPaid
                                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                    : isVerificationPending
                                    ? "bg-amber-100 text-amber-900 border-amber-300 animate-pulse"
                                    : "bg-rose-50 text-rose-700 border-rose-200"
                                }`}
                              >
                                {isPaid ? (
                                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                ) : (
                                  <Clock className="w-3 h-3" />
                                )}
                                {fee.status}
                              </span>
                            </div>

                            {/* Date + Receipt/UTR Meta */}
                            <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-500 font-medium break-all">
                              <span>Date: {dateDisplay}</span>

                              {/* Receipt Number */}
                              {receiptNo ? (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <span className="font-mono font-bold text-emerald-900 select-all break-all">
                                    Receipt: {receiptNo}
                                  </span>
                                </>
                              ) : fee.utrNumber ? (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <span className="font-mono text-slate-700 select-all break-all">
                                    UTR: {fee.utrNumber}
                                  </span>
                                </>
                              ) : null}

                              {/* Attribution & Provisional Badge */}
                              {fee.receivedByName && (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <span className="inline-flex items-center gap-1 font-semibold text-slate-600 text-[10px]">
                                    <User className="w-3 h-3 text-slate-400" />
                                    <span>Collected by {fee.receivedByName}</span>
                                    {fee.receivedByRole === "teacher" ? (
                                      <span className="px-1 rounded bg-amber-100 text-amber-900 border border-amber-300 font-extrabold text-[9px] uppercase">
                                        Provisional Cash
                                      </span>
                                    ) : (
                                      <span className="px-1 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-extrabold text-[9px] uppercase">
                                        Owner Verified
                                      </span>
                                    )}
                                  </span>
                                </>
                              )}

                              {fee.notes && (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <span className="text-slate-500 italic truncate max-w-xs break-words">
                                    &quot;{fee.notes}&quot;
                                  </span>
                                </>
                              )}
                            </div>

                            {/* Partial Paid Progress Indicator */}
                            {fee.status === "Partial Paid" && (
                              <div className="mt-1 flex items-center gap-1.5 text-[10.5px]">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-900 border border-amber-200 font-medium">
                                  <span>Paid: <strong>₹{(fee.paidAmount || 0).toLocaleString("en-IN")}</strong></span>
                                  <span className="text-amber-400">•</span>
                                  <span>Balance Due: <strong className="text-rose-700 font-mono">₹{fee.amountDue.toLocaleString("en-IN")}</strong></span>
                                </span>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Right: Amount & Actions */}
                        <div className="flex items-center justify-between sm:justify-end gap-2 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 w-full sm:w-auto flex-wrap">
                          <div className="text-left sm:text-right mr-1">
                            <div className="text-sm font-black font-mono text-slate-900 tracking-tight">
                              {formatCurrency(isPaid ? getSettledAmount(fee) : fee.amountDue)}
                            </div>
                            <span className="text-[10px] text-slate-400 font-semibold block">
                              {isPaid ? "Settled" : fee.status === "Partial Paid" ? "Balance Due" : "Due"}
                            </span>
                          </div>

                          {/* Action 1: View Details & History */}
                          <button
                            type="button"
                            onClick={() => setSelectedDetailFeeId(fee._id)}
                            className="tap-bounce h-8 px-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs flex items-center gap-1 shadow-2xs transition-all cursor-pointer"
                            title="View complete payment history & custody"
                          >
                            <span>Details</span>
                          </button>

                          {/* Action 2: View Receipt slip if paid or partial */}
                          {(isPaid || (Number(fee.paidAmount) || 0) > 0) && (
                            <button
                              type="button"
                              onClick={() => handleOpenReceiptForFee(fee)}
                              className="tap-bounce h-8 px-2.5 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:scale-95 text-emerald-800 font-bold text-xs flex items-center gap-1 shadow-2xs transition-all cursor-pointer"
                              title="View official digital receipt slip"
                            >
                              <Receipt className="w-3.5 h-3.5 text-emerald-600 stroke-[2.2]" />
                              <span>Receipt</span>
                            </button>
                          )}

                          {/* Action 3: Record Payment if balance due */}
                          {fee.amountDue > 0 && (
                            <button
                              type="button"
                              onClick={() => handleOpenPayment(fee)}
                              className="tap-bounce h-8 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold flex items-center gap-1 shadow-2xs cursor-pointer"
                              title="Record cash payment against this fee"
                            >
                              <Banknote className="w-3.5 h-3.5 text-emerald-100" />
                              <span>Record Payment</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Phase 5.3: Cash/Manual Fee Payment Collection Modal */}
      <FeePaymentModal
        isOpen={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        student={
          student
            ? {
                _id: student._id,
                name: student.name,
                batch: student.batch,
                centerId: student.centerId,
                monthlyFee: student.monthlyFee,
              }
            : null
        }
        fee={selectedFeeForPayment}
        onSuccess={handlePaymentSuccess}
      />

      {/* Phase 5.3: Detailed Fee History & Custody Modal */}
      <FeeDetailModal
        isOpen={Boolean(selectedDetailFeeId)}
        onClose={() => setSelectedDetailFeeId(null)}
        feeId={selectedDetailFeeId}
        userRole={currentUserRole}
        onRecordPayment={(feeDoc) => {
          handleOpenPayment(feeDoc as unknown as StudentFeeItem);
        }}
        onViewReceipt={(receiptData) => {
          setActiveReceiptData(receiptData);
        }}
      />

      {/* Phase 5.3: Official / Provisional Receipt Slip Modal */}
      <ReceiptSlipModal
        isOpen={Boolean(activeReceiptData)}
        onClose={() => setActiveReceiptData(null)}
        receiptData={activeReceiptData}
      />

      {student && (
        <StudentBatchRequestModal
          isOpen={isBatchRequestOpen}
          onClose={() => setIsBatchRequestOpen(false)}
          initialStudent={student}
          batches={batches}
          onSuccess={() => {
            handleManualRefresh();
          }}
        />
      )}
    </div>
  );
}
