"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  IndianRupee,
  Calendar,
  CalendarDays,
  CreditCard,
  GraduationCap,
  AlertCircle,
  Clock,
  ShieldCheck,
  Download,
  Search,
  Users,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  X,
  FileText,
  Layers,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { getAuthenticatedCenter } from "@/lib/centerProfile";
import { useSetHeader } from "@/components/layout/HeaderContext";
import type {
  FinancialSummaryResponse,
  FinancialSummaryKPIs,
  TeacherReportRow,
  BatchReportRow,
  StudentLedgerRow,
  HandoverReportRow,
  TeacherRecord,
  BatchRecord,
} from "@/types";

type ReportFilterType = "daily" | "monthly" | "custom" | "all";
type ReportTabType = "teachers" | "batches" | "students" | "handovers";

// Deterministic pastel avatar background colors
const AVATAR_COLORS = [
  "bg-indigo-100 text-indigo-700 border-indigo-200",
  "bg-emerald-100 text-emerald-700 border-emerald-200",
  "bg-blue-100 text-blue-700 border-blue-200",
  "bg-purple-100 text-purple-700 border-purple-200",
  "bg-amber-100 text-amber-700 border-amber-200",
  "bg-rose-100 text-rose-700 border-rose-200",
  "bg-teal-100 text-teal-700 border-teal-200",
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Returns current date in IST (Asia/Kolkata UTC+5:30) as YYYY-MM-DD
 */
function getTodayIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffset);
  return istDate.toISOString().slice(0, 10);
}

/**
 * Returns yesterday's date in IST as YYYY-MM-DD
 */
function getYesterdayIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffset - (24 * 60 * 60 * 1000));
  return istDate.toISOString().slice(0, 10);
}

/**
 * Returns current month in IST as YYYY-MM
 */
function getCurrentMonthIST(): string {
  return getTodayIST().slice(0, 7);
}

/**
 * Returns start of current month in IST as YYYY-MM-01
 */
function getMonthStartIST(): string {
  return `${getCurrentMonthIST()}-01`;
}

function formatReadableDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const raw = dateStr.includes("T") ? dateStr.slice(0, 10) : dateStr;
    const [year, month, day] = raw.split("-");
    const d = new Date(Number(year), Number(month) - 1, Number(day));
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatReadableMonth(monthStr: string): string {
  if (!monthStr) return "";
  try {
    const [year, month] = monthStr.split("-");
    const d = new Date(Number(year), Number(month) - 1, 1);
    return d.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
  } catch {
    return monthStr;
  }
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

export default function CollectionReportsPage() {
  const router = useRouter();

  // TopHeader Dynamic Synchronization
  useSetHeader({
    title: "Financial Reports",
    subtitle: "Owner Financial Reports & Collection Analytics",
    badgeText: "Owner",
  });

  // Role Protection: strictly Owner-only. Redirect Teachers to "/"
  useEffect(() => {
    getAuthenticatedCenter().then((center) => {
      if (center?.role === "teacher") {
        router.replace("/");
      }
    });
  }, [router]);

  // Active Tab State
  const [activeTab, setActiveTab] = useState<ReportTabType>("teachers");

  // Filter States (Asia/Kolkata IST)
  const [filterType, setFilterType] = useState<ReportFilterType>("monthly");
  const [dailyDate, setDailyDate] = useState<string>(getTodayIST());
  const [monthlyDate, setMonthlyDate] = useState<string>(getCurrentMonthIST());
  const [customStartDate, setCustomStartDate] = useState<string>(getMonthStartIST());
  const [customEndDate, setCustomEndDate] = useState<string>(getTodayIST());

  // Additional Filter Selectors
  const [selectedTeacher, setSelectedTeacher] = useState<string>("");
  const [selectedBatch, setSelectedBatch] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [selectedHandoverStatus, setSelectedHandoverStatus] = useState<string>("");
  const [searchStudent, setSearchStudent] = useState<string>("");

  // Metadata dropdown options
  const [teachersList, setTeachersList] = useState<TeacherRecord[]>([]);
  const [batchesList, setBatchesList] = useState<BatchRecord[]>([]);

  // Expanded student rows in Student Ledger tab
  const [expandedStudents, setExpandedStudents] = useState<Record<string, boolean>>({});

  // Data & Request States
  const [kpis, setKpis] = useState<FinancialSummaryKPIs | null>(null);
  const [teacherReports, setTeacherReports] = useState<TeacherReportRow[]>([]);
  const [batchReports, setBatchReports] = useState<BatchReportRow[]>([]);
  const [studentLedger, setStudentLedger] = useState<StudentLedgerRow[]>([]);
  const [handoverReports, setHandoverReports] = useState<HandoverReportRow[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Derive date validation error
  const dateValidationError = useMemo(() => {
    if (filterType === "custom" && customStartDate && customEndDate && customStartDate > customEndDate) {
      return "Start date cannot be after end date";
    }
    return null;
  }, [filterType, customStartDate, customEndDate]);

  // Fetch Teacher and Batch option lists on mount
  useEffect(() => {
    let mounted = true;
    apiClient<{ data?: TeacherRecord[] }>("/teachers?isActive=true")
      .then((res) => {
        if (mounted && res.success && Array.isArray(res.data)) {
          setTeachersList(res.data.filter((t) => t.isActive !== false));
        }
      })
      .catch(() => {});

    apiClient<BatchRecord[]>("/batches")
      .then((res) => {
        if (mounted && res.success && Array.isArray(res.data)) {
          setBatchesList(res.data.filter((b) => b.isActive !== false));
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
    };
  }, []);

  // Fetch financial summary report data
  const fetchReport = useCallback(
    async (isManualRefresh = false) => {
      if (filterType === "custom" && customStartDate > customEndDate) {
        return;
      }

      if (isManualRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const queryParams: Record<string, string> = {};

        if (filterType === "daily") {
          queryParams.startDate = dailyDate;
          queryParams.endDate = dailyDate;
        } else if (filterType === "monthly") {
          // monthlyDate format "YYYY-MM"
          const [y, m] = monthlyDate.split("-");
          const lastDay = new Date(Number(y), Number(m), 0).getDate();
          queryParams.startDate = `${monthlyDate}-01`;
          queryParams.endDate = `${monthlyDate}-${String(lastDay).padStart(2, "0")}`;
        } else if (filterType === "custom") {
          queryParams.startDate = customStartDate;
          queryParams.endDate = customEndDate;
        }

        if (selectedTeacher) queryParams.teacherId = selectedTeacher;
        if (selectedBatch) queryParams.batch = selectedBatch;
        if (selectedStatus) queryParams.status = selectedStatus;
        if (selectedHandoverStatus) queryParams.handoverStatus = selectedHandoverStatus;
        if (searchStudent.trim()) queryParams.student = searchStudent.trim();

        const res = await apiClient<FinancialSummaryResponse>("/reports/financial-summary", {
          params: queryParams,
          skipCache: true,
        });

        // Backend response resolution
        const raw = res as unknown as Record<string, unknown>;
        const dataObj = res.data as unknown as Record<string, unknown> | undefined;
        const resolved: FinancialSummaryResponse =
          dataObj && typeof dataObj === "object" && "kpis" in dataObj
            ? (res.data as FinancialSummaryResponse)
            : (raw as unknown as FinancialSummaryResponse);

        if (resolved && resolved.success) {
          setKpis(resolved.kpis);

          const safeTeacherReports: TeacherReportRow[] = (resolved.teacherReports || []).map((t) => {
            const raw = t as unknown as Record<string, unknown>;
            const inHand = t.teacherInHandAmount ?? (raw.cashInHand as number | undefined);
            const pending = t.ownerPendingAmount ?? (raw.cashSubmitted as number | undefined);
            const verified = t.ownerVerifiedAmount ?? (raw.cashVerified as number | undefined);
            return {
              ...t,
              totalCollected: Number(t.totalCollected ?? 0),
              teacherInHandAmount: Number(inHand ?? 0),
              ownerPendingAmount: Number(pending ?? 0),
              ownerVerifiedAmount: Number(verified ?? 0),
              activeDiscrepancies: Number(t.activeDiscrepancies ?? 0),
              transactionCount: Number(t.transactionCount ?? 0),
              cashInHand: Number(inHand ?? 0),
              cashSubmitted: Number(pending ?? 0),
              cashVerified: Number(verified ?? 0),
            };
          });
          setTeacherReports(safeTeacherReports);

          const safeBatchReports: BatchReportRow[] = (resolved.batchReports || []).map((b) => {
            const raw = b as unknown as Record<string, unknown>;
            const rate = b.collectionRate ?? (raw.collectionRatePercent as number | undefined);
            return {
              ...b,
              studentCount: Number(b.studentCount ?? 0),
              totalInvoiced: Number(b.totalInvoiced ?? 0),
              totalCollected: Number(b.totalCollected ?? 0),
              outstandingBalance: Number(b.outstandingBalance ?? 0),
              partialPaymentCount: Number(b.partialPaymentCount ?? 0),
              collectionRate: Number(rate ?? 0),
              collectionRatePercent: Number(rate ?? 0),
            };
          });
          setBatchReports(safeBatchReports);

          const safeStudentLedger: StudentLedgerRow[] = (resolved.studentLedger || []).map((s) => {
            const raw = s as unknown as Record<string, unknown>;
            const bName = s.batchName || (raw.batch as string | undefined) || "General";
            const pName = s.parentName || "Parent";
            const pPhone = s.parentPhone || "";
            const mMonth = s.month || (raw.feeMonth as string | undefined) || "";
            const fStatus = s.feeStatus || (raw.status as string | undefined) || "Pending";
            return {
              ...s,
              studentName: s.studentName || "Unknown Student",
              parentName: pName,
              parentPhone: pPhone,
              batchName: bName,
              month: mMonth,
              amountDue: Number(s.amountDue ?? 0),
              paidAmount: Number(s.paidAmount ?? 0),
              outstandingBalance: Number(s.outstandingBalance ?? s.amountDue ?? 0),
              feeStatus: fStatus,
              payments: (s.payments || []).map((p) => {
                const rawP = p as unknown as Record<string, unknown>;
                const label = p.custodyLabel || (rawP.custodyStatus as string | undefined) || "N/A";
                return {
                  ...p,
                  amount: Number(p.amount ?? 0),
                  custodyLabel: label,
                  receivedByRole: (p.receivedByRole as "owner" | "teacher") || "teacher",
                  isOwnerVerified: Boolean(p.isOwnerVerified),
                  status: p.status || "approved",
                };
              }),
            };
          });
          setStudentLedger(safeStudentLedger);

          const safeHandoverReports: HandoverReportRow[] = (resolved.handoverReports || []).map((h) => ({
            ...h,
            handoverNumber: h.handoverNumber || "N/A",
            teacherName: h.teacherName || "Faculty",
            submittedAmount: Number(h.submittedAmount ?? 0),
            approvedAmount: Number(h.approvedAmount ?? 0),
            discrepancyAmount: Number(h.discrepancyAmount ?? 0),
            remainingDiscrepancy: Number(h.remainingDiscrepancy ?? 0),
            status: h.status || "pending_verification",
            discrepancyStatus: h.discrepancyStatus || "none",
            itemCount: Number(h.itemCount ?? 0),
            resolutionsCount: Number(h.resolutionsCount ?? 0),
            settlementsCount: Number(h.settlementsCount ?? 0),
          }));
          setHandoverReports(safeHandoverReports);
        } else {
          setError(resolved?.error || "Failed to retrieve financial summary");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load financial reports";
        setError(msg);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [
      filterType,
      dailyDate,
      monthlyDate,
      customStartDate,
      customEndDate,
      selectedTeacher,
      selectedBatch,
      selectedStatus,
      selectedHandoverStatus,
      searchStudent,
    ]
  );

  // Auto-fetch on filter changes
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (active) {
        await fetchReport(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [fetchReport]);

  const toggleStudentExpanded = (feeId: string) => {
    setExpandedStudents((prev) => ({
      ...prev,
      [feeId]: !prev[feeId],
    }));
  };

  const resetFilters = () => {
    setFilterType("monthly");
    setMonthlyDate(getCurrentMonthIST());
    setSelectedTeacher("");
    setSelectedBatch("");
    setSelectedStatus("");
    setSelectedHandoverStatus("");
    setSearchStudent("");
  };

  // Export CSV handler for the active tab
  const handleExportCsv = () => {
    let headers: string[] = [];
    let rows: string[][] = [];
    const dateStamp = getTodayIST();
    let filename = `financial-report-${activeTab}-${dateStamp}.csv`;

    if (activeTab === "teachers") {
      filename = `faculty-collection-report-${dateStamp}.csv`;
      headers = [
        "Faculty Name",
        "Total Collected (INR)",
        "Faculty In-Hand Cash (INR)",
        "Pending Verification (INR)",
        "Owner Verified Cash (INR)",
        "Active Discrepancies (INR)",
        "Receipts Count",
      ];
      rows = teacherReports.map((t) => [
        t.teacherName,
        String(t.totalCollected ?? 0),
        String(t.teacherInHandAmount ?? t.cashInHand ?? 0),
        String(t.ownerPendingAmount ?? t.cashSubmitted ?? 0),
        String(t.ownerVerifiedAmount ?? t.cashVerified ?? 0),
        String(t.activeDiscrepancies ?? 0),
        String(t.transactionCount ?? 0),
      ]);
    } else if (activeTab === "batches") {
      filename = `batch-analytics-report-${dateStamp}.csv`;
      headers = [
        "Batch Name",
        "Students",
        "Total Invoiced (INR)",
        "Total Collected (INR)",
        "Outstanding Dues (INR)",
        "Partial Payments",
        "Collection Rate (%)",
      ];
      rows = batchReports.map((b) => [
        b.batchName,
        String(b.studentCount ?? 0),
        String(b.totalInvoiced ?? 0),
        String(b.totalCollected ?? 0),
        String(b.outstandingBalance ?? 0),
        String(b.partialPaymentCount ?? 0),
        `${b.collectionRate ?? b.collectionRatePercent ?? 0}%`,
      ]);
    } else if (activeTab === "students") {
      filename = `student-ledger-report-${dateStamp}.csv`;
      headers = [
        "Student Name",
        "Parent Name",
        "Parent Phone",
        "Batch",
        "Month/Cycle",
        "Amount Due (INR)",
        "Paid Amount (INR)",
        "Outstanding Balance (INR)",
        "Status",
        "Payments Count",
      ];
      rows = studentLedger.map((s) => [
        s.studentName,
        s.parentName || "Parent",
        s.parentPhone || "",
        s.batchName || s.batch || "General",
        s.month || s.feeMonth || "N/A",
        String(s.amountDue ?? 0),
        String(s.paidAmount ?? 0),
        String(s.outstandingBalance ?? 0),
        s.feeStatus || s.status || "Pending",
        String(s.payments?.length ?? 0),
      ]);
    } else if (activeTab === "handovers") {
      filename = `cash-handover-audit-report-${dateStamp}.csv`;
      headers = [
        "Handover Number",
        "Faculty Name",
        "Submission Date",
        "Submitted Amount (INR)",
        "Verified Amount (INR)",
        "Discrepancy (INR)",
        "Remaining Discrepancy (INR)",
        "Status",
        "Discrepancy Status",
        "Payment Items",
      ];
      rows = handoverReports.map((h) => [
        h.handoverNumber || "N/A",
        h.teacherName || "Faculty",
        formatReadableDate(String(h.submittedAt || "")),
        String(h.submittedAmount ?? 0),
        String(h.approvedAmount ?? 0),
        String(h.discrepancyAmount ?? 0),
        String(h.remainingDiscrepancy ?? 0),
        h.status || "pending_verification",
        h.discrepancyStatus || "none",
        String(h.itemCount ?? 0),
      ]);
    }

    const csvContent = [
      headers.map(escapeCsvCell).join(","),
      ...rows.map((row) => row.map(escapeCsvCell).join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Human readable active period badge
  const periodLabel = useMemo(() => {
    if (filterType === "daily") {
      return dailyDate === getTodayIST()
        ? `Today (${formatReadableDate(dailyDate)})`
        : dailyDate === getYesterdayIST()
        ? `Yesterday (${formatReadableDate(dailyDate)})`
        : formatReadableDate(dailyDate);
    }
    if (filterType === "monthly") {
      return formatReadableMonth(monthlyDate);
    }
    if (filterType === "custom") {
      return `${formatReadableDate(customStartDate)} – ${formatReadableDate(customEndDate)}`;
    }
    return "All Time";
  }, [filterType, dailyDate, monthlyDate, customStartDate, customEndDate]);

  return (
    <div className="space-y-6 pb-24 max-w-6xl mx-auto px-3 sm:px-6">
      {/* 1. Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
        <div className="flex items-center gap-3.5">
          <Link
            href="/"
            className="tap-bounce w-10 h-10 rounded-2xl bg-white border border-slate-200/90 flex items-center justify-center text-slate-600 hover:text-slate-900 shadow-xs hover:border-slate-300 transition-all flex-shrink-0"
            title="Return to Dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Financial Reports
              </h1>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-200/60 uppercase">
                Owner Confidential
              </span>
            </div>
            <p className="text-xs text-slate-500 font-medium mt-0.5">
              Institute revenue, cash custody verification &amp; faculty attribution analytics
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2.5 self-end sm:self-auto flex-wrap">
          <button
            onClick={handleExportCsv}
            disabled={loading}
            className="tap-bounce flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:text-slate-900 hover:border-slate-300 shadow-xs transition-all disabled:opacity-50"
            title="Export active report as CSV"
          >
            <Download className="w-3.5 h-3.5 text-slate-500" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={() => fetchReport(true)}
            disabled={refreshing || loading}
            className="tap-bounce flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:text-slate-900 hover:border-slate-300 shadow-xs transition-all disabled:opacity-50"
            title="Refresh report"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-slate-400 ${
                refreshing ? "animate-spin text-emerald-600" : ""
              }`}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* 2. Mandatory Financial Invariants Notice */}
      <div className="p-3.5 sm:p-4 rounded-2xl bg-gradient-to-r from-emerald-50/80 via-teal-50/50 to-blue-50/60 border border-emerald-200/70 text-slate-700 text-xs shadow-2xs">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-0.5 leading-relaxed">
            <span className="font-bold text-slate-900">Physical Custody Segregation Invariant:</span>{" "}
            Parent collections represent tuition revenue received. Physical cash reflects institute safe balance.
            Teacher-to-Owner handover transfers are strictly internal custody shifts and never inflate parent collections.
            Active shortages and discrepancies remain segregated from physical cash assets.
          </div>
        </div>
      </div>

      {/* 3. Filter Controls Card */}
      <div className="glass-card p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-xs space-y-4 bg-white/95 backdrop-blur-md">
        {/* Date Filter Selection */}
        <div className="flex items-center justify-between gap-2 flex-wrap border-b border-slate-100 pb-3">
          <div className="flex items-center gap-1.5 p-1 bg-slate-100/80 rounded-2xl border border-slate-200/60 flex-wrap">
            <button
              type="button"
              onClick={() => setFilterType("daily")}
              className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                filterType === "daily"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Daily</span>
            </button>
            <button
              type="button"
              onClick={() => setFilterType("monthly")}
              className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                filterType === "monthly"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>Monthly</span>
            </button>
            <button
              type="button"
              onClick={() => setFilterType("custom")}
              className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                filterType === "custom"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Custom Range</span>
            </button>
            <button
              type="button"
              onClick={() => setFilterType("all")}
              className={`tap-bounce px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                filterType === "all"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>All Time</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-500 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>IST</span>
            </span>
            <button
              type="button"
              onClick={resetFilters}
              className="text-[11px] font-bold text-slate-600 hover:text-rose-600 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <X className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        {/* Date Inputs based on Type */}
        {filterType === "daily" && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 max-w-xs">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                Select Date
              </label>
              <input
                type="date"
                value={dailyDate}
                onChange={(e) => setDailyDate(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <div className="flex items-center gap-2 sm:pt-5">
              <button
                type="button"
                onClick={() => setDailyDate(getTodayIST())}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                  dailyDate === getTodayIST()
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700 font-bold"
                    : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => setDailyDate(getYesterdayIST())}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                  dailyDate === getYesterdayIST()
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700 font-bold"
                    : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                Yesterday
              </button>
            </div>
          </div>
        )}

        {filterType === "monthly" && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 max-w-xs">
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                Select Month &amp; Year
              </label>
              <input
                type="month"
                value={monthlyDate}
                onChange={(e) => setMonthlyDate(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              />
            </div>
            <div className="flex items-center gap-2 sm:pt-5">
              <button
                type="button"
                onClick={() => setMonthlyDate(getCurrentMonthIST())}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                  monthlyDate === getCurrentMonthIST()
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700 font-bold"
                    : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                Current Month
              </button>
            </div>
          </div>
        )}

        {filterType === "custom" && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md">
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                  Start Date
                </label>
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                  End Date
                </label>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                />
              </div>
            </div>
            {dateValidationError && (
              <div className="flex items-center gap-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold max-w-md">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{dateValidationError}</span>
              </div>
            )}
          </div>
        )}

        {/* Multi-Dimensional Filter Dropdowns */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 pt-2 border-t border-slate-100">
          {/* Teacher Selector */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Faculty
            </label>
            <select
              value={selectedTeacher}
              onChange={(e) => setSelectedTeacher(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50/60 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            >
              <option value="">All Faculty</option>
              {teachersList.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* Batch Selector */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Batch
            </label>
            <select
              value={selectedBatch}
              onChange={(e) => setSelectedBatch(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50/60 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            >
              <option value="">All Batches</option>
              {batchesList.map((b) => (
                <option key={b._id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          {/* Fee Payment Status */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Fee Status
            </label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50/60 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            >
              <option value="">All Statuses</option>
              <option value="Paid">Paid</option>
              <option value="Partial Paid">Partial Paid</option>
              <option value="Pending">Pending</option>
            </select>
          </div>

          {/* Handover Status */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Handover Status
            </label>
            <select
              value={selectedHandoverStatus}
              onChange={(e) => setSelectedHandoverStatus(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50/60 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            >
              <option value="">All Handovers</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="partially_approved">Partially Approved</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {/* Student Search */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Search Student
            </label>
            <div className="relative">
              <input
                type="text"
                placeholder="Student / Parent..."
                value={searchStudent}
                onChange={(e) => setSearchStudent(e.target.value)}
                className="w-full pl-7 pr-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50/60 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-2" />
            </div>
          </div>
        </div>
      </div>

      {/* 4. API Error Banner */}
      {error && (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200/90 text-rose-800 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <span className="font-bold">Failed to load financial report:</span> {error}
          </div>
          <button
            onClick={() => fetchReport(true)}
            className="text-xs font-bold text-rose-700 underline hover:text-rose-900"
          >
            Retry
          </button>
        </div>
      )}

      {/* 5. Loading Skeleton */}
      {loading ? (
        <div className="space-y-4 animate-pulse">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-28 rounded-3xl bg-slate-200/80" />
            ))}
          </div>
          <div className="h-64 rounded-3xl bg-slate-200/80" />
        </div>
      ) : (
        <>
          {/* 6. Summary KPI Cards (6 Key Financial Metrics) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {/* Card 1: Total Parent Collections */}
            <div className="p-5 rounded-3xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-md shadow-emerald-700/20 relative overflow-hidden">
              <div className="absolute right-3 -bottom-3 text-emerald-500/20 pointer-events-none">
                <IndianRupee className="w-24 h-24 stroke-[1.2]" />
              </div>
              <div className="relative z-10">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-100">
                    Total Parent Collections
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/20 text-white">
                    Revenue
                  </span>
                </div>
                <div className="text-2xl sm:text-3xl font-black mt-2 tracking-tight">
                  ₹{(kpis?.totalParentCollections ?? 0).toLocaleString("en-IN")}
                </div>
                <p className="text-[11px] text-emerald-100/90 font-medium mt-1">
                  Tuition payments received across all modes
                </p>
              </div>
            </div>

            {/* Card 2: Verified Cash in Safe */}
            <div className="p-5 rounded-3xl bg-white border border-slate-200/90 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Verified Cash in Safe
                </span>
                <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <ShieldCheck className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <span className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight text-emerald-700">
                  ₹{(kpis?.verifiedCashReceived ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium mt-1">
                Physically received &amp; verified into institute custody
              </p>
            </div>

            {/* Card 3: Faculty In-Hand Cash */}
            <div className="p-5 rounded-3xl bg-white border border-slate-200/90 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">
                  Faculty In-Hand Cash
                </span>
                <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                  <CreditCard className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <span className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight text-amber-600">
                  ₹{(kpis?.teacherHeldCash ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium mt-1">
                Provisional collections held by faculty awaiting handover
              </p>
            </div>

            {/* Card 4: Pending Owner Verification */}
            <div className="p-5 rounded-3xl bg-white border border-slate-200/90 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">
                  Pending Verification
                </span>
                <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <Clock className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <span className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight text-blue-600">
                  ₹{(kpis?.pendingVerificationCash ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium mt-1">
                Submitted in handovers awaiting Owner sign-off
              </p>
            </div>

            {/* Card 5: Outstanding Student Fee Balance */}
            <div className="p-5 rounded-3xl bg-white border border-slate-200/90 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-rose-500 uppercase tracking-wider">
                  Outstanding Student Dues
                </span>
                <div className="w-8 h-8 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center">
                  <AlertCircle className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <span className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight text-rose-600">
                  ₹{(kpis?.outstandingFeeBalance ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium mt-1">
                Unpaid student tuition across active invoices
              </p>
            </div>

            {/* Card 6: Active Discrepancies / Disputed Amounts */}
            <div className="p-5 rounded-3xl bg-white border border-slate-200/90 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-purple-600 uppercase tracking-wider">
                  Active Discrepancies
                </span>
                <div className="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-2">
                <span className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight text-purple-600">
                  ₹{(kpis?.activeDiscrepancies ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium mt-1">
                Shortages &amp; disputed items in handover reconciliation
              </p>
            </div>
          </div>

          {/* 7. Report Navigation Tabs */}
          <div className="border-b border-slate-200">
            <nav className="flex space-x-4 sm:space-x-8 overflow-x-auto pb-1" aria-label="Reports">
              <button
                type="button"
                onClick={() => setActiveTab("teachers")}
                className={`py-3 px-1 border-b-2 font-bold text-xs whitespace-nowrap flex items-center gap-2 transition-all ${
                  activeTab === "teachers"
                    ? "border-emerald-600 text-emerald-700"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                }`}
              >
                <Users className="w-4 h-4" />
                <span>Faculty Collections</span>
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">
                  {teacherReports.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("batches")}
                className={`py-3 px-1 border-b-2 font-bold text-xs whitespace-nowrap flex items-center gap-2 transition-all ${
                  activeTab === "batches"
                    ? "border-emerald-600 text-emerald-700"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                }`}
              >
                <GraduationCap className="w-4 h-4" />
                <span>Batch Analytics</span>
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">
                  {batchReports.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("students")}
                className={`py-3 px-1 border-b-2 font-bold text-xs whitespace-nowrap flex items-center gap-2 transition-all ${
                  activeTab === "students"
                    ? "border-emerald-600 text-emerald-700"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                }`}
              >
                <FileText className="w-4 h-4" />
                <span>Student Fee Ledger</span>
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">
                  {studentLedger.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("handovers")}
                className={`py-3 px-1 border-b-2 font-bold text-xs whitespace-nowrap flex items-center gap-2 transition-all ${
                  activeTab === "handovers"
                    ? "border-emerald-600 text-emerald-700"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>Cash Handover Audit</span>
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">
                  {handoverReports.length}
                </span>
              </button>
            </nav>
          </div>

          {/* 8. Active Tab Content Views */}

          {/* TAB 1: TEACHER / FACULTY COLLECTIONS */}
          {activeTab === "teachers" && (
            <div className="space-y-4">
              <div className="glass-card rounded-3xl border border-slate-200/90 overflow-hidden shadow-xs bg-white">
                <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Faculty-Wise Collection &amp; Custody</h3>
                    <p className="text-xs text-slate-500 font-medium mt-0.5">
                      Breakdown of funds collected from parents, provisional cash held, and verified amounts.
                    </p>
                  </div>
                  <span className="text-xs font-bold text-slate-600 bg-slate-50 px-2.5 py-1 rounded-xl border border-slate-200">
                    {periodLabel}
                  </span>
                </div>

                {teacherReports.length === 0 ? (
                  <div className="p-10 text-center text-slate-500 text-xs">
                    No faculty collection records found matching selected filters.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50/80 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                        <tr>
                          <th className="px-4 py-3">Faculty / Collector</th>
                          <th className="px-4 py-3 text-right">Total Parent Collections</th>
                          <th className="px-4 py-3 text-right">In-Hand Cash</th>
                          <th className="px-4 py-3 text-right">Pending Verification</th>
                          <th className="px-4 py-3 text-right">Verified in Safe</th>
                          <th className="px-4 py-3 text-right">Active Shortages</th>
                          <th className="px-4 py-3 text-center">Receipts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                        {teacherReports.map((row) => (
                          <tr key={row.teacherId} className="hover:bg-slate-50/60 transition-colors">
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-2.5">
                                <div
                                  className={`w-8 h-8 rounded-xl flex items-center justify-center text-[10px] font-black border flex-shrink-0 ${getAvatarColor(
                                    row.teacherName
                                  )}`}
                                >
                                  {getInitials(row.teacherName)}
                                </div>
                                <div>
                                  <div className="font-bold text-slate-900">{row.teacherName}</div>
                                  <div className="text-[10px] text-slate-400">ID: {row.teacherId.slice(-6)}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3.5 text-right font-black text-slate-900">
                              ₹{(row.totalCollected ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-amber-600">
                              ₹{(row.teacherInHandAmount ?? row.cashInHand ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-blue-600">
                              ₹{(row.ownerPendingAmount ?? row.cashSubmitted ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-emerald-700">
                              ₹{(row.ownerVerifiedAmount ?? row.cashVerified ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-purple-600">
                              ₹{(row.activeDiscrepancies ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-center text-slate-500">
                              <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[11px] font-bold">
                                {row.transactionCount ?? 0}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50/90 font-bold text-slate-900 border-t border-slate-200">
                        <tr>
                          <td className="px-4 py-3">Totals</td>
                          <td className="px-4 py-3 text-right">
                            ₹{teacherReports.reduce((sum, r) => sum + (r.totalCollected ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-amber-700">
                            ₹{teacherReports.reduce((sum, r) => sum + (r.teacherInHandAmount ?? r.cashInHand ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-blue-700">
                            ₹{teacherReports.reduce((sum, r) => sum + (r.ownerPendingAmount ?? r.cashSubmitted ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-emerald-800">
                            ₹{teacherReports.reduce((sum, r) => sum + (r.ownerVerifiedAmount ?? r.cashVerified ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-purple-700">
                            ₹{teacherReports.reduce((sum, r) => sum + (r.activeDiscrepancies ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {teacherReports.reduce((sum, r) => sum + (r.transactionCount ?? 0), 0)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: BATCH ANALYTICS */}
          {activeTab === "batches" && (
            <div className="space-y-4">
              <div className="glass-card rounded-3xl border border-slate-200/90 overflow-hidden shadow-xs bg-white">
                <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Batch-Wise Revenue &amp; Recovery Rate</h3>
                    <p className="text-xs text-slate-500 font-medium mt-0.5">
                      Collection rates, invoiced amounts, and pending student balances by batch.
                    </p>
                  </div>
                  <span className="text-xs font-bold text-slate-600 bg-slate-50 px-2.5 py-1 rounded-xl border border-slate-200">
                    {periodLabel}
                  </span>
                </div>

                {batchReports.length === 0 ? (
                  <div className="p-10 text-center text-slate-500 text-xs">
                    No batch analytics records found matching selected filters.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50/80 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                        <tr>
                          <th className="px-4 py-3">Batch Name</th>
                          <th className="px-4 py-3 text-center">Students</th>
                          <th className="px-4 py-3 text-right">Invoiced (INR)</th>
                          <th className="px-4 py-3 text-right">Collected (INR)</th>
                          <th className="px-4 py-3 text-right">Outstanding (INR)</th>
                          <th className="px-4 py-3 text-center">Partial Payments</th>
                          <th className="px-4 py-3 text-right">Collection Rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                        {batchReports.map((row) => (
                          <tr key={row.batchName} className="hover:bg-slate-50/60 transition-colors">
                            <td className="px-4 py-3.5 font-bold text-slate-900 flex items-center gap-2">
                              <GraduationCap className="w-4 h-4 text-emerald-600" />
                              <span>{row.batchName}</span>
                            </td>
                            <td className="px-4 py-3.5 text-center text-slate-600">{row.studentCount ?? 0}</td>
                            <td className="px-4 py-3.5 text-right font-medium text-slate-800">
                              ₹{(row.totalInvoiced ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-emerald-700">
                              ₹{(row.totalCollected ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-rose-600">
                              ₹{(row.outstandingBalance ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-center">
                              {(row.partialPaymentCount ?? 0) > 0 ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                                  {row.partialPaymentCount} partial
                                </span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <span className="font-black text-slate-900">{row.collectionRate ?? row.collectionRatePercent ?? 0}%</span>
                                <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden hidden sm:block">
                                  <div
                                    className={`h-full rounded-full ${
                                      (row.collectionRate ?? row.collectionRatePercent ?? 0) >= 80
                                        ? "bg-emerald-500"
                                        : (row.collectionRate ?? row.collectionRatePercent ?? 0) >= 50
                                        ? "bg-amber-500"
                                        : "bg-rose-500"
                                    }`}
                                    style={{ width: `${Math.min(100, Math.max(0, row.collectionRate ?? row.collectionRatePercent ?? 0))}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50/90 font-bold text-slate-900 border-t border-slate-200">
                        <tr>
                          <td className="px-4 py-3">Totals</td>
                          <td className="px-4 py-3 text-center">
                            {batchReports.reduce((sum, b) => sum + (b.studentCount ?? 0), 0)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            ₹{batchReports.reduce((sum, b) => sum + (b.totalInvoiced ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-emerald-800">
                            ₹{batchReports.reduce((sum, b) => sum + (b.totalCollected ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-rose-700">
                            ₹{batchReports.reduce((sum, b) => sum + (b.outstandingBalance ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {batchReports.reduce((sum, b) => sum + (b.partialPaymentCount ?? 0), 0)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {(() => {
                              const totalInv = batchReports.reduce((s, b) => s + (b.totalInvoiced ?? 0), 0);
                              const totalCol = batchReports.reduce((s, b) => s + (b.totalCollected ?? 0), 0);
                              return totalInv > 0 ? `${Math.round((totalCol / totalInv) * 100)}%` : "0%";
                            })()}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: STUDENT FEE LEDGER */}
          {activeTab === "students" && (
            <div className="space-y-4">
              <div className="glass-card rounded-3xl border border-slate-200/90 overflow-hidden shadow-xs bg-white">
                <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Student Fee Ledger &amp; Payment History</h3>
                    <p className="text-xs text-slate-500 font-medium mt-0.5">
                      Itemized breakdown of student invoices, payment vouchers, collector attribution &amp; custody status.
                    </p>
                  </div>
                  <span className="text-xs font-bold text-slate-600 bg-slate-50 px-2.5 py-1 rounded-xl border border-slate-200">
                    {studentLedger.length} Records
                  </span>
                </div>

                {studentLedger.length === 0 ? (
                  <div className="p-10 text-center text-slate-500 text-xs">
                    No student fee records found matching selected filters.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {studentLedger.map((row) => {
                      const isExpanded = !!expandedStudents[row.feeId];

                      return (
                        <div key={row.feeId} className="transition-colors hover:bg-slate-50/40">
                          {/* Student Summary Row */}
                          <div
                            onClick={() => toggleStudentExpanded(row.feeId)}
                            className="p-4 flex items-center justify-between gap-3 cursor-pointer select-none"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <button
                                type="button"
                                className="w-6 h-6 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center flex-shrink-0"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <div
                                className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black border flex-shrink-0 ${getAvatarColor(
                                  row.studentName
                                )}`}
                              >
                                {getInitials(row.studentName)}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h4 className="text-xs sm:text-sm font-bold text-slate-900 truncate">
                                    {row.studentName}
                                  </h4>
                                  <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700">
                                    {row.batchName}
                                  </span>
                                  {row.month && (
                                    <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-slate-50 text-slate-500">
                                      {row.month}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  Parent: <span className="font-semibold text-slate-700">{row.parentName}</span>
                                  {row.parentPhone && <span className="ml-1.5 text-slate-400">({row.parentPhone})</span>}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-4 flex-shrink-0 text-right">
                              <div className="hidden sm:block">
                                <div className="text-[10px] font-bold text-slate-400 uppercase">Paid / Invoiced</div>
                                <div className="text-xs font-bold text-slate-900">
                                  ₹{(row.paidAmount ?? 0).toLocaleString("en-IN")} / ₹{(row.amountDue ?? 0).toLocaleString("en-IN")}
                                </div>
                              </div>

                              <div>
                                <div className="text-[10px] font-bold text-slate-400 uppercase">Balance</div>
                                <div
                                  className={`text-xs font-black ${
                                    (row.outstandingBalance ?? 0) > 0 ? "text-rose-600" : "text-emerald-700"
                                  }`}
                                >
                                  ₹{(row.outstandingBalance ?? 0).toLocaleString("en-IN")}
                                </div>
                              </div>

                              <span
                                className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase border ${
                                  row.feeStatus === "Paid"
                                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                    : row.feeStatus === "Partial Paid"
                                    ? "bg-amber-50 text-amber-800 border-amber-200"
                                    : "bg-rose-50 text-rose-800 border-rose-200"
                                }`}
                              >
                                {row.feeStatus}
                              </span>
                            </div>
                          </div>

                          {/* Expanded Itemized Payments */}
                          {isExpanded && (
                            <div className="px-4 pb-4 pt-1 bg-slate-50/60 border-t border-slate-100 space-y-2">
                              <div className="text-[11px] font-bold text-slate-600 uppercase tracking-wider flex items-center justify-between">
                                <span>Itemized Payment History &amp; Physical Custody</span>
                                <span>{row.payments.length} Transaction(s)</span>
                              </div>

                              {row.payments.length === 0 ? (
                                <div className="text-xs text-slate-500 italic py-2">
                                  No payments have been recorded for this fee invoice yet.
                                </div>
                              ) : (
                                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                                  <table className="w-full text-left text-xs">
                                    <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                                      <tr>
                                        <th className="px-3 py-2">Date</th>
                                        <th className="px-3 py-2">Amount</th>
                                        <th className="px-3 py-2">Mode</th>
                                        <th className="px-3 py-2">Receipt Voucher</th>
                                        <th className="px-3 py-2">Collected By</th>
                                        <th className="px-3 py-2">Custody Status</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 text-slate-700 font-medium">
                                      {row.payments.map((p) => (
                                        <tr key={p.paymentId} className="hover:bg-slate-50/40">
                                          <td className="px-3 py-2 text-slate-600">
                                            {formatReadableDate(p.paymentDate)}
                                          </td>
                                          <td className="px-3 py-2 font-black text-slate-900">
                                            ₹{(p.amount ?? 0).toLocaleString("en-IN")}
                                          </td>
                                          <td className="px-3 py-2 capitalize">
                                            <span className="px-2 py-0.5 rounded-md bg-slate-100 font-semibold text-[11px]">
                                              {p.paymentMode}
                                            </span>
                                          </td>
                                          <td className="px-3 py-2 font-mono text-[11px] font-semibold text-slate-800">
                                            {p.receiptNumber}
                                          </td>
                                          <td className="px-3 py-2">
                                            <div className="flex items-center gap-1.5">
                                              <span className="font-semibold">{p.receivedByName}</span>
                                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 uppercase font-bold">
                                                {p.receivedByRole}
                                              </span>
                                            </div>
                                          </td>
                                          <td className="px-3 py-2">
                                            <span
                                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                                                p.isOwnerVerified
                                                  ? "bg-emerald-100 text-emerald-800"
                                                  : p.receivedByRole === "teacher"
                                                  ? "bg-amber-100 text-amber-800"
                                                  : "bg-blue-100 text-blue-800"
                                              }`}
                                            >
                                              {p.isOwnerVerified && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
                                              <span>{p.custodyLabel}</span>
                                            </span>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: HANDOVER AUDIT */}
          {activeTab === "handovers" && (
            <div className="space-y-4">
              <div className="glass-card rounded-3xl border border-slate-200/90 overflow-hidden shadow-xs bg-white">
                <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Cash Handover Audit Trail</h3>
                    <p className="text-xs text-slate-500 font-medium mt-0.5">
                      Complete log of teacher envelopes, approved cash, shortages, and dispute status.
                    </p>
                  </div>
                  <Link
                    href="/fees?tab=handovers"
                    className="tap-bounce text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200/80 flex items-center gap-1.5 transition-all"
                  >
                    <span>Open Handover Console</span>
                    <ArrowLeft className="w-3 h-3 rotate-180" />
                  </Link>
                </div>

                {handoverReports.length === 0 ? (
                  <div className="p-10 text-center text-slate-500 text-xs">
                    No cash handover envelopes found matching selected filters.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50/80 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                        <tr>
                          <th className="px-4 py-3">Handover #</th>
                          <th className="px-4 py-3">Faculty</th>
                          <th className="px-4 py-3">Submitted Date</th>
                          <th className="px-4 py-3 text-right">Submitted (INR)</th>
                          <th className="px-4 py-3 text-right">Verified (INR)</th>
                          <th className="px-4 py-3 text-right">Discrepancy</th>
                          <th className="px-4 py-3 text-center">Status</th>
                          <th className="px-4 py-3 text-center">Dispute Status</th>
                          <th className="px-4 py-3 text-center">Items</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                        {handoverReports.map((row) => (
                          <tr key={row.handoverId} className="hover:bg-slate-50/60 transition-colors">
                            <td className="px-4 py-3.5 font-mono font-bold text-slate-900">
                              {row.handoverNumber}
                            </td>
                            <td className="px-4 py-3.5 font-bold text-slate-800">{row.teacherName}</td>
                            <td className="px-4 py-3.5 text-slate-500">
                              {formatReadableDate(row.submittedAt)}
                            </td>
                            <td className="px-4 py-3.5 text-right font-black text-slate-900">
                              ₹{(row.submittedAmount ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold text-emerald-700">
                              ₹{(row.approvedAmount ?? 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-3.5 text-right">
                              {(row.discrepancyAmount ?? 0) > 0 ? (
                                <div>
                                  <span className="font-bold text-purple-600">
                                    ₹{(row.remainingDiscrepancy ?? 0).toLocaleString("en-IN")}
                                  </span>
                                  {(row.remainingDiscrepancy ?? 0) < (row.discrepancyAmount ?? 0) && (
                                    <div className="text-[10px] text-slate-400 line-through">
                                      ₹{(row.discrepancyAmount ?? 0).toLocaleString("en-IN")}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 text-center">
                              <span
                                className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase border ${
                                  row.status === "approved"
                                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                    : row.status === "partially_approved"
                                    ? "bg-amber-50 text-amber-800 border-amber-200"
                                    : row.status === "rejected"
                                    ? "bg-rose-50 text-rose-800 border-rose-200"
                                    : "bg-blue-50 text-blue-800 border-blue-200"
                                }`}
                              >
                                {row.status.replace("_", " ")}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-center">
                              <span
                                className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                                  row.discrepancyStatus === "resolved"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : row.discrepancyStatus === "disputed"
                                    ? "bg-purple-100 text-purple-800"
                                    : row.discrepancyStatus === "shortage_confirmed"
                                    ? "bg-rose-100 text-rose-800"
                                    : "bg-slate-100 text-slate-600"
                                }`}
                              >
                                {row.discrepancyStatus.replace("_", " ")}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-center text-slate-500 font-semibold">
                              {row.itemCount ?? 0}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50/90 font-bold text-slate-900 border-t border-slate-200">
                        <tr>
                          <td className="px-4 py-3" colSpan={3}>
                            Totals
                          </td>
                          <td className="px-4 py-3 text-right">
                            ₹{handoverReports.reduce((s, h) => s + (h.submittedAmount ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-emerald-800">
                            ₹{handoverReports.reduce((s, h) => s + (h.approvedAmount ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3 text-right text-purple-700">
                            ₹{handoverReports.reduce((s, h) => s + (h.remainingDiscrepancy ?? 0), 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-4 py-3" colSpan={3}></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
