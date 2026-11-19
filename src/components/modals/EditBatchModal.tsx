"use client";

import { useState, useEffect, useMemo } from "react";
import {
  X,
  Layers,
  BookOpen,
  Clock,
  UserCheck,
  Loader2,
  AlertCircle,
  Info,
  Check,
} from "lucide-react";
import { apiClient, invalidateApiCache } from "@/lib/apiClient";
import { BatchRecord, TeacherRecord } from "@/types";

interface EditBatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: BatchRecord | null;
  teachers: TeacherRecord[];
  onSuccess: (updatedBatch: BatchRecord) => void;
}

const QUICK_TIMINGS = [
  "4:00 PM - 5:30 PM (Mon, Wed, Fri)",
  "5:30 PM - 7:00 PM (Tue, Thu, Sat)",
  "6:00 PM - 7:30 PM (Daily)",
  "9:00 AM - 11:00 AM (Weekend)",
];

export default function EditBatchModal({
  isOpen,
  onClose,
  batch,
  teachers,
  onSuccess,
}: EditBatchModalProps) {
  // Compute the initial teacher ID linked to this batch
  const initialTeacherId = useMemo(() => {
    if (!batch) return "";
    if (batch.assignedTeacherId) return String(batch.assignedTeacherId);
    const teacherWithBatch = teachers.find((t) =>
      t.assignedBatches?.includes(batch.name)
    );
    return teacherWithBatch ? teacherWithBatch._id : "";
  }, [batch, teachers]);

  const [name, setName] = useState(() => batch?.name || "");
  const [subject, setSubject] = useState(() => batch?.subject || "");
  const [timing, setTiming] = useState(() => batch?.timing || "");
  const [assignedTeacherId, setAssignedTeacherId] = useState<string>(() => initialTeacherId);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state safely when modal opens or batch changes
  useEffect(() => {
    if (!batch || !isOpen) return;
    const timer = setTimeout(() => {
      setName(batch.name || "");
      setSubject(batch.subject || "");
      setTiming(batch.timing || "");
      setAssignedTeacherId(initialTeacherId);
      setError(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [batch, isOpen, initialTeacherId]);

  const isTeacherTransfer = Boolean(
    batch && assignedTeacherId !== initialTeacherId
  );

  if (!isOpen || !batch) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanName = name.trim();
    if (!cleanName) {
      setError("Please enter a batch name.");
      return;
    }

    setLoading(true);

    try {
      const res = await apiClient<{ data: BatchRecord }>(
        `/batches/${batch._id}`,
        {
          method: "PATCH",
          body: {
            name: cleanName,
            subject: subject.trim() || undefined,
            timing: timing.trim() || undefined,
            assignedTeacherId: assignedTeacherId ? assignedTeacherId : null,
          },
        }
      );

      invalidateApiCache("/batches");
      invalidateApiCache("/students");

      const updated = res.data?.data || (res.data as unknown as BatchRecord);
      onSuccess(updated);
      onClose();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to update batch.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fade-in overflow-y-auto">
      <div className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200/90 overflow-hidden my-6">
        {/* Accent Bar */}
        <div className="h-1.5 w-full bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600" />

        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-start justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-600/25 ring-2 ring-indigo-100">
              <Layers className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Edit Batch Details
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Update batch information and faculty assignment
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {/* Batch Name */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
              Batch Name <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <Layers className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Class 10 - Mathematics"
                className="w-full pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all placeholder:text-slate-400"
              />
            </div>
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
              Subject <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <div className="relative">
              <BookOpen className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Mathematics, Physics, Chemistry"
                className="w-full pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all placeholder:text-slate-400"
              />
            </div>
          </div>

          {/* Timing / Schedule */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
              Timing / Schedule <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <div className="relative">
              <Clock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={timing}
                onChange={(e) => setTiming(e.target.value)}
                placeholder="e.g. 5:00 PM - 6:30 PM (Mon, Wed, Fri)"
                className="w-full pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all placeholder:text-slate-400"
              />
            </div>

            {/* Quick Timings */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {QUICK_TIMINGS.map((qt) => (
                <button
                  key={qt}
                  type="button"
                  onClick={() => setTiming(qt)}
                  className={`text-[10px] px-2.5 py-1 rounded-xl border transition-all ${
                    timing === qt
                      ? "bg-indigo-50 text-indigo-700 border-indigo-200 font-bold"
                      : "bg-slate-50 text-slate-600 border-slate-200/80 hover:bg-slate-100"
                  }`}
                >
                  {qt}
                </button>
              ))}
            </div>
          </div>

          {/* Assigned Teacher / Faculty */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
              Assigned Faculty / Teacher
            </label>
            <div className="relative">
              <UserCheck className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                value={assignedTeacherId}
                onChange={(e) => setAssignedTeacherId(e.target.value)}
                className="w-full pl-10 pr-8 py-2.5 rounded-2xl border border-slate-200 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all bg-white appearance-none cursor-pointer"
              >
                <option value="">Direct Owner Management (Unassigned)</option>
                {teachers.map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.name} {t.phone ? `(${t.phone})` : ""}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* Teacher Transfer Subtle Info Note */}
          {isTeacherTransfer && (
            <div className="p-3.5 rounded-2xl bg-blue-50/80 border border-blue-200/80 text-blue-900 text-xs flex items-start gap-2.5 animate-fade-in leading-relaxed">
              <Info className="w-4 h-4 flex-shrink-0 text-blue-600 mt-0.5" />
              <div className="space-y-1">
                <span className="font-semibold block text-blue-950">
                  Batch Transfer Notice
                </span>
                <p className="text-blue-800">
                  Transferring this batch updates teacher access immediately. Past
                  fee/cash records remain unchanged and no WhatsApp welcome
                  messages will be sent.
                </p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-slate-100">
            <button
              type="button"
              disabled={loading}
              onClick={onClose}
              className="px-4 py-2.5 rounded-2xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-xs font-bold shadow-md shadow-indigo-600/25 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Save Changes</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
