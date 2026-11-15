"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSetHeader } from "@/components/layout/HeaderContext";
import FeesSummaryHeroCard from "@/components/fees/FeesSummaryHeroCard";
import GlobalReminderButton from "@/components/fees/GlobalReminderButton";
import OverdueStudentItem from "@/components/fees/OverdueStudentItem";
import dynamic from "next/dynamic";
import { apiClient, getCurrentCenterId, getApiCache, invalidateApiCache } from "@/lib/apiClient";
import { OverdueFeeStudent, TeacherRecord } from "@/types";
import { getAuthenticatedCenter, getCachedCenter, CenterInfo } from "@/lib/centerProfile";
import StudentPhoneMasked from "@/components/common/StudentPhoneMasked";
import { resolveFeeTabs, type MainFeeTab, type PaymentsSubTab } from "./feeNavigation";

const AddFeeModal = dynamic(() => import("@/components/modals/AddFeeModal"), {
  loading: () => null,
});
const FeePaymentModal = dynamic(() => import("@/components/modals/FeePaymentModal"), {
  loading: () => null,
});
const FeeDetailModal = dynamic(() => import("@/components/modals/FeeDetailModal"), {
  loading: () => null,
});
const ReceiptSlipModal = dynamic(() => import("@/components/modals/ReceiptSlipModal"), {
  loading: () => null,
});
const TeacherHandoverConsole = dynamic(
  () => import("@/components/handovers/TeacherHandoverConsole"),
  {
    loading: () => (
      <div className="p-8 text-center text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600 mb-2" />
        <span className="text-sm">Loading handover console...</span>
      </div>
    ),
  }
);
const OwnerHandoverConsole = dynamic(
  () => import("@/components/handovers/OwnerHandoverConsole"),
  {
    loading: () => (
      <div className="p-8 text-center text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600 mb-2" />
        <span className="text-sm">Loading handover console...</span>
      </div>
    ),
  }
);
import type { TargetStudentInfo, TargetFeeInfo } from "@/components/modals/FeePaymentModal";
import type { ReceiptSlipData } from "@/components/modals/ReceiptSlipModal";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  IndianRupee,
  ShieldCheck,
  Clock,
  Loader2,
  Plus,
  Users,
  Banknote,
  LayoutDashboard,
  CreditCard,
  ArrowRight,
  TrendingUp,
  Wallet,
  Building2,
  Sparkles,
  Bell,
  Info,
  FileText,
  Camera,
  ZoomIn,
  ZoomOut,
  Eye,
  X,
  Trash2,
  Hash,
  Copy,
} from "lucide-react";

interface ApiStudentRef {
  _id: string;
  name: string;
  batch?: string;
  parentWhatsApp?: string;
}

interface ApiFee {
  _id: string;
  centerId: string;
  studentId: ApiStudentRef | string;
  month: string;
  title?: string;
  amountDue: number;
  paidAmount?: number;
  dueDate: string;
  status: "Pending" | "Paid" | "Verification Pending" | "Partial Paid";
  utrNumber?: string;
  isAdvance?: boolean;
  feeType?: string;
  paymentMode?: string;
  paidDate?: string;
  paidAt?: string;
  paymentDate?: string;
  receiptNumber?: string;
  createdAt?: string;
  receivedByName?: string;
  receivedByRole?: "owner" | "teacher";
  assignedTeacherName?: string;
  batchAtPayment?: string;
  hasPaymentProof?: boolean;
  latestPaymentProofId?: string;
  rejectionReason?: string;
}

interface RecentCollectionFeedItem {
  feeId: string;
  paymentId: string;
  amount: number;
  paymentDate?: string | Date | null;
  receiptNumber: string;
  studentName: string;
  collectorName: string;
  collectorRole: string;
  custodyStatus: string;
}

export interface StudentFeeActivityItem {
  feeId: string;
  studentName: string;
  batchName: string;
  month: string;
  title?: string;
  amountDue: number;
  paidAmount: number;
  status: string;
  dueDate?: Date | string;
  updatedAt: Date | string;
}

export interface TeacherNotificationItem {
  _id?: string;
  id?: string;
  title: string;
  message: string;
  amount?: number;
  statusLabel?: string;
  type?: string;
  isRead?: boolean;
  createdAt?: Date | string;
}

interface FeesSummaryData {
  totalPendingAmount: number;
  pendingStudentsCount: number;
  collectedAmount: number;
  role?: "owner" | "teacher";
  kpis?: {
    totalParentCollections?: number;
    verifiedCashReceived?: number;
    teacherHeldCash?: number;
    pendingVerificationCash?: number;
    outstandingFeeBalance?: number;
    activeDiscrepancies?: number;
    ownCashCollected?: number;
    ownCashInHand?: number;
    ownSubmittedHandovers?: number;
    ownVerifiedHandovers?: number;
  };
  studentStatus?: {
    totalAssignedStudents?: number;
    studentsWithDues?: number;
    studentsFullyPaid?: number;
    totalOutstandingBalance?: number;
    recentActivity?: StudentFeeActivityItem[];
  };
  actionRequired?: {
    pendingHandoversCount?: number;
    pendingHandoversAmount?: number;
    overdueCount?: number;
    disputesCount?: number;
    eligibleForHandoverAmount?: number;
    pendingHandoverCount?: number;
    rejectedHandoverCount?: number;
    activeDisputesCount?: number;
  };
  recentCollections?: RecentCollectionFeedItem[];
  notifications?: TeacherNotificationItem[];
}

export type { MainFeeTab, PaymentsSubTab };

const AVATAR_COLORS = [
  "bg-amber-100 text-amber-800 border-amber-200",
  "bg-rose-100 text-rose-700 border-rose-200",
  "bg-purple-100 text-purple-700 border-purple-200",
  "bg-blue-100 text-blue-700 border-blue-200",
  "bg-cyan-100 text-cyan-700 border-cyan-200",
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function calculateDaysLate(dueDateString?: string): number {
  if (!dueDateString) return 0;
  const due = new Date(dueDateString);
  const now = new Date();
  const dueMidnight = new Date(
    due.getFullYear(),
    due.getMonth(),
    due.getDate()
  );
  const nowMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const diffTime = nowMidnight.getTime() - dueMidnight.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

interface ProofListItem {
  _id?: string;
  submittedUtr?: string;
  fileUrl?: string;
  thumbnailUrl?: string;
  status?: string;
  createdAt?: string;
  fileSizeBytes?: number;
  originalFileName?: string;
  mimeType?: string;
  notes?: string;
  rejectionReason?: string;
}

function FeePaginationBar({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
  label = "records",
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (newPage: number) => void;
  label?: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-3.5 py-2.5 bg-slate-50 border border-slate-200/90 rounded-2xl text-xs text-slate-600 mt-3 shadow-2xs">
      <div className="font-semibold text-slate-500">
        Page <span className="text-slate-800 font-bold">{currentPage}</span> of{" "}
        <span className="text-slate-800 font-bold">{Math.max(1, totalPages)}</span>{" "}
        <span className="hidden sm:inline">({totalItems} {label})</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="tap-bounce px-3 py-1 rounded-xl border border-slate-200 bg-white font-bold text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 transition-all shadow-2xs"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="tap-bounce px-3 py-1 rounded-xl border border-slate-200 bg-white font-bold text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 transition-all shadow-2xs"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function mapFeeToStudent(fee: ApiFee, idx: number): OverdueFeeStudent {
  const studentObj =
    typeof fee.studentId === "object" && fee.studentId !== null
      ? fee.studentId
      : null;

  const rawStudentId =
    typeof fee.studentId === "object" && fee.studentId !== null
      ? fee.studentId._id
      : (fee.studentId as string);

  const studentName = studentObj?.name || "Student";
  const batchName = studentObj?.batch || "General Batch";
  const parentPhone = studentObj?.parentWhatsApp || "";
  const daysLate = calculateDaysLate(fee.dueDate);

  const paidAmount = Number(fee.paidAmount) || 0;
  const remainingDue = Number(fee.amountDue) || 0;
  const totalAmount =
    fee.status === "Partial Paid"
      ? paidAmount + remainingDue
      : fee.status === "Paid"
      ? paidAmount || remainingDue
      : remainingDue;

  const rawPaidDate = fee.paidDate || fee.paymentDate || fee.paidAt;

  return {
    id: fee._id,
    feeId: fee._id,
    studentId: rawStudentId,
    name: studentName,
    batchName: `${batchName} • ${fee.title || fee.month}`,
    title: fee.title || fee.month,
    month: fee.month,
    pendingAmount: remainingDue,
    paidAmount: paidAmount,
    totalAmount: totalAmount,
    daysLate: daysLate,
    parentName: `Parent of ${studentName}`,
    parentPhone: parentPhone,
    dueDate: fee.dueDate
      ? new Date(fee.dueDate).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "Due Soon",
    paidDate: rawPaidDate
      ? new Date(rawPaidDate).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : undefined,
    avatarColor: AVATAR_COLORS[idx % AVATAR_COLORS.length],
    initials: getInitials(studentName),
    status: fee.status,
    utrNumber: fee.utrNumber,
    paymentMode: fee.paymentMode,
    receiptNumber: fee.receiptNumber,
    paidAt: fee.paidAt,
    paymentDate: fee.paymentDate,
    receivedByName: fee.receivedByName,
    receivedByRole: fee.receivedByRole,
    assignedTeacherName: fee.assignedTeacherName,
    batchAtPayment: fee.batchAtPayment,
    hasPaymentProof: Boolean(fee.hasPaymentProof),
    latestPaymentProofId: fee.latestPaymentProofId ? String(fee.latestPaymentProofId) : undefined,
    rejectionReason: fee.rejectionReason,
  };
}

export interface FeesClientProps {
  initialTab?: MainFeeTab;
  initialSub?: PaymentsSubTab;
  initialProfile?: CenterInfo | null;
}

export default function FeesClient({
  initialTab = "overview",
  initialSub = "pending",
  initialProfile = null,
}: FeesClientProps) {
  // 3-Section Navigation State (Phase 7.1)
  const [mainTab, setMainTab] = useState<MainFeeTab>(initialTab);
  const [paymentsSubTab, setPaymentsSubTab] = useState<PaymentsSubTab>(initialSub);

  // Multi-Identity Profile & Faculty Filter (Owner Mode)
  const [userProfile, setUserProfile] = useState<CenterInfo | null>(initialProfile);
  const isOwner = userProfile?.role === "owner";
  const isTeacher = userProfile?.role === "teacher";
  const effectivePaymentsSubTab = isTeacher && paymentsSubTab === "review" ? "pending" : paymentsSubTab;
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [selectedTeacherFilter, setSelectedTeacherFilter] = useState<string>("all");

  const activeCenterId = userProfile?.centerId || (typeof window !== "undefined" ? getCurrentCenterId() : "");
  const cachedPending = getApiCache<ApiFee[]>("/fees", { centerId: activeCenterId, status: "Pending,Partial Paid" });
  const cachedReview = getApiCache<ApiFee[]>("/fees", { centerId: activeCenterId, status: "Verification Pending" });
  const cachedSummary = getApiCache<FeesSummaryData>("/fees/summary", { centerId: activeCenterId });

  // Data lists strictly separated by status
  const [pendingStudents, setPendingStudents] = useState<OverdueFeeStudent[]>([]);
  const [reviewStudents, setReviewStudents] = useState<OverdueFeeStudent[]>([]);
  const [paidStudents, setPaidStudents] = useState<OverdueFeeStudent[]>([]);
  const [collectedAmount, setCollectedAmount] = useState<number>(0);
  const [summaryOverview, setSummaryOverview] = useState<FeesSummaryData | null>(null);
  const [loadingPaid, setLoadingPaid] = useState<boolean>(false);
  const [hasLoadedPaid, setHasLoadedPaid] = useState<boolean>(false);

  // Sub-filter for Pending Dues tab
  const [pendingFilter, setPendingFilter] = useState<"all" | "critical" | "moderate">("all");

  // Server-side pagination states (P0 Optimization)
  const [pendingPage, setPendingPage] = useState<number>(1);
  const [pendingTotal, setPendingTotal] = useState<number>(0);
  const [pendingTotalPages, setPendingTotalPages] = useState<number>(1);

  const [reviewPage, setReviewPage] = useState<number>(1);
  const [reviewTotal, setReviewTotal] = useState<number>(0);
  const [reviewTotalPages, setReviewTotalPages] = useState<number>(1);

  const [paidPage, setPaidPage] = useState<number>(1);
  const [paidTotal, setPaidTotal] = useState<number>(0);
  const [paidTotalPages, setPaidTotalPages] = useState<number>(1);

  // Reminder & Action States
  const [sentReminders, setSentReminders] = useState<Record<string, boolean>>({});
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(null);
  const [isGlobalSent, setIsGlobalSent] = useState(false);
  const [isSendingBulk, setIsSendingBulk] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Phase 2A Modal & Confirmation States
  const [isAddFeeModalOpen, setIsAddFeeModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [selectedStudentForPayment, setSelectedStudentForPayment] = useState<TargetStudentInfo | null>(null);
  const [selectedFeeForPayment, setSelectedFeeForPayment] = useState<TargetFeeInfo | null>(null);
  const [selectedDetailFeeId, setSelectedDetailFeeId] = useState<string | null>(null);
  const [activeReceiptData, setActiveReceiptData] = useState<ReceiptSlipData | null>(null);
  const [cooldownConfirmFee, setCooldownConfirmFee] = useState<{
    feeId: string;
    student: OverdueFeeStudent;
    message: string;
  } | null>(null);
  const [overrideReasonInput, setOverrideReasonInput] = useState(
    "Parent requested urgent invoice link via phone"
  );
  const [isOverriding, setIsOverriding] = useState(false);

  // Payment Proof Review & Screenshot Viewer States (Phase 3)
  const [proofModalOpen, setProofModalOpen] = useState(false);
  const [activeProofStudent, setActiveProofStudent] = useState<OverdueFeeStudent | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofList, setProofList] = useState<ProofListItem[]>([]);
  const [proofError, setProofError] = useState<string | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);

  // Rejection Reason Modal States
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectTargetStudent, setRejectTargetStudent] = useState<OverdueFeeStudent | null>(null);
  const [rejectionReasonInput, setRejectionReasonInput] = useState("");
  const [rejectionError, setRejectionError] = useState<string | null>(null);

  // Approval Confirmation Modal States
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [approveTargetStudent, setApproveTargetStudent] = useState<OverdueFeeStudent | null>(null);

  // Header Context
  useSetHeader({
    title: "Fee Management",
    subtitle:
      mainTab === "overview"
        ? "Collections Overview & Activity"
        : mainTab === "handovers"
        ? "Physical Cash Custody & Verification"
        : "Pending Dues, Reviews & Paid History",
    badgeText:
      reviewStudents.length > 0
        ? `${reviewStudents.length} Review`
        : `${pendingStudents.length} Due`,
  });

  // Synchronize browser Back / Forward URL navigation
  useEffect(() => {
    const handlePopState = () => {
      const p = new URLSearchParams(window.location.search);
      const { initialTab: resolvedTab, initialSub: resolvedSub } = resolveFeeTabs({
        tab: p.get("tab"),
        sub: p.get("sub"),
      });
      setMainTab(resolvedTab);
      setPaymentsSubTab(resolvedSub);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // Switch Main Section
  const handleSwitchMainTab = (tab: MainFeeTab) => {
    setMainTab(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      if (tab === "payments") {
        const effectiveSub = userProfile?.role === "teacher" && paymentsSubTab === "review" ? "pending" : paymentsSubTab;
        url.searchParams.set("sub", effectiveSub);
      } else {
        url.searchParams.delete("sub");
      }
      window.history.replaceState({}, "", url.toString());
    }
  };

  // Switch Payments Subsection
  const handleSwitchPaymentsSub = (sub: PaymentsSubTab) => {
    if (userProfile?.role === "teacher" && sub === "review") return;
    setPaymentsSubTab(sub);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "payments");
      url.searchParams.set("sub", sub);
      window.history.replaceState({}, "", url.toString());
    }
    if (sub === "paid" && !hasLoadedPaid) {
      fetchPaidHistory();
    }
  };

  // Load user profile & active faculty for Owner filters
  useEffect(() => {
    let mounted = true;
    getAuthenticatedCenter().then((profile) => {
      if (mounted && profile) {
        setUserProfile(profile);
        if (profile.role === "owner") {
          apiClient<{ data?: TeacherRecord[] }>("/teachers?isActive=true")
            .then((res) => {
              if (mounted && res.success && Array.isArray(res.data)) {
                setTeachers(res.data.filter((t) => t.isActive !== false));
              }
            })
            .catch(() => {});
        }
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Lazy fetch historical paid records on demand
  const fetchPaidHistory = useCallback(async (isRefresh = false, targetPage?: number) => {
    setLoadingPaid(true);
    try {
      const activeId = getCurrentCenterId();
      const teacherParam =
        selectedTeacherFilter !== "all" ? { assignedTeacher: selectedTeacherFilter } : {};
      const pageToFetch = targetPage !== undefined ? targetPage : paidPage;
      const res = await apiClient<ApiFee[]>("/fees", {
        params: {
          centerId: activeId,
          status: "Paid,Partial Paid",
          page: pageToFetch,
          limit: 50,
          ...teacherParam,
        },
        skipCache: isRefresh,
      });
      if (res.success && Array.isArray(res.data)) {
        const rawPaid = res.data;
        setPaidStudents(rawPaid.map(mapFeeToStudent));

        const paginationObj = (res as unknown as { pagination?: { total?: number; totalPages?: number } }).pagination;
        if (paginationObj) {
          setPaidTotal(paginationObj.total || rawPaid.length);
          setPaidTotalPages(paginationObj.totalPages || 1);
        } else {
          setPaidTotal(rawPaid.length);
          setPaidTotalPages(1);
        }

        const totalPaid = rawPaid.reduce(
          (sum, f) => sum + (Number(f.paidAmount || f.amountDue) || 0),
          0
        );
        setCollectedAmount((prev) => (prev > 0 ? prev : totalPaid));
        setHasLoadedPaid(true);
      }
    } catch {
      // ignore
    } finally {
      setLoadingPaid(false);
    }
  }, [selectedTeacherFilter, paidPage]);

  // Fetch active fee data & enriched summary
  const fetchFeesData = useCallback(async (isRefresh = false, targetPendingPage?: number, targetReviewPage?: number) => {
    if (isRefresh || (!cachedPending && !cachedReview)) {
      queueMicrotask(() => setLoading(true));
    }
    setError(null);
    try {
      const activeId = getCurrentCenterId();
      const teacherParam =
        selectedTeacherFilter !== "all" ? { assignedTeacher: selectedTeacherFilter } : {};
      const penPage = targetPendingPage !== undefined ? targetPendingPage : pendingPage;
      const revPage = targetReviewPage !== undefined ? targetReviewPage : reviewPage;

      const [pendingRes, reviewRes, summaryRes] = await Promise.allSettled([
        apiClient<ApiFee[]>("/fees", {
          params: { centerId: activeId, status: "Pending,Partial Paid", page: penPage, limit: 50, ...teacherParam },
          skipCache: isRefresh,
        }),
        apiClient<ApiFee[]>("/fees", {
          params: { centerId: activeId, status: "Verification Pending", page: revPage, limit: 50, ...teacherParam },
          skipCache: isRefresh,
        }),
        apiClient<FeesSummaryData>("/fees/summary", {
          params: { centerId: activeId, ...teacherParam },
          skipCache: isRefresh,
        }),
      ]);

      let validReviewFees: ApiFee[] = [];
      if (reviewRes.status === "fulfilled" && reviewRes.value.success && Array.isArray(reviewRes.value.data)) {
        validReviewFees = reviewRes.value.data;
        setReviewStudents(validReviewFees.map(mapFeeToStudent));
        const revPagination = (reviewRes.value as unknown as { pagination?: { total?: number; totalPages?: number } }).pagination;
        if (revPagination) {
          setReviewTotal(revPagination.total || validReviewFees.length);
          setReviewTotalPages(revPagination.totalPages || 1);
        }
      } else if (isRefresh || !cachedReview) {
        setReviewStudents([]);
      }

      if (pendingRes.status === "fulfilled" && pendingRes.value.success && Array.isArray(pendingRes.value.data)) {
        const reviewFeeIdSet = new Set(validReviewFees.map((f) => String(f._id)));
        const cleanPending = pendingRes.value.data.filter((fee) => {
          // Rule F: Fully paid fees must never appear in Pending Dues
          if (fee.status === "Paid") return false;
          // Rule B: Verification pending fees must never appear in Pending Dues while under review
          if (fee.status === "Verification Pending" || reviewFeeIdSet.has(String(fee._id))) {
            return false;
          }
          // Rule A & D: Must have an active remaining balance (> 0)
          const remainingDue = Number(fee.amountDue) || 0;
          if (remainingDue <= 0) return false;
          // Rule E: Fully covered advance payment must not appear in Pending Dues
          const isAdvanceRecord = Boolean(
            fee.isAdvance ||
            fee.feeType === "advance" ||
            (fee.title && /advance/i.test(fee.title)) ||
            (fee.month && /advance/i.test(fee.month))
          );
          if (isAdvanceRecord && remainingDue <= 0) return false;
          return true;
        });
        setPendingStudents(cleanPending.map(mapFeeToStudent));
        const penPagination = (pendingRes.value as unknown as { pagination?: { total?: number; totalPages?: number } }).pagination;
        if (penPagination) {
          setPendingTotal(penPagination.total || cleanPending.length);
          setPendingTotalPages(penPagination.totalPages || 1);
        }
      } else if (isRefresh || !cachedPending) {
        setPendingStudents([]);
      }

      if (summaryRes.status === "fulfilled" && summaryRes.value.success && summaryRes.value.data) {
        setCollectedAmount(summaryRes.value.data.collectedAmount || 0);
        setSummaryOverview(summaryRes.value.data);
      }

      if (hasLoadedPaid) {
        fetchPaidHistory(isRefresh);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load fee records";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [hasLoadedPaid, fetchPaidHistory, cachedPending, cachedReview, selectedTeacherFilter, pendingPage, reviewPage]);

  const handlePendingPageChange = (newPage: number) => {
    setPendingPage(newPage);
    fetchFeesData(true, newPage, reviewPage);
  };

  const handleReviewPageChange = (newPage: number) => {
    setReviewPage(newPage);
    fetchFeesData(true, pendingPage, newPage);
  };

  const handlePaidPageChange = (newPage: number) => {
    setPaidPage(newPage);
    fetchPaidHistory(true, newPage);
  };

  useEffect(() => {
    let ignore = false;
    void (async () => {
      if (!ignore) {
        await fetchFeesData();
      }
    })();
    return () => {
      ignore = true;
    };
  }, [fetchFeesData]);

  // Real-time Event Listener for Immediate Visibility
  useEffect(() => {
    const handleCollectionRecorded = (event: Event) => {
      const customDetail = (event as CustomEvent<{ feeId?: string; amount?: number }>)?.detail;
      const targetFeeId = customDetail?.feeId;
      if (targetFeeId) {
        setPendingStudents((prev) => prev.filter((s) => (s.feeId || s.id) !== targetFeeId));
      }
      invalidateApiCache();
      fetchFeesData(true);
      fetchPaidHistory(true);
      setToastMessage(
        customDetail?.amount
          ? `Cash collection of ₹${customDetail.amount} recorded! Balances & overview updated.`
          : "Cash collection recorded! Balances & overview updated."
      );
      setTimeout(() => setToastMessage(null), 4000);
    };

    const handleFeeAlreadyPaid = (event: Event) => {
      const customDetail = (event as CustomEvent<{ feeId?: string; studentId?: string; message?: string }>)?.detail;
      const targetFeeId = customDetail?.feeId;
      const targetStudentId = customDetail?.studentId;

      setPendingStudents((prev) =>
        prev.filter((s) => {
          if (targetFeeId && (s.feeId || s.id) === targetFeeId) return false;
          if (targetStudentId && s.studentId === targetStudentId) return false;
          return true;
        })
      );

      invalidateApiCache();
      fetchFeesData(true);
      fetchPaidHistory(true);
      setToastMessage(
        customDetail?.message || "Fee is already Paid in full. Pending dues list refreshed."
      );
      setTimeout(() => setToastMessage(null), 4000);
    };

    window.addEventListener("msec:collection-recorded", handleCollectionRecorded);
    window.addEventListener("msec:fee-already-paid", handleFeeAlreadyPaid);
    return () => {
      window.removeEventListener("msec:collection-recorded", handleCollectionRecorded);
      window.removeEventListener("msec:fee-already-paid", handleFeeAlreadyPaid);
    };
  }, [fetchFeesData, fetchPaidHistory]);

  // Paid history on navigation
  useEffect(() => {
    if (
      mainTab === "payments" &&
      effectivePaymentsSubTab === "paid" &&
      (!hasLoadedPaid || selectedTeacherFilter) &&
      !loadingPaid
    ) {
      fetchPaidHistory();
    }
  }, [mainTab, effectivePaymentsSubTab, hasLoadedPaid, loadingPaid, fetchPaidHistory, selectedTeacherFilter]);

  // Overdue calculations
  const totalOverdue = useMemo(() => {
    return pendingStudents.reduce((sum, s) => {
      if (s.status === "Pending" || s.status === "Partial Paid") {
        return sum + (Number(s.pendingAmount) || 0);
      }
      return sum;
    }, 0);
  }, [pendingStudents]);

  const criticalCount = useMemo(
    () => pendingStudents.filter((s) => s.daysLate > 7).length,
    [pendingStudents]
  );
  const moderateCount = useMemo(
    () => pendingStudents.filter((s) => s.daysLate <= 7).length,
    [pendingStudents]
  );

  const filteredPendingStudents = useMemo(() => {
    if (pendingFilter === "critical") {
      return pendingStudents.filter((s) => s.daysLate > 7);
    }
    if (pendingFilter === "moderate") {
      return pendingStudents.filter((s) => s.daysLate <= 7);
    }
    return pendingStudents;
  }, [pendingStudents, pendingFilter]);

  // Actions
  const handleMarkPaid = (student: OverdueFeeStudent) => {
    setSelectedStudentForPayment({
      _id: student.studentId || student.id || "",
      name: student.name,
      batch: student.batchName,
      centerId: activeCenterId,
    });
    setSelectedFeeForPayment({
      _id: student.feeId || student.id || "",
      month: student.month || "",
      title: student.title,
      amountDue: student.pendingAmount,
      paidAmount: student.paidAmount,
      totalAmount: student.totalAmount,
    });
    setIsPaymentModalOpen(true);
  };

  const handlePaymentSuccess = (
    feeData: unknown,
    receiptSlip: ReceiptSlipData
  ) => {
    const rawFee = feeData as { _id?: string; amountDue?: number; status?: string } | null;
    const paidFeeId = rawFee?._id || selectedFeeForPayment?._id;
    if (paidFeeId) {
      if (rawFee?.status === "Paid" || !rawFee?.amountDue || rawFee.amountDue <= 0) {
        // Full settlement: Immediately remove from pending dues
        setPendingStudents((prev) => prev.filter((s) => (s.feeId || s.id) !== paidFeeId));
      } else {
        // Partial settlement: Update pending amount in place
        setPendingStudents((prev) =>
          prev.map((s) =>
            (s.feeId || s.id) === paidFeeId
              ? {
                  ...s,
                  pendingAmount: Number(rawFee.amountDue) || 0,
                  paidAmount: (Number(s.paidAmount) || 0) + (receiptSlip.amount || 0),
                  status: "Partial Paid",
                }
              : s
          )
        );
      }
    }
    invalidateApiCache();
    fetchFeesData(true);
    fetchPaidHistory(true);
    if (receiptSlip) {
      setActiveReceiptData(receiptSlip);
    }
    setToastMessage("Payment recorded successfully!");
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleViewDetails = (student: OverdueFeeStudent) => {
    setSelectedDetailFeeId(student.feeId || student.id);
  };

  const handleViewReceipt = (student: OverdueFeeStudent) => {
    const rawPaidDate = student.paidDate || student.paymentDate || student.paidAt || "";
    const receiptData: ReceiptSlipData = {
      receiptNumber: student.receiptNumber || `RCPT-${(student.studentId || student.id).slice(-6).toUpperCase()}`,
      studentName: student.name,
      batchName: student.batchName,
      amount: student.paidAmount || student.totalAmount || 0,
      paymentMode: student.paymentMode || "Cash",
      paymentDate: rawPaidDate ? new Date(rawPaidDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
      title: student.title || student.month,
      collectorName: student.receivedByName || (student.receivedByRole === "owner" ? "Institute Owner" : "Teacher"),
      collectorRole: student.receivedByRole || "teacher",
      isProvisional: student.receivedByRole === "teacher",
      remainingBalance: student.pendingAmount || 0,
    };
    setActiveReceiptData(receiptData);
  };

  // =========================================================================
  // PAYMENT PROOF REVIEW WORKFLOW (PHASE 3)
  // =========================================================================
  const handleViewProof = async (student: OverdueFeeStudent) => {
    const feeId = student.feeId || student.id;
    setActiveProofStudent(student);
    setProofModalOpen(true);
    setProofLoading(true);
    setProofError(null);
    setProofList([]);
    setIsZoomed(false);

    try {
      const res = await apiClient<ProofListItem[]>(`/fees/${feeId}/payment-proof`, {
        method: "GET",
      });

      if (res.success && Array.isArray(res.data) && res.data.length > 0) {
        setProofList(res.data);
      } else if (res.success && Array.isArray(res.data) && res.data.length === 0) {
        if (student.utrNumber) {
          setProofList([
            {
              submittedUtr: student.utrNumber,
              fileUrl: "",
              status: "pending_review",
              createdAt: new Date().toISOString(),
            },
          ]);
        } else {
          setProofError("No payment details or screenshot uploaded for this fee record.");
        }
      } else {
        setProofError(res.error || "Failed to load payment proof screenshot.");
      }
    } catch {
      setProofError("Unable to reach the server. Please check your network connection.");
    } finally {
      setProofLoading(false);
    }
  };

  const handleOpenApproveModal = (student: OverdueFeeStudent) => {
    setApproveTargetStudent(student);
    setShowApproveModal(true);
  };

  const handleConfirmApprove = async () => {
    if (!approveTargetStudent) return;
    const feeId = approveTargetStudent.feeId || approveTargetStudent.id;
    if (approvingId === feeId) return; // Prevent duplicate approval submissions
    setApprovingId(feeId);
    try {
      const res = await apiClient<{ message?: string; error?: string }>(`/fees/${feeId}/payment-proof`, {
        method: "PUT",
        body: { action: "approve" },
      });
      if (res.success) {
        setReviewStudents((prev) => prev.filter((s) => (s.feeId || s.id) !== feeId));
        setPendingStudents((prev) => prev.filter((s) => (s.feeId || s.id) !== feeId));
        setShowApproveModal(false);
        setProofModalOpen(false);
        setToastMessage(`Payment of ₹${approveTargetStudent.pendingAmount} verified & marked as Paid!`);
        setTimeout(() => setToastMessage(null), 3500);
        invalidateApiCache();
        fetchFeesData(true);
        fetchPaidHistory(true);
      } else {
        alert(res.error || "Failed to approve payment proof");
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error approving payment. Please try again.");
    } finally {
      setApprovingId(null);
      setApproveTargetStudent(null);
    }
  };

  const handleOpenRejectModal = (student: OverdueFeeStudent) => {
    setRejectTargetStudent(student);
    setRejectionReasonInput("");
    setRejectionError(null);
    setShowRejectModal(true);
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectTargetStudent) return;
    const feeId = rejectTargetStudent.feeId || rejectTargetStudent.id;
    if (rejectingId === feeId) return; // Prevent duplicate rejection submissions

    const cleanReason = rejectionReasonInput.trim();
    if (!cleanReason) {
      setRejectionError("Please provide a rejection reason so the parent knows what to correct.");
      return;
    }

    setRejectingId(feeId);
    setRejectionError(null);

    try {
      const res = await apiClient<{ message?: string; error?: string }>(`/fees/${feeId}/payment-proof`, {
        method: "PUT",
        body: {
          action: "reject",
          rejectionReason: cleanReason,
        },
      });

      if (res.success) {
        setReviewStudents((prev) => prev.filter((s) => (s.feeId || s.id) !== feeId));
        setShowRejectModal(false);
        setProofModalOpen(false);
        setToastMessage(`Payment proof rejected and fee returned to Pending dues.`);
        setTimeout(() => setToastMessage(null), 3500);
        invalidateApiCache();
        fetchFeesData(true);
      } else {
        setRejectionError(res.error || "Failed to reject payment proof.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to reject payment proof. Please try again.";
      setRejectionError(msg);
    } finally {
      setRejectingId(null);
    }
  };

  const handleApprovePayment = async (student: OverdueFeeStudent) => {
    handleOpenApproveModal(student);
  };

  const handleRejectPayment = async (student: OverdueFeeStudent) => {
    handleOpenRejectModal(student);
  };

  const handleSendIndividual = async (
    student: OverdueFeeStudent,
    confirmedOverride = false,
    reason?: string
  ) => {
    const feeId = student.feeId || student.id;
    setSendingReminderId(feeId);
    try {
      const res = await apiClient<{ message?: string; code?: string }>(
        `/fees/${feeId}/remind`,
        {
          method: "POST",
          body: {
            confirmedOverride,
            reason: reason || "Manual reminder trigger via UI",
          },
        }
      );
      if (res.success) {
        setSentReminders((prev) => ({ ...prev, [feeId]: true }));
        setCooldownConfirmFee(null);
        setToastMessage(`Fee reminder dispatched to ${student.name}`);
        setTimeout(() => setToastMessage(null), 3000);
      } else if (res.code === "COOLDOWN_ACTIVE") {
        setCooldownConfirmFee({
          feeId,
          student,
          message: res.error || "A reminder was already sent within the last 24 hours.",
        });
      } else {
        alert(res.error || "Failed to send reminder");
      }
    } catch {
      alert("Network error sending reminder. Please try again.");
    } finally {
      setSendingReminderId(null);
      setIsOverriding(false);
    }
  };

  const handleSendAll = async () => {
    if (pendingStudents.length === 0) return;
    setIsSendingBulk(true);
    try {
      const res = await apiClient<{
        message?: string;
        sentCount?: number;
        suppressedCooldownCount?: number;
      }>("/fees/remind-all", {
        method: "POST",
      });
      if (res.success) {
        setIsGlobalSent(true);
        const sent = res.data?.sentCount ?? pendingStudents.length;
        const cooldown = res.data?.suppressedCooldownCount ?? 0;
        let msg = `Dispatched ${sent} fee reminder${sent === 1 ? "" : "s"} via WhatsApp!`;
        if (cooldown > 0) {
          msg += ` (${cooldown} skipped due to 24-hr cooldown)`;
        }
        setToastMessage(msg);
        setTimeout(() => setToastMessage(null), 4500);
        const newSent: Record<string, boolean> = {};
        pendingStudents.forEach((s) => {
          newSent[s.feeId || s.id] = true;
        });
        setSentReminders(newSent);
      } else {
        alert(res.error || "Failed to dispatch reminders");
      }
    } catch {
      alert("Error sending bulk reminders");
    } finally {
      setIsSendingBulk(false);
    }
  };

  return (
    <div className="p-3.5 min-[380px]:p-4 sm:p-5 md:p-6 space-y-4 max-w-4xl lg:max-w-5xl mx-auto pb-28 sm:pb-24 w-full max-w-full overflow-x-hidden">
      {/* Toast Banner */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 rounded-2xl bg-slate-900 text-white px-4 py-3 shadow-xl text-xs font-bold flex items-center gap-2 border border-slate-700 animate-in fade-in slide-in-from-bottom-3 duration-200"
        >
          <Sparkles className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top 3-Section Navigation Bar (Phase 7.1) */}
      <div className="p-1 rounded-2xl bg-slate-100 border border-slate-200/90 flex sm:grid sm:grid-cols-3 gap-1 shadow-2xs overflow-x-auto no-scrollbar touch-pan-x w-full max-w-full">
        {/* Section 1: Overview */}
        <button
          type="button"
          onClick={() => handleSwitchMainTab("overview")}
          className={`tap-bounce py-2 sm:py-2.5 px-2.5 sm:px-2 rounded-xl text-[11px] min-[360px]:text-xs font-bold transition-all flex items-center justify-center gap-1 sm:gap-1.5 flex-1 min-w-[90px] sm:min-w-0 flex-shrink-0 sm:flex-shrink whitespace-nowrap ${
            mainTab === "overview"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-900"
          }`}
        >
          <LayoutDashboard
            className={`h-4 w-4 flex-shrink-0 ${
              mainTab === "overview" ? "text-blue-600" : "text-slate-400"
            }`}
          />
          <span>Overview</span>
        </button>

        {/* Section 2: Payments */}
        <button
          type="button"
          onClick={() => handleSwitchMainTab("payments")}
          className={`tap-bounce py-2 sm:py-2.5 px-2.5 sm:px-2 rounded-xl text-[11px] min-[360px]:text-xs font-bold transition-all flex items-center justify-center gap-1 sm:gap-1.5 flex-1 min-w-[90px] sm:min-w-0 flex-shrink-0 sm:flex-shrink whitespace-nowrap ${
            mainTab === "payments"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-900"
          }`}
        >
          <CreditCard
            className={`h-4 w-4 flex-shrink-0 ${
              mainTab === "payments" ? "text-emerald-600" : "text-slate-400"
            }`}
          />
          <span>Payments</span>
          {pendingStudents.length + reviewStudents.length > 0 && (
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold flex-shrink-0 ${
                mainTab === "payments"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-slate-200 text-slate-600"
              }`}
            >
              {pendingStudents.length + reviewStudents.length}
            </span>
          )}
        </button>

        {/* Section 3: Cash Handover */}
        <button
          type="button"
          onClick={() => handleSwitchMainTab("handovers")}
          className={`tap-bounce py-2 sm:py-2.5 px-2.5 sm:px-2 rounded-xl text-[11px] min-[360px]:text-xs font-bold transition-all flex items-center justify-center gap-1 sm:gap-1.5 flex-1 min-w-[90px] sm:min-w-0 flex-shrink-0 sm:flex-shrink whitespace-nowrap ${
            mainTab === "handovers"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-900"
          }`}
        >
          <Banknote
            className={`h-4 w-4 flex-shrink-0 ${
              mainTab === "handovers" ? "text-amber-600" : "text-slate-400"
            }`}
          />
          <span className="sm:inline hidden">Cash Handover</span>
          <span className="sm:hidden inline">Handover</span>
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
            <span className="font-semibold">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => fetchFeesData(true)}
            className="text-xs font-bold text-rose-700 underline hover:text-rose-900"
          >
            Retry
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SECTION A: OVERVIEW TAB                                                  */}
      {/* ========================================================================= */}
      {mainTab === "overview" && (
        <div className="space-y-4 animate-fade-in">
          {/* OWNER OVERVIEW DASHBOARD */}
          {isOwner && (
            <>
              {/* 6 Owner Financial KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {/* KPI 1: Total Parent Collections */}
                <div className="rounded-2xl border border-slate-200/90 bg-white p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider">
                      Parent Collections
                    </span>
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-lg sm:text-xl font-black text-slate-900 font-mono">
                    ₹{(summaryOverview?.kpis?.totalParentCollections ?? collectedAmount).toLocaleString("en-IN")}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5 truncate">
                    Direct parent tuition fees
                  </p>
                </div>

                {/* KPI 2: Verified Cash in Institute */}
                <div className="rounded-2xl border border-emerald-200/90 bg-emerald-50/40 p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between text-emerald-700 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider">
                      Verified Safe Cash
                    </span>
                    <Building2 className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-lg sm:text-xl font-black text-emerald-900 font-mono">
                    ₹{(summaryOverview?.kpis?.verifiedCashReceived ?? 0).toLocaleString("en-IN")}
                  </div>
                  <p className="text-[10px] text-emerald-600/80 mt-0.5 truncate">
                    Owner safe custody
                  </p>
                </div>

                {/* KPI 3: Teacher Cash in Hand */}
                <div className="rounded-2xl border border-amber-200/90 bg-amber-50/40 p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between text-amber-700 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider">
                      Teacher In-Hand
                    </span>
                    <Clock className="w-4 h-4 text-amber-600" />
                  </div>
                  <div className="text-lg sm:text-xl font-black text-amber-900 font-mono">
                    ₹{(summaryOverview?.kpis?.teacherHeldCash ?? 0).toLocaleString("en-IN")}
                  </div>
                  <p className="text-[10px] text-amber-700/80 mt-0.5 truncate">
                    Collected, awaiting handover
                  </p>
                </div>

                {/* KPI 4: Pending Verification Cash */}
                <div className="rounded-2xl border border-purple-200/90 bg-purple-50/40 p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between text-purple-700 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider">
                      Awaiting Count
                    </span>
                    <ShieldCheck className="w-4 h-4 text-purple-600" />
                  </div>
                  <div className="text-lg sm:text-xl font-black text-purple-900 font-mono">
                    ₹{(summaryOverview?.kpis?.pendingVerificationCash ?? 0).toLocaleString("en-IN")}
                  </div>
                  <p className="text-[10px] text-purple-700/80 mt-0.5 truncate">
                    Submitted envelopes
                  </p>
                </div>

                {/* KPI 5: Outstanding Student Dues */}
                <div className="rounded-2xl border border-rose-200/90 bg-rose-50/40 p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between text-rose-700 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider">
                      Student Dues
                    </span>
                    <AlertCircle className="w-4 h-4 text-rose-600" />
                  </div>
                  <div className="text-lg sm:text-xl font-black text-rose-900 font-mono">
                    ₹{(summaryOverview?.kpis?.outstandingFeeBalance ?? totalOverdue).toLocaleString("en-IN")}
                  </div>
                  <p className="text-[10px] text-rose-700/80 mt-0.5 truncate">
                    {pendingStudents.length} students pending
                  </p>
                </div>

                {/* KPI 6: Active Discrepancies */}
                <div className="rounded-2xl border border-slate-200/90 bg-white p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider">
                      Discrepancies
                    </span>
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                  </div>
                  <div className="text-lg sm:text-xl font-black text-slate-900 font-mono">
                    ₹{(summaryOverview?.kpis?.activeDiscrepancies ?? 0).toLocaleString("en-IN")}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5 truncate">
                    {summaryOverview?.actionRequired?.disputesCount ?? 0} active disputes
                  </p>
                </div>
              </div>

              {/* Action Required Cards */}
              <div className="space-y-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-500 px-0.5">
                  Action Required
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {/* Incoming Handover Verification */}
                  {(summaryOverview?.actionRequired?.pendingHandoversCount ?? 0) > 0 ? (
                    <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-3.5 flex items-center justify-between gap-2 shadow-2xs">
                      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-xl bg-amber-500 text-white flex items-center justify-center flex-shrink-0">
                          <Banknote className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-black text-slate-900 truncate">
                            {summaryOverview?.actionRequired?.pendingHandoversCount} Cash Envelope(s) Awaiting Count
                          </div>
                          <p className="text-[11px] text-slate-600 font-mono truncate">
                            ₹{(summaryOverview?.actionRequired?.pendingHandoversAmount ?? 0).toLocaleString("en-IN")} submitted
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSwitchMainTab("handovers")}
                        className="tap-bounce rounded-xl bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1 shadow-2xs flex-shrink-0"
                      >
                        Verify
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : null}

                  {/* Overdue Dues Action */}
                  {pendingStudents.length > 0 && (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-3.5 flex items-center justify-between gap-2 shadow-2xs">
                      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-xl bg-rose-600 text-white flex items-center justify-center flex-shrink-0">
                          <AlertCircle className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-black text-slate-900 truncate">
                            {pendingStudents.length} Overdue Dues (₹{totalOverdue.toLocaleString("en-IN")})
                          </div>
                          <p className="text-[11px] text-slate-600 truncate">
                            Tap to review dues & dispatch reminders
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          handleSwitchMainTab("payments");
                          handleSwitchPaymentsSub("pending");
                        }}
                        className="tap-bounce rounded-xl bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1 shadow-2xs flex-shrink-0"
                      >
                        View
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Active Disputes Action */}
                  {(summaryOverview?.actionRequired?.disputesCount ?? 0) > 0 && (
                    <div className="rounded-2xl border border-red-300 bg-red-50/70 p-3.5 flex items-center justify-between gap-2 shadow-2xs">
                      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-xl bg-red-600 text-white flex items-center justify-center flex-shrink-0">
                          <AlertTriangle className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-black text-slate-900 truncate">
                            {summaryOverview?.actionRequired?.disputesCount} Discrepancy Dispute(s)
                          </div>
                          <p className="text-[11px] text-slate-600 truncate">
                            Handover shortages needing resolution
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSwitchMainTab("handovers")}
                        className="tap-bounce rounded-xl bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1 shadow-2xs flex-shrink-0"
                      >
                        Resolve
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {/* If nothing urgent pending */}
                  {(summaryOverview?.actionRequired?.pendingHandoversCount ?? 0) === 0 &&
                    pendingStudents.length === 0 &&
                    (summaryOverview?.actionRequired?.disputesCount ?? 0) === 0 && (
                      <div className="col-span-full rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 text-center">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 mx-auto mb-1" />
                        <span className="text-xs font-bold text-emerald-900">
                          All caught up! No urgent handovers or overdue actions pending.
                        </span>
                      </div>
                    )}
                </div>
              </div>
            </>
          )}

          {/* TEACHER OVERVIEW DASHBOARD (Phase 7.3) */}
          {isTeacher && (
            <div className="space-y-6">
              {/* ========================================================================= */}
              {/* SECTION A: MY FINANCIAL ACTIVITY                                         */}
              {/* ========================================================================= */}
              <div className="space-y-3.5">
                <div className="flex items-center justify-between px-0.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-xs shadow-amber-500/50" />
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                      My Financial Activity
                    </h3>
                  </div>
                  <span className="text-[11px] font-semibold text-slate-400">
                    Your Personal Cash Collections &amp; Custody
                  </span>
                </div>

                {/* 4 Teacher Financial KPIs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {/* Own Cash Collected */}
                  <div className="rounded-2xl border border-slate-200/90 bg-white p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-slate-500 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Collected By You
                      </span>
                      <TrendingUp className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-slate-900 font-mono">
                      ₹{(summaryOverview?.kpis?.ownCashCollected ?? 0).toLocaleString("en-IN")}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 truncate">
                      Total parent cash collected
                    </p>
                  </div>

                  {/* Cash in Your Hand */}
                  <div className="rounded-2xl border border-amber-200/90 bg-amber-50/40 p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-amber-700 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Cash in Hand
                      </span>
                      <Clock className="w-4 h-4 text-amber-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-amber-900 font-mono">
                      ₹{(summaryOverview?.kpis?.ownCashInHand ?? 0).toLocaleString("en-IN")}
                    </div>
                    <p className="text-[10px] text-amber-700/80 mt-0.5 truncate">
                      Eligible for handover
                    </p>
                  </div>

                  {/* Submitted Handovers */}
                  <div className="rounded-2xl border border-purple-200/90 bg-purple-50/40 p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-purple-700 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Submitted
                      </span>
                      <ShieldCheck className="w-4 h-4 text-purple-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-purple-900 font-mono">
                      ₹{(summaryOverview?.kpis?.ownSubmittedHandovers ?? 0).toLocaleString("en-IN")}
                    </div>
                    <p className="text-[10px] text-purple-700/80 mt-0.5 truncate">
                      Awaiting Owner count
                    </p>
                  </div>

                  {/* Verified Handovers */}
                  <div className="rounded-2xl border border-emerald-200/90 bg-emerald-50/40 p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-emerald-700 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Verified
                      </span>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-emerald-900 font-mono">
                      ₹{(summaryOverview?.kpis?.ownVerifiedHandovers ?? 0).toLocaleString("en-IN")}
                    </div>
                    <p className="text-[10px] text-emerald-700/80 mt-0.5 truncate">
                      Received by institute
                    </p>
                  </div>
                </div>

                {/* Teacher Action Required */}
                <div className="space-y-2">
                  <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-4 flex items-center justify-between shadow-2xs">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center flex-shrink-0">
                        <Wallet className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-sm font-black text-slate-900">
                          ₹{(summaryOverview?.actionRequired?.eligibleForHandoverAmount ?? 0).toLocaleString("en-IN")} Physical Cash in Your Custody
                        </div>
                        <p className="text-xs text-slate-600 mt-0.5">
                          Submit a handover envelope to transfer physical custody to the Owner.
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSwitchMainTab("handovers")}
                      className="tap-bounce rounded-xl bg-amber-600 hover:bg-amber-700 text-white px-3.5 py-2 text-xs font-bold flex items-center gap-1.5 shadow-xs flex-shrink-0"
                    >
                      <span>Submit Handover</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Teacher Status Alerts */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(summaryOverview?.actionRequired?.pendingHandoverCount ?? 0) > 0 && (
                      <div className="rounded-xl border border-purple-200 bg-purple-50/60 p-3 text-xs text-purple-900 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-purple-600 flex-shrink-0" />
                        <span>
                          <strong>{summaryOverview?.actionRequired?.pendingHandoverCount}</strong> envelope(s) awaiting Owner approval.
                        </span>
                      </div>
                    )}

                    {(summaryOverview?.actionRequired?.rejectedHandoverCount ?? 0) > 0 && (
                      <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-900 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                        <span>
                          <strong>{summaryOverview?.actionRequired?.rejectedHandoverCount}</strong> envelope(s) rejected by Owner.
                        </span>
                      </div>
                    )}

                    {(summaryOverview?.actionRequired?.activeDisputesCount ?? 0) > 0 && (
                      <div className="rounded-xl border border-red-200 bg-red-50/60 p-3 text-xs text-red-900 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                        <span>
                          <strong>{summaryOverview?.actionRequired?.activeDisputesCount}</strong> active dispute(s) being reconciled.
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Teacher Personal Notifications */}
                {summaryOverview?.notifications && summaryOverview.notifications.length > 0 && (
                  <div className="rounded-2xl border border-slate-200/90 bg-white p-3.5 sm:p-4 shadow-2xs space-y-2">
                    <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                        <Bell className="w-3.5 h-3.5 text-blue-600" />
                        <span>Recent Personal Notifications</span>
                      </div>
                      <span className="text-[10.5px] font-semibold text-slate-400">
                        {summaryOverview.notifications.length} update(s)
                      </span>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {summaryOverview.notifications.map((n, i) => (
                        <div key={n._id || n.id || i} className="py-2 flex items-start justify-between gap-2.5 text-xs">
                          <div className="space-y-0.5 min-w-0">
                            <div className="font-bold text-slate-800 flex items-center gap-1.5">
                              <span>{n.title}</span>
                              {n.statusLabel && (
                                <span className="px-1.5 py-0.2 rounded-md bg-slate-100 text-slate-600 text-[9.5px] font-semibold">
                                  {n.statusLabel}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 leading-snug">{n.message}</p>
                          </div>
                          <span className="text-[10px] text-slate-400 whitespace-nowrap flex-shrink-0">
                            {n.createdAt ? new Date(n.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "Recent"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Teacher Recent Cash Collections Activity Feed */}
                <div className="rounded-2xl sm:rounded-3xl border border-slate-200/90 bg-white p-4 sm:p-5 shadow-xs space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0">
                        <Banknote className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-extrabold text-slate-900 truncate">
                          Your Recent Cash Collections
                        </h4>
                        <p className="text-[11px] text-slate-500 line-clamp-1 sm:line-clamp-none">
                          Live recorded cash payments in your custody awaiting or processed for handover
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-start sm:self-auto flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setIsAddFeeModalOpen(true)}
                        className="tap-bounce rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1 shadow-2xs whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Record Cash</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => fetchFeesData(true)}
                        title="Refresh collections"
                        aria-label="Refresh collections"
                        className="tap-bounce p-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {summaryOverview?.recentCollections && summaryOverview.recentCollections.length > 0 ? (
                    <div className="divide-y divide-slate-100">
                      {summaryOverview.recentCollections.map((item, idx) => {
                        const custodyPillStyle =
                          item.custodyStatus === "Verified by Owner"
                            ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                            : item.custodyStatus === "Pending Verification"
                            ? "bg-purple-50 text-purple-800 border-purple-200"
                            : item.custodyStatus === "Teacher In-Hand"
                            ? "bg-amber-50 text-amber-800 border-amber-200"
                            : "bg-slate-50 text-slate-700 border-slate-200";

                        return (
                          <div
                            key={item.paymentId || idx}
                            className="py-3 flex items-center justify-between gap-2.5 text-xs hover:bg-slate-50/50 rounded-xl px-2 transition-colors"
                          >
                            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                              <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold font-mono text-[11px] flex-shrink-0">
                                ₹
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="font-extrabold text-slate-900 truncate">
                                  {item.studentName}
                                </div>
                                <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5 flex-wrap">
                                  <span>
                                    {item.paymentDate && !isNaN(new Date(item.paymentDate).getTime())
                                      ? new Date(item.paymentDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                                      : "Undated"}
                                  </span>
                                  <span>•</span>
                                  <span className="font-mono text-slate-600 truncate max-w-[120px]">{item.receiptNumber || "Offline"}</span>
                                  <span>•</span>
                                  <span className="text-slate-500 font-medium">You</span>
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-col items-end gap-1 flex-shrink-0 sm:flex-row sm:items-center sm:gap-2.5">
                              <span className="font-black font-mono text-slate-900 text-sm">
                                ₹{item.amount.toLocaleString("en-IN")}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${custodyPillStyle}`}
                              >
                                {item.custodyStatus}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-slate-400">
                      <Banknote className="w-8 h-8 mx-auto mb-1 text-slate-300" />
                      <p className="text-xs font-semibold text-slate-600">No cash collections recorded yet</p>
                      <p className="text-[11px] mt-0.5">Recorded desk collections appear here immediately.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* ========================================================================= */}
              {/* SECTION B: MY STUDENTS' FEE STATUS                                       */}
              {/* ========================================================================= */}
              <div className="space-y-3.5 pt-3 border-t border-slate-200/90">
                <div className="flex items-center justify-between px-0.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-xs shadow-blue-500/50" />
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                      My Students&apos; Fee Status
                    </h3>
                  </div>
                  <span className="text-[11px] font-semibold text-slate-400">
                    Academic Fee Ledger for Assigned Students
                  </span>
                </div>

                {/* 4 Assigned Student Fee Status KPIs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {/* KPI 1: Total Assigned Students */}
                  <div className="rounded-2xl border border-slate-200/90 bg-white p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-slate-500 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Assigned Students
                      </span>
                      <Users className="w-4 h-4 text-blue-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-slate-900 font-mono">
                      {summaryOverview?.studentStatus?.totalAssignedStudents ?? 0}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 truncate">
                      Active in your batches
                    </p>
                  </div>

                  {/* KPI 2: Total Outstanding Dues */}
                  <div className="rounded-2xl border border-rose-200/90 bg-rose-50/40 p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-rose-700 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Student Dues
                      </span>
                      <AlertCircle className="w-4 h-4 text-rose-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-rose-900 font-mono">
                      ₹{(summaryOverview?.studentStatus?.totalOutstandingBalance ?? totalOverdue).toLocaleString("en-IN")}
                    </div>
                    <p className="text-[10px] text-rose-700/80 mt-0.5 truncate">
                      {summaryOverview?.studentStatus?.studentsWithDues ?? pendingStudents.length} students pending
                    </p>
                  </div>

                  {/* KPI 3: Students With Dues */}
                  <div className="rounded-2xl border border-amber-200/90 bg-amber-50/40 p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-amber-700 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Dues Pending
                      </span>
                      <Clock className="w-4 h-4 text-amber-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-amber-900 font-mono">
                      {summaryOverview?.studentStatus?.studentsWithDues ?? pendingStudents.length}
                    </div>
                    <p className="text-[10px] text-amber-700/80 mt-0.5 truncate">
                      Require fee collection
                    </p>
                  </div>

                  {/* KPI 4: Fully Paid Students */}
                  <div className="rounded-2xl border border-emerald-200/90 bg-emerald-50/40 p-3.5 shadow-2xs">
                    <div className="flex items-center justify-between text-emerald-700 mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Fees Cleared
                      </span>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div className="text-lg sm:text-xl font-black text-emerald-900 font-mono">
                      {summaryOverview?.studentStatus?.studentsFullyPaid ?? 0}
                    </div>
                    <p className="text-[10px] text-emerald-700/80 mt-0.5 truncate">
                      No dues pending
                    </p>
                  </div>
                </div>

                {/* Important Financial Separation Callout */}
                <div className="rounded-2xl border border-blue-200/90 bg-blue-50/50 p-3.5 text-xs text-blue-900 shadow-2xs flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <span className="font-bold text-blue-950 block">
                      Financial Separation Invariant
                    </span>
                    <p className="text-[11px] text-blue-800 leading-relaxed">
                      <strong>Student Dues</strong> (₹{(summaryOverview?.studentStatus?.totalOutstandingBalance ?? totalOverdue).toLocaleString("en-IN")}), <strong>Cash in Hand</strong> (₹{(summaryOverview?.kpis?.ownCashInHand ?? 0).toLocaleString("en-IN")}), and <strong>Verified Institute Cash</strong> (₹{(summaryOverview?.kpis?.ownVerifiedHandovers ?? 0).toLocaleString("en-IN")}) are three distinct financial states. Student dues are invoices owed by parents. Cash in Hand is physical money in your personal custody. Cash only clears to the institute when the Owner verifies your handover envelope.
                    </p>
                  </div>
                </div>

                {/* Recent Assigned Student Fee Activity & Action Button */}
                <div className="rounded-2xl sm:rounded-3xl border border-slate-200/90 bg-white p-4 sm:p-5 shadow-xs space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-sm font-extrabold text-slate-900">
                          Assigned Students&apos; Fee Status
                        </h4>
                        <p className="text-[11px] text-slate-500">
                          Live academic fee invoices for students in your assigned batches (contact numbers masked for privacy)
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSwitchMainTab("payments")}
                      className="tap-bounce rounded-xl bg-slate-900 hover:bg-slate-800 text-white px-3.5 py-1.5 text-xs font-bold flex items-center gap-1.5 shadow-2xs"
                    >
                      <span>View All Pending Dues</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {summaryOverview?.studentStatus?.recentActivity && summaryOverview.studentStatus.recentActivity.length > 0 ? (
                    <div className="divide-y divide-slate-100">
                      {summaryOverview.studentStatus.recentActivity.map((act) => {
                        const isPaid = act.status === "Paid";
                        const isPartial = act.status === "Partial Paid";
                        const statusStyle = isPaid
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : isPartial
                          ? "bg-amber-50 text-amber-800 border-amber-200"
                          : "bg-rose-50 text-rose-800 border-rose-200";

                        return (
                          <div
                            key={act.feeId}
                            className="py-3 flex items-center justify-between gap-3 text-xs hover:bg-slate-50/50 rounded-xl px-2 transition-colors"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-xs flex-shrink-0">
                                {act.studentName.slice(0, 2).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <div className="font-extrabold text-slate-900 truncate">
                                  {act.studentName}
                                </div>
                                <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                                  <span className="font-semibold text-slate-600">{act.batchName}</span>
                                  <span>•</span>
                                  <span>{act.month || act.title}</span>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-2.5 flex-shrink-0">
                              <div className="text-right">
                                <span className="font-mono font-black text-slate-900 text-xs block">
                                  ₹{act.amountDue.toLocaleString("en-IN")}
                                </span>
                                {isPartial && act.paidAmount > 0 && (
                                  <span className="text-[10px] text-slate-400 block">
                                    Paid: ₹{act.paidAmount.toLocaleString("en-IN")}
                                  </span>
                                )}
                              </div>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusStyle}`}>
                                {act.status}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-slate-400">
                      <Users className="w-8 h-8 mx-auto mb-1 text-slate-300" />
                      <p className="text-xs font-semibold text-slate-600">No assigned student fee invoices yet</p>
                      <p className="text-[11px] mt-0.5">When students are assigned to your batches, their fee status will appear here.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* RECENT CASH COLLECTIONS ACTIVITY FEED (Owner View) */}
          {isOwner && (
            <div className="rounded-3xl border border-slate-200/90 bg-white p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
                    <Banknote className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-extrabold text-slate-900 truncate">
                      Recent Cash Collections Across Faculty
                    </h3>
                    <p className="text-[11px] text-slate-500 line-clamp-1 sm:line-clamp-none">
                      Live recorded cash transactions with immediate custody attribution
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setIsAddFeeModalOpen(true)}
                    className="tap-bounce rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1 shadow-2xs whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Record Cash</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fetchFeesData(true)}
                    title="Refresh collections"
                    aria-label="Refresh collections"
                    className="tap-bounce p-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Collections List */}
              {summaryOverview?.recentCollections && summaryOverview.recentCollections.length > 0 ? (
                <div className="divide-y divide-slate-100">
                  {summaryOverview.recentCollections.map((item, idx) => {
                    const custodyPillStyle =
                      item.custodyStatus === "Verified by Owner"
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                        : item.custodyStatus === "Pending Verification"
                        ? "bg-purple-50 text-purple-800 border-purple-200"
                        : item.custodyStatus === "Teacher In-Hand"
                        ? "bg-amber-50 text-amber-800 border-amber-200"
                        : "bg-slate-50 text-slate-700 border-slate-200";

                    return (
                      <div
                        key={item.paymentId || idx}
                        className="py-3 flex items-center justify-between gap-2.5 text-xs hover:bg-slate-50/50 rounded-xl px-2 transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold font-mono text-[11px] flex-shrink-0">
                            ₹
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="font-extrabold text-slate-900 truncate">
                              {item.studentName}
                            </div>
                            <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5 flex-wrap">
                              <span>
                                {item.paymentDate && !isNaN(new Date(item.paymentDate).getTime())
                                  ? new Date(item.paymentDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                                  : "Undated"}
                              </span>
                              <span>•</span>
                              <span className="font-mono text-slate-600 truncate max-w-[120px]">{item.receiptNumber || "Offline"}</span>
                              <span>•</span>
                              <span className="text-slate-500 font-medium truncate max-w-[100px]">{item.collectorName}</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-1 flex-shrink-0 sm:flex-row sm:items-center sm:gap-2.5">
                          <span className="font-black font-mono text-slate-900 text-sm">
                            ₹{item.amount.toLocaleString("en-IN")}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${custodyPillStyle}`}
                          >
                            {item.custodyStatus}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 text-center text-slate-400">
                  <Banknote className="w-8 h-8 mx-auto mb-1 text-slate-300" />
                  <p className="text-xs font-semibold text-slate-600">No cash collections recorded yet</p>
                  <p className="text-[11px] mt-0.5">When staff record cash payments, they appear here immediately.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* SECTION B: PAYMENTS TAB (Pending Dues, Awaiting Review, Paid History)     */}
      {/* ========================================================================= */}
      {mainTab === "payments" && (
        <div className="space-y-4 animate-fade-in">
          {/* Internal Subsection Selector (2 tabs for Teacher, 3 tabs for Owner) */}
          <div className={`p-1 rounded-2xl bg-slate-100 border border-slate-200/80 flex sm:grid ${isTeacher ? "sm:grid-cols-2" : "sm:grid-cols-3"} gap-1 overflow-x-auto no-scrollbar touch-pan-x w-full max-w-full`}>
            {/* Sub-tab 1: Pending Dues */}
            <button
              type="button"
              onClick={() => handleSwitchPaymentsSub("pending")}
              className={`tap-bounce py-2 px-2.5 sm:px-2 rounded-xl text-[11px] min-[360px]:text-xs font-bold transition-all flex items-center justify-center gap-1 sm:gap-1.5 flex-1 min-w-[90px] sm:min-w-0 flex-shrink-0 sm:flex-shrink whitespace-nowrap ${
                effectivePaymentsSubTab === "pending"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Clock
                className={`h-3.5 w-3.5 flex-shrink-0 ${
                  effectivePaymentsSubTab === "pending" ? "text-rose-600" : "text-slate-400"
                }`}
              />
              <span className="sm:inline hidden">Pending Dues</span>
              <span className="sm:hidden inline">Pending</span>
              <span
                className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold flex-shrink-0 ${
                  effectivePaymentsSubTab === "pending"
                    ? "bg-rose-100 text-rose-700"
                    : "bg-slate-200 text-slate-600"
                }`}
              >
                {pendingStudents.length}
              </span>
            </button>

            {/* Sub-tab 2: Awaiting Review (Owner Only) */}
            {isOwner && (
              <button
                type="button"
                onClick={() => handleSwitchPaymentsSub("review")}
                className={`tap-bounce py-2 px-2.5 sm:px-2 rounded-xl text-[11px] min-[360px]:text-xs font-bold transition-all flex items-center justify-center gap-1 sm:gap-1.5 flex-1 min-w-[90px] sm:min-w-0 flex-shrink-0 sm:flex-shrink whitespace-nowrap ${
                  effectivePaymentsSubTab === "review"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-900"
                }`}
              >
                <ShieldCheck
                  className={`h-3.5 w-3.5 flex-shrink-0 ${
                    effectivePaymentsSubTab === "review" ? "text-amber-600" : "text-slate-400"
                  }`}
                />
                <span className="sm:inline hidden">Awaiting Review</span>
                <span className="sm:hidden inline">Review</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold flex-shrink-0 ${
                    reviewStudents.length > 0
                      ? "bg-amber-500 text-white animate-pulse"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {reviewStudents.length}
                </span>
              </button>
            )}

            {/* Sub-tab 3: Paid History */}
            <button
              type="button"
              onClick={() => handleSwitchPaymentsSub("paid")}
              className={`tap-bounce py-2 px-2.5 sm:px-2 rounded-xl text-[11px] min-[360px]:text-xs font-bold transition-all flex items-center justify-center gap-1 sm:gap-1.5 flex-1 min-w-[90px] sm:min-w-0 flex-shrink-0 sm:flex-shrink whitespace-nowrap ${
                effectivePaymentsSubTab === "paid"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <CheckCircle2
                className={`h-3.5 w-3.5 flex-shrink-0 ${
                  effectivePaymentsSubTab === "paid" ? "text-emerald-600" : "text-slate-400"
                }`}
              />
              <span className="sm:inline hidden">Paid History</span>
              <span className="sm:hidden inline">Paid</span>
              <span
                className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold flex-shrink-0 ${
                  effectivePaymentsSubTab === "paid"
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-200 text-slate-600"
                }`}
              >
                {hasLoadedPaid ? paidStudents.length : "—"}
              </span>
            </button>
          </div>

          {/* Owner Faculty Filter Pills */}
          {isOwner && teachers.length > 0 && (
            <div
              className="flex items-center gap-1.5 overflow-x-auto pb-1.5 no-scrollbar w-full max-w-full touch-pan-x"
              data-testid="fees-faculty-filter"
            >
              <span className="text-[11px] font-bold text-slate-400 mr-1 flex items-center gap-1 flex-shrink-0">
                <Users className="w-3.5 h-3.5" />
                Faculty:
              </span>
              <button
                type="button"
                onClick={() => setSelectedTeacherFilter("all")}
                className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex-shrink-0 ${
                  selectedTeacherFilter === "all"
                    ? "bg-blue-600 text-white shadow-xs"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                All Fees
              </button>
              <button
                type="button"
                onClick={() => setSelectedTeacherFilter("owner")}
                className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex-shrink-0 ${
                  selectedTeacherFilter === "owner"
                    ? "bg-blue-600 text-white shadow-xs"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                Myself (Owner)
              </button>
              {teachers.map((t) => (
                <button
                  key={t._id}
                  type="button"
                  onClick={() => setSelectedTeacherFilter(t._id)}
                  className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex-shrink-0 ${
                    selectedTeacherFilter === t._id
                      ? "bg-blue-600 text-white shadow-xs"
                      : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}

          {/* Loading Skeleton */}
          {loading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-44 rounded-3xl bg-slate-200/80 p-5 flex flex-col justify-between" />
              <div className="h-12 w-full rounded-2xl bg-slate-200" />
              <div className="h-20 rounded-2xl border border-slate-100 bg-white p-3.5" />
            </div>
          ) : (
            <>
              {/* SUBSECTION 1: PENDING DUES */}
              {effectivePaymentsSubTab === "pending" && (
                <div className="space-y-4 animate-fade-in">
                  {/* Red Overdue Hero Card */}
                  <FeesSummaryHeroCard
                    totalOverdueAmount={totalOverdue}
                    pendingStudentsCount={pendingStudents.length}
                    collectedAmount={collectedAmount}
                  />

                  {/* Bulk WhatsApp Reminder Button */}
                  <GlobalReminderButton
                    pendingCount={pendingStudents.length}
                    onSendAll={handleSendAll}
                    isSent={isGlobalSent}
                    isSending={isSendingBulk}
                  />

                  {/* Sub-filter Chips for Pending Dues */}
                  <div className="flex items-center justify-between pt-1 gap-2">
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 w-full max-w-full touch-pan-x">
                      <button
                        type="button"
                        onClick={() => setPendingFilter("all")}
                        className={`tap-bounce rounded-xl px-3 py-1.5 text-xs font-bold transition-all whitespace-nowrap flex-shrink-0 ${
                          pendingFilter === "all"
                            ? "bg-slate-900 text-white shadow-xs"
                            : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        All ({pendingStudents.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => setPendingFilter("critical")}
                        className={`tap-bounce rounded-xl px-3 py-1.5 text-xs font-bold transition-all whitespace-nowrap flex-shrink-0 ${
                          pendingFilter === "critical"
                            ? "bg-rose-600 text-white shadow-xs"
                            : "bg-rose-50 text-rose-700 border border-rose-200/80 hover:bg-rose-100"
                        }`}
                      >
                        Critical &gt;7 Days ({criticalCount})
                      </button>

                      <button
                        type="button"
                        onClick={() => setPendingFilter("moderate")}
                        className={`tap-bounce rounded-xl px-3 py-1.5 text-xs font-bold transition-all whitespace-nowrap flex-shrink-0 ${
                          pendingFilter === "moderate"
                            ? "bg-amber-600 text-white shadow-xs"
                            : "bg-amber-50 text-amber-800 border border-amber-200/80 hover:bg-amber-100"
                        }`}
                      >
                        &lt;7 Days ({moderateCount})
                      </button>
                    </div>

                    <button
                      onClick={() => fetchFeesData(true)}
                      className="tap-bounce text-slate-400 hover:text-slate-600 p-1 flex-shrink-0"
                      title="Reload fees"
                      aria-label="Reload fees"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Pending List Header with Add Fee trigger */}
                  <div className="flex items-center justify-between px-0.5">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[14px] font-bold text-slate-900 tracking-tight">
                        Pending Students ({filteredPendingStudents.length})
                      </h2>
                      <span className="text-[11px] font-semibold text-slate-400 hidden sm:inline">
                        • Tap green icon to remind
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsAddFeeModalOpen(true)}
                      className="tap-bounce rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-95 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 shadow-xs shadow-blue-600/25 transition-all"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add Fee</span>
                    </button>
                  </div>

                  {/* Pending Students List */}
                  <div className="space-y-2.5">
                    {filteredPendingStudents.length > 0 ? (
                      filteredPendingStudents.map((student) => {
                        const feeId = student.feeId || student.id;
                        return (
                          <OverdueStudentItem
                            key={feeId}
                            student={student}
                            tabType="pending"
                            userRole={userProfile?.role}
                            onSendReminder={handleSendIndividual}
                            isReminderSent={Boolean(sentReminders[feeId])}
                            isSendingReminder={sendingReminderId === feeId}
                            onMarkPaid={handleMarkPaid}
                            isMarkingPaid={false}
                            onViewDetails={handleViewDetails}
                            onViewReceipt={handleViewReceipt}
                          />
                        );
                      })
                    ) : (
                      <div className="rounded-3xl border border-slate-100 bg-white p-8 text-center shadow-xs">
                        <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center mb-2">
                          <IndianRupee className="w-5 h-5" />
                        </div>
                        <p className="text-sm font-bold text-slate-800">
                          No pending fees found!
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          All students in this category have cleared their dues.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Server-Side Pagination for Pending Dues */}
                  <FeePaginationBar
                    currentPage={pendingPage}
                    totalPages={pendingTotalPages}
                    totalItems={pendingTotal}
                    onPageChange={handlePendingPageChange}
                    label="pending dues"
                  />
                </div>
              )}

              {/* SUBSECTION 2: AWAITING REVIEW (Owner Only) */}
              {isOwner && effectivePaymentsSubTab === "review" && (
                <div className="space-y-4 animate-fade-in">
                  <div className="rounded-2xl sm:rounded-3xl border border-amber-300 bg-gradient-to-br from-amber-500/10 via-amber-50 to-orange-50/60 p-3.5 sm:p-5 shadow-xs w-full max-w-full">
                    <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 w-full">
                      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-amber-500 text-white flex items-center justify-center shadow-md shadow-amber-500/25 flex-shrink-0">
                          <ShieldCheck className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h2 className="text-sm sm:text-base md:text-lg font-black text-slate-900 tracking-tight truncate">
                            Incoming Payments to Verify
                          </h2>
                          <p className="text-[11px] sm:text-xs text-slate-600 font-medium mt-0.5 line-clamp-2 sm:line-clamp-none">
                            Review parent UTR submissions and advance payments before marking paid
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap sm:flex-nowrap flex-shrink-0">
                        <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full text-[11px] sm:text-xs font-extrabold bg-amber-100 text-amber-900 border border-amber-300">
                          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                          <span>{reviewStudents.length} {reviewStudents.length === 1 ? "Payment" : "Payments"} Awaiting Approval</span>
                        </span>
                        <button
                          onClick={() => fetchFeesData(true)}
                          className="tap-bounce text-slate-400 hover:text-slate-600 p-1"
                          title="Reload verifications"
                          aria-label="Reload verifications"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {reviewStudents.length > 0 ? (
                      reviewStudents.map((student) => {
                        const feeId = student.feeId || student.id;
                        return (
                          <OverdueStudentItem
                            key={feeId}
                            student={student}
                            tabType="review"
                            userRole={userProfile?.role}
                            onVerifyPaid={isOwner ? handleOpenApproveModal : undefined}
                            isVerifyingPaid={approvingId === feeId}
                            onRejectFee={isOwner ? handleOpenRejectModal : undefined}
                            isRejectingFee={rejectingId === feeId}
                            onViewProof={isOwner ? handleViewProof : undefined}
                            onViewDetails={handleViewDetails}
                            onViewReceipt={handleViewReceipt}
                          />
                        );
                      })
                    ) : (
                      <div className="rounded-3xl border border-slate-100 bg-white p-10 text-center shadow-xs">
                        <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 mx-auto flex items-center justify-center mb-3">
                          <ShieldCheck className="w-6 h-6 stroke-[2.2]" />
                        </div>
                        <h3 className="text-sm font-bold text-slate-800">
                          All Clear! No Payments Awaiting Review
                        </h3>
                        <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto leading-relaxed">
                          When parents submit UTR transaction numbers or advance fee payments via their VIP portal, they will appear here for you to verify against your bank statement.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Server-Side Pagination for Review Queue */}
                  <FeePaginationBar
                    currentPage={reviewPage}
                    totalPages={reviewTotalPages}
                    totalItems={reviewTotal}
                    onPageChange={handleReviewPageChange}
                    label="review items"
                  />
                </div>
              )}

              {/* SUBSECTION 3: PAID HISTORY */}
              {effectivePaymentsSubTab === "paid" && (
                <div className="space-y-4 animate-fade-in">
                  <div className="rounded-2xl sm:rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-500/10 via-emerald-50 to-teal-50/60 p-3.5 sm:p-5 shadow-xs w-full max-w-full">
                    <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 w-full">
                      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-md shadow-emerald-600/25 flex-shrink-0">
                          <CheckCircle2 className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h2 className="text-sm sm:text-base md:text-lg font-black text-slate-900 tracking-tight truncate">
                            Paid Fee History
                          </h2>
                          <p className="text-[11px] sm:text-xs text-slate-600 font-medium mt-0.5 truncate">
                            Total Collection: <span className="font-bold text-emerald-800 font-mono">₹{collectedAmount.toLocaleString("en-IN")}</span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap sm:flex-nowrap flex-shrink-0">
                        <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full text-[11px] sm:text-xs font-extrabold bg-emerald-100 text-emerald-900 border border-emerald-200">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                          <span>{hasLoadedPaid ? `${paidStudents.length} Records Cleared` : "Loading..."}</span>
                        </span>
                        <button
                          onClick={() => {
                            fetchFeesData();
                            fetchPaidHistory();
                          }}
                          className="tap-bounce text-slate-400 hover:text-slate-600 p-1"
                          title="Reload history"
                          aria-label="Reload history"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${loadingPaid ? "animate-spin text-emerald-600" : ""}`} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {loadingPaid && paidStudents.length === 0 ? (
                      <div className="rounded-3xl border border-slate-100 bg-white p-10 text-center shadow-xs">
                        <Loader2 className="w-6 h-6 animate-spin text-emerald-600 mx-auto mb-2" />
                        <p className="text-xs font-semibold text-slate-500">
                          Loading paid fee records...
                        </p>
                      </div>
                    ) : paidStudents.length > 0 ? (
                      paidStudents.map((student) => (
                        <OverdueStudentItem
                          key={student.feeId || student.id}
                          student={student}
                          tabType="paid"
                          userRole={userProfile?.role}
                          onViewDetails={handleViewDetails}
                          onViewReceipt={handleViewReceipt}
                        />
                      ))
                    ) : (
                      <div className="rounded-3xl border border-slate-100 bg-white p-10 text-center shadow-xs">
                        <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center mb-3">
                          <IndianRupee className="w-6 h-6" />
                        </div>
                        <h3 className="text-sm font-bold text-slate-800">
                          No Paid Fee Records Yet
                        </h3>
                        <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto leading-relaxed">
                          Fees marked as paid or approved from the review queue will appear here.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Server-Side Pagination for Paid History */}
                  <FeePaginationBar
                    currentPage={paidPage}
                    totalPages={paidTotalPages}
                    totalItems={paidTotal}
                    onPageChange={handlePaidPageChange}
                    label="paid records"
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* SECTION C: CASH HANDOVER TAB                                             */}
      {/* ========================================================================= */}
      {mainTab === "handovers" && userProfile && (
        <div className="space-y-4 animate-fade-in">
          {userProfile.role === "teacher" ? (
            <TeacherHandoverConsole userProfile={userProfile} />
          ) : (
            <OwnerHandoverConsole userProfile={userProfile} />
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODALS & OVERLAYS                                                        */}
      {/* ========================================================================= */}
      {/* Add Fee Modal */}
      {isAddFeeModalOpen && (
        <AddFeeModal
          isOpen={isAddFeeModalOpen}
          onClose={() => setIsAddFeeModalOpen(false)}
          onSuccess={() => {
            setIsAddFeeModalOpen(false);
            invalidateApiCache();
            fetchFeesData(true);
            fetchPaidHistory(true);
          }}
        />
      )}

      {/* Fee Payment Collection Modal */}
      {isPaymentModalOpen && (
        <FeePaymentModal
          isOpen={isPaymentModalOpen}
          onClose={() => setIsPaymentModalOpen(false)}
          student={selectedStudentForPayment}
          fee={selectedFeeForPayment}
          onSuccess={handlePaymentSuccess}
        />
      )}

      {/* Detailed Fee History & Custody Modal */}
      {Boolean(selectedDetailFeeId) && (
        <FeeDetailModal
          isOpen={Boolean(selectedDetailFeeId)}
          onClose={() => setSelectedDetailFeeId(null)}
          feeId={selectedDetailFeeId}
          userRole={userProfile?.role}
          onRecordPayment={(feeDoc, studentDoc) => {
            setSelectedStudentForPayment({
              _id: String((studentDoc as { _id?: unknown; id?: unknown })?._id || (studentDoc as { _id?: unknown; id?: unknown })?.id),
              name: String((studentDoc as { name?: unknown })?.name || "Student"),
              batch: String((studentDoc as { batch?: unknown })?.batch || ""),
              centerId: activeCenterId,
            });
            setSelectedFeeForPayment({
              _id: String(feeDoc._id),
              month: String(feeDoc.month || ""),
              title: feeDoc.title ? String(feeDoc.title) : undefined,
              amountDue: Number(feeDoc.amountDue) || 0,
              paidAmount: Number(feeDoc.paidAmount) || 0,
              totalAmount: Number(feeDoc.originalAmountDue) || Number(feeDoc.amountDue) || 0,
              originalAmountDue: Number(feeDoc.originalAmountDue) || undefined,
            });
            setIsPaymentModalOpen(true);
          }}
          onViewReceipt={(receiptData) => {
            setActiveReceiptData(receiptData);
          }}
        />
      )}

      {/* Official / Provisional Receipt Slip Modal */}
      {Boolean(activeReceiptData) && (
        <ReceiptSlipModal
          isOpen={Boolean(activeReceiptData)}
          onClose={() => setActiveReceiptData(null)}
          receiptData={activeReceiptData}
        />
      )}

      {/* 24-Hour Cooldown Confirmation Dialog */}
      {cooldownConfirmFee && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4 backdrop-blur-xs animate-fade-in">
          <div className="rounded-3xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-2xl w-full max-w-sm relative transition-all">
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 text-amber-600">
              <AlertTriangle className="h-5 w-5 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 leading-snug">
                  Reminder Sent Inside 24 Hours
                </h3>
                <p className="text-[11px] text-slate-400">
                  Manual Resend Confirmation
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-600 my-3 leading-relaxed">
              A reminder was already sent to{" "}
              <strong className="text-slate-900">{cooldownConfirmFee.student.name}</strong>{" "}
              (
              <StudentPhoneMasked
                phone={cooldownConfirmFee.student.parentPhone}
                userRole={userProfile?.role}
                showQuickActions={false}
                className="inline"
                textClassName="font-medium text-slate-700"
              />
              ) within the last 24 hours. Are you sure you want to send another reminder now?
            </p>

            <div className="mb-4">
              <label
                htmlFor="override-reason"
                className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
              >
                Audit Reason for Override
              </label>
              <input
                id="override-reason"
                type="text"
                value={overrideReasonInput}
                onChange={(e) => setOverrideReasonInput(e.target.value)}
                placeholder="e.g. Parent requested urgent invoice link via phone"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 px-3.5 py-2 text-xs font-semibold text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCooldownConfirmFee(null)}
                disabled={isOverriding}
                className="tap-bounce flex-1 h-10 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={async () => {
                  setIsOverriding(true);
                  await handleSendIndividual(
                    cooldownConfirmFee.student,
                    true,
                    overrideReasonInput || "Owner explicit confirmation via UI"
                  );
                }}
                disabled={isOverriding}
                className="tap-bounce flex-1 h-10 rounded-2xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-amber-600/25 transition-all disabled:opacity-60"
              >
                {isOverriding ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Sending...</span>
                  </>
                ) : (
                  <span>Confirm Resend</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PHASE 3: SCREENSHOT VIEWER MODAL (AUTHENTICATED & EXPIRING SIGNED URL)    */}
      {/* ========================================================================= */}
      {proofModalOpen && activeProofStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-5 backdrop-blur-xs animate-fade-in overflow-y-auto">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-4 sm:p-6 shadow-2xl space-y-4 border border-slate-200 my-auto animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5 min-w-0 pr-2">
                <div className="h-10 w-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-200/80 shadow-2xs shrink-0">
                  <Camera className="h-5 w-5 stroke-[2.2]" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-black text-slate-900 tracking-tight truncate">
                    Payment Proof Review
                  </h3>
                  <p className="text-xs text-slate-500 font-medium truncate">
                    {activeProofStudent.name} • {activeProofStudent.batchName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProofModalOpen(false)}
                className="tap-bounce h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 transition-colors cursor-pointer shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Content */}
            {proofLoading ? (
              <div className="py-16 text-center space-y-3">
                <Loader2 className="h-8 w-8 animate-spin text-indigo-600 mx-auto" />
                <p className="text-xs font-bold text-slate-600">
                  Loading signed payment screenshot from secure storage...
                </p>
                <span className="text-[11px] text-slate-400">
                  Authenticating with ImageKit private delivery service
                </span>
              </div>
            ) : proofError ? (
              <div className="py-10 text-center space-y-3.5">
                <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
                  <AlertCircle className="w-6 h-6 stroke-[2.2]" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-slate-800">Screenshot Unavailable</h4>
                  <p className="text-xs text-rose-600 font-medium max-w-sm mx-auto">{proofError}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleViewProof(activeProofStudent)}
                  className="tap-bounce px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-bold transition-all shadow-sm"
                >
                  Retry Loading
                </button>
              </div>
            ) : proofList.length > 0 ? (
              (() => {
                const latestProof = proofList[0];
                const hasScreenshot = Boolean(latestProof.fileUrl && String(latestProof.fileUrl).trim());
                const utrValue = String(latestProof.submittedUtr || activeProofStudent.utrNumber || "").trim();
                const hasUtr = Boolean(utrValue);

                return (
                  <div className="space-y-3.5">
                    {/* Metadata Context Bar */}
                    <div className="rounded-2xl bg-slate-50 p-3.5 border border-slate-200/90 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 pb-2">
                        <div>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                            Amount to Clear
                          </span>
                          <span className="text-lg font-black text-slate-900 font-mono">
                            ₹{activeProofStudent.pendingAmount.toLocaleString("en-IN")}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                            Submitted Reference
                          </span>
                          <span className="font-mono font-bold text-indigo-900 bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-200 select-all">
                            {utrValue || "No UTR Provided"}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                        <div>
                          <span className="text-slate-400">Uploaded:</span>{" "}
                          <span className="font-bold text-slate-700 font-mono">
                            {latestProof.createdAt
                              ? new Date(latestProof.createdAt).toLocaleString("en-IN", {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                })
                              : "Recent"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">Proof Mode:</span>{" "}
                          <span className="font-bold text-slate-800">
                            {hasScreenshot && hasUtr
                              ? "UTR + Screenshot"
                              : hasScreenshot
                              ? "Screenshot Only"
                              : "UTR Reference Only"}
                          </span>
                        </div>
                      </div>

                      {hasScreenshot && (latestProof.fileSizeBytes ?? 0) > 0 && (
                        <div className="text-[11px] text-slate-500">
                          <span className="text-slate-400">File:</span>{" "}
                          <span className="font-medium text-slate-700">
                            {latestProof.originalFileName || "screenshot.jpg"} (
                            {((latestProof.fileSizeBytes || 0) / 1024).toFixed(0)} KB •{" "}
                            {latestProof.mimeType?.replace("image/", "").toUpperCase()})
                          </span>
                        </div>
                      )}

                      {latestProof.notes && (
                        <div className="pt-1 text-[11px] text-slate-600 border-t border-slate-200/60">
                          <span className="text-slate-400 font-medium">Parent Note:</span>{" "}
                          <span className="font-semibold text-slate-800 italic">&ldquo;{latestProof.notes}&rdquo;</span>
                        </div>
                      )}
                    </div>

                    {/* Case A & Combined: Prominent UTR Reference Card */}
                    {hasUtr ? (
                      <div className="rounded-2xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/80 via-white to-blue-50/50 p-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-800 flex items-center gap-1.5">
                            <Hash className="w-4 h-4 text-indigo-600" />
                            12-Digit UTR / Transaction Ref
                          </span>
                          <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-900 border border-indigo-200">
                            {hasScreenshot ? "Attached with Screenshot" : "UTR Only (No Screenshot)"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-xl bg-white border border-indigo-200 shadow-xs">
                          <span className="font-mono font-black text-lg sm:text-xl text-slate-900 tracking-wider select-all">
                            {utrValue}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(utrValue);
                              setToastMessage("UTR reference copied to clipboard!");
                              setTimeout(() => setToastMessage(null), 2500);
                            }}
                            className="tap-bounce p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer"
                            title="Copy UTR Reference"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-600 leading-tight">
                          Cross-check this 12-digit transaction ID with your bank statement / UPI merchant settlements.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3.5 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                            <Hash className="w-4 h-4 text-slate-400" />
                            UTR / Transaction Ref
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                            UTR Not Fetched
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                          No transaction reference was returned by the UPI app. Please verify the payment screenshot below against your bank statement.
                        </p>
                      </div>
                    )}

                    {/* Case B & Combined: Image Viewport with Zoom Controls */}
                    {hasScreenshot ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
                          <span>Click image or button to zoom</span>
                          <button
                            type="button"
                            onClick={() => setIsZoomed(!isZoomed)}
                            className="tap-bounce inline-flex items-center gap-1 font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
                          >
                            {isZoomed ? (
                              <>
                                <ZoomOut className="w-3.5 h-3.5" />
                                <span>Fit to Window</span>
                              </>
                            ) : (
                              <>
                                <ZoomIn className="w-3.5 h-3.5" />
                                <span>Zoom In (100%)</span>
                              </>
                            )}
                          </button>
                        </div>

                        <div className="bg-slate-950 rounded-2xl overflow-auto p-2 sm:p-4 flex items-center justify-center max-h-[52vh] border border-slate-800 shadow-inner">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={latestProof.fileUrl}
                            alt={`Payment screenshot for ${activeProofStudent.name}`}
                            onClick={() => setIsZoomed(!isZoomed)}
                            className={`rounded-lg shadow-2xl transition-all duration-200 select-none ${
                              isZoomed
                                ? "min-w-full cursor-zoom-out object-none"
                                : "max-h-[46vh] w-auto object-contain cursor-zoom-in"
                            }`}
                          />
                        </div>
                      </div>
                    ) : (
                      !hasUtr && (
                        <div className="py-8 text-center text-slate-500 space-y-1">
                          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto" />
                          <p className="text-xs font-bold text-slate-700">No Screenshot Attached</p>
                          <p className="text-[11px] text-slate-400">Payment details submitted with note only.</p>
                        </div>
                      )
                    )}

                    {/* Action Buttons in Modal Footer: Primary CTA first on mobile column, side-by-side on desktop */}
                    <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => handleOpenRejectModal(activeProofStudent)}
                        disabled={approvingId === (activeProofStudent.feeId || activeProofStudent.id)}
                        className="tap-bounce h-11 px-4 rounded-2xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4 text-rose-600" />
                        <span>Reject Submission</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleOpenApproveModal(activeProofStudent)}
                        disabled={approvingId === (activeProofStudent.feeId || activeProofStudent.id)}
                        className="tap-bounce h-11 px-5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-600/30 cursor-pointer disabled:opacity-50"
                      >
                        {approvingId === (activeProofStudent.feeId || activeProofStudent.id) ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                            <span>Marking Paid...</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-4 w-4 stroke-[2.5]" />
                            <span>Approve &amp; Mark Paid (₹{activeProofStudent.pendingAmount.toLocaleString("en-IN")})</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="py-12 text-center text-slate-500 space-y-2">
                <FileText className="w-10 h-10 text-slate-300 mx-auto" />
                <p className="text-xs font-bold text-slate-700">No Screenshot on Record</p>
                <p className="text-[11px] text-slate-400">This fee was submitted with manual UTR reference only.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* APPROVE CONFIRMATION MODAL                                                */}
      {/* ========================================================================= */}
      {showApproveModal && approveTargetStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-fade-in overflow-y-auto">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl space-y-4 border border-slate-200 my-auto animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center border border-emerald-200 shrink-0">
                <CheckCircle2 className="h-6 w-6 stroke-[2.4]" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-900 tracking-tight">Confirm Payment Approval</h3>
                <p className="text-[11px] text-slate-500 font-medium">Issue Official e-Receipt</p>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 p-3.5 border border-slate-200 space-y-1.5 text-xs">
              <div className="flex items-center justify-between font-bold text-slate-700">
                <span>Student:</span>
                <span className="text-slate-900">{approveTargetStudent.name}</span>
              </div>
              <div className="flex items-center justify-between font-bold text-slate-700">
                <span>Amount:</span>
                <span className="text-base font-black text-emerald-700 font-mono">
                  ₹{approveTargetStudent.pendingAmount.toLocaleString("en-IN")}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
              Approving will update the student fee ledger to <strong>Paid</strong>, generate an official receipt number, and automatically dispatch a confirmation slip to the parent&apos;s WhatsApp.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowApproveModal(false)}
                disabled={approvingId === (approveTargetStudent.feeId || approveTargetStudent.id)}
                className="tap-bounce flex-1 h-10 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmApprove}
                disabled={approvingId === (approveTargetStudent.feeId || approveTargetStudent.id)}
                className="tap-bounce flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/25 transition-all cursor-pointer disabled:opacity-60"
              >
                {approvingId === (approveTargetStudent.feeId || approveTargetStudent.id) ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Approving...</span>
                  </>
                ) : (
                  <span>Confirm Approval</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* REJECT WITH MANDATORY REASON MODAL                                        */}
      {/* ========================================================================= */}
      {showRejectModal && rejectTargetStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-fade-in overflow-y-auto">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl space-y-4 border border-slate-200 my-auto animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center border border-rose-200 shrink-0">
                <Trash2 className="h-5 w-5 stroke-[2.2]" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-900 tracking-tight">Reject Payment Proof</h3>
                <p className="text-[11px] text-slate-500 font-medium">{rejectTargetStudent.name} • Return to Pending</p>
              </div>
            </div>

            <form onSubmit={handleConfirmReject} className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-700 block">
                  Rejection Reason * <span className="text-slate-400 font-normal">(Sent to Parent Portal)</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={rejectionReasonInput}
                  onChange={(e) => {
                    setRejectionReasonInput(e.target.value);
                    if (rejectionError) setRejectionError(null);
                  }}
                  placeholder="e.g. UTR reference not found in bank statement, amount mismatch, or screenshot is blurry..."
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/60 p-2.5 text-xs text-slate-900 focus:bg-white focus:outline-hidden focus:ring-4 focus:ring-rose-100 focus:border-rose-600 transition-all font-medium"
                />
              </div>

              {rejectionError && (
                <p className="text-[11px] text-rose-600 font-semibold">{rejectionError}</p>
              )}

              <p className="text-[10px] text-slate-400 font-medium leading-relaxed">
                Rejecting returns the fee status to Pending without altering ledger balances. The parent will be notified to submit a corrected receipt.
              </p>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowRejectModal(false)}
                  disabled={rejectingId === (rejectTargetStudent.feeId || rejectTargetStudent.id)}
                  className="tap-bounce flex-1 h-10 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    rejectingId === (rejectTargetStudent.feeId || rejectTargetStudent.id) ||
                    !rejectionReasonInput.trim()
                  }
                  className="tap-bounce flex-1 h-10 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-rose-600/25 transition-all cursor-pointer disabled:opacity-50"
                >
                  {rejectingId === (rejectTargetStudent.feeId || rejectTargetStudent.id) ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Rejecting...</span>
                    </>
                  ) : (
                    <span>Reject Proof</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
