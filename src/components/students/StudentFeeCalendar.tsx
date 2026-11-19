"use client";

import { useState, useEffect } from "react";
import {
  Calendar,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
  AlertTriangle,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";

export interface FeeCalendarSummary {
  totalDue: number;
  advanceBalance: number;
  nextBillingDate: string;
  monthlyFee: number;
  dueDay: number;
  admissionDate: string | null;
}

export type FeeCalendarMonthStatus =
  | "paid"
  | "partial"
  | "due"
  | "advance"
  | "upcoming"
  | "pre_admission";

export interface FeeCalendarMonth {
  month: number;
  label: string;
  billingDate: string;
  status: FeeCalendarMonthStatus;
  amountInvoiced: number;
  amountPaid: number;
  amountDue: number;
  paidDate: string | null;
  paymentMode: string | null;
  feeId: string | null;
}

export interface FeeCalendarData {
  studentId: string;
  year: number;
  summary: FeeCalendarSummary;
  months: FeeCalendarMonth[];
}

interface StudentFeeCalendarProps {
  studentId: string;
}

function formatDisplayDate(dateInput?: string | Date | null): string {
  if (!dateInput) return "—";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function getDayOrdinal(day: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = day % 100;
  return day + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function StudentFeeCalendar({ studentId }: StudentFeeCalendarProps) {
  const [selectedYear, setSelectedYear] = useState<number>(() =>
    new Date().getFullYear()
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [calendarData, setCalendarData] = useState<FeeCalendarData | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<FeeCalendarMonth | null>(
    null
  );
  const [refreshCount, setRefreshCount] = useState<number>(0);

  useEffect(() => {
    const onRefresh = (e: Event) => {
      const customEvent = e as CustomEvent<{ studentId?: string }>;
      if (!customEvent.detail?.studentId || customEvent.detail.studentId === studentId) {
        setRefreshCount((prev) => prev + 1);
      }
    };

    window.addEventListener("msec:fee-summary-refresh", onRefresh);
    window.addEventListener("msec:collection-recorded", onRefresh);

    return () => {
      window.removeEventListener("msec:fee-summary-refresh", onRefresh);
      window.removeEventListener("msec:collection-recorded", onRefresh);
    };
  }, [studentId]);

  useEffect(() => {
    let ignore = false;
    if (!studentId) return;

    apiClient<FeeCalendarData>(
      `/students/${studentId}/fee-summary?year=${selectedYear}&_rc=${refreshCount}`
    )
      .then((res) => {
        if (!ignore && res.data) {
          setCalendarData(res.data);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          const msg =
            err instanceof Error ? err.message : "Failed to load fee calendar";
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [studentId, selectedYear, refreshCount]);

  const handleYearChange = (delta: number) => {
    setLoading(true);
    setSelectedYear((prev) => prev + delta);
    setSelectedMonth(null);
  };

  const handleRetry = () => {
    setLoading(true);
    setError(null);
    apiClient<FeeCalendarData>(
      `/students/${studentId}/fee-summary?year=${selectedYear}`
    )
      .then((res) => {
        if (res.data) {
          setCalendarData(res.data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "Failed to load fee calendar";
        setError(msg);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const handleCardClick = (month: FeeCalendarMonth) => {
    if (month.status === "pre_admission" || month.status === "upcoming") {
      return;
    }
    if (selectedMonth?.month === month.month) {
      setSelectedMonth(null);
    } else {
      setSelectedMonth(month);
    }
  };

  const summary = calendarData?.summary;
  const months = calendarData?.months || [];

  // Guarantee strict consistency between the top TOTAL DUE box and the monthly calendar cells
  const calendarDueSum = months
    .filter((m) => m.status === "due" || m.status === "partial")
    .reduce((sum, m) => sum + (Number(m.amountDue) || 0), 0);
  const effectiveTotalDue = Math.max(summary?.totalDue || 0, calendarDueSum);

  return (
    <div className="rounded-3xl border border-slate-200/90 bg-white p-4 sm:p-5 shadow-xs space-y-4">
      {/* Section Header with Title and Year Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-base font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <Calendar className="w-5 h-5 text-blue-600 stroke-[2.3]" />
            <span>Fee Calendar</span>
          </h2>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            12-month visual payment &amp; fee obligation history
          </p>
        </div>

        {/* Compact Year Switcher */}
        <div className="flex items-center gap-1.5 self-start sm:self-auto bg-slate-100 p-1 rounded-xl">
          <button
            type="button"
            onClick={() => handleYearChange(-1)}
            disabled={loading}
            aria-label="Previous Year"
            className="tap-bounce p-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-white transition-all disabled:opacity-50 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2.5 py-0.5 text-xs font-black font-mono text-slate-800">
            {selectedYear}
          </span>
          <button
            type="button"
            onClick={() => handleYearChange(1)}
            disabled={loading}
            aria-label="Next Year"
            className="tap-bounce p-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-white transition-all disabled:opacity-50 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Loading Skeleton */}
      {loading ? (
        <div className="py-12 text-center space-y-3">
          <Loader2 className="w-7 h-7 text-blue-600 animate-spin mx-auto" />
          <p className="text-xs font-semibold text-slate-500">
            Loading 12-month fee calendar...
          </p>
        </div>
      ) : error ? (
        /* Error State */
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={handleRetry}
            className="tap-bounce px-3 py-1 text-xs font-bold bg-white text-rose-700 border border-rose-300 rounded-lg shadow-2xs hover:bg-rose-50 cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Top Clear Picture Header: 3 Compact KPI Cards */}
          {summary && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
              {/* Card 1: Total Due */}
              <div
                className={`rounded-2xl p-3.5 border shadow-2xs transition-all ${
                  effectiveTotalDue > 0
                    ? "bg-rose-50/70 border-rose-200/90 text-rose-900"
                    : "bg-emerald-50/70 border-emerald-200/90 text-emerald-900"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] font-extrabold uppercase tracking-wider opacity-80 mb-1">
                  <span>Total Due</span>
                  {effectiveTotalDue > 0 ? (
                    <AlertCircle className="w-4 h-4 text-rose-600" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  )}
                </div>
                <div className="text-xl sm:text-2xl font-black font-mono">
                  {effectiveTotalDue > 0 ? (
                    `₹${effectiveTotalDue.toLocaleString("en-IN")}`
                  ) : (
                    <span className="text-emerald-700 text-lg sm:text-xl">
                      ₹0 • Cleared
                    </span>
                  )}
                </div>
                <p className="text-[10px] opacity-75 mt-0.5 truncate">
                  {effectiveTotalDue > 0
                    ? "Outstanding fee obligations"
                    : "All dues fully settled"}
                </p>
              </div>

              {/* Card 2: Advance Balance */}
              <div
                className={`rounded-2xl p-3.5 border shadow-2xs transition-all ${
                  summary.advanceBalance > 0
                    ? "bg-blue-50/70 border-blue-200/90 text-blue-900"
                    : "bg-slate-50 border-slate-200 text-slate-700"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] font-extrabold uppercase tracking-wider opacity-80 mb-1">
                  <span>Advance Balance</span>
                  <Sparkles
                    className={`w-4 h-4 ${
                      summary.advanceBalance > 0
                        ? "text-blue-600"
                        : "text-slate-400"
                    }`}
                  />
                </div>
                <div className="text-xl sm:text-2xl font-black font-mono">
                  ₹{summary.advanceBalance.toLocaleString("en-IN")}
                </div>
                <p className="text-[10px] opacity-75 mt-0.5 truncate">
                  {summary.advanceBalance > 0
                    ? "Available wallet credit"
                    : "Zero advance on account"}
                </p>
              </div>

              {/* Card 3: Next Billing Date */}
              <div className="rounded-2xl p-3.5 border border-slate-200 bg-slate-50/60 text-slate-800 shadow-2xs">
                <div className="flex items-center justify-between text-[11px] font-extrabold uppercase tracking-wider text-slate-500 mb-1">
                  <span>Next Billing Date</span>
                  <Clock className="w-4 h-4 text-slate-400" />
                </div>
                <div className="text-sm sm:text-base font-black font-mono text-slate-900 truncate">
                  {formatDisplayDate(summary.nextBillingDate)}
                </div>
                <p className="text-[10.5px] font-semibold text-slate-500 mt-0.5 truncate">
                  Monthly Fee: ₹{summary.monthlyFee.toLocaleString("en-IN")} • Due{" "}
                  {getDayOrdinal(summary.dueDay)}
                </p>
              </div>
            </div>
          )}

          {/* 12-Month Visual Fee Grid */}
          <div className="space-y-2">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 sm:gap-2.5">
              {months.map((m) => {
                const isSelected = selectedMonth?.month === m.month;
                const isClickable =
                  m.status !== "pre_admission" && m.status !== "upcoming";

                let cardStyle =
                  "border-slate-200 bg-white hover:border-slate-300";
                let badgeNode = null;

                switch (m.status) {
                  case "paid":
                    cardStyle =
                      "border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50/70";
                    badgeNode = (
                      <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                        <span className="font-mono">
                          ₹{m.amountPaid.toLocaleString("en-IN")}
                        </span>
                      </div>
                    );
                    break;
                  case "partial":
                    cardStyle =
                      "border-amber-200 bg-amber-50/40 hover:bg-amber-50/70";
                    badgeNode = (
                      <div className="flex items-center gap-1 text-[11px] font-bold text-amber-800">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                        <span className="font-mono">
                          Due ₹{m.amountDue.toLocaleString("en-IN")}
                        </span>
                      </div>
                    );
                    break;
                  case "due":
                    cardStyle =
                      "border-rose-200 bg-rose-50/40 hover:bg-rose-50/70";
                    badgeNode = (
                      <div className="flex items-center gap-1 text-[11px] font-bold text-rose-700">
                        <AlertCircle className="w-3.5 h-3.5 text-rose-600 flex-shrink-0" />
                        <span className="font-mono">
                          Due ₹{m.amountDue.toLocaleString("en-IN")}
                        </span>
                      </div>
                    );
                    break;
                  case "advance":
                    cardStyle =
                      "border-blue-200 bg-blue-50/40 hover:bg-blue-50/70";
                    badgeNode = (
                      <div className="flex items-center gap-1 text-[11px] font-bold text-blue-700">
                        <Sparkles className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                        <span>Advance</span>
                      </div>
                    );
                    break;
                  case "upcoming":
                    cardStyle = "border-slate-200 bg-slate-50/40 text-slate-400";
                    badgeNode = (
                      <div className="flex items-center gap-1 text-[10.5px] font-medium text-slate-400">
                        <Clock className="w-3 h-3 text-slate-400 flex-shrink-0" />
                        <span>Upcoming</span>
                      </div>
                    );
                    break;
                  case "pre_admission":
                    cardStyle =
                      "border-slate-100 bg-slate-50/20 text-slate-300 opacity-60 cursor-not-allowed";
                    badgeNode = (
                      <span className="text-xs text-slate-300 font-bold tracking-widest">
                        —
                      </span>
                    );
                    break;
                }

                return (
                  <button
                    key={m.month}
                    type="button"
                    onClick={() => handleCardClick(m)}
                    disabled={!isClickable}
                    className={`tap-bounce rounded-2xl border p-2.5 sm:p-3 text-left transition-all relative flex flex-col justify-between min-h-[72px] sm:min-h-[82px] ${cardStyle} ${
                      isSelected
                        ? "ring-2 ring-blue-500 border-transparent shadow-xs"
                        : ""
                    } ${isClickable ? "cursor-pointer" : "cursor-default"}`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-xs sm:text-sm font-black text-slate-900">
                        {m.label}
                      </span>
                      {summary?.dueDay && m.status !== "pre_admission" && (
                        <span className="text-[10px] font-semibold text-slate-400">
                          Due {getDayOrdinal(summary.dueDay)}
                        </span>
                      )}
                    </div>

                    <div className="mt-1.5">{badgeNode}</div>
                  </button>
                );
              })}
            </div>

            {/* Interactive Detail Strip */}
            {selectedMonth && (
              <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-3.5 sm:p-4 animate-fade-in space-y-2.5">
                <div className="flex items-center justify-between border-b border-blue-100 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black uppercase tracking-wider text-blue-900">
                      {selectedMonth.label} {selectedYear} Fee Details
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-white border border-blue-200 text-blue-700">
                      {selectedMonth.status}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedMonth(null)}
                    className="p-1 rounded-lg text-blue-600 hover:text-blue-900 hover:bg-blue-100/50 cursor-pointer"
                    aria-label="Close details"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
                  <div className="rounded-xl bg-white p-2 border border-blue-100/80">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase">
                      Billing Date
                    </span>
                    <span className="font-bold text-slate-800 font-mono text-[11px] block mt-0.5">
                      {formatDisplayDate(selectedMonth.billingDate)}
                    </span>
                  </div>

                  <div className="rounded-xl bg-white p-2 border border-blue-100/80">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase">
                      Amount Invoiced
                    </span>
                    <span className="font-bold text-slate-900 font-mono text-[11px] block mt-0.5">
                      ₹{selectedMonth.amountInvoiced.toLocaleString("en-IN")}
                    </span>
                  </div>

                  <div className="rounded-xl bg-white p-2 border border-blue-100/80">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase">
                      Amount Paid
                    </span>
                    <span className="font-bold text-emerald-700 font-mono text-[11px] block mt-0.5">
                      ₹{selectedMonth.amountPaid.toLocaleString("en-IN")}
                    </span>
                  </div>

                  <div className="rounded-xl bg-white p-2 border border-blue-100/80">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase">
                      Balance Due
                    </span>
                    <span
                      className={`font-bold font-mono text-[11px] block mt-0.5 ${
                        selectedMonth.amountDue > 0
                          ? "text-rose-700"
                          : "text-slate-600"
                      }`}
                    >
                      ₹{selectedMonth.amountDue.toLocaleString("en-IN")}
                    </span>
                  </div>

                  <div className="rounded-xl bg-white p-2 border border-blue-100/80">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase">
                      Paid Date
                    </span>
                    <span className="font-bold text-slate-800 font-mono text-[11px] block mt-0.5">
                      {formatDisplayDate(selectedMonth.paidDate)}
                    </span>
                  </div>

                  <div className="rounded-xl bg-white p-2 border border-blue-100/80">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase">
                      Payment Mode
                    </span>
                    <span className="font-bold text-slate-800 text-[11px] block mt-0.5">
                      {selectedMonth.paymentMode || "—"}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
