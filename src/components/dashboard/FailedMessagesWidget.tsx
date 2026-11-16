"use client";

import { useState, useEffect, useCallback, memo } from "react";
import {
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Send,
  WifiOff,
  Inbox,
} from "lucide-react";
import { getAuthenticatedCenter } from "@/lib/centerProfile";

interface FailedMessagesWidgetProps {
  isWhatsAppConnected?: boolean | null;
  onRetrySuccess?: (requeuedCount: number) => void;
  className?: string;
}

interface RetryStatusData {
  count: number;
  breakdown: {
    admissionWelcome: number;
    feeReminders: number;
    campaigns: number;
  };
}

function FailedMessagesWidget({
  isWhatsAppConnected = false,
  onRetrySuccess,
  className = "",
}: FailedMessagesWidgetProps) {
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [statusData, setStatusData] = useState<RetryStatusData>({
    count: 0,
    breakdown: {
      admissionWelcome: 0,
      feeReminders: 0,
      campaigns: 0,
    },
  });
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // 1. Verify caller role (Owner only)
  useEffect(() => {
    getAuthenticatedCenter().then((center) => {
      if (center?.role === "owner" || (!center?.role && center?.centerId)) {
        setIsOwner(true);
      } else {
        setIsOwner(false);
      }
    });
  }, []);

  // 2. Fetch pending / failed message count from GET /api/whatsapp/retry
  const fetchCounts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/whatsapp/retry", {
        method: "GET",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        setStatusData({
          count: Number(data.count) || 0,
          breakdown: {
            admissionWelcome: Number(data.breakdown?.admissionWelcome) || 0,
            feeReminders: Number(data.breakdown?.feeReminders) || 0,
            campaigns: Number(data.breakdown?.campaigns) || 0,
          },
        });
      }
    } catch {
      // Graceful fallback on network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    fetchCounts();

    // Re-check every 45 seconds
    const interval = setInterval(fetchCounts, 45000);
    return () => clearInterval(interval);
  }, [isOwner, fetchCounts]);

  // 3. Retry action
  const handleRetry = async () => {
    if (!isWhatsAppConnected || retrying || statusData.count === 0) return;

    setRetrying(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/whatsapp/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        setFeedback({
          type: "success",
          message:
            data.message ||
            `Successfully queued ${data.requeuedCount} message(s) for retry.`,
        });
        onRetrySuccess?.(data.requeuedCount || 0);
        // Refresh counts
        await fetchCounts();
      } else {
        throw new Error(data?.error || "Failed to trigger retry engine.");
      }
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to retry failed messages.",
      });
    } finally {
      setRetrying(false);
      // Auto-clear feedback toast after 5s
      setTimeout(() => setFeedback(null), 5000);
    }
  };

  // Only render for owners
  if (!isOwner) return null;

  const hasFailedMessages = statusData.count > 0;
  const canRetry = isWhatsAppConnected === true && hasFailedMessages;

  return (
    <div
      className={`rounded-2xl border bg-white p-4 shadow-sm transition-all ${
        hasFailedMessages
          ? "border-amber-200/90 bg-gradient-to-br from-white to-amber-50/40"
          : "border-slate-200/80"
      } ${className}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 ${
              hasFailedMessages
                ? "bg-amber-100 text-amber-700"
                : "bg-emerald-50 text-emerald-600"
            }`}
          >
            {hasFailedMessages ? (
              <Inbox className="w-5 h-5 stroke-[2.2]" />
            ) : (
              <CheckCircle2 className="w-5 h-5 stroke-[2.2]" />
            )}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Outbound Message Queue
              </h4>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                </span>
              ) : hasFailedMessages ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200/80">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {statusData.count} Pending / Failed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  All Synced
                </span>
              )}
            </div>

            <p className="mt-0.5 text-xs text-slate-600 font-medium leading-relaxed">
              {hasFailedMessages ? (
                <>
                  {statusData.breakdown.admissionWelcome > 0 && (
                    <span>
                      {statusData.breakdown.admissionWelcome} welcome
                      {statusData.breakdown.feeReminders > 0 ||
                      statusData.breakdown.campaigns > 0
                        ? ", "
                        : " "}
                    </span>
                  )}
                  {statusData.breakdown.feeReminders > 0 && (
                    <span>
                      {statusData.breakdown.feeReminders} fee reminder
                      {statusData.breakdown.campaigns > 0 ? ", " : " "}
                    </span>
                  )}
                  {statusData.breakdown.campaigns > 0 && (
                    <span>{statusData.breakdown.campaigns} announcement</span>
                  )}
                  {" "}held due to prior disconnect.
                </>
              ) : (
                "All admission welcome and fee reminder messages are delivered."
              )}
            </p>

            {/* Offline helper note when retry is disabled */}
            {hasFailedMessages && !isWhatsAppConnected && (
              <p className="mt-1 text-[11px] text-rose-600 font-semibold flex items-center gap-1">
                <WifiOff className="w-3 h-3" />
                WhatsApp is disconnected. Reconnect above to enable retry.
              </p>
            )}
          </div>
        </div>

        {/* Retry Button */}
        <div className="flex items-center gap-2 self-end sm:self-center">
          <button
            onClick={handleRetry}
            disabled={!canRetry || retrying}
            className={`tap-bounce inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold shadow-xs transition-all ${
              canRetry && !retrying
                ? "bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white shadow-emerald-500/20 cursor-pointer"
                : "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed opacity-75"
            }`}
            title={
              !isWhatsAppConnected
                ? "Connect WhatsApp above to retry failed messages"
                : !hasFailedMessages
                ? "No failed messages to retry"
                : "Queue all failed messages for sequential retry"
            }
          >
            {retrying ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Re-queuing...</span>
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retry Failed Messages</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Inline Feedback Banner */}
      {feedback && (
        <div
          className={`mt-3 p-2.5 rounded-xl text-xs font-medium flex items-center gap-2 animate-in fade-in ${
            feedback.type === "success"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-rose-50 text-rose-800 border border-rose-200"
          }`}
        >
          {feedback.type === "success" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
          )}
          <span className="flex-1">{feedback.message}</span>
        </div>
      )}
    </div>
  );
}

export default memo(FailedMessagesWidget);
