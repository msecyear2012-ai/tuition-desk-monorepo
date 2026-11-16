"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSetHeader } from "@/components/layout/HeaderContext";
import ChildProfileHeader from "@/components/parent/ChildProfileHeader";
import AttendanceProgressCard from "@/components/parent/AttendanceProgressCard";
import FeeActionCard from "@/components/parent/FeeActionCard";
import FeeHistoryCard from "@/components/parent/FeeHistoryCard";
import PushNotificationToggle from "@/components/parent/PushNotificationToggle";
import ParentInbox from "@/components/parent/ParentInbox";
import {
  Award,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Phone,
  MessageCircle,
  Calendar,
  Sparkles,
  GraduationCap,
  Lock,
  Unlock,
  ShieldCheck,
  ShieldAlert,
  Users,
  KeyRound,
  X,
  ChevronRight,
  Inbox,
  CreditCard,
} from "lucide-react";

interface ApiStudent {
  _id: string;
  centerId: string;
  name: string;
  batch: string;
  parentWhatsApp: string;
  isActive: boolean;
  monthlyFee?: number;
  billingCycleDate?: number;
  advanceBalance?: number;
}

interface ApiCenter {
  name: string;
  ownerName: string;
  phone: string;
  upiId: string;
}

interface ApiAttendanceStats {
  percentage: number;
  totalClasses: number;
  attended: number;
  missed: number;
  history?: Array<{
    id: string;
    date: string;
    batch: string;
    status: string;
  }>;
}

interface ApiFees {
  feeId?: string | null;
  amountDue?: number;
  pendingAmount: number;
  dueDate: string | null;
  daysLate: number;
  status: "Pending" | "Paid" | "Verification Pending" | "Partial Paid";
  utrNumber?: string;
  rejectionReason?: string | null;
  month?: string;
  history?: Array<{
    id: string;
    month: string;
    title?: string;
    amountDue: number;
    paidAmount?: number;
    dueDate?: string | null;
    status: string;
    utrNumber?: string;
    receiptNumber?: string;
    paymentDate?: string | null;
    paidDate?: string | null;
    paidAt?: string | null;
    paymentMode?: string;
    createdAt?: string | null;
  }>;
}

interface ApiTestResult {
  id: string;
  title: string;
  batch: string;
  date: string;
  maxMarks: number;
  marksObtained: number;
  percentage: number;
  isAbsent?: boolean;
}

interface LinkedStudentInfo {
  _id: string;
  name: string;
  batch?: string;
  rollNumber?: string;
}

interface ParentPortalPayload {
  success: boolean;
  sessionToken?: string;
  requirePassword?: boolean;
  isPasswordProtected?: boolean;
  parent?: {
    id: string;
    parentName?: string;
    parentPhone?: string;
    tokenPrefix: string;
    isPasswordProtected: boolean;
    linkedStudents: LinkedStudentInfo[];
    selectedStudentId?: string;
  };
  student?: ApiStudent;
  center?: ApiCenter;
  attendanceStats?: ApiAttendanceStats;
  fees?: ApiFees;
  testResults?: ApiTestResult[];
  error?: string;
  revoked?: boolean;
  locked?: boolean;
}

function getInitials(name: string): string {
  if (!name) return "ST";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function formatDate(dateString?: string | null): string {
  if (!dateString) return "Immediate";
  try {
    const d = new Date(dateString);
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(dateString);
  }
}

export default function StaticParentPortalPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRevoked, setIsRevoked] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [requirePassword, setRequirePassword] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockLoading, setUnlockLoading] = useState(false);

  const [data, setData] = useState<ParentPortalPayload | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState<string>("");
  const [isPaid, setIsPaid] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [activePortalTab, setActivePortalTab] = useState<
    "overview" | "fees" | "attendance" | "inbox"
  >("overview");

  // Transient in-memory token extracted from hash fragment (never logged, wiped from URL)
  const inMemoryTokenRef = useRef<string>("");
  const [inMemoryToken, setInMemoryToken] = useState<string>("");

  // Password Management Modal State
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [securityActionLoading, setSecurityActionLoading] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);

  // Synchronize Parent Portal header config with the persistent root TopHeader
  useSetHeader({
    title: data?.center?.name || "Tuition Desk",
    subtitle: requirePassword
      ? "VIP Parent Portal • Security Gate"
      : error || !data || !data.student
      ? "VIP Parent Portal • Link Status"
      : "VIP Parent Portal • Live Progress",
    badgeText: requirePassword ? "PIN Protected" : "Verified Parent",
    showLogout: false,
    showNotifications: false,
  });

  const backendUrl =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

  const executeExchange = useCallback(
    async (tokenArg?: string, targetStudentId?: string, passwordArg?: string) => {
      setLoading(true);
      setError(null);
      setIsRevoked(false);
      setIsLocked(false);

      try {
        const payload: Record<string, string> = {};
        const activeToken = tokenArg || inMemoryTokenRef.current;
        if (activeToken) {
          payload.token = activeToken;
        }
        if (targetStudentId) {
          payload.studentId = targetStudentId;
        }
        if (passwordArg) {
          payload.password = passwordArg;
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        const storedToken =
          typeof window !== "undefined"
            ? sessionStorage.getItem("parent_portal_session_token") ||
              localStorage.getItem("parent_portal_session_token")
            : null;
        if (storedToken) {
          headers["Authorization"] = `Bearer ${storedToken}`;
        }

        const res = await fetch(`${backendUrl}/parent/portal/exchange`, {
          method: "POST",
          headers,
          credentials: "include",
          body: JSON.stringify(payload),
        });

        const json: ParentPortalPayload = await res.json();

        // 1. Password challenge gate
        if (json.requirePassword) {
          setRequirePassword(true);
          setData(json);
          setLoading(false);
          return;
        }

        if (!res.ok || !json.success) {
          if (res.status === 401 && typeof window !== "undefined") {
            sessionStorage.removeItem("parent_portal_session_token");
            localStorage.removeItem("parent_portal_session_token");
          }
          if (res.status === 403 || json.revoked) {
            setIsRevoked(true);
            throw new Error(
              json.error || "This portal access link has been revoked."
            );
          }
          if (res.status === 429 || json.locked) {
            setIsLocked(true);
            throw new Error(
              json.error ||
                "Portal access locked due to excessive failed password attempts."
            );
          }
          throw new Error(json.error || "Failed to load portal records");
        }

        if (json.sessionToken && typeof window !== "undefined") {
          sessionStorage.setItem("parent_portal_session_token", json.sessionToken);
          localStorage.setItem("parent_portal_session_token", json.sessionToken);
        }

        setRequirePassword(false);
        setData(json);

        const currentChildId =
          json.parent?.selectedStudentId || json.student?._id;
        if (currentChildId) {
          setSelectedStudentId(currentChildId);
        }

        if (
          json.fees?.status === "Paid" ||
          json.fees?.pendingAmount === 0
        ) {
          setIsPaid(true);
        } else {
          setIsPaid(false);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : "Unable to load student information";
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [backendUrl]
  );

  // Mount Effect: Extract token from hash, clean URL immediately, and exchange
  useEffect(() => {
    let rawToken = "";

    if (typeof window !== "undefined") {
      const hash = window.location.hash || "";
      if (hash) {
        // Strip # or #token=
        const trimmedHash = hash.replace(/^#/, "");
        if (trimmedHash.startsWith("token=")) {
          rawToken = trimmedHash.slice(6);
        } else if (trimmedHash.startsWith("pt_")) {
          rawToken = trimmedHash;
        }

        // Clean address bar IMMEDIATELY to prevent token exposure in referrer/history
        window.history.replaceState(null, "", window.location.pathname);
      }
    }

    if (rawToken) {
      inMemoryTokenRef.current = rawToken;
      setInMemoryToken(rawToken);
    }

    // Call exchange with token or rely on existing HttpOnly session cookie
    executeExchange(rawToken);
  }, [executeExchange]);

  // Handle password unlock submission
  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockPassword.trim()) return;

    setUnlockLoading(true);
    setUnlockError(null);

    try {
      await executeExchange(
        inMemoryTokenRef.current,
        selectedStudentId || undefined,
        unlockPassword.trim()
      );
      setUnlockPassword("");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to unlock portal";
      setUnlockError(msg);
    } finally {
      setUnlockLoading(false);
    }
  };

  // Handle Child Switcher
  const handleSelectChild = (childId: string) => {
    if (childId === selectedStudentId) return;
    executeExchange(undefined, childId);
  };

  // Handle Password Setup / Removal
  const handleSaveSecurity = async (action: "set" | "remove") => {
    setSecurityActionLoading(true);
    setSecurityError(null);

    try {
      if (action === "set") {
        if (!newPassword || newPassword.length < 4) {
          throw new Error("Password must be at least 4 characters long");
        }
        if (newPassword !== confirmPassword) {
          throw new Error("Passwords do not match");
        }
      } else {
        if (!currentPassword) {
          throw new Error("Current password is required to disable protection");
        }
      }

      const res = await fetch(`${backendUrl}/parent/portal/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action,
          newPassword,
          currentPassword,
          token: inMemoryTokenRef.current || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to update password settings");
      }

      setToastMessage(
        action === "set"
          ? "PIN/Password protection enabled successfully!"
          : "Password protection removed. Direct link access restored."
      );
      setTimeout(() => setToastMessage(null), 4000);

      setShowSecurityModal(false);
      setNewPassword("");
      setConfirmPassword("");
      setCurrentPassword("");
      await executeExchange(undefined, selectedStudentId || undefined);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Security update error";
      setSecurityError(msg);
    } finally {
      setSecurityActionLoading(false);
    }
  };

  const handlePaymentSuccess = () => {
    setIsPaid(true);
    setToastMessage(
      "Payment Successful! Official e-receipt generated and sent to WhatsApp."
    );
    setTimeout(() => setToastMessage(null), 4500);
  };

  // 1. Loading Skeleton State
  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-slate-50">
        <div className="p-4 space-y-4 max-w-lg mx-auto w-full animate-pulse">
          <div className="h-10 w-full rounded-2xl bg-slate-200/90" />
          <div className="h-28 rounded-3xl bg-slate-200/90 p-4 flex items-center gap-4">
            <div className="h-16 w-16 rounded-2xl bg-slate-300" />
            <div className="flex-1 space-y-2">
              <div className="h-5 w-36 bg-slate-300 rounded" />
              <div className="h-4 w-24 bg-slate-200 rounded" />
            </div>
          </div>
          <div className="h-44 rounded-3xl bg-slate-200/90" />
          <div className="h-32 rounded-3xl bg-slate-200/90" />
        </div>
      </div>
    );
  }

  // 2. Password Challenge Gate
  if (requirePassword) {
    return (
      <div className="flex flex-col min-h-screen bg-slate-50">
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="max-w-sm w-full rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-lg space-y-4">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-50 text-purple-600 border border-purple-100">
              <Lock className="h-7 w-7" />
            </div>

            <div className="space-y-1">
              <h2 className="text-lg font-bold text-slate-900">
                Enter Portal PIN / Password
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                This portal link has been password-protected by the parent for
                added privacy.
              </p>
            </div>

            {unlockError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-xs font-semibold text-left">
                {unlockError}
              </div>
            )}

            <form onSubmit={handleUnlockSubmit} className="space-y-3.5">
              <input
                type="password"
                required
                placeholder="Enter your PIN or password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                className="w-full h-11 px-3.5 rounded-2xl border border-slate-200 text-center text-sm font-bold tracking-widest focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />

              <button
                type="submit"
                disabled={unlockLoading || !unlockPassword.trim()}
                className="tap-bounce w-full h-11 rounded-2xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-purple-600/25 transition-all disabled:opacity-50"
              >
                {unlockLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Unlock className="w-4 h-4" />
                )}
                <span>Unlock Student Portal</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // 3. Error States (Revoked / Locked / Invalid)
  if (error || !data || !data.student) {
    return (
      <div className="flex flex-col min-h-screen bg-slate-50">
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="max-w-sm w-full rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-lg space-y-4">
            <div
              className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${
                isRevoked
                  ? "bg-amber-50 text-amber-600 border border-amber-100"
                  : isLocked
                  ? "bg-purple-50 text-purple-600 border border-purple-100"
                  : "bg-rose-50 text-rose-600 border border-rose-100"
              }`}
            >
              {isRevoked ? (
                <ShieldAlert className="h-7 w-7" />
              ) : isLocked ? (
                <Lock className="h-7 w-7" />
              ) : (
                <AlertCircle className="h-7 w-7" />
              )}
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-slate-900">
                {isRevoked
                  ? "Access Link Revoked"
                  : isLocked
                  ? "Portal Temporarily Locked"
                  : "Portal Record Not Found"}
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                {error ||
                  "The requested student magic link is invalid or may have expired."}
              </p>
            </div>
            <button
              onClick={() => executeExchange()}
              className="tap-bounce w-full h-11 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center shadow-md shadow-blue-600/20"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { student, center, attendanceStats, fees, testResults, parent } = data;

  const studentName = student.name || "Student";
  const batchName = student.batch || "Regular Batch";
  const initials = getInitials(studentName);
  const formattedDueDate = formatDate(fees?.dueDate);
  const upiId = center?.upiId || "tuitiondesk@upi";

  return (
    <div className="flex flex-col min-h-full relative bg-slate-50/50">
      {/* Floating Success Toast */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 w-[92%] max-w-sm z-50 animate-bounce">
          <div className="rounded-2xl bg-slate-900 text-white p-3.5 shadow-xl flex items-center gap-2.5 border border-slate-700">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex-1 text-xs font-semibold leading-snug">
              {toastMessage}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="p-4 space-y-4 pb-24 max-w-lg mx-auto w-full">
        {/* Child Switcher Navigation (If 2+ siblings linked to this parent) */}
        {parent?.linkedStudents && parent.linkedStudents.length > 1 && (
          <div className="rounded-2xl bg-slate-200/80 p-1 flex items-center gap-1 overflow-x-auto shadow-2xs">
            {parent.linkedStudents.map((child) => {
              const isSelected = child._id === selectedStudentId;
              return (
                <button
                  key={child._id}
                  onClick={() => handleSelectChild(child._id)}
                  className={`tap-bounce flex-1 min-w-[120px] py-1.5 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
                    isSelected
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span className="truncate">{child.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 1. Header & Profile Card: Real Student & Batch + Security Toggle */}
        <div className="relative">
          <ChildProfileHeader
            childName={studentName}
            batchName={batchName}
            rollNumber={student._id.slice(-4).toUpperCase()}
            initials={initials}
            avatarColor="bg-blue-100 text-blue-700 border-blue-200"
          />

          <button
            onClick={() => setShowSecurityModal(true)}
            className="absolute top-3.5 right-3.5 p-2 rounded-xl bg-slate-50/80 hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors border border-slate-200/60 cursor-pointer"
            title="Portal Privacy & Password Settings"
          >
            {parent?.isPasswordProtected ? (
              <Lock className="w-4 h-4 text-purple-600" />
            ) : (
              <KeyRound className="w-4 h-4 text-slate-400" />
            )}
          </button>
        </div>

        {/* 1.2 Portal Section Navigation Tabs */}
        <div className="rounded-2xl bg-slate-200/80 p-1 flex items-center gap-1 shadow-2xs">
          <button
            type="button"
            onClick={() => setActivePortalTab("overview")}
            className={`tap-bounce flex-1 py-1.5 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activePortalTab === "overview"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Overview</span>
          </button>
          <button
            type="button"
            onClick={() => setActivePortalTab("fees")}
            className={`tap-bounce flex-1 py-1.5 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activePortalTab === "fees"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Fees</span>
          </button>
          <button
            type="button"
            onClick={() => setActivePortalTab("attendance")}
            className={`tap-bounce flex-1 py-1.5 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activePortalTab === "attendance"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Attendance</span>
          </button>
          <button
            type="button"
            onClick={() => setActivePortalTab("inbox")}
            className={`tap-bounce flex-1 py-1.5 px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activePortalTab === "inbox"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Inbox className="w-3.5 h-3.5" />
            <span>Inbox</span>
          </button>
        </div>

        {/* 1.5 Real-time Web Push / PWA Notification Card */}
        {activePortalTab === "overview" && (
          <PushNotificationToggle rawToken={inMemoryToken || inMemoryTokenRef.current} />
        )}

        {/* Tab: INBOX */}
        {activePortalTab === "inbox" && (
          <ParentInbox rawToken={inMemoryToken || inMemoryTokenRef.current} />
        )}

        {/* Tab: FEES */}
        {(activePortalTab === "overview" || activePortalTab === "fees") && (
          <>
            {fees ? (
              <FeeActionCard
                feeId={fees.feeId}
                studentId={student._id}
                centerId={student.centerId}
                amount={fees.pendingAmount}
                dueDate={formattedDueDate}
                daysLate={fees.daysLate}
                upiId={center?.upiId || upiId}
                centerName={center?.name || "Tuition Center"}
                status={fees.status}
                utrNumber={fees.utrNumber}
                advanceBalance={student.advanceBalance !== undefined ? Number(student.advanceBalance) : 0}
                rejectionReason={fees.rejectionReason}
                onPaymentSuccess={() => {
                  handlePaymentSuccess();
                  executeExchange(undefined, selectedStudentId);
                }}
                onUtrSubmitted={(utr) => {
                  setToastMessage(`Payment reference ${utr} submitted for verification!`);
                  setTimeout(() => setToastMessage(null), 4500);
                  executeExchange(undefined, selectedStudentId);
                }}
                onAdvancePaymentSuccess={() => {
                  setToastMessage(
                    "Advance payment submitted successfully! Awaiting center verification."
                  );
                  setTimeout(() => setToastMessage(null), 4500);
                  executeExchange(undefined, selectedStudentId);
                }}
                onProofSubmitted={() => {
                  setToastMessage(
                    "Payment proof submitted! Center staff will verify your payment."
                  );
                  setTimeout(() => setToastMessage(null), 4500);
                  executeExchange(undefined, selectedStudentId);
                }}
                isPaid={isPaid || fees.status === "Paid"}
              />
            ) : (
              <FeeActionCard
                feeId={null}
                studentId={student._id}
                centerId={student.centerId}
                amount={0}
                dueDate="Immediate"
                daysLate={0}
                upiId={center?.upiId || upiId}
                centerName={center?.name || "Tuition Center"}
                status="Paid"
                advanceBalance={student.advanceBalance !== undefined ? Number(student.advanceBalance) : 0}
                onAdvancePaymentSuccess={() => {
                  setToastMessage(
                    "Advance payment submitted successfully! Awaiting center verification."
                  );
                  setTimeout(() => setToastMessage(null), 4500);
                  executeExchange(undefined, selectedStudentId);
                }}
                isPaid={true}
              />
            )}

            {fees?.history && (
              <FeeHistoryCard
                history={fees.history}
                studentName={student?.name}
                centerName={center?.name}
              />
            )}
          </>
        )}

        {/* Tab: ATTENDANCE & ACADEMICS */}
        {(activePortalTab === "overview" || activePortalTab === "attendance") && (
          <>
            {attendanceStats && (
              <AttendanceProgressCard
                percentage={attendanceStats.percentage}
                totalClasses={attendanceStats.totalClasses}
                attended={attendanceStats.attended}
                missed={attendanceStats.missed}
              />
            )}

            {testResults && (
              <div className="rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-50 text-amber-600 border border-amber-100">
                      <Award className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-slate-900">
                        Academic Test Results
                      </h3>
                      <p className="text-[10px] text-slate-500">
                        Latest classroom evaluation reports
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {testResults.length} Tests
                  </span>
                </div>

                {testResults.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4 text-center">
                    <p className="text-xs text-slate-500 font-medium">
                      No graded tests recorded yet.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {testResults.slice(0, 5).map((test) => (
                      <div
                        key={test.id}
                        className="flex items-center justify-between p-3 rounded-2xl bg-slate-50 border border-slate-100"
                      >
                        <div className="space-y-0.5">
                          <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                            <span>{test.title}</span>
                            {test.percentage >= 80 && (
                              <Sparkles className="w-3 h-3 text-amber-500 fill-amber-500" />
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {formatDate(test.date)} • {test.batch}
                          </div>
                        </div>

                        <div className="text-right">
                          {test.isAbsent ? (
                            <span className="text-xs font-bold text-rose-600">
                              Absent
                            </span>
                          ) : (
                            <div>
                              <div className="text-xs font-bold text-slate-900">
                                {test.marksObtained} / {test.maxMarks}
                              </div>
                              <div
                                className={`text-[10px] font-semibold ${
                                  test.percentage >= 75
                                    ? "text-emerald-600"
                                    : test.percentage >= 50
                                    ? "text-amber-600"
                                    : "text-rose-600"
                                }`}
                              >
                                {test.percentage}%
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* 5. Center Contact Support Footer */}
        <div className="rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600 border border-blue-100">
              <Phone className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-900">
                Tuition Center Helpdesk
              </h3>
              <p className="text-[10px] text-slate-500">
                Managed by {center?.ownerName || "Center Head"}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            {center?.phone && (
              <>
                <a
                  href={`tel:${center.phone}`}
                  className="tap-bounce flex-1 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>Call Center</span>
                </a>
                <a
                  href={`https://wa.me/91${center.phone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tap-bounce flex-1 h-9 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center gap-1.5 border border-emerald-200/60 transition-colors"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>WhatsApp</span>
                </a>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Password Management Modal */}
      {showSecurityModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white border border-slate-200 shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-purple-50 text-purple-600 border border-purple-100">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Portal PIN Protection
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Optional password lock for student privacy
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSecurityModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {securityError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs font-semibold">
                {securityError}
              </div>
            )}

            {parent?.isPasswordProtected ? (
              <div className="space-y-3">
                <div className="p-3 rounded-2xl bg-purple-50/70 border border-purple-100 flex items-start gap-2 text-xs text-purple-900">
                  <ShieldCheck className="w-4 h-4 text-purple-600 shrink-0 mt-0.5" />
                  <span>
                    Your portal link is currently protected. Entering your PIN is
                    required whenever opening the portal on a new device.
                  </span>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700">
                    Enter Current PIN / Password to Disable
                  </label>
                  <input
                    type="password"
                    placeholder="Enter current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <button
                  onClick={() => handleSaveSecurity("remove")}
                  disabled={securityActionLoading || !currentPassword}
                  className="tap-bounce w-full h-10 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                >
                  {securityActionLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <span>Remove Password Protection</span>
                  )}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed">
                  Set a 4+ digit PIN or password. Anyone clicking your magic link
                  will need to enter this PIN to view reports or fees.
                </p>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700">
                    New PIN / Password
                  </label>
                  <input
                    type="password"
                    placeholder="At least 4 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-700">
                    Confirm PIN / Password
                  </label>
                  <input
                    type="password"
                    placeholder="Re-enter password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <button
                  onClick={() => handleSaveSecurity("set")}
                  disabled={
                    securityActionLoading ||
                    !newPassword ||
                    newPassword.length < 4 ||
                    newPassword !== confirmPassword
                  }
                  className="tap-bounce w-full h-10 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-purple-600/25 transition-colors disabled:opacity-50"
                >
                  {securityActionLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <span>Enable Password Protection</span>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
