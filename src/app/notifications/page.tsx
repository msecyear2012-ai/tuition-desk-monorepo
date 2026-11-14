"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Bell,
  CheckCircle2,
  Info,
  CreditCard,
  Briefcase,
  Users,
  GraduationCap,
  MessageSquare,
  RefreshCw,
  Check,
  ChevronRight,
  FilterX,
} from "lucide-react";
import { useHeader, useSetHeader } from "@/components/layout/HeaderContext";

interface NotificationItem {
  _id: string;
  centerId: string;
  recipientId: string;
  recipientRole: string;
  category?: string;
  type: string;
  title: string;
  message: string;
  amount?: number;
  statusLabel?: string;
  feeId?: string;
  paymentId?: string;
  studentId?: string;
  studentName?: string;
  collectorName?: string;
  entityType?: string;
  entityId?: string;
  link?: string;
  deepLink?: string;
  isRead: boolean;
  createdAt: string;
}

const CATEGORIES = [
  { id: "all", label: "All Categories" },
  { id: "fee", label: "Fees & Collections" },
  { id: "handover", label: "Cash Handovers" },
  { id: "batch", label: "Batch Requests" },
  { id: "academic", label: "Academic & Tests" },
  { id: "communication", label: "Communication" },
  { id: "system", label: "System" },
];

function resolveNotificationCategory(category?: string, type?: string): string {
  if (category && category !== "general") return category.toLowerCase();
  if (type === "cash_collection" || type === "fee_reminder") return "fee";
  if (
    type === "handover_submitted" ||
    type === "handover_verified" ||
    type === "handover_rejected" ||
    type === "dispute_raised" ||
    type === "dispute_resolved"
  )
    return "handover";
  if (
    type === "batch_request_submitted" ||
    type === "batch_request_approved" ||
    type === "batch_request_rejected"
  )
    return "batch";
  if (
    type === "student_admitted" ||
    type === "attendance_marked" ||
    type === "test_scheduled" ||
    type === "test_result" ||
    type === "homework_assigned"
  )
    return "academic";
  if (type === "parent_message") return "communication";
  return "system";
}

function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getEmptyStateMessage(
  status: "all" | "unread" | "read",
  category: string
): { title: string; subtitle: string } {
  const categoryLabels: Record<string, string> = {
    fee: "fee and collection",
    handover: "cash handover",
    batch: "batch request",
    academic: "academic and test",
    communication: "communication",
    system: "system alert",
  };

  const catLabel = categoryLabels[category];

  if (status === "unread") {
    if (catLabel) {
      return {
        title: `No unread ${catLabel} notifications`,
        subtitle: `All ${catLabel} alerts have been marked as read.`,
      };
    }
    return {
      title: "No unread notifications",
      subtitle: "You have caught up with all alerts and updates!",
    };
  }

  if (status === "read") {
    if (catLabel) {
      return {
        title: `No read ${catLabel} notifications`,
        subtitle: `You don't have any archived ${catLabel} notifications.`,
      };
    }
    return {
      title: "No read notifications",
      subtitle: "Notifications you've marked as read will appear here.",
    };
  }

  // status === "all"
  if (catLabel) {
    return {
      title: `No ${catLabel} notifications`,
      subtitle: `No ${catLabel} notifications match your current filter selection.`,
    };
  }
  return {
    title: "No notifications found",
    subtitle: "Your center currently has no notifications in this view.",
  };
}

export default function NotificationCenterPage() {
  const headerContext = useHeader();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "read">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [totalCount, setTotalCount] = useState<number>(0);
  const [unreadCount, setUnreadCount] = useState<number>(0);

  useSetHeader({
    title: "Notification Center",
    subtitle: "Institute alerts, financial transactions, and academic updates",
    badgeText: "Inbox",
  });

  const refreshList = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      params.set("limit", "100");

      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data?.success) {
        const list = data.notifications || data.staffNotifications || [];
        setNotifications(list);
        setTotalCount(
          typeof data.totalCount === "number" ? data.totalCount : list.length
        );
        if (typeof data.unreadCount === "number") {
          setUnreadCount(data.unreadCount);
        }
      }
    } catch (err) {
      console.warn("[NOTIFICATION CENTER] Failed to refresh notifications:", err);
    } finally {
      setRefreshing(false);
    }
  }, [statusFilter, categoryFilter]);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (categoryFilter !== "all") params.set("category", categoryFilter);
        params.set("limit", "100");

        const res = await fetch(`/api/notifications?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();

        if (!ignore && data?.success) {
          const list = data.notifications || data.staffNotifications || [];
          setNotifications(list);
          setTotalCount(
            typeof data.totalCount === "number" ? data.totalCount : list.length
          );
          if (typeof data.unreadCount === "number") {
            setUnreadCount(data.unreadCount);
          }
        }
      } catch (err) {
        console.warn("[NOTIFICATION CENTER] Failed to fetch notifications:", err);
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      ignore = true;
    };
  }, [statusFilter, categoryFilter]);

  const handleMarkAsRead = async (notifId: string) => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId: notifId }),
      });

      // Optimistically update list and counts without resetting filters
      setNotifications((prev) =>
        statusFilter === "unread"
          ? prev.filter((n) => n._id !== notifId)
          : prev.map((n) => (n._id === notifId ? { ...n, isRead: true } : n))
      );

      if (statusFilter === "unread") {
        setTotalCount((c) => Math.max(0, c - 1));
      }
      setUnreadCount((c) => Math.max(0, c - 1));

      // Synchronize header badge in real time
      headerContext?.refreshAlerts();
    } catch {
      // ignore
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markAllRead: true,
          category: categoryFilter !== "all" ? categoryFilter : undefined,
        }),
      });

      // Optimistically update state
      if (statusFilter === "unread") {
        setNotifications([]);
        setTotalCount(0);
      } else {
        setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      }

      setUnreadCount(0);
      headerContext?.refreshAlerts();
    } catch {
      // ignore
    }
  };

  const handleResetFilters = () => {
    setStatusFilter("all");
    setCategoryFilter("all");
  };

  const getCategoryIcon = (category?: string, type?: string) => {
    const resolved = resolveNotificationCategory(category, type);

    if (resolved === "fee") {
      return {
        icon: CreditCard,
        bg: "bg-emerald-50 text-emerald-600 border-emerald-200",
        label: "Fee",
      };
    }
    if (resolved === "handover") {
      return {
        icon: Briefcase,
        bg: "bg-blue-50 text-blue-600 border-blue-200",
        label: "Handover",
      };
    }
    if (resolved === "batch") {
      return {
        icon: Users,
        bg: "bg-purple-50 text-purple-600 border-purple-200",
        label: "Batch",
      };
    }
    if (resolved === "academic") {
      return {
        icon: GraduationCap,
        bg: "bg-amber-50 text-amber-600 border-amber-200",
        label: "Academic",
      };
    }
    if (resolved === "communication") {
      return {
        icon: MessageSquare,
        bg: "bg-indigo-50 text-indigo-600 border-indigo-200",
        label: "Message",
      };
    }
    return {
      icon: Info,
      bg: "bg-slate-50 text-slate-600 border-slate-200",
      label: "System",
    };
  };

  const emptyState = getEmptyStateMessage(statusFilter, categoryFilter);
  const isFiltered = statusFilter !== "all" || categoryFilter !== "all";

  return (
    <div className="max-w-4xl mx-auto px-4 py-5 space-y-5">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
            <Bell className="h-5 w-5 text-blue-600" />
            Notification Center
            {unreadCount > 0 && (
              <span className="rounded-full bg-rose-500 text-white px-2 py-0.5 text-xs font-bold ring-2 ring-rose-100">
                {unreadCount} New
              </span>
            )}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time institute alerts, financial activity, and academic updates.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold shadow-xs transition-colors"
            >
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              Mark all as read
            </button>
          )}

          <button
            type="button"
            onClick={refreshList}
            disabled={refreshing}
            className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold shadow-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin text-blue-600" : ""}`}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter Tabs & Category Pills */}
      <div className="space-y-3 bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs">
        {/* Status Tabs */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-1">
            {(["all", "unread", "read"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all capitalize ${
                  statusFilter === tab
                    ? "bg-slate-900 text-white shadow-xs"
                    : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-slate-400">
              {totalCount} notification{totalCount !== 1 ? "s" : ""}
            </span>

            {isFiltered && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                title="Reset filters to All"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Category Pills (with horizontal touch-scroll on mobile) */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-0.5 pb-1 touch-pan-x">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(cat.id)}
              className={`flex-shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors border ${
                categoryFilter === cat.id
                  ? "bg-blue-50 text-blue-700 border-blue-200"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Notifications List */}
      <div className="space-y-2.5">
        {loading ? (
          <div className="space-y-2.5">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-20 rounded-2xl bg-white border border-slate-100 p-4 animate-pulse flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-xl bg-slate-100 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="w-1/3 h-3.5 bg-slate-100 rounded" />
                  <div className="w-2/3 h-3 bg-slate-100 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="rounded-3xl border border-slate-100 bg-white p-12 text-center space-y-3 shadow-xs">
            <div className="w-12 h-12 rounded-2xl bg-slate-50 text-slate-500 flex items-center justify-center mx-auto">
              {statusFilter === "unread" ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              ) : (
                <FilterX className="h-6 w-6 text-slate-400" />
              )}
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-800">
                {emptyState.title}
              </h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                {emptyState.subtitle}
              </p>
            </div>
            {isFiltered && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-colors"
              >
                Reset all filters
              </button>
            )}
          </div>
        ) : (
          notifications.map((notif) => {
            const { icon: Icon, bg, label } = getCategoryIcon(
              notif.category,
              notif.type
            );
            const destination = notif.deepLink || notif.link;

            return (
              <div
                key={notif._id}
                className={`group relative rounded-2xl border transition-all p-3.5 sm:p-4 flex items-start gap-3.5 bg-white ${
                  !notif.isRead
                    ? "border-blue-200/80 bg-blue-50/10 shadow-xs"
                    : "border-slate-200/70 hover:border-slate-300"
                }`}
              >
                {/* Unread Indicator Bar */}
                {!notif.isRead && (
                  <span className="absolute left-1 top-4 bottom-4 w-1 bg-blue-600 rounded-full" />
                )}

                {/* Category Icon */}
                <div
                  className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center flex-shrink-0 border shadow-2xs ${bg}`}
                >
                  <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
                </div>

                {/* Notification Content */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                        {label}
                      </span>
                      <h4
                        className={`text-xs sm:text-sm font-bold truncate ${
                          !notif.isRead ? "text-slate-900" : "text-slate-700"
                        }`}
                      >
                        {notif.title}
                      </h4>
                    </div>

                    <span className="text-[10px] font-medium text-slate-400 flex-shrink-0">
                      {formatRelativeTime(notif.createdAt)}
                    </span>
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed">
                    {notif.message}
                  </p>

                  {/* Context Badges / Metadata */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {typeof notif.amount === "number" && notif.amount > 0 && (
                      <span className="inline-flex items-center text-[10px] font-extrabold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200/60">
                        ₹{notif.amount.toLocaleString("en-IN")}
                      </span>
                    )}

                    {notif.statusLabel && (
                      <span className="inline-flex items-center text-[10px] font-semibold text-slate-600 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200">
                        {notif.statusLabel}
                      </span>
                    )}

                    {notif.studentName && (
                      <span className="inline-flex items-center text-[10px] font-medium text-slate-500">
                        Student:{" "}
                        <strong className="ml-1 text-slate-700">
                          {notif.studentName}
                        </strong>
                      </span>
                    )}

                    {/* Actions Row */}
                    <div className="ml-auto flex items-center gap-2">
                      {!notif.isRead && (
                        <button
                          type="button"
                          onClick={() => handleMarkAsRead(notif._id)}
                          title="Mark as read"
                          className="tap-bounce text-[10px] font-semibold text-slate-500 hover:text-blue-600 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-100 transition-colors"
                        >
                          <Check className="h-3 w-3" />
                          Mark read
                        </button>
                      )}

                      {destination && (
                        <Link
                          href={destination}
                          className="tap-bounce inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-800 bg-blue-50/60 hover:bg-blue-100/60 px-2.5 py-1 rounded-lg transition-colors"
                        >
                          Open
                          <ChevronRight className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
