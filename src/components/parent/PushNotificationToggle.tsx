"use client";

import { useWebPush } from "@/hooks/useWebPush";
import {
  Bell,
  BellRing,
  BellOff,
  Smartphone,
  Globe,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";

interface PushNotificationToggleProps {
  rawToken?: string;
  className?: string;
}

export default function PushNotificationToggle({
  rawToken,
  className = "",
}: PushNotificationToggleProps) {
  const {
    isSupported,
    isStandalone,
    permission,
    isSubscribed,
    loading,
    error,
    subscribe,
    unsubscribe,
  } = useWebPush();

  if (!isSupported) {
    return (
      <div
        className={`bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500 flex items-center gap-2 ${className}`}
      >
        <AlertCircle className="w-4 h-4 text-slate-400 shrink-0" />
        <span>Push notifications are not supported on this browser version.</span>
      </div>
    );
  }

  const handleToggle = async () => {
    if (isSubscribed) {
      await unsubscribe(rawToken);
    } else {
      await subscribe(rawToken);
    }
  };

  const isBlocked = permission === "denied";

  return (
    <div
      className={`bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs transition-all ${className}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              isSubscribed
                ? "bg-emerald-50 text-emerald-600 border border-emerald-200/60"
                : isBlocked
                ? "bg-rose-50 text-rose-500 border border-rose-200/60"
                : "bg-blue-50 text-blue-600 border border-blue-200/60"
            }`}
          >
            {isSubscribed ? (
              <BellRing className="w-5 h-5 animate-pulse" />
            ) : isBlocked ? (
              <BellOff className="w-5 h-5" />
            ) : (
              <Bell className="w-5 h-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-slate-900">
                Push Notifications
              </h4>
              <span
                className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 ${
                  isStandalone
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200/60"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {isStandalone ? (
                  <>
                    <Smartphone className="w-3 h-3" /> App Alert
                  </>
                ) : (
                  <>
                    <Globe className="w-3 h-3" /> Browser Alert
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {isSubscribed
                ? "Real-time attendance & fee reminders are active."
                : isBlocked
                ? "Notifications are blocked in your browser settings."
                : "Get instant fee receipts and attendance updates."}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleToggle}
          disabled={loading || isBlocked}
          className={`px-4 py-2 text-xs font-medium rounded-xl transition-all flex items-center gap-1.5 shrink-0 shadow-xs cursor-pointer ${
            isSubscribed
              ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300/80"
              : isBlocked
              ? "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"
              : "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20"
          }`}
        >
          {loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            </>
          ) : isSubscribed ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Enabled</span>
            </>
          ) : isBlocked ? (
            <span>Blocked</span>
          ) : (
            <>
              <Bell className="w-3.5 h-3.5" />
              <span>Enable Alerts</span>
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mt-3 p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* iOS Safari PWA Installation Hint */}
      {!isStandalone && typeof window !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent) && (
        <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200/80 rounded-xl text-xs text-amber-800">
          <span className="font-semibold">iOS Note:</span> To receive push
          notifications on iPhone or iPad, tap the Share icon ⎋ and choose{" "}
          <span className="font-semibold">&quot;Add to Home Screen&quot;</span>, then
          open the portal from your home screen.
        </div>
      )}
    </div>
  );
}
