"use client";

import { useState, useEffect } from "react";
import {
  X,
  Layers,
  User,
  FileText,
  Loader2,
  AlertCircle,
  ArrowRight,
  Send,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { StudentRecord, BatchRecord, StudentBatchRequestRecord } from "@/types";

interface StudentBatchRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (request: StudentBatchRequestRecord) => void;
  initialStudent?: StudentRecord | null;
  students?: StudentRecord[];
  batches?: BatchRecord[];
}

export default function StudentBatchRequestModal({
  isOpen,
  onClose,
  onSuccess,
  initialStudent,
  students = [],
  batches = [],
}: StudentBatchRequestModalProps) {
  const [selectedStudentId, setSelectedStudentId] = useState<string>("");
  const [targetBatchName, setTargetBatchName] = useState<string>("");
  const [requestNotes, setRequestNotes] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronize initial student when modal opens
  useEffect(() => {
    if (initialStudent?._id) {
      setSelectedStudentId(initialStudent._id);
    } else if (students.length > 0 && !selectedStudentId) {
      setSelectedStudentId(students[0]._id);
    }
  }, [initialStudent, students, isOpen]);

  // Reset form when closed
  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setTargetBatchName("");
      setRequestNotes("");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentStudent =
    students.find((s) => s._id === selectedStudentId) || initialStudent;

  // Filter available batches: only active batches, excluding student's current batch
  const eligibleBatches = batches.filter(
    (b) =>
      b.isActive !== false &&
      b.name.toLowerCase().trim() !== (currentStudent?.batch || "").toLowerCase().trim()
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedStudentId) {
      setError("Please select a student.");
      return;
    }

    if (!targetBatchName) {
      setError("Please select a target batch to request.");
      return;
    }

    setLoading(true);

    try {
      const res = await apiClient<StudentBatchRequestRecord>("/batch-requests", {
        method: "POST",
        body: {
          studentId: selectedStudentId,
          batchName: targetBatchName,
          requestNotes: requestNotes.trim() || undefined,
        },
      });

      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to submit batch request";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-request-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-md overflow-hidden bg-white rounded-3xl shadow-2xl border border-slate-100 animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-linear-to-r from-indigo-50/50 via-white to-white">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-100/80 text-indigo-700 rounded-2xl">
              <Layers className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h3
                id="batch-request-modal-title"
                className="text-base font-black text-slate-900 leading-tight"
              >
                Request Batch Assignment
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                Submit for Owner verification and official assignment
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2.5 p-3.5 bg-rose-50 border border-rose-200/80 rounded-2xl text-rose-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
              <span className="font-semibold leading-relaxed">{error}</span>
            </div>
          )}

          {/* Student Selector / Info */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Select Student
            </label>
            {initialStudent ? (
              <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200/70 rounded-2xl">
                <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-xs">
                  {initialStudent.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-slate-800 truncate">
                    {initialStudent.name}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    Current:{" "}
                    <span className="font-semibold text-slate-700">
                      {initialStudent.batch}
                    </span>
                  </p>
                </div>
              </div>
            ) : (
              <div className="relative">
                <select
                  value={selectedStudentId}
                  onChange={(e) => {
                    setSelectedStudentId(e.target.value);
                    setTargetBatchName("");
                  }}
                  className="w-full h-11 pl-3.5 pr-8 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                >
                  <option value="">Select a student...</option>
                  {students.map((s) => (
                    <option key={s._id} value={s._id}>
                      {s.name} ({s.batch || "No Batch"})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Current Batch vs Target Batch Preview */}
          {currentStudent && (
            <div className="p-3 bg-slate-50/80 border border-slate-200/60 rounded-2xl flex items-center justify-between text-xs">
              <div>
                <span className="text-[10px] uppercase font-bold text-slate-400 block">
                  Current Batch
                </span>
                <span className="font-bold text-slate-700">
                  {currentStudent.batch || "Unassigned"}
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400" />
              <div className="text-right">
                <span className="text-[10px] uppercase font-bold text-indigo-500 block">
                  Target Batch
                </span>
                <span className="font-bold text-indigo-700">
                  {targetBatchName || "Select below"}
                </span>
              </div>
            </div>
          )}

          {/* Target Batch Dropdown */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Requested Target Batch <span className="text-rose-500">*</span>
            </label>
            <select
              value={targetBatchName}
              onChange={(e) => setTargetBatchName(e.target.value)}
              required
              className="w-full h-11 px-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            >
              <option value="">Choose an existing batch...</option>
              {eligibleBatches.map((b) => (
                <option key={b._id} value={b.name}>
                  {b.name} {b.timing ? `(${b.timing})` : ""}
                </option>
              ))}
            </select>
            {eligibleBatches.length === 0 && (
              <p className="text-[11px] text-amber-600 mt-1 font-medium">
                No other active batches found in this institute.
              </p>
            )}
          </div>

          {/* Optional Request Notes */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Reason / Notes <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <textarea
              value={requestNotes}
              onChange={(e) => setRequestNotes(e.target.value)}
              placeholder="e.g. Student requested timing change to morning batch..."
              rows={2}
              className="w-full p-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-medium text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 placeholder:text-slate-400"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 h-11 rounded-2xl border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !targetBatchName || !selectedStudentId}
              className="flex-1 h-11 rounded-2xl bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white text-xs font-bold shadow-md shadow-indigo-600/30 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Submitting...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Submit Request</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
