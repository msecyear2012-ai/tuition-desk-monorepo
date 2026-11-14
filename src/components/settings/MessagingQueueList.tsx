"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RotateCcw,
  CheckCircle2,
  CheckCheck,
  AlertCircle,
  Loader2,
  RefreshCw,
  Clock,
  GraduationCap,
  Bell,
  MessageSquare,
  Smartphone,
  WifiOff,
  Inbox,
  Filter,
  Send,
  Eye,
  Activity,
  Layers,
  Archive,
  X,
  HelpCircle,
  Trash2,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { getAuthenticatedCenter } from "@/lib/centerProfile";

export type LiveQueueStatus =
  | "pending"
  | "processing"
  | "provider_accepted"
  | "delivered"
  | "sent"
  | "simulated"
  | "failed"
  | "ambiguous"
  | "outcome_unknown";

export type DeliveryState =
  | "pending"
  | "processing"
  | "provider_accepted"
  | "delivered"
  | "sent"
  | "simulated"
  | "failed"
  | "outcome_unknown";

export interface QueueItem {
  id: string;
  type: "admission_welcome" | "fee_reminder" | "campaign";
  typeLabel: string;
  recipientPhone: string;
  studentName: string;
  status: LiveQueueStatus;
  statusLabel?: string;
  deliveryState?: DeliveryState;
  error?: string;
  timestamp: string;
  attempts?: number;
}

export interface QueueSummary {
  pending: number;
  processing: number;
  provider_accepted: number;
  delivered: number;
  sent: number;
  failed: number;
  simulated: number;
  uncertain?: number;
  archived?: number;
  total: number;
}

interface RetryStatusResponse {
  success: boolean;
  count: number;
  inFlightCount?: number;
  breakdown: {
    admissionWelcome: number;
    feeReminders: number;
    campaigns: number;
  };
  summary?: QueueSummary;
  items?: QueueItem[];
  pendingItems?: QueueItem[];
  failedItems?: QueueItem[];
  recentActivity?: QueueItem[];
  error?: string;
}

export interface CleanupPreviewData {
  eligibleTotal: number;
  successfulCount: number;
  failedCount: number;
  protectedCount: number;
  breakdown?: {
    feeReminders?: { totalEligible: number; successful: number; failed: number; protected: number };
    admissionWelcome?: { totalEligible: number; successful: number; failed: number; protected: number };
    campaigns?: { totalEligible: number; successful: number; failed: number; protected: number };
  };
}

export interface MessagingQueueListProps {
  isWhatsAppConnected?: boolean | null;
  onRetrySuccess?: (requeuedCount: number) => void;
  className?: string;
}

function formatPhoneDisplay(phone: string): string {
  const clean = phone.replace(/\D/g, "");
  if (clean.length === 10) {
    return `+91 ${clean.slice(0, 5)} ${clean.slice(5)}`;
  }
  if (clean.length === 12 && clean.startsWith("91")) {
    return `+91 ${clean.slice(2, 7)} ${clean.slice(7)}`;
  }
  return phone;
}

function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "Recently";
    return d.toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "Recently";
  }
}

export default function MessagingQueueList({
  isWhatsAppConnected = false,
  onRetrySuccess,
  className = "",
}: MessagingQueueListProps) {
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Data states
  const [items, setItems] = useState<QueueItem[]>([]);
  const [recentActivity, setRecentActivity] = useState<QueueItem[]>([]);
  const [pendingItems, setPendingItems] = useState<QueueItem[]>([]);
  const [failedItems, setFailedItems] = useState<QueueItem[]>([]);
  const [count, setCount] = useState(0);
  const [inFlightCount, setInFlightCount] = useState(0);
  const [, setBreakdown] = useState({
    admissionWelcome: 0,
    feeReminders: 0,
    campaigns: 0,
  });
  const [summary, setSummary] = useState<QueueSummary>({
    pending: 0,
    processing: 0,
    provider_accepted: 0,
    delivered: 0,
    sent: 0,
    failed: 0,
    simulated: 0,
    archived: 0,
    total: 0,
  });

  // Modal and archive states
  const [showClearModal, setShowClearModal] = useState(false);
  const [clearingDelivered, setClearingDelivered] = useState(false);
  const [cutoffTimestamp, setCutoffTimestamp] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  // Permanent Cleanup Modal and preview states
  const [showCleanupModal, setShowCleanupModal] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreviewData | null>(null);
  const [loadingCleanupPreview, setLoadingCleanupPreview] = useState(false);
  const [executingCleanup, setExecutingCleanup] = useState(false);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [eligibleLogCount, setEligibleLogCount] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  // Navigation view: "activity" (recent stream), "failed" (retries), "pending" (in-flight)
  const [activeView, setActiveView] = useState<"activity" | "failed" | "pending">("activity");

  // Filter tabs: "all" | "admission_welcome" | "fee_reminder" | "campaign"
  const [activeFilter, setActiveFilter] = useState<
    "all" | "admission_welcome" | "fee_reminder" | "campaign"
  >("all");

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // 1. Role verification (strictly Owner)
  useEffect(() => {
    getAuthenticatedCenter().then((center) => {
      if (center?.role === "owner" || (!center?.role && center?.centerId)) {
        setIsOwner(true);
      } else {
        setIsOwner(false);
      }
    });
  }, []);

  // 2. Fetch detailed items and count from GET /api/whatsapp/retry
  const fetchQueue = useCallback(
    async (showGlobalLoader = false, withArchived?: boolean) => {
      try {
        if (showGlobalLoader) {
          setLoading(true);
        } else {
          setRefreshing(true);
        }

        const shouldIncludeArchived =
          withArchived !== undefined ? withArchived : includeArchived;
        const url = `/api/whatsapp/retry${shouldIncludeArchived ? "?includeArchived=true" : ""}`;

        const res = await fetch(url, {
          method: "GET",
          cache: "no-store",
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data: RetryStatusResponse = await res.json().catch(() => null);

        if (data?.success) {
          setCount(Number(data.count) || 0);
          setInFlightCount(Number(data.inFlightCount) || 0);
          setBreakdown({
            admissionWelcome: Number(data.breakdown?.admissionWelcome) || 0,
            feeReminders: Number(data.breakdown?.feeReminders) || 0,
            campaigns: Number(data.breakdown?.campaigns) || 0,
          });

          if (data.summary) {
            setSummary(data.summary);
          }

          const rawItems = Array.isArray(data.items) ? data.items : [];
          const rawRecent = Array.isArray(data.recentActivity) ? data.recentActivity : [];
          const rawPending = Array.isArray(data.pendingItems)
            ? data.pendingItems
            : rawItems.filter((i) => i.status === "pending" || i.status === "processing");
          const rawFailed = Array.isArray(data.failedItems)
            ? data.failedItems
            : rawItems.filter((i) => i.status === "failed");

          setItems(rawItems);
          setRecentActivity(rawRecent.length > 0 ? rawRecent : rawItems);
          setPendingItems(rawPending);
          setFailedItems(rawFailed);

          // Synchronously sync eligible cleanup count for Owner
          try {
            const cleanupRes = await fetch("/api/whatsapp/logs/cleanup", {
              method: "GET",
              cache: "no-store",
            });
            const cleanupData = await cleanupRes.json();
            if (cleanupData?.success) {
              setEligibleLogCount(Number(cleanupData.eligibleTotal) || 0);
            }
          } catch {}
        } else {
          throw new Error(data?.error || "Failed to fetch retry queue status");
        }
      } catch (err: unknown) {
        console.warn("Could not fetch WhatsApp retry queue:", err);
        throw err;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [includeArchived]
  );

  // 3. Initial load & periodic background sync (every 45s when idle)
  useEffect(() => {
    if (!isOwner) return;

    let mounted = true;
    const initialTimer = setTimeout(() => {
      if (mounted) {
        fetchQueue(false).catch(() => {});
      }
    }, 0);

    const idleInterval = setInterval(() => {
      if (mounted) {
        fetchQueue(false).catch(() => {});
      }
    }, 45000);

    return () => {
      mounted = false;
      clearTimeout(initialTimer);
      clearInterval(idleInterval);
    };
  }, [isOwner, fetchQueue]);

  // 4. Adaptive Polling: actively polls every 4 seconds ONLY when messages are in-flight
  const hasActiveMessages =
    inFlightCount > 0 ||
    summary.pending > 0 ||
    summary.processing > 0 ||
    pendingItems.length > 0 ||
    items.some((item) => item.status === "pending" || item.status === "processing");

  useEffect(() => {
    if (!isOwner || !hasActiveMessages) return;

    let intervalId: NodeJS.Timeout | null = null;

    const poll = async () => {
      try {
        await fetchQueue(false);
      } catch (err) {
        console.warn("[MessagingQueueList] Polling halted due to error:", err);
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }
    };

    intervalId = setInterval(poll, 4000);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isOwner, hasActiveMessages, fetchQueue]);

  // 5. Retry action
  const handleRetryAll = async () => {
    if (!isWhatsAppConnected || retrying || count === 0) return;

    setRetrying(true);
    setFeedback(null);

    // Optimistic UI update: mark failed items as pending
    setFailedItems((prev) =>
      prev.map((item) => ({
        ...item,
        status: "pending",
        error: "Queued for retry...",
      }))
    );

    try {
      const res = await fetch("/api/whatsapp/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        const requeued = Number(data.requeued ?? data.requeuedCount ?? 0);
        setFeedback({
          type: "success",
          message:
            data.message ||
            `Successfully queued ${requeued} message(s) for sequential retry.`,
        });
        onRetrySuccess?.(requeued);
      } else {
        throw new Error(data?.error || `Retry service returned HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to queue messages for retry.",
      });
    } finally {
      setRetrying(false);
      await fetchQueue(false).catch(() => {});
      setTimeout(() => setFeedback(null), 6000);
    }
  };

  // 6. Clear Delivered action
  const handleOpenClearModal = () => {
    setCutoffTimestamp(new Date().toISOString());
    setShowClearModal(true);
  };

  const handleConfirmClearDelivered = async () => {
    if (clearingDelivered) return;
    setClearingDelivered(true);

    try {
      const res = await fetch("/api/whatsapp/retry/clear-delivered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cutoffTimestamp }),
      });

      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        const archived = Number(data.archivedCount ?? 0);
        setFeedback({
          type: "success",
          message:
            data.message ||
            `Successfully cleared ${archived} delivered message(s) from active view.`,
        });
        setShowClearModal(false);
        await fetchQueue(false);
      } else {
        throw new Error(data?.error || `Failed to clear delivered messages (${res.status})`);
      }
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to clear delivered messages.",
      });
    } finally {
      setClearingDelivered(false);
      setTimeout(() => setFeedback(null), 6000);
    }
  };

  // 7. Permanent Log Cleanup action (Owner-only)
  const fetchCleanupPreview = useCallback(async () => {
    try {
      setLoadingCleanupPreview(true);
      setPreviewError(null);
      const res = await fetch("/api/whatsapp/logs/cleanup", {
        method: "GET",
        cache: "no-store",
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        const errorMsg =
          data?.error || `Failed to fetch cleanup preview (HTTP ${res.status})`;
        setPreviewError(errorMsg);
        return null;
      }

      setCleanupPreview(data);
      setEligibleLogCount(Number(data.eligibleTotal) || 0);
      return data;
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : "Failed to connect to cleanup preview service";
      console.warn("Could not fetch WhatsApp log cleanup preview:", err);
      setPreviewError(errorMsg);
    } finally {
      setLoadingCleanupPreview(false);
    }
    return null;
  }, []);

  const handleOpenCleanupModal = async () => {
    if (executingCleanup) return;
    setCleanupConfirmed(false);
    setPreviewError(null);
    setCleanupError(null);
    setShowCleanupModal(true);
    await fetchCleanupPreview();
  };

  const handleConfirmCleanup = async () => {
    if (!cleanupConfirmed || executingCleanup) return;
    setExecutingCleanup(true);
    setCleanupError(null);

    try {
      const res = await fetch("/api/whatsapp/logs/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });

      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        const deleted = Number(data.deletedCount ?? 0);
        setFeedback({
          type: "success",
          message:
            data.message ||
            `Successfully cleaned up ${deleted} terminal WhatsApp dispatch record(s).`,
        });
        setShowCleanupModal(false);
        setCleanupConfirmed(false);
        setEligibleLogCount(0);
        setCleanupPreview(null);
        await fetchQueue(false);
      } else {
        const errorMsg =
          data?.error || `Failed to clean up logs (HTTP ${res.status})`;
        setCleanupError(errorMsg);
        setFeedback({
          type: "error",
          message: errorMsg,
        });
      }
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : "Failed to complete log cleanup.";
      setCleanupError(errorMsg);
      setFeedback({
        type: "error",
        message: errorMsg,
      });
    } finally {
      setExecutingCleanup(false);
      setTimeout(() => setFeedback(null), 6000);
    }
  };

  if (!isOwner) return null;

  // Determine which item pool to display based on activeView
  const currentPool =
    activeView === "activity"
      ? recentActivity
      : activeView === "failed"
      ? failedItems
      : pendingItems;

  const filteredItems =
    activeFilter === "all"
      ? currentPool
      : currentPool.filter((item) => item.type === activeFilter);

  const hasFailedMessages = failedItems.length > 0 || summary.failed > 0;
  const canRetry = isWhatsAppConnected === true && hasFailedMessages;

  // Helper to render distinct status badges
  const renderStatusBadge = (item: QueueItem) => {
    const status = item.status;
    const deliveryState = item.deliveryState;

    if (status === "delivered" || deliveryState === "delivered") {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200/80"
          title="Message was confirmed delivered to recipient device"
        >
          <CheckCheck className="w-3.5 h-3.5 text-emerald-600 stroke-[2.2]" />
          <span>Confirmed Delivered</span>
        </span>
      );
    }

    if (status === "provider_accepted" || deliveryState === "provider_accepted") {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-800 border border-teal-200/80"
          title="Accepted by WhatsApp server. Awaiting recipient phone delivery acknowledgment"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 stroke-[2]" />
          <span>Accepted by Provider</span>
        </span>
      );
    }

    if (status === "sent" || deliveryState === "sent") {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200/60"
          title="Dispatched to WhatsApp socket"
        >
          <Send className="w-3 h-3 text-emerald-600" />
          <span>Sent</span>
        </span>
      );
    }

    if (status === "simulated" || deliveryState === "simulated") {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-800 border border-purple-200/80"
          title="Simulated dispatch (WHATSAPP_MODE=simulation)"
        >
          <Eye className="w-3 h-3 text-purple-600" />
          <span>Simulated</span>
        </span>
      );
    }

    if (status === "processing" || deliveryState === "processing") {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-800 border border-blue-200/80"
          title="Message is actively being transmitted"
        >
          <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
          <span>Processing</span>
        </span>
      );
    }

    if (status === "failed" || deliveryState === "failed") {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-800 border border-rose-200/80"
          title="Delivery attempt failed. Action required."
        >
          <AlertCircle className="w-3 h-3 text-rose-600" />
          <span>Failed</span>
        </span>
      );
    }

    if (
      status === "outcome_unknown" ||
      status === "ambiguous" ||
      deliveryState === "outcome_unknown"
    ) {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300"
          title="Dispatch outcome uncertain: awaiting delivery acknowledgment"
        >
          <HelpCircle className="w-3.5 h-3.5 text-amber-600 stroke-[2]" />
          <span>Outcome Unknown</span>
        </span>
      );
    }

    // Pending / Queued
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200/80"
        title="Queued for sequential rate-limited delivery"
      >
        <Clock className="w-3 h-3 text-amber-600" />
        <span>Queued</span>
      </span>
    );
  };

  return (
    <div
      className={`glass-card p-6 sm:p-7 rounded-3xl border border-slate-200/90 shadow-sm space-y-6 bg-white ${className}`}
    >
      {/* Top Header & Action Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100">
        <div className="flex items-start gap-3.5">
          <div
            className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-xs ${
              hasActiveMessages
                ? "bg-blue-100 text-blue-700 ring-2 ring-blue-50"
                : hasFailedMessages
                ? "bg-amber-100 text-amber-700 ring-2 ring-amber-50"
                : "bg-emerald-50 text-emerald-600 ring-2 ring-emerald-50"
            }`}
          >
            {hasActiveMessages ? (
              <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            ) : hasFailedMessages ? (
              <Inbox className="w-5 h-5 stroke-[2.2]" />
            ) : (
              <CheckCircle2 className="w-5 h-5 stroke-[2.2]" />
            )}
          </div>

          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
                Live WhatsApp Dispatch Queue &amp; Delivery Monitor
              </h3>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
                  <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                  Checking queue...
                </span>
              ) : hasActiveMessages ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800 border border-blue-200/80">
                  <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                  {inFlightCount || pendingItems.length} In-Flight...
                </span>
              ) : hasFailedMessages ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200/80">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {failedItems.length} Action Required
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  All Messages Dispatched
                </span>
              )}
            </div>

            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
              Real-time multi-status tracking of automated student admission invites, fee
              reminders, and academic notifications.
            </p>
          </div>
        </div>

        {/* Action Buttons: Refresh, Clear Delivered, & Retry */}
        <div className="flex items-center gap-2 self-start md:self-center flex-wrap">
          <button
            type="button"
            onClick={() => fetchQueue(false)}
            disabled={loading || refreshing}
            className="tap-bounce flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-all disabled:opacity-50 cursor-pointer"
            title="Refresh live queue status"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-slate-500 ${refreshing ? "animate-spin text-blue-600" : ""}`}
            />
            <span>Refresh</span>
          </button>

          {summary.delivered > 0 && (
            <button
              type="button"
              onClick={handleOpenClearModal}
              disabled={loading || clearingDelivered}
              className="tap-bounce flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200/80 text-xs font-bold transition-all disabled:opacity-50 cursor-pointer"
              title="Clear confirmed delivered messages from active feed"
            >
              <Archive className="w-3.5 h-3.5 text-emerald-600" />
              <span>Clear Delivered ({summary.delivered})</span>
            </button>
          )}

          {/* Permanent Log Cleanup Button (Owner-only) */}
          <button
            type="button"
            onClick={handleOpenCleanupModal}
            disabled={executingCleanup}
            className="tap-bounce flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200/80 text-xs font-bold transition-all disabled:opacity-50 cursor-pointer"
            title="Permanently remove terminal dispatch records from database"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-600" />
            <span>
              Clear Logs
              {eligibleLogCount !== null && eligibleLogCount > 0
                ? ` (${eligibleLogCount})`
                : ""}
            </span>
          </button>

          <button
            type="button"
            onClick={handleRetryAll}
            disabled={!canRetry || retrying || hasActiveMessages}
            className={`tap-bounce flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-xs font-bold shadow-xs transition-all ${
              canRetry && !retrying && !hasActiveMessages
                ? "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 active:scale-[0.98] text-white shadow-emerald-500/25 cursor-pointer"
                : "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed opacity-75"
            }`}
            title={
              !isWhatsAppConnected
                ? "Connect WhatsApp in General tab to retry failed messages"
                : hasActiveMessages
                ? "Messages are currently being dispatched in the background..."
                : !hasFailedMessages
                ? "No failed messages to retry"
                : "Queue all failed messages for sequential retry (3-7s delay)"
            }
          >
            {retrying ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Re-queuing...</span>
              </>
            ) : hasActiveMessages ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                <span>Dispatching...</span>
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5 stroke-[2.2]" />
                <span>Retry Failed Messages ({failedItems.length})</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* KPI Metrics Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* In-Flight Pending */}
        <div
          onClick={() => setActiveView("pending")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            activeView === "pending"
              ? "bg-blue-50/80 border-blue-300 ring-2 ring-blue-100"
              : "bg-slate-50/60 border-slate-200/70 hover:bg-slate-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              In-Flight
            </span>
            {hasActiveMessages ? (
              <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
            ) : (
              <Clock className="w-3.5 h-3.5 text-slate-400" />
            )}
          </div>
          <div className="mt-1 text-xl font-extrabold text-slate-900 tracking-tight">
            {inFlightCount || pendingItems.length}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            {inFlightCount > 0 ? "Pending rate-limiter queue" : "Zero in-flight"}
          </div>
        </div>

        {/* Accepted by Provider */}
        <div
          onClick={() => setActiveView("activity")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            activeView === "activity"
              ? "bg-teal-50/80 border-teal-300 ring-2 ring-teal-100"
              : "bg-slate-50/60 border-slate-200/70 hover:bg-slate-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              Accepted
            </span>
            <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" />
          </div>
          <div className="mt-1 text-xl font-extrabold text-teal-900 tracking-tight">
            {summary.provider_accepted}
          </div>
          <div className="text-[10px] text-teal-700 mt-0.5">
            Accepted by WhatsApp
          </div>
        </div>

        {/* Confirmed Delivered */}
        <div
          onClick={() => setActiveView("activity")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            summary.delivered > 0
              ? "bg-emerald-50/40 border-emerald-200/80 hover:bg-emerald-50/70"
              : "bg-slate-50/60 border-slate-200/70 hover:bg-slate-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              Delivered
            </span>
            <CheckCheck className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="mt-1 text-xl font-extrabold text-emerald-900 tracking-tight">
            {summary.delivered}
          </div>
          <div className="text-[10px] text-emerald-700 mt-0.5">
            {summary.delivered > 0 ? "Confirmed terminal delivery" : "Zero active delivered"}
          </div>
        </div>

        {/* Action Required (Failed) */}
        <div
          onClick={() => setActiveView("failed")}
          className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
            activeView === "failed"
              ? "bg-rose-50/80 border-rose-300 ring-2 ring-rose-100"
              : hasFailedMessages
              ? "bg-amber-50/60 border-amber-200/80 hover:bg-amber-50"
              : "bg-slate-50/60 border-slate-200/70 hover:bg-slate-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              Failed
            </span>
            <AlertCircle
              className={`w-3.5 h-3.5 ${hasFailedMessages ? "text-rose-600" : "text-slate-400"}`}
            />
          </div>
          <div
            className={`mt-1 text-xl font-extrabold tracking-tight ${
              hasFailedMessages ? "text-rose-900" : "text-slate-900"
            }`}
          >
            {failedItems.length}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            {hasFailedMessages ? "Needs retry dispatch" : "Zero failed messages"}
          </div>
        </div>
      </div>

      {/* Disconnected Warning Note when items exist but WhatsApp is offline */}
      {hasFailedMessages && !isWhatsAppConnected && (
        <div className="p-3.5 rounded-2xl bg-amber-50/90 border border-amber-200 text-amber-900 text-xs font-medium flex items-center gap-2.5">
          <WifiOff className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span>
            <strong>WhatsApp Engine Disconnected:</strong> Reconnect your
            WhatsApp account in the General tab to enable the &quot;Retry Failed Messages&quot;
            button.
          </span>
        </div>
      )}

      {/* Feedback Alert Banner */}
      {feedback && (
        <div
          className={`p-3.5 rounded-2xl text-xs flex items-center gap-2.5 animate-fade-in ${
            feedback.type === "success"
              ? "bg-emerald-50 text-emerald-900 border border-emerald-200"
              : "bg-rose-50 text-rose-900 border border-rose-200"
          }`}
        >
          {feedback.type === "success" ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600" />
          )}
          <span className="font-semibold leading-relaxed">
            {feedback.message}
          </span>
        </div>
      )}

      {/* Primary View Switcher & Type Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        {/* View Switcher Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100/90 rounded-2xl self-start overflow-x-auto max-w-full no-scrollbar">
          <button
            type="button"
            onClick={() => setActiveView("activity")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeView === "activity"
                ? "bg-white text-slate-900 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-blue-600" />
            <span>Activity</span>
            {recentActivity.length > 0 && (
              <span className="ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] bg-slate-100 text-slate-600">
                {recentActivity.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveView("failed")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeView === "failed"
                ? "bg-white text-slate-900 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <AlertCircle
              className={`w-3.5 h-3.5 ${
                failedItems.length > 0 ? "text-rose-600" : "text-slate-400"
              }`}
            />
            <span>Action Required</span>
            {failedItems.length > 0 && (
              <span className="ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] bg-rose-100 text-rose-800 font-extrabold">
                {failedItems.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveView("pending")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeView === "pending"
                ? "bg-white text-slate-900 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-amber-600" />
            <span>In-Flight</span>
            {pendingItems.length > 0 && (
              <span className="ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 text-blue-800 font-extrabold">
                {pendingItems.length}
              </span>
            )}
          </button>
        </div>

        {/* Message Type Filter & Archive Toggle */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 self-start sm:self-auto max-w-full no-scrollbar">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1 mr-1 flex-shrink-0">
            <Filter className="w-3 h-3" />
            Filter:
          </span>
          <button
            type="button"
            onClick={() => setActiveFilter("all")}
            className={`tap-bounce px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer flex-shrink-0 ${
              activeFilter === "all"
                ? "bg-slate-900 text-white shadow-2xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter("admission_welcome")}
            className={`tap-bounce px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer flex-shrink-0 ${
              activeFilter === "admission_welcome"
                ? "bg-emerald-600 text-white shadow-2xs"
                : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            }`}
          >
            Admissions
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter("fee_reminder")}
            className={`tap-bounce px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer flex-shrink-0 ${
              activeFilter === "fee_reminder"
                ? "bg-amber-600 text-white shadow-2xs"
                : "bg-amber-50 text-amber-800 hover:bg-amber-100"
            }`}
          >
            Fee Reminders
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter("campaign")}
            className={`tap-bounce px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer flex-shrink-0 ${
              activeFilter === "campaign"
                ? "bg-indigo-600 text-white shadow-2xs"
                : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            }`}
          >
            Announcements
          </button>

          {summary.archived && summary.archived > 0 ? (
            <button
              type="button"
              onClick={() => {
                const nextState = !includeArchived;
                setIncludeArchived(nextState);
                fetchQueue(false, nextState);
              }}
              className={`tap-bounce px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1 flex-shrink-0 ${
                includeArchived
                  ? "bg-purple-600 text-white shadow-2xs"
                  : "bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200/60"
              }`}
              title="Toggle visibility of archived delivered messages"
            >
              <Archive className="w-3 h-3" />
              <span>{includeArchived ? "Hide Archived" : `Archived (${summary.archived})`}</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Content: Table / List View OR Empty State */}
      {loading && filteredItems.length === 0 ? (
        <div className="p-8 rounded-2xl bg-slate-50/70 border border-slate-100 flex flex-col items-center justify-center gap-2 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <p className="text-xs font-semibold text-slate-500">
            Loading live message queue...
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="p-8 rounded-2xl bg-gradient-to-br from-emerald-50/40 via-white to-white border border-emerald-100 text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto shadow-2xs">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-extrabold text-slate-900">
            {activeView === "failed"
              ? "Zero Failed Messages"
              : activeView === "pending"
              ? "No Messages In-Flight"
              : activeFilter === "all"
              ? "No Recent Messaging Activity"
              : "No messages in this filter"}
          </h4>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            {activeView === "failed"
              ? "All notifications have been successfully delivered or accepted. No failed messages requiring retry."
              : activeView === "pending"
              ? "All pending messages have been processed through the rate-limiting queue."
              : "Notifications dispatched to parents for admissions and fee reminders will stream here live."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/90 shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/90 text-slate-500 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200/80">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Type
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Student &amp; Parent Phone
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Delivery Details / Error
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Timestamp
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filteredItems.map((item) => (
                  <tr
                    key={item.id}
                    className="hover:bg-slate-50/70 transition-colors"
                  >
                    {/* Message Type Pill */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {item.type === "admission_welcome" ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200/60">
                          <GraduationCap className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                          <span>Admission Welcome</span>
                        </span>
                      ) : item.type === "fee_reminder" ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200/60">
                          <Bell className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                          <span>Fee Reminder</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-800 border border-indigo-200/60">
                          <MessageSquare className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0" />
                          <span>{item.typeLabel || "Announcement"}</span>
                        </span>
                      )}
                    </td>

                    {/* Student Name & Recipient Phone */}
                    <td className="px-4 py-3.5">
                      <div className="font-bold text-slate-900 text-xs">
                        {item.studentName || "Student"}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono flex items-center gap-1 mt-0.5">
                        <Smartphone className="w-3 h-3 text-slate-400" />
                        <span>{formatPhoneDisplay(item.recipientPhone)}</span>
                      </div>
                    </td>

                    {/* Distinct Status Badge */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {renderStatusBadge(item)}
                    </td>

                    {/* Reason / Delivery Notes */}
                    <td className="px-4 py-3.5 text-slate-600 max-w-xs">
                      {item.error ? (
                        <span
                          className={`text-[11px] font-medium truncate block ${
                            item.status === "pending" || item.status === "processing"
                              ? "text-blue-600 font-semibold"
                              : item.status === "outcome_unknown" || item.status === "ambiguous"
                              ? "text-amber-700 font-semibold"
                              : "text-rose-600"
                          }`}
                          title={item.error}
                        >
                          {item.error}
                        </span>
                      ) : item.status === "outcome_unknown" || item.status === "ambiguous" ? (
                        <span className="text-[11px] text-amber-700 font-medium">
                          Dispatch outcome uncertain: awaiting delivery acknowledgment
                        </span>
                      ) : item.status === "delivered" ? (
                        <span className="text-[11px] text-emerald-700 font-medium">
                          Delivered to parent phone
                        </span>
                      ) : item.status === "provider_accepted" ? (
                        <span className="text-[11px] text-teal-700 font-medium">
                          Accepted by WhatsApp server
                        </span>
                      ) : item.status === "sent" ? (
                        <span className="text-[11px] text-emerald-700 font-medium">
                          Dispatched successfully
                        </span>
                      ) : item.status === "simulated" ? (
                        <span className="text-[11px] text-purple-700 font-medium">
                          Logged under simulation
                        </span>
                      ) : item.status === "processing" ? (
                        <span className="text-[11px] text-blue-600 font-medium">
                          In anti-ban dispatch queue (3–7s delay)
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">
                          Queued for dispatch
                        </span>
                      )}
                    </td>

                    {/* Timestamp */}
                    <td className="px-4 py-3.5 text-right whitespace-nowrap text-[11px] font-medium text-slate-500 font-mono">
                      {formatDateTime(item.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Clear Delivered Confirmation Modal */}
      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-fade-in">
          <div className="relative w-full max-w-md bg-white rounded-3xl p-6 shadow-2xl border border-slate-100 space-y-4">
            <div className="flex items-start justify-between">
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <Archive className="w-5 h-5" />
              </div>
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                className="p-1 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <h4 className="text-base font-bold text-slate-900">
                Clear Delivered Messages?
              </h4>
              <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                This will archive <strong className="text-slate-900">{summary.delivered}</strong> confirmed delivered message(s) from your active live feed.
              </p>
              <p className="text-[11px] text-slate-500 mt-2.5 bg-slate-50 p-2.5 rounded-xl border border-slate-100 leading-relaxed">
                🔒 <strong>Non-destructive:</strong> Records are safely soft-archived. Your historical audit logs, parent communication receipts, and reports remain permanently intact in the database.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                disabled={clearingDelivered}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmClearDelivered}
                disabled={clearingDelivered}
                className="tap-bounce flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs transition-all disabled:opacity-50 cursor-pointer"
              >
                {clearingDelivered ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Clearing...</span>
                  </>
                ) : (
                  <>
                    <CheckCheck className="w-3.5 h-3.5" />
                    <span>Confirm Clear ({summary.delivered})</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent Clear Logs Confirmation Modal */}
      {showCleanupModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !executingCleanup) {
              setShowCleanupModal(false);
            }
          }}
        >
          <div
            className="relative w-full max-w-lg bg-white rounded-3xl p-6 shadow-2xl border border-slate-100 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-slate-900">
                    Clear WhatsApp Dispatch Logs
                  </h4>
                  <span className="text-[11px] font-semibold text-rose-600 uppercase tracking-wider">
                    Permanent Deletion — Owner Only
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowCleanupModal(false)}
                disabled={executingCleanup}
                className="p-1 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Warning Banner */}
            <div className="bg-amber-50 border border-amber-200/80 rounded-2xl p-3.5 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-900 leading-relaxed">
                <p className="font-bold">Permanent hard deletion</p>
                <p className="mt-0.5 text-amber-800">
                  This permanently removes terminal dispatch records from the database. This action <strong>cannot be undone</strong>.
                </p>
              </div>
            </div>

            {/* Error Banners */}
            {previewError && (
              <div className="bg-rose-50 border border-rose-200/80 rounded-2xl p-3.5 flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-rose-900 leading-relaxed">
                    <p className="font-bold">Could not load preview</p>
                    <p className="mt-0.5 text-rose-800">{previewError}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={fetchCleanupPreview}
                  disabled={loadingCleanupPreview}
                  className="tap-bounce px-2.5 py-1 rounded-lg bg-rose-100 hover:bg-rose-200 text-rose-800 text-[11px] font-bold shrink-0 cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}

            {cleanupError && (
              <div className="bg-rose-50 border border-rose-200/80 rounded-2xl p-3.5 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div className="text-xs text-rose-900 leading-relaxed">
                  <p className="font-bold">Cleanup Failed</p>
                  <p className="mt-0.5 text-rose-800">{cleanupError}</p>
                </div>
              </div>
            )}

            {/* Preview Statistics or Loader */}
            {loadingCleanupPreview ? (
              <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-500">
                <Loader2 className="w-6 h-6 animate-spin text-rose-500" />
                <span className="text-xs font-medium">Scanning terminal records...</span>
              </div>
            ) : cleanupPreview ? (
              <div className="space-y-3">
                {/* Count Cards */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-emerald-50/70 border border-emerald-100 rounded-2xl p-3 text-center">
                    <span className="text-[11px] font-medium text-emerald-700 block">
                      Delivered & Sent
                    </span>
                    <span className="text-xl font-bold text-emerald-800 mt-1 block">
                      {cleanupPreview.successfulCount}
                    </span>
                    <span className="text-[10px] text-emerald-600">
                      Terminal Success
                    </span>
                  </div>
                  <div className="bg-rose-50/70 border border-rose-100 rounded-2xl p-3 text-center">
                    <span className="text-[11px] font-medium text-rose-700 block">
                      Permanently Failed
                    </span>
                    <span className="text-xl font-bold text-rose-800 mt-1 block">
                      {cleanupPreview.failedCount}
                    </span>
                    <span className="text-[10px] text-rose-600">
                      Terminal Failures
                    </span>
                  </div>
                </div>

                {/* Safety Guarantee */}
                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3 space-y-1">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <span>Protected Records ({cleanupPreview.protectedCount} safely preserved)</span>
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    Pending, in-flight, retry-locked, and provider-accepted records awaiting delivery confirmation are <strong>never deleted</strong>. Student admissions, fees, receipts, and parent inbox items remain untouched.
                  </p>
                </div>

                {/* Breakdown by Job Type */}
                {cleanupPreview.breakdown && (
                  <div className="border border-slate-100 rounded-2xl p-3 bg-white text-xs space-y-2">
                    <div className="font-semibold text-slate-700 text-[11px] uppercase tracking-wider">
                      Record Breakdown
                    </div>
                    <div className="divide-y divide-slate-100 text-slate-600 text-xs">
                      <div className="py-1.5 flex justify-between">
                        <span>Fee Reminder Logs</span>
                        <span className="font-bold text-slate-900">
                          {cleanupPreview.breakdown.feeReminders?.totalEligible ?? 0} eligible
                        </span>
                      </div>
                      <div className="py-1.5 flex justify-between">
                        <span>Admission Welcome Jobs</span>
                        <span className="font-bold text-slate-900">
                          {cleanupPreview.breakdown.admissionWelcome?.totalEligible ?? 0} eligible
                        </span>
                      </div>
                      <div className="py-1.5 flex justify-between">
                        <span>Message Campaigns</span>
                        <span className="font-bold text-slate-900">
                          {cleanupPreview.breakdown.campaigns?.totalEligible ?? 0} eligible
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-4 text-center">
                Could not load log preview. You can still confirm to clean up eligible records.
              </p>
            )}

            {/* Explicit Confirmation Checkbox */}
            <div className="pt-1">
              <label className="flex items-start gap-2.5 p-3 rounded-2xl border border-slate-200 bg-slate-50/60 hover:bg-slate-50 cursor-pointer select-none transition-colors">
                <input
                  type="checkbox"
                  checked={cleanupConfirmed}
                  onChange={(e) => setCleanupConfirmed(e.target.checked)}
                  disabled={executingCleanup}
                  className="mt-0.5 rounded text-rose-600 focus:ring-rose-500 w-4 h-4 cursor-pointer"
                />
                <span className="text-xs font-medium text-slate-700 leading-relaxed">
                  I understand this permanently removes{" "}
                  {cleanupPreview?.eligibleTotal ?? eligibleLogCount ?? ""}{" "}
                  terminal dispatch records and cannot be undone.
                </span>
              </label>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowCleanupModal(false)}
                disabled={executingCleanup}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmCleanup}
                disabled={
                  !cleanupConfirmed ||
                  executingCleanup ||
                  (cleanupPreview !== null && cleanupPreview.eligibleTotal === 0)
                }
                className={`tap-bounce flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white shadow-xs transition-all ${
                  cleanupConfirmed &&
                  !executingCleanup &&
                  !(cleanupPreview !== null && cleanupPreview.eligibleTotal === 0)
                    ? "bg-rose-600 hover:bg-rose-700 active:scale-[0.98] cursor-pointer"
                    : "bg-slate-200 text-slate-400 cursor-not-allowed"
                }`}
              >
                {executingCleanup ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Cleaning up...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>
                      Permanently Clear Logs
                      {cleanupPreview?.eligibleTotal !== undefined
                        ? ` (${cleanupPreview.eligibleTotal})`
                        : eligibleLogCount !== null && eligibleLogCount > 0
                        ? ` (${eligibleLogCount})`
                        : ""}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
