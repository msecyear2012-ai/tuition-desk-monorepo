"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { getParentPortalAuthHeaders } from "@/lib/parentPortalLink";
import {
  Bell,
  BellOff,
  Inbox,
  CheckCircle2,
  Calendar,
  CreditCard,
  Megaphone,
  Loader2,
  RefreshCw,
  Search,
  Filter,
  User,
  Clock,
  Sparkles,
} from "lucide-react";

export interface ParentNotificationItem {
  id: string;
  campaignId: string;
  title: string;
  campaignType: string;
  body: string;
  status: string;
  studentId?: string | null;
  studentName?: string;
  parentName?: string;
  dispatchedAt: string;
  createdAt: string;
}

interface ParentInboxProps {
  rawToken?: string;
  className?: string;
}

export default function ParentInbox({
  rawToken,
  className = "",
}: ParentInboxProps) {
  const [notifications, setNotifications] = useState<ParentNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<"all" | "attendance" | "fee" | "announcement">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const backendUrl =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

  const fetchNotifications = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const queryParams = new URLSearchParams();
        const effectiveRawToken =
          rawToken ||
          (typeof window !== "undefined"
            ? sessionStorage.getItem("parent_portal_raw_token") ||
              localStorage.getItem("parent_portal_raw_token")
            : "");
        if (effectiveRawToken) {
          queryParams.set("token", effectiveRawToken);
        }

        const url = `${backendUrl}/parent/notifications${
          queryParams.toString() ? `?${queryParams.toString()}` : ""
        }`;

        const authHeaders = getParentPortalAuthHeaders();

        const res = await fetch(url, {
          method: "GET",
          headers: {
            ...authHeaders,
          },
          credentials: "include",
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to load notification history");
        }

        setNotifications(data.notifications || []);
      } catch (err: any) {
        console.error("[PARENT INBOX ERROR]", err);
        setError(err.message || "Could not fetch notifications");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [backendUrl, rawToken]
  );

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const filteredNotifications = useMemo(() => {
    return notifications.filter((item) => {
      // Type matching
      const typeLower = (item.campaignType || "").toLowerCase();
      if (filterType === "attendance" && !typeLower.includes("attendance")) {
        return false;
      }
      if (filterType === "fee" && !typeLower.includes("fee")) {
        return false;
      }
      if (
        filterType === "announcement" &&
        (typeLower.includes("attendance") || typeLower.includes("fee"))
      ) {
        return false;
      }

      // Query matching
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = item.title?.toLowerCase().includes(q);
        const matchesBody = item.body?.toLowerCase().includes(q);
        const matchesStudent = item.studentName?.toLowerCase().includes(q);
        return matchesTitle || matchesBody || matchesStudent;
      }

      return true;
    });
  }, [notifications, filterType, searchQuery]);

  const formatNotificationDate = (dateString?: string) => {
    if (!dateString) return "Recently";
    try {
      const d = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffMins < 2) return "Just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24 && now.getDate() === d.getDate()) {
        return `Today at ${d.toLocaleTimeString("en-IN", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })}`;
      }
      if (diffDays === 1) {
        return `Yesterday at ${d.toLocaleTimeString("en-IN", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })}`;
      }
      return d.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
      });
    } catch {
      return dateString;
    }
  };

  const getTypeMetadata = (typeStr: string) => {
    const t = typeStr.toLowerCase();
    if (t.includes("attendance")) {
      return {
        label: "Attendance",
        icon: Calendar,
        badgeStyle: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
        iconBoxStyle: "bg-emerald-50 text-emerald-600 border-emerald-100",
      };
    }
    if (t.includes("fee")) {
      return {
        label: "Fee Reminder",
        icon: CreditCard,
        badgeStyle: "bg-amber-50 text-amber-700 border-amber-200/80",
        iconBoxStyle: "bg-amber-50 text-amber-600 border-amber-100",
      };
    }
    return {
      label: "Announcement",
      icon: Megaphone,
      badgeStyle: "bg-blue-50 text-blue-700 border-blue-200/80",
      iconBoxStyle: "bg-blue-50 text-blue-600 border-blue-100",
    };
  };

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Top Controls: Filter Pills & Search */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-3 shadow-xs space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shrink-0">
              <Inbox className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Notification Inbox
              </h3>
              <p className="text-[11px] text-slate-500">
                Official alerts dispatched to your registered contact
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => fetchNotifications(true)}
            disabled={loading || refreshing}
            className="p-2 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors border border-slate-200/60 cursor-pointer disabled:opacity-50"
            title="Refresh notifications"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-xs">
          <button
            type="button"
            onClick={() => setFilterType("all")}
            className={`px-3 py-1.5 rounded-xl font-medium transition-colors shrink-0 cursor-pointer ${
              filterType === "all"
                ? "bg-blue-600 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            All ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterType("attendance")}
            className={`px-3 py-1.5 rounded-xl font-medium transition-colors shrink-0 cursor-pointer ${
              filterType === "attendance"
                ? "bg-emerald-600 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Attendance
          </button>
          <button
            type="button"
            onClick={() => setFilterType("fee")}
            className={`px-3 py-1.5 rounded-xl font-medium transition-colors shrink-0 cursor-pointer ${
              filterType === "fee"
                ? "bg-amber-600 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Fees
          </button>
          <button
            type="button"
            onClick={() => setFilterType("announcement")}
            className={`px-3 py-1.5 rounded-xl font-medium transition-colors shrink-0 cursor-pointer ${
              filterType === "announcement"
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Announcements
          </button>
        </div>

        {/* Search input (visible if > 3 notifications) */}
        {notifications.length > 3 && (
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notifications..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200/80 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
        )}
      </div>

      {/* Loading Skeleton */}
      {loading && !refreshing && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs animate-pulse space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 bg-slate-200 rounded-lg" />
                  <div className="h-4 w-28 bg-slate-200 rounded-md" />
                </div>
                <div className="h-3 w-16 bg-slate-200 rounded-md" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3.5 w-full bg-slate-200 rounded-md" />
                <div className="h-3.5 w-4/5 bg-slate-200 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error Banner */}
      {error && !loading && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 text-xs text-rose-700 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => fetchNotifications()}
            className="text-xs font-semibold text-rose-800 underline cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && filteredNotifications.length === 0 && (
        <div className="bg-white border border-slate-200/80 rounded-3xl p-8 text-center shadow-xs space-y-3">
          <div className="w-14 h-14 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center mx-auto border border-slate-200/60">
            <BellOff className="w-6 h-6" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-800">
              No Notifications Found
            </h4>
            <p className="text-xs text-slate-500 max-w-xs mx-auto mt-1">
              {searchQuery || filterType !== "all"
                ? "No notifications match your current filter criteria."
                : "All official attendance alerts, fee receipts, and institute announcements will appear here permanently."}
            </p>
          </div>
          {(searchQuery || filterType !== "all") && (
            <button
              type="button"
              onClick={() => {
                setFilterType("all");
                setSearchQuery("");
              }}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 underline cursor-pointer"
            >
              Reset Filters
            </button>
          )}
        </div>
      )}

      {/* Notification List */}
      {!loading && filteredNotifications.length > 0 && (
        <div className="space-y-3">
          {filteredNotifications.map((item) => {
            const meta = getTypeMetadata(item.campaignType);
            const Icon = meta.icon;

            return (
              <div
                key={item.id}
                className="bg-white border border-slate-200/80 hover:border-slate-300 rounded-2xl p-4 shadow-xs transition-all space-y-2.5"
              >
                {/* Header: Badge & Date */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center border shrink-0 ${meta.iconBoxStyle}`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${meta.badgeStyle}`}
                    >
                      {meta.label}
                    </span>

                    {item.studentName && (
                      <span className="text-[10px] font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <User className="w-2.5 h-2.5 text-slate-400" />
                        {item.studentName}
                      </span>
                    )}
                  </div>

                  <span className="text-[11px] text-slate-400 flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3" />
                    {formatNotificationDate(item.dispatchedAt)}
                  </span>
                </div>

                {/* Title (if distinct) */}
                {item.title && item.title !== meta.label && (
                  <h4 className="text-xs font-bold text-slate-900 leading-snug">
                    {item.title}
                  </h4>
                )}

                {/* Message Body */}
                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-line break-words bg-slate-50/60 p-2.5 rounded-xl border border-slate-100">
                  {item.body}
                </p>

                {/* Footer Status */}
                <div className="flex items-center justify-between pt-1 text-[10px] text-slate-400">
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                    Dispatched to verified parent WhatsApp
                  </span>
                  <span className="capitalize text-slate-400">
                    {item.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
