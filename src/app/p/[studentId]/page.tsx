"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import TopHeader from "@/components/layout/TopHeader";
import ChildProfileHeader from "@/components/parent/ChildProfileHeader";
import AttendanceProgressCard from "@/components/parent/AttendanceProgressCard";
import FeeActionCard from "@/components/parent/FeeActionCard";
import FeeHistoryCard from "@/components/parent/FeeHistoryCard";
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

interface ParentInfo {
  id: string;
  parentName?: string;
  parentPhone?: string;
  isPasswordProtected: boolean;
  linkedStudents: LinkedStudentInfo[];
  selectedStudentId?: string;
}

interface ParentPortalPayload {
  parent?: ParentInfo;
  student: ApiStudent;
  center: ApiCenter;
  attendanceStats: ApiAttendanceStats;
  fees: ApiFees;
  testResults: ApiTestResult[];
  requirePassword?: boolean;
  sessionToken?: string;
}

function getInitials(name: string): string {
  if (!name) return "ST";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatDate(dateString?: string | null): string {
  if (!dateString) return "Upcoming";
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

export default function ParentMagicLinkPage() {
  const routeParams = useParams();
  const rawTokenOrId =
    typeof routeParams?.studentId === "string"
      ? routeParams.studentId
      : Array.isArray(routeParams?.studentId)
      ? routeParams.studentId[0]
      : "";

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

  // Password Management Modal State
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [securityActionLoading, setSecurityActionLoading] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);

  const backendUrl =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

  // Fetch real Parent Portal data on mount from backend API
  const loadPortalData = useCallback(
    async (targetStudentId?: string) => {
      if (!rawTokenOrId) {
        setError("No portal access token specified in link.");
        setLoading(false);
        return;
      }

      // If opening with a high-entropy portal token (pt_...), seamlessly redirect to canonical /portal#token=... flow
      if (rawTokenOrId.startsWith("pt_") && typeof window !== "undefined") {
        window.location.replace(`/portal#token=${rawTokenOrId}`);
        return;
      }

      setLoading(true);
      setError(null);
      setIsRevoked(false);
      setIsLocked(false);

      try {
        const queryParams = new URLSearchParams();
        if (targetStudentId) {
          queryParams.set("studentId", targetStudentId);
        }

        const url = `${backendUrl}/parent/portal/${rawTokenOrId}${
          queryParams.toString() ? `?${queryParams.toString()}` : ""
        }`;

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

        const res = await fetch(url, {
          method: "GET",
          headers,
          credentials: "include", // send/receive session cookie
        });

        const json = await res.json();

        // 1. Check for password requirement
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
                "Portal access locked due to failed password attempts."
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
        setSelectedStudentId(currentChildId);

        // Clean-URL exchange: strip raw token pt_... from address bar once authenticated
        if (
          typeof window !== "undefined" &&
          currentChildId &&
          window.location.pathname.includes("pt_")
        ) {
          window.history.replaceState(
            { studentId: currentChildId },
            "",
            `/p/${currentChildId}`
          );
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
    [rawTokenOrId, backendUrl]
  );

  useEffect(() => {
    loadPortalData();
  }, [loadPortalData]);

  // Handle password unlock submission
  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockPassword.trim()) return;

    setUnlockLoading(true);
    setUnlockError(null);

    try {
      const res = await fetch(
        `${backendUrl}/parent/portal/${rawTokenOrId}/unlock`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ password: unlockPassword.trim() }),
        }
      );

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(
          json.error ||
            `Incorrect password.${
              json.remainingAttempts !== undefined
                ? ` (${json.remainingAttempts} attempts remaining)`
                : ""
            }`
        );
      }

      setRequirePassword(false);
      setUnlockPassword("");
      await loadPortalData();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to unlock portal";
      setUnlockError(msg);
    } finally {
      setUnlockLoading(false);
    }
  };

  // Handle Child Switcher with Clean-URL preservation
  const handleSelectChild = (childId: string) => {
    if (childId === selectedStudentId) return;
    loadPortalData(childId);
    if (typeof window !== "undefined") {
      window.history.replaceState({ studentId: childId }, "", `/p/${childId}`);
    }
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

      const res = await fetch(
        `${backendUrl}/parent/portal/${rawTokenOrId}/password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            action,
            newPassword,
            currentPassword,
          }),
        }
      );

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
      await loadPortalData();
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
        <TopHeader
          title="Tuition Desk"
          subtitle="VIP Parent Portal • Live Progress"
          badgeText="Verified Parent"
          showLogout={false}
        />
        <div className="p-4 space-y-4 max-w-lg mx-auto w-full animate-pulse">
          <div className="h-10 w-full rounded-2xl bg-slate-200/90" />
          <div className="h-28 rounded-3xl bg-slate-200/90 p-4 flex items-center gap-4">
            <div className="h-16 w-16 rounded-2xl bg-slate-300" />
            <div className="flex-1 space-y-2">
              <div className="h-5 w-36 bg-slate-300 rounded" />
              <div className="h-3 w-48 bg-slate-300 rounded" />
            </div>
          </div>
          <div className="h-40 rounded-3xl bg-slate-200/80 p-5 space-y-3">
            <div className="h-4 w-28 bg-slate-300 rounded" />
            <div className="h-8 w-44 bg-slate-300 rounded-lg" />
            <div className="h-10 w-full bg-slate-300/80 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  // 2. Password Protection Gate Modal / View
  if (requirePassword) {
    return (
      <div className="flex flex-col min-h-screen bg-slate-50">
        <TopHeader
          title={data?.center?.name || "Tuition Center"}
          subtitle="VIP Parent Portal • Protected Access"
          badgeText="Protected"
          showLogout={false}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="max-w-sm w-full rounded-3xl border border-slate-200 bg-white p-6 shadow-xl space-y-5 text-center">
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
        <TopHeader
          title="Tuition Desk"
          subtitle="VIP Parent Portal"
          badgeText="Link Status"
          showLogout={false}
        />
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
                  : error?.includes("Authentication required")
                  ? "Active Parent Session Required"
                  : "Portal Record Not Found"}
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                {error?.includes("Authentication required")
                  ? "To view this student's records, please open the private VIP portal link sent to your registered WhatsApp number, or contact your institute."
                  : error ||
                    "The requested student magic link is invalid or may have expired."}
              </p>
            </div>
            {error?.includes("Authentication required") ? (
              <a
                href="/portal"
                className="tap-bounce w-full h-11 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center shadow-md shadow-blue-600/20"
              >
                Go to Parent Portal
              </a>
            ) : (
              <button
                onClick={() => loadPortalData()}
                className="tap-bounce w-full h-11 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center shadow-md shadow-blue-600/20"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const { student, center, attendanceStats, fees, testResults, parent } = data;

  const studentName = student.name || "Student";
  const batchName = student.batch || "Regular Batch";
  const initials = getInitials(studentName);
  const formattedDueDate = formatDate(fees.dueDate);
  const upiId = center?.upiId || "tuitiondesk@upi";

  return (
    <div className="flex flex-col min-h-full relative bg-slate-50/50">
      {/* Top Header */}
      <TopHeader
        title={center?.name || "Tuition Center"}
        subtitle="VIP Parent Portal • Live Progress"
        badgeText="Verified Parent"
        showLogout={false}
      />

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

          {/* Quick Security / PIN Protection Trigger */}
          <button
            onClick={() => setShowSecurityModal(true)}
            className="absolute top-3.5 right-3.5 p-2 rounded-xl bg-slate-50/80 hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors border border-slate-200/60"
            title="Portal Privacy & Password Settings"
          >
            {parent?.isPasswordProtected ? (
              <Lock className="w-4 h-4 text-purple-600" />
            ) : (
              <KeyRound className="w-4 h-4 text-slate-400" />
            )}
          </button>
        </div>

        {/* 2. Crucial Fee Action Card (Real fee from MongoDB) */}
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
          rejectionReason={fees.rejectionReason}
          onPaymentSuccess={() => {
            handlePaymentSuccess();
            loadPortalData(selectedStudentId);
          }}
          onUtrSubmitted={(utr) => {
            setToastMessage(`Payment reference ${utr} submitted for verification!`);
            setTimeout(() => setToastMessage(null), 4500);
            loadPortalData(selectedStudentId);
          }}
          onAdvancePaymentSuccess={() => {
            setToastMessage(
              "Advance payment submitted successfully! Awaiting center verification."
            );
            setTimeout(() => setToastMessage(null), 4500);
            loadPortalData(selectedStudentId);
          }}
          onProofSubmitted={() => {
            setToastMessage(
              "Payment proof submitted! Center staff will verify your payment."
            );
            setTimeout(() => setToastMessage(null), 4500);
            loadPortalData(selectedStudentId);
          }}
          isPaid={isPaid || fees.status === "Paid"}
        />

        {/* 2.5 Fee Payment History (Paid Receipts Archive) */}
        <FeeHistoryCard
          history={fees.history}
          studentName={student?.name}
          centerName={center?.name}
        />

        {/* 3. Core Metric: Overall Attendance % */}
        <AttendanceProgressCard
          percentage={attendanceStats.percentage}
          totalClasses={attendanceStats.totalClasses}
          attended={attendanceStats.attended}
          missed={attendanceStats.missed}
        />

        {/* 4. Performance & Test Results (Real Test Marks from MongoDB) */}
        <div className="rounded-3xl border border-slate-100 bg-white p-4.5 shadow-sm space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center">
                <Award className="h-4 w-4 stroke-[2.2]" />
              </div>
              <div>
                <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">
                  Recent Test Marks
                </h3>
                <p className="text-[11px] text-slate-500">
                  Evaluated classroom tests &amp; quizzes
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">
              <GraduationCap className="h-3 w-3" />
              {testResults.length} Tests
            </span>
          </div>

          {testResults.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center space-y-1.5">
              <Sparkles className="h-5 w-5 text-slate-400 mx-auto" />
              <p className="text-xs font-semibold text-slate-700">
                No Tests Recorded Yet
              </p>
              <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                Evaluated test scores and performance ratings will appear here
                once published by the center.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5 pt-1">
              {testResults.map((test) => {
                const isGreat = test.percentage >= 80;
                const isPassing = test.percentage >= 50;

                const badgeBg = test.isAbsent
                  ? "bg-rose-50 text-rose-700 border-rose-200"
                  : isGreat
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : isPassing
                  ? "bg-blue-50 text-blue-700 border-blue-200"
                  : "bg-amber-50 text-amber-700 border-amber-200";

                return (
                  <div
                    key={test.id}
                    className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3.5 space-y-2 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <h4 className="text-[13px] font-bold text-slate-900 leading-snug">
                          {test.title}
                        </h4>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 font-medium">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3 text-slate-400" />
                            {formatDate(test.date)}
                          </span>
                          <span>•</span>
                          <span>{test.batch}</span>
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        {test.isAbsent ? (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border ${badgeBg}`}
                          >
                            Absent
                          </span>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-xs font-extrabold text-slate-900 font-mono">
                              <span className="text-[14px]">
                                {test.marksObtained}
                              </span>
                              <span className="text-slate-400 font-normal">
                                /{test.maxMarks}
                              </span>
                            </span>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${badgeBg}`}
                            >
                              {test.percentage}%
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {!test.isAbsent && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            isGreat
                              ? "bg-emerald-500"
                              : isPassing
                              ? "bg-blue-500"
                              : "bg-amber-500"
                          }`}
                          style={{
                            width: `${Math.min(
                              100,
                              Math.max(0, test.percentage)
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 5. Direct Teacher Connect Card */}
        <div className="rounded-3xl border border-slate-100 bg-white p-4 shadow-sm space-y-2.5">
          <h3 className="text-[13px] font-bold text-slate-800">
            Have questions about {studentName}&apos;s progress?
          </h3>
          <p className="text-[11px] text-slate-500">
            You can reach out directly to tuition head{" "}
            {center?.ownerName || "the Center Head"}.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <a
              href={`tel:+91${center?.phone || "9876543210"}`}
              rel="noreferrer"
              className="tap-bounce flex-1 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors"
            >
              <Phone className="h-3.5 w-3.5 text-slate-600" />
              Call Center
            </a>
            <a
              href={`https://wa.me/91${center?.phone || "9876543210"}`}
              target="_blank"
              rel="noreferrer"
              className="tap-bounce flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp
            </a>
          </div>
        </div>
      </div>

      {/* Parent Security Modal (PIN Setup / Removal) */}
      {showSecurityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in">
          <div className="max-w-sm w-full bg-white rounded-3xl p-5 shadow-2xl space-y-4 border border-slate-100">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-purple-600" />
                <span>Portal Privacy &amp; Security</span>
              </h4>
              <button
                onClick={() => {
                  setShowSecurityModal(false);
                  setSecurityError(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {securityError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-xs font-semibold">
                {securityError}
              </div>
            )}

            {parent?.isPasswordProtected ? (
              <div className="space-y-3.5">
                <p className="text-xs text-slate-500 leading-relaxed">
                  This portal is currently protected with a password. Enter your
                  current password to remove protection and restore direct link
                  access.
                </p>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-700 block">
                    Current Password:
                  </label>
                  <input
                    type="password"
                    placeholder="Enter current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-xs font-bold"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowSecurityModal(false)}
                    className="px-3.5 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleSaveSecurity("remove")}
                    disabled={securityActionLoading || !currentPassword}
                    className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm"
                  >
                    {securityActionLoading && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    )}
                    <span>Remove Password</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3.5">
                <p className="text-xs text-slate-500 leading-relaxed">
                  Direct link access is active. You can optionally set a 4–32
                  character PIN or password for extra privacy.
                </p>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-700 block">
                    New PIN / Password:
                  </label>
                  <input
                    type="password"
                    placeholder="Minimum 4 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-xs font-bold"
                  />
                  <input
                    type="password"
                    placeholder="Confirm password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-xs font-bold"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowSecurityModal(false)}
                    className="px-3.5 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleSaveSecurity("set")}
                    disabled={
                      securityActionLoading ||
                      !newPassword ||
                      newPassword !== confirmPassword
                    }
                    className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                  >
                    {securityActionLoading && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    )}
                    <span>Set Password</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
