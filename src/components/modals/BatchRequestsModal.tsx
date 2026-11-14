"use client";

import { useState, useEffect, useCallback } from "react";
import {
  X,
  Layers,
  CheckCircle,
  XCircle,
  Clock,
  ArrowRight,
  AlertCircle,
  Loader2,
  RefreshCw,
  Plus,
  Send,
  User,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { StudentRecord, BatchRecord, StudentBatchRequestRecord } from "@/types";

interface BatchRequestsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userRole?: "owner" | "teacher" | string;
  onRequestsUpdated?: () => void;
  onRequestNew?: () => void;
}

export default function BatchRequestsModal({
  isOpen,
  onClose,
  userRole = "owner",
  onRequestsUpdated,
  onRequestNew,
}: BatchRequestsModalProps) {
  const [requests, setRequests] = useState<StudentBatchRequestRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"pending" | "all">("pending");

  // Rejection Inline Form State
  const [rejectingRequestId, setRejectingRequestId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>("");
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient<StudentBatchRequestRecord[]>("/batch-requests", {
        skipCache: true,
      });
      setRequests(res.data || []);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load batch requests";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchRequests();
      setRejectingRequestId(null);
      setRejectionReason("");
    }
  }, [isOpen, fetchRequests]);

  if (!isOpen) return null;

  const isOwner = userRole === "owner";
  const pendingRequests = requests.filter((r) => r.status === "pending");
  const displayedRequests =
    activeTab === "pending"
      ? pendingRequests
      : requests;

  const handleApprove = async (requestId: string) => {
    try {
      setProcessingId(requestId);
      setError(null);
      await apiClient(`/batch-requests/${requestId}/approve`, {
        method: "PUT",
      });
      await fetchRequests();
      onRequestsUpdated?.();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to approve request";
      setError(msg);
    } finally {
      setProcessingId(null);
    }
  };

  const handleRejectConfirm = async (requestId: string) => {
    const trimmedReason = rejectionReason.trim();
    if (!trimmedReason) {
      setError("Please provide a rejection reason.");
      return;
    }

    try {
      setProcessingId(requestId);
      setError(null);
      await apiClient(`/batch-requests/${requestId}/reject`, {
        method: "PUT",
        body: { rejectionReason: trimmedReason },
      });
      setRejectingRequestId(null);
      setRejectionReason("");
      await fetchRequests();
      onRequestsUpdated?.();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to reject request";
      setError(msg);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-requests-inbox-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-2xl max-h-[90vh] flex flex-col bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-linear-to-r from-slate-50 via-white to-white">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-100/80 text-indigo-700 rounded-2xl">
              <Layers className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3
                  id="batch-requests-inbox-title"
                  className="text-base font-black text-slate-900 leading-tight"
                >
                  {isOwner
                    ? "Student Assignment Requests"
                    : "My Batch Assignment Requests"}
                </h3>
                {pendingRequests.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800">
                    {pendingRequests.length} Pending
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 font-medium">
                {isOwner
                  ? "Verify teacher requests before students are officially assigned to batches"
                  : "Track approval status of your student-to-batch assignment requests"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={fetchRequests}
              disabled={loading}
              title="Refresh requests"
              className="p-2 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-100 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toolbar: Tabs & Teacher Action */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-100 bg-slate-50/60">
          <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-xl text-xs font-bold">
            <button
              type="button"
              onClick={() => setActiveTab("pending")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === "pending"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Pending ({pendingRequests.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("all")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === "all"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              All Requests ({requests.length})
            </button>
          </div>

          {!isOwner && onRequestNew && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onRequestNew();
              }}
              className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-xs transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Request</span>
            </button>
          )}
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mx-6 mt-4 flex items-start gap-2.5 p-3.5 bg-rose-50 border border-rose-200/80 rounded-2xl text-rose-700 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
            <span className="font-semibold leading-relaxed">{error}</span>
          </div>
        )}

        {/* List Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {loading && requests.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              <p className="text-xs font-medium">Loading requests...</p>
            </div>
          ) : displayedRequests.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-2">
                <CheckCircle className="w-6 h-6 stroke-[1.8]" />
              </div>
              <p className="text-sm font-bold text-slate-700">
                {activeTab === "pending"
                  ? "No pending requests"
                  : "No requests found"}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                {activeTab === "pending"
                  ? "All student batch assignment requests have been reviewed."
                  : "Submit a request to assign or transfer a student to another batch."}
              </p>
            </div>
          ) : (
            displayedRequests.map((req) => {
              const studentName =
                typeof req.studentId === "object" && req.studentId !== null
                  ? req.studentId.name
                  : "Student";
              const isProcessing = processingId === req._id;
              const isRejecting = rejectingRequestId === req._id;

              return (
                <div
                  key={req._id}
                  className="p-4 rounded-2xl border border-slate-200/80 bg-white hover:border-slate-300 transition-all shadow-xs space-y-3"
                >
                  {/* Top Bar: Student info & Status */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 font-black flex items-center justify-center text-xs">
                        {studentName.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <h4 className="text-sm font-black text-slate-900 leading-tight">
                          {studentName}
                        </h4>
                        <p className="text-xs text-slate-500 font-medium">
                          Requested by{" "}
                          <span className="font-semibold text-slate-700">
                            {req.requesterName}
                          </span>{" "}
                          ({req.requesterRole}) •{" "}
                          {new Date(req.createdAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                    </div>

                    {/* Status Badge */}
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-bold ${
                        req.status === "pending"
                          ? "bg-amber-50 text-amber-700 border border-amber-200"
                          : req.status === "approved"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : "bg-rose-50 text-rose-700 border border-rose-200"
                      }`}
                    >
                      {req.status === "pending" && <Clock className="w-3 h-3" />}
                      {req.status === "approved" && <CheckCircle className="w-3 h-3" />}
                      {req.status === "rejected" && <XCircle className="w-3 h-3" />}
                      <span className="capitalize">{req.status}</span>
                    </span>
                  </div>

                  {/* Batch Flow Display */}
                  <div className="p-2.5 bg-slate-50 border border-slate-200/60 rounded-xl flex items-center justify-between text-xs">
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">
                        Current Batch
                      </span>
                      <span className="font-semibold text-slate-700">
                        {req.currentBatch || "Unassigned"}
                      </span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-slate-400 shrink-0 mx-2" />
                    <div className="text-right">
                      <span className="text-[10px] uppercase font-bold text-indigo-500 block">
                        Requested Batch
                      </span>
                      <span className="font-bold text-indigo-700">
                        {req.batchName}
                      </span>
                    </div>
                  </div>

                  {/* Notes if provided */}
                  {req.requestNotes && (
                    <p className="text-xs text-slate-600 bg-indigo-50/40 p-2.5 rounded-xl border border-indigo-100/60 italic">
                      &quot;{req.requestNotes}&quot;
                    </p>
                  )}

                  {/* Rejection Banner */}
                  {req.status === "rejected" && req.rejectionReason && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200/70 rounded-xl text-xs text-rose-800">
                      <p className="font-bold">
                        Rejection Reason{" "}
                        {req.reviewedByName && (
                          <span className="font-normal text-rose-600">
                            (by {req.reviewedByName})
                          </span>
                        )}
                        :
                      </p>
                      <p className="mt-0.5">{req.rejectionReason}</p>
                    </div>
                  )}

                  {/* Approval Banner */}
                  {req.status === "approved" && req.reviewedByName && (
                    <p className="text-[11px] text-emerald-700 font-semibold">
                      Officially approved by {req.reviewedByName} on{" "}
                      {req.reviewedAt
                        ? new Date(req.reviewedAt).toLocaleDateString("en-IN")
                        : "recently"}
                    </p>
                  )}

                  {/* Owner Action Buttons (When Pending) */}
                  {isOwner && req.status === "pending" && (
                    <div className="pt-1">
                      {isRejecting ? (
                        <div className="p-3 bg-rose-50/70 border border-rose-200 rounded-2xl space-y-2 animate-in fade-in duration-150">
                          <label className="block text-[11px] font-bold text-rose-800">
                            Reason for rejection (mandatory):
                          </label>
                          <textarea
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            placeholder="e.g. Batch is full, prerequisite not met..."
                            rows={2}
                            className="w-full p-2.5 bg-white border border-rose-200 rounded-xl text-xs text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setRejectingRequestId(null);
                                setRejectionReason("");
                              }}
                              disabled={isProcessing}
                              className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRejectConfirm(req._id)}
                              disabled={isProcessing || !rejectionReason.trim()}
                              className="px-4 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-xs disabled:opacity-50"
                            >
                              {isProcessing ? "Rejecting..." : "Confirm Reject"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setRejectingRequestId(req._id);
                              setRejectionReason("");
                            }}
                            disabled={isProcessing}
                            className="tap-bounce px-3.5 py-1.5 rounded-xl border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-bold transition-all"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() => handleApprove(req._id)}
                            disabled={isProcessing}
                            className="tap-bounce inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs transition-all disabled:opacity-50"
                          >
                            {isProcessing ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Approving...</span>
                              </>
                            ) : (
                              <>
                                <CheckCircle className="w-3.5 h-3.5" />
                                <span>Approve &amp; Assign</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
