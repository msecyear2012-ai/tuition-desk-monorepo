import { Calendar, ChevronDown, CheckCheck, Loader2 } from "lucide-react";
import { QuickBatchAttendance } from "@/types";

interface AttendanceHeaderProps {
  batches: QuickBatchAttendance[];
  selectedBatchId: string;
  onSelectBatch: (id: string) => void;
  selectedDate: string;
  selectedDateRaw?: string;
  onSelectDate?: (date: string) => void;
  presentCount: number;
  absentCount: number;
  unmarkedCount: number;
  onMarkAllPresent: () => void;
  loadingBatches?: boolean;
}

export default function AttendanceHeader({
  batches,
  selectedBatchId,
  onSelectBatch,
  selectedDate,
  selectedDateRaw,
  onSelectDate,
  presentCount,
  absentCount,
  unmarkedCount,
  onMarkAllPresent,
  loadingBatches = false,
}: AttendanceHeaderProps) {
  return (
    <div className="space-y-3 w-full max-w-full min-w-0 overflow-hidden">
      {/* Batch Selector & Date Picker Bar */}
      <div className="rounded-3xl border border-slate-100 bg-white p-4 shadow-sm space-y-3 w-full max-w-full min-w-0 overflow-hidden">
        {/* Top: Batch Selector Dropdown */}
        <div className="w-full max-w-full min-w-0 overflow-hidden">
          <label
            htmlFor="batch-selector"
            className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5"
          >
            Select Batch
          </label>
          <div className="relative w-full max-w-full min-w-0 overflow-hidden">
            <select
              id="batch-selector"
              value={selectedBatchId}
              onChange={(e) => onSelectBatch(e.target.value)}
              disabled={batches.length === 0 || loadingBatches}
              className="w-full max-w-full min-w-0 overflow-hidden text-ellipsis truncate appearance-none rounded-2xl border border-slate-200/90 bg-slate-50/70 px-3.5 py-2.5 pr-10 text-[13px] font-bold text-slate-800 shadow-2xs outline-none focus:border-[var(--primary-color)] focus:bg-white transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loadingBatches ? (
                <option value="" disabled>
                  Loading batches...
                </option>
              ) : batches.length === 0 ? (
                <option value="" disabled>
                  No batches available
                </option>
              ) : (
                batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.batchName} {batch.timeSlot ? `(${batch.timeSlot})` : ""}
                  </option>
                ))
              )}
            </select>
            <div className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500">
              {loadingBatches ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </div>
          </div>
        </div>

        {/* Date Row + Quick 'Mark All Present' CTA */}
        <div className="flex items-center justify-between pt-1 border-t border-slate-100 gap-2 w-full max-w-full min-w-0">
          <label
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 bg-slate-100/80 hover:bg-slate-200/80 px-2.5 py-1.5 rounded-xl border border-slate-200/60 transition-colors relative cursor-pointer group min-w-0 truncate"
            title="Click to change date"
          >
            <Calendar className="h-3.5 w-3.5 text-blue-600 group-hover:scale-110 transition-transform" />
            <span>{selectedDate}</span>
            {onSelectDate && (
              <input
                type="date"
                value={selectedDateRaw || ""}
                onChange={(e) => e.target.value && onSelectDate(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                aria-label="Select Attendance Date"
              />
            )}
          </label>

          <button
            type="button"
            onClick={onMarkAllPresent}
            disabled={batches.length === 0 || loadingBatches}
            className="tap-bounce shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/80 px-2.5 py-1.5 rounded-xl transition-colors shadow-2xs disabled:opacity-50 disabled:pointer-events-none"
          >
            <CheckCheck className="h-3.5 w-3.5 stroke-[2.5]" />
            Mark All Present
          </button>
        </div>
      </div>

      {/* Live Counter Badges Pill */}
      <div className="grid grid-cols-3 gap-2 w-full max-w-full">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-2.5 text-center shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 block">
            Present
          </span>
          <span className="text-lg font-extrabold text-emerald-700 font-mono">
            {presentCount}
          </span>
        </div>

        <div className="rounded-2xl border border-rose-100 bg-rose-50/70 p-2.5 text-center shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-rose-700 block">
            Absent
          </span>
          <span className="text-lg font-extrabold text-rose-700 font-mono">
            {absentCount}
          </span>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-2.5 text-center shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
            Unmarked
          </span>
          <span className="text-lg font-extrabold text-slate-700 font-mono">
            {unmarkedCount}
          </span>
        </div>
      </div>
    </div>
  );
}
