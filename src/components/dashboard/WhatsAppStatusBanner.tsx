"use client";

import { useState, useEffect, useCallback, useRef, memo } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  QrCode,
  RefreshCw,
  CheckCircle2,
  X,
  ExternalLink,
  Smartphone,
  ShieldAlert,
} from "lucide-react";
import { getAuthenticatedCenter } from "@/lib/centerProfile";

interface WhatsAppStatusBannerProps {
  onStatusChange?: (isConnected: boolean) => void;
  className?: string;
}

function WhatsAppStatusBanner({
  onStatusChange,
  className = "",
}: WhatsAppStatusBannerProps) {
  const [isOwner, setIsOwner] = useState(false);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>("disconnected");
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [modalStatus, setModalStatus] = useState<string>("initializing");
  const [modalError, setModalError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const modalPollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const modalInitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const qrCodeRef = useRef<string | null>(null);
  const modalStatusRef = useRef<string>("initializing");

  // Keep stable reference to onStatusChange callback to prevent infinite re-render loops
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const lastReportedStatusRef = useRef<boolean | null>(null);

  // Notify parent only when connection state strictly changes
  const notifyStatusChange = useCallback((online: boolean) => {
    if (lastReportedStatusRef.current !== online) {
      lastReportedStatusRef.current = online;
      onStatusChangeRef.current?.(online);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (modalPollTimerRef.current) {
        clearInterval(modalPollTimerRef.current);
        modalPollTimerRef.current = null;
      }
      if (modalInitTimeoutRef.current) {
        clearTimeout(modalInitTimeoutRef.current);
        modalInitTimeoutRef.current = null;
      }
    };
  }, []);

  // 1. Verify caller role (restricted strictly to Owner)
  useEffect(() => {
    getAuthenticatedCenter().then((center) => {
      if (isMountedRef.current) {
        if (center?.role === "owner" || (!center?.role && center?.centerId)) {
          setIsOwner(true);
        } else {
          setIsOwner(false);
        }
      }
    });
  }, []);

  // 2. Poll /api/whatsapp/status every 30 seconds with stable callback
  const checkStatus = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      const res = await fetch("/api/whatsapp/status", { cache: "no-store" });
      const data = await res.json().catch(() => null);

      if (!isMountedRef.current) return;

      const online = Boolean(res.ok && data?.ready === true && data?.status === "connected");
      const statusStr = String(data?.status || (online ? "connected" : "disconnected"));
      setConnectionStatus(statusStr);
      setIsConnected((prev) => (prev !== online ? online : prev));
      notifyStatusChange(online);
    } catch {
      if (isMountedRef.current) {
        setConnectionStatus("disconnected");
        setIsConnected((prev) => (prev !== false ? false : prev));
        notifyStatusChange(false);
      }
    }
  }, [notifyStatusChange]);

  // Periodic polling hook with stable dependency array
  useEffect(() => {
    if (!isOwner) return;

    // Immediate initial check
    checkStatus();

    // 30-second interval polling
    pollTimerRef.current = setInterval(checkStatus, 30000);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isOwner, checkStatus]);

  // Close QR modal and cleanly terminate all modal polling and timeouts
  const handleCloseModal = useCallback(() => {
    setShowQrModal(false);
    setIsInitializing(false);
    setModalStatus("idle");
    setModalError(null);
    setQrCode(null);
    qrCodeRef.current = null;
    modalStatusRef.current = "idle";

    if (modalPollTimerRef.current) {
      clearInterval(modalPollTimerRef.current);
      modalPollTimerRef.current = null;
    }
    if (modalInitTimeoutRef.current) {
      clearTimeout(modalInitTimeoutRef.current);
      modalInitTimeoutRef.current = null;
    }
  }, []);

  // 3. Initiate QR pairing flow when modal opens
  const handleOpenPairing = async () => {
    setShowQrModal(true);
    setIsInitializing(true);
    setModalStatus("initializing");
    modalStatusRef.current = "initializing";
    setModalError(null);
    setQrCode(null);
    qrCodeRef.current = null;

    // Timeout guard: auto-abort if stuck in initializing for > 25 seconds
    if (modalInitTimeoutRef.current) clearTimeout(modalInitTimeoutRef.current);
    modalInitTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current && modalStatusRef.current === "initializing") {
        setIsInitializing(false);
        setModalStatus("error");
        modalStatusRef.current = "error";
        setModalError(
          "Initialization timed out. WhatsApp microservice did not respond in time. Please check your connection and click Retry."
        );
      }
    }, 25000);

    try {
      const res = await fetch("/api/whatsapp/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);

      if (!isMountedRef.current) return;

      if (!res.ok) {
        throw new Error(data?.error || `Failed to initialize (HTTP ${res.status})`);
      }

      if (modalInitTimeoutRef.current) {
        clearTimeout(modalInitTimeoutRef.current);
        modalInitTimeoutRef.current = null;
      }

      if (data?.qr) {
        qrCodeRef.current = data.qr;
        setQrCode(data.qr);
        setModalStatus("qr_ready");
        modalStatusRef.current = "qr_ready";
      } else if (data?.status === "connected" || data?.ready) {
        setModalStatus("connected");
        modalStatusRef.current = "connected";
        setIsConnected(true);
        notifyStatusChange(true);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        if (modalInitTimeoutRef.current) {
          clearTimeout(modalInitTimeoutRef.current);
          modalInitTimeoutRef.current = null;
        }
        setModalError(
          err instanceof Error ? err.message : "Failed to generate pairing QR code"
        );
        setModalStatus("error");
        modalStatusRef.current = "error";
      }
    } finally {
      if (isMountedRef.current) {
        setIsInitializing(false);
      }
    }
  };

  // 4. Modal fast-poll every 2.5s strictly while modal is open and not connected
  useEffect(() => {
    // Stop immediately if modal is closed or already connected
    if (!showQrModal || modalStatus === "connected") {
      if (modalPollTimerRef.current) {
        clearInterval(modalPollTimerRef.current);
        modalPollTimerRef.current = null;
      }
      return;
    }

    const pollStatus = async () => {
      if (!isMountedRef.current || modalStatusRef.current === "connected") return;
      try {
        const res = await fetch("/api/whatsapp/status", { cache: "no-store" });
        const data = await res.json().catch(() => null);

        if (!isMountedRef.current) return;

        // Update QR code if changed
        if (data?.qr && data.qr !== qrCodeRef.current) {
          qrCodeRef.current = data.qr;
          setQrCode(data.qr);
          setModalStatus("qr_ready");
          modalStatusRef.current = "qr_ready";
        }

        // Detect connection success
        if (res.ok && data?.ready === true && data?.status === "connected") {
          modalStatusRef.current = "connected";
          setModalStatus("connected");
          setIsConnected(true);
          notifyStatusChange(true);

          if (modalPollTimerRef.current) {
            clearInterval(modalPollTimerRef.current);
            modalPollTimerRef.current = null;
          }

          // Auto-close modal after 2 seconds on success
          setTimeout(() => {
            if (isMountedRef.current) {
              handleCloseModal();
            }
          }, 2000);
        }
      } catch {
        // graceful ignore during rapid polling
      }
    };

    modalPollTimerRef.current = setInterval(pollStatus, 2500);

    return () => {
      if (modalPollTimerRef.current) {
        clearInterval(modalPollTimerRef.current);
        modalPollTimerRef.current = null;
      }
    };
  }, [showQrModal, modalStatus === "connected", notifyStatusChange, handleCloseModal]);

  // If caller is not owner or status is connected, do not display the warning banner
  if (!isOwner || isConnected === true || isConnected === null) {
    return null;
  }

  return (
    <>
      {/* Disconnection or Reconnecting Warning Banner */}
      <div
        className={`rounded-2xl border p-4 shadow-xs animate-in fade-in ${
          connectionStatus === "reconnecting"
            ? "border-blue-300/80 bg-gradient-to-r from-blue-50 via-blue-50/70 to-white text-blue-900"
            : "border-amber-300/80 bg-gradient-to-r from-amber-50 via-amber-50/80 to-white text-amber-900"
        } ${className}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 shadow-2xs ${
                connectionStatus === "reconnecting"
                  ? "bg-blue-100 text-blue-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {connectionStatus === "reconnecting" ? (
                <RefreshCw className="w-5 h-5 animate-spin text-blue-600" />
              ) : (
                <AlertTriangle className="w-5 h-5 stroke-[2.2]" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider">
                  {connectionStatus === "reconnecting"
                    ? "WhatsApp Reconnecting Automatically"
                    : "WhatsApp Disconnected"}
                </h4>
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    connectionStatus === "reconnecting"
                      ? "bg-blue-200/60 text-blue-800"
                      : "bg-amber-200/60 text-amber-800"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      connectionStatus === "reconnecting"
                        ? "bg-blue-600 animate-ping"
                        : "bg-amber-600"
                    }`}
                  />
                  {connectionStatus === "reconnecting" ? "Auto-Recovery" : "Paused"}
                </span>
              </div>
              <p
                className={`mt-0.5 text-xs leading-relaxed font-medium ${
                  connectionStatus === "reconnecting" ? "text-blue-800" : "text-amber-800"
                }`}
              >
                {connectionStatus === "reconnecting"
                  ? "Reconnecting to WhatsApp using your saved center credentials. Outbound messages will dispatch automatically once re-established."
                  : "WhatsApp is disconnected. Outbound messages are currently paused."}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center">
            {connectionStatus !== "reconnecting" && (
              <button
                onClick={handleOpenPairing}
                className="tap-bounce inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 active:scale-[0.98] text-white text-xs font-bold shadow-xs transition-all cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Reconnect / Scan QR</span>
              </button>
            )}
            <Link
              href="/settings?tab=general"
              className="tap-bounce inline-flex items-center justify-center p-2 rounded-xl bg-white/80 hover:bg-white text-slate-600 hover:text-slate-900 border border-slate-200 text-xs font-semibold transition-all"
              title="Open Full WhatsApp Settings"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>

      {/* Interactive QR Code Pairing Modal */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 animate-in fade-in duration-200">
          <div className="relative w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-slate-100 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <QrCode className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-slate-900">
                    Pair WhatsApp Account
                  </h3>
                  <p className="text-[11px] text-slate-500 font-medium">
                    Scan to resume outbound reminders
                  </p>
                </div>
              </div>
              <button
                onClick={handleCloseModal}
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors cursor-pointer"
                aria-label="Close dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body State */}
            {modalStatus === "connected" ? (
              <div className="py-6 flex flex-col items-center justify-center text-center space-y-2">
                <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-inner">
                  <CheckCircle2 className="w-8 h-8 stroke-[2.4]" />
                </div>
                <h4 className="text-base font-extrabold text-slate-900">
                  Connected Successfully!
                </h4>
                <p className="text-xs text-slate-500">
                  WhatsApp automation is active. You can now retry any failed messages.
                </p>
              </div>
            ) : modalError ? (
              <div className="py-4 space-y-3 text-center">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center">
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <p className="text-xs text-rose-700 font-medium">{modalError}</p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    onClick={handleOpenPairing}
                    className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800"
                  >
                    Retry Initialization
                  </button>
                  <button
                    onClick={handleCloseModal}
                    className="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-xs font-bold hover:bg-slate-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : isInitializing || !qrCode ? (
              <div className="py-8 flex flex-col items-center justify-center text-center space-y-3">
                <RefreshCw className="w-8 h-8 text-blue-600 animate-spin" />
                <p className="text-xs font-semibold text-slate-600">
                  Generating secure pairing QR code...
                </p>
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="mt-2 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 flex flex-col items-center justify-center">
                  <div className="bg-white p-3 rounded-xl shadow-xs">
                    <QRCodeSVG
                      value={qrCode}
                      size={180}
                      level="M"
                      includeMargin={false}
                    />
                  </div>
                  <div className="mt-2.5 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                    <span>Live QR Code • Ready to scan</span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-600 bg-slate-50/80 p-3 rounded-xl border border-slate-200/60 space-y-1">
                  <p className="font-bold text-slate-800 flex items-center gap-1">
                    <Smartphone className="w-3.5 h-3.5 text-blue-600" />
                    How to Link:
                  </p>
                  <ol className="list-decimal list-inside space-y-0.5 text-slate-600 font-medium">
                    <li>Open WhatsApp on coaching phone</li>
                    <li>Go to Settings &gt; Linked Devices</li>
                    <li>Tap &quot;Link a Device&quot; and point camera at QR</li>
                  </ol>
                </div>
              </div>
            )}

            <div className="pt-2 flex items-center justify-between text-xs border-t border-slate-100">
              <Link
                href="/settings?tab=general"
                onClick={handleCloseModal}
                className="text-blue-600 hover:text-blue-700 font-bold inline-flex items-center gap-1"
              >
                <span>Full WhatsApp Settings</span>
                <ExternalLink className="w-3 h-3" />
              </Link>
              <button
                onClick={handleCloseModal}
                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default memo(WhatsAppStatusBanner);
