"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import AttendanceHeader from "@/components/attendance/AttendanceHeader";
import StudentAttendanceRow from "@/components/attendance/StudentAttendanceRow";
import StickySaveBar from "@/components/attendance/StickySaveBar";
import { apiClient, getCurrentCenterId, invalidateApiCache } from "@/lib/apiClient";
import { getAuthenticatedCenter, type CenterInfo } from "@/lib/centerProfile";
import {
  AttendanceStatus,
  QuickBatchAttendance,
  StudentAttendanceItem,
  TeacherRecord,
} from "@/types";
import { CheckCircle2, AlertCircle, Users, RefreshCw, Loader2, Layers } from "lucide-react";

interface ApiBatch {
  _id: string;
  name: string;
  timing?: string;
  subject?: string;
  isActive?: boolean;
}

interface ApiStudent {
  _id: string;
  centerId: string;
  name: string;
  batch: string;
  parentWhatsApp: string;
  assignedTeacherId?: string | null;
  isActive: boolean;
  createdAt: string;
}

interface ApiAttendanceRecord {
  _id: string;
  centerId: string;
  studentId: string | { _id: string };
  assignedTeacherId?: string | null;
  date: string;
  batch: string;
  status: "Present" | "Absent";
}

interface AttendanceSaveResponse {
  success: boolean;
  count: number;
  data: unknown[];
  notifications?: {
    attempted: number;
    sent: number;
    simulated: number;
    failed: number;
    status: "none" | "simulated" | "sent" | "disabled" | "failed";
    message: string;
  };
  error?: string;
}

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700 border-blue-200",
  "bg-purple-100 text-purple-700 border-purple-200",
  "bg-emerald-100 text-emerald-700 border-emerald-200",
  "bg-amber-100 text-amber-800 border-amber-200",
  "bg-rose-100 text-rose-700 border-rose-200",
  "bg-cyan-100 text-cyan-700 border-cyan-200",
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Returns today's calendar date string (YYYY-MM-DD) under Asia/Kolkata (IST = UTC+5:30).
 */
function getTodayISTString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

/**
 * Formats canonical YYYY-MM-DD date into localized Indian date label.
 */
function formatISTDisplay(dateStr: string): string {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "Today";
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export default function AttendancePage() {
  const [userProfile, setUserProfile] = useState<CenterInfo | null>(null);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [selectedTeacherFilter, setSelectedTeacherFilter] = useState<string>("all");

  // Dynamic Batches state
  const [batches, setBatches] = useState<ApiBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(true);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");

  // Attendance Date state (canonical YYYY-MM-DD in IST)
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayISTString());

  // Batch-Specific Students state
  const [batchStudents, setBatchStudents] = useState<ApiStudent[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState<string | null>(null);

  // Attendance Map & Status
  const [attendanceMap, setAttendanceMap] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [notificationToast, setNotificationToast] = useState<string | null>(null);

  // Stale response guard ref
  const requestEpochRef = useRef(0);

  // Fetch teachers for Owner faculty filters
  const fetchTeachers = useCallback(async () => {
    try {
      const res = await apiClient<{ data?: TeacherRecord[] }>("/teachers?isActive=true");
      const list = Array.isArray(res.data)
        ? res.data
        : res.data && Array.isArray((res.data as { data?: TeacherRecord[] }).data)
        ? ((res.data as { data?: TeacherRecord[] }).data as TeacherRecord[])
        : [];
      setTeachers(list.filter((t) => t.isActive !== false));
    } catch (err) {
      console.error("Failed to fetch teachers for attendance:", err);
    }
  }, []);

  // Fetch user profile on mount
  useEffect(() => {
    async function loadProfile() {
      try {
        const profile = await getAuthenticatedCenter();
        setUserProfile(profile);
        if (profile?.role === "owner") {
          fetchTeachers();
        }
      } catch (err) {
        console.error("Failed to load user profile:", err);
      }
    }
    loadProfile();
  }, [fetchTeachers]);

  // Quick teacher ID to name lookup map
  const teacherMap = useMemo(() => {
    const map: Record<string, string> = {};
    teachers.forEach((t) => {
      map[t._id] = t.name;
    });
    return map;
  }, [teachers]);

  // 1. Fetch Dynamic Batches from Authenticated Backend API
  const fetchBatches = useCallback(async (isRefresh = false) => {
    setBatchesLoading(true);
    setBatchesError(null);

    try {
      const res = await apiClient<ApiBatch[]>("/batches", {
        params: { centerId: getCurrentCenterId() },
        skipCache: isRefresh,
      });

      const list = Array.isArray(res.data) ? res.data : [];
      setBatches(list);

      // Resolve selected batch ID: check URL query param (?batchId=... or legacy ?batch=...)
      let targetBatchId = "";
      if (typeof window !== "undefined") {
        const urlParams = new URLSearchParams(window.location.search);
        const urlBatchId = urlParams.get("batchId");
        const urlBatchName = urlParams.get("batch");

        if (urlBatchId && list.some((b) => b._id === urlBatchId)) {
          targetBatchId = urlBatchId;
        } else if (urlBatchName) {
          const match = list.find((b) => b.name === urlBatchName);
          if (match) targetBatchId = match._id;
        }
      }

      if (!targetBatchId && list.length > 0) {
        targetBatchId = list[0]._id;
      }

      setSelectedBatchId(targetBatchId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load batches";
      setBatchesError(msg);
    } finally {
      setBatchesLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchBatches();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchBatches]);

  // Currently selected batch object
  const selectedBatch = useMemo(() => {
    return batches.find((b) => b._id === selectedBatchId) || null;
  }, [batches, selectedBatchId]);

  // 2. Fetch Batch-Specific Students & Existing Attendance for Target Date
  const fetchBatchStudentsAndAttendance = useCallback(
    async (batchId: string, facultyFilter: string, targetDateStr: string, isRefresh = false) => {
      if (!batchId) {
        setBatchStudents([]);
        setAttendanceMap({});
        return;
      }

      const currentEpoch = ++requestEpochRef.current;
      setStudentsLoading(true);
      setStudentsError(null);
      setIsSaved(false);

      try {
        const batchObj = batches.find((b) => b._id === batchId);
        const batchName = batchObj?.name || "";

        // Build students query parameters (fetch all batch students up to 250)
        const studentParams: Record<string, string> = {
          batchId,
          centerId: getCurrentCenterId(),
          limit: "250",
        };

        if (userProfile?.role === "owner" && facultyFilter !== "all") {
          studentParams.assignedTeacher = facultyFilter;
        }

        // Fetch students and target date's attendance in parallel
        const [studentsRes, attendanceRes] = await Promise.all([
          apiClient<ApiStudent[]>("/students", {
            params: studentParams,
            skipCache: isRefresh,
          }),
          batchName
            ? apiClient<ApiAttendanceRecord[]>("/attendance", {
                params: {
                  batch: batchName,
                  date: targetDateStr,
                  centerId: getCurrentCenterId(),
                  ...(userProfile?.role === "owner" && facultyFilter !== "all"
                    ? { assignedTeacher: facultyFilter }
                    : {}),
                },
                skipCache: isRefresh,
              }).catch(() => ({ success: false, data: [] as ApiAttendanceRecord[] }))
            : Promise.resolve({ success: false, data: [] as ApiAttendanceRecord[] }),
        ]);

        // Stale response guard: discard if user switched batch/date/filter while request was in flight
        if (currentEpoch !== requestEpochRef.current) {
          return;
        }

        const fetchedStudents = Array.isArray(studentsRes.data)
          ? studentsRes.data.filter((s) => s.isActive !== false)
          : [];
        setBatchStudents(fetchedStudents);

        // Populate initial attendance map from existing records or default to 'unmarked'
        const existingAttendance = Array.isArray(attendanceRes.data) ? attendanceRes.data : [];
        const attendanceByStudentId = new Map<string, "Present" | "Absent">();

        existingAttendance.forEach((rec) => {
          const sId =
            typeof rec.studentId === "object" && rec.studentId !== null
              ? (rec.studentId as { _id: string })._id
              : String(rec.studentId || "");
          if (sId) {
            attendanceByStudentId.set(sId, rec.status);
          }
        });

        const initialMap: Record<string, AttendanceStatus> = {};
        fetchedStudents.forEach((student) => {
          const existingStatus = attendanceByStudentId.get(student._id);
          if (existingStatus === "Present") {
            initialMap[student._id] = "present";
          } else if (existingStatus === "Absent") {
            initialMap[student._id] = "absent";
          } else {
            initialMap[student._id] = "unmarked";
          }
        });

        setAttendanceMap(initialMap);
      } catch (err: unknown) {
        if (currentEpoch !== requestEpochRef.current) return;
        const msg = err instanceof Error ? err.message : "Failed to load student checklist";
        setStudentsError(msg);
      } finally {
        if (currentEpoch === requestEpochRef.current) {
          setStudentsLoading(false);
        }
      }
    },
    [batches, userProfile]
  );

  // Trigger roster load when selected batch, date, or owner faculty filter changes
  useEffect(() => {
    if (selectedBatchId) {
      const timer = setTimeout(() => {
        fetchBatchStudentsAndAttendance(selectedBatchId, selectedTeacherFilter, selectedDate);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [selectedBatchId, selectedTeacherFilter, selectedDate, fetchBatchStudentsAndAttendance]);

  // Handle batch selection with URL sync and state reset
  const handleSelectBatch = (batchId: string) => {
    if (batchId === selectedBatchId) return;
    setSelectedBatchId(batchId);
    setIsSaved(false);

    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("batchId", batchId);
      url.searchParams.delete("batch");
      window.history.replaceState(null, "", url.toString());
    }
  };

  // Convert batches to AttendanceHeader expected format
  const headerBatches: QuickBatchAttendance[] = useMemo(() => {
    if (batches.length === 0) {
      return [];
    }

    return batches.map((batch) => ({
      id: batch._id,
      batchName: batch.name,
      subject: batch.subject || "All Subjects",
      timeSlot: batch.timing || "General Timing",
      totalStudents: batch._id === selectedBatchId ? batchStudents.length : 0,
      markedStudents: 0,
      status: "pending",
      timelineStatus: "ongoing",
    }));
  }, [batches, selectedBatchId, batchStudents.length]);

  // Map batch students to StudentAttendanceItem
  const currentBatchStudents: StudentAttendanceItem[] = useMemo(() => {
    return batchStudents.map((s, idx) => ({
      id: s._id,
      name: s.name,
      rollNumber: String(idx + 1).padStart(2, "0"),
      avatarColor: AVATAR_COLORS[idx % AVATAR_COLORS.length],
      initials: getInitials(s.name),
      parentPhone: s.parentWhatsApp,
      attendanceRate: 95,
      assignedTeacherName: s.assignedTeacherId
        ? teacherMap[s.assignedTeacherId] || "Teacher"
        : userProfile?.role === "owner"
        ? "Myself (Owner)"
        : undefined,
    }));
  }, [batchStudents, teacherMap, userProfile]);

  // Toggle individual student status
  const handleToggleStatus = useCallback(
    (studentId: string, newStatus: AttendanceStatus) => {
      setIsSaved(false);
      setAttendanceMap((prev) => ({
        ...prev,
        [studentId]: newStatus,
      }));
    },
    []
  );

  // Mark all students in current batch present
  const handleMarkAllPresent = useCallback(() => {
    setIsSaved(false);
    setAttendanceMap((prev) => {
      const updated: Record<string, AttendanceStatus> = {};
      currentBatchStudents.forEach((std) => {
        updated[std.id] = "present";
      });
      return { ...prev, ...updated };
    });
  }, [currentBatchStudents]);

  // Live counts
  const presentCount = currentBatchStudents.filter(
    (s) => attendanceMap[s.id] === "present"
  ).length;

  const absentCount = currentBatchStudents.filter(
    (s) => attendanceMap[s.id] === "absent"
  ).length;

  const unmarkedCount =
    currentBatchStudents.length - (presentCount + absentCount);

  // Save attendance & notify parents via backend API
  const handleSaveAndNotify = async () => {
    if (saving || isSaved || !selectedBatch) return;

    const markedStudents = currentBatchStudents.filter(
      (s) =>
        attendanceMap[s.id] === "present" || attendanceMap[s.id] === "absent"
    );

    if (markedStudents.length === 0) {
      setNotificationToast("Please mark at least one student before saving.");
      setTimeout(() => setNotificationToast(null), 3000);
      return;
    }

    setSaving(true);
    try {
      const targetDate = `${selectedDate}T12:00:00.000+05:30`;

      const payload = {
        records: markedStudents.map((s) => ({
          studentId: s.id,
          batch: selectedBatch.name,
          date: targetDate,
          status: attendanceMap[s.id] === "absent" ? "Absent" : "Present",
        })),
        notifyParents: true,
        notificationScope: "absent",
      };

      const res = await apiClient<AttendanceSaveResponse>("/attendance", {
        method: "POST",
        body: payload,
      });

      if (res && (res.success || (res as unknown as { success?: boolean }).success !== false)) {
        setIsSaved(true);
        invalidateApiCache("/attendance");

        // Honest feedback based on actual notification response
        const notif = res.data?.notifications || (res as unknown as AttendanceSaveResponse).notifications;
        if (notif?.status === "simulated") {
          setNotificationToast(
            `Attendance saved for ${markedStudents.length} student(s). WhatsApp notifications simulated (simulation mode).`
          );
        } else if (notif?.status === "sent" && notif.sent > 0) {
          setNotificationToast(
            `Attendance saved! WhatsApp alerts dispatched to ${notif.sent} parent(s).`
          );
        } else if (notif?.status === "failed") {
          setNotificationToast(
            `Attendance saved for ${markedStudents.length} student(s). WhatsApp service is offline or unreachable.`
          );
        } else if (notif?.status === "disabled") {
          setNotificationToast(
            `Attendance saved for ${markedStudents.length} student(s). WhatsApp notifications are currently disabled.`
          );
        } else {
          setNotificationToast(
            `Attendance saved for ${markedStudents.length} student(s) successfully.`
          );
        }
      } else {
        throw new Error(res.error || "Failed to save attendance");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save attendance";
      setNotificationToast(`Error: ${msg}`);
    } finally {
      setSaving(false);
      setTimeout(() => {
        setNotificationToast(null);
      }, 5000);
    }
  };

  return (
    <div className="flex flex-col min-h-full relative w-full max-w-full overflow-x-hidden">
      {/* Floating Save Toast Notification */}
      {notificationToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 w-[90%] max-w-sm z-50 animate-bounce">
          <div className="rounded-2xl bg-slate-900 text-white p-3.5 shadow-xl flex items-center gap-2.5 border border-slate-700">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex-1 text-xs font-semibold leading-snug">
              {notificationToast}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="p-4 space-y-4 pb-36 w-full max-w-full min-w-0 overflow-x-hidden">
        {/* Batches Error Alert */}
        {batchesError && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800 flex items-start gap-3 shadow-sm">
            <AlertCircle className="h-5 w-5 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-xs">
              <p className="font-bold">Failed to load batches</p>
              <p className="mt-0.5 text-rose-700">{batchesError}</p>
              <button
                type="button"
                onClick={() => fetchBatches(true)}
                className="mt-2 font-bold underline text-rose-900 hover:text-rose-950 inline-flex items-center gap-1"
              >
                <RefreshCw className="h-3 w-3" /> Retry loading batches
              </button>
            </div>
          </div>
        )}

        {/* Students Error Alert */}
        {studentsError && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800 flex items-start gap-3 shadow-sm">
            <AlertCircle className="h-5 w-5 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-xs">
              <p className="font-bold">Failed to load student checklist</p>
              <p className="mt-0.5 text-rose-700">{studentsError}</p>
              <button
                type="button"
                onClick={() =>
                  fetchBatchStudentsAndAttendance(selectedBatchId, selectedTeacherFilter, selectedDate, true)
                }
                className="mt-2 font-bold underline text-rose-900 hover:text-rose-950 inline-flex items-center gap-1"
              >
                <RefreshCw className="h-3 w-3" /> Retry loading roster
              </button>
            </div>
          </div>
        )}

        {/* Faculty Filter Pills (Owner View) */}
        {userProfile?.role === "owner" && batches.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar scrollbar-none text-xs font-bold w-full max-w-full min-w-0">
            <span className="text-[11px] text-slate-400 font-medium whitespace-nowrap mr-0.5 shrink-0">
              Faculty:
            </span>
            <button
              type="button"
              onClick={() => setSelectedTeacherFilter("all")}
              className={`px-3 py-1 rounded-xl whitespace-nowrap transition-colors ${
                selectedTeacherFilter === "all"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              All Faculty
            </button>
            <button
              type="button"
              onClick={() => setSelectedTeacherFilter("owner")}
              className={`px-3 py-1 rounded-xl whitespace-nowrap transition-colors ${
                selectedTeacherFilter === "owner"
                  ? "bg-indigo-600 text-white shadow-xs"
                  : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              Myself (Owner)
            </button>
            {teachers.map((t) => (
              <button
                key={t._id}
                type="button"
                onClick={() => setSelectedTeacherFilter(t._id)}
                className={`px-3 py-1 rounded-xl whitespace-nowrap transition-colors ${
                  selectedTeacherFilter === t._id
                    ? "bg-blue-600 text-white shadow-xs"
                    : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}

        {/* Batch & Date Header Controls */}
        <AttendanceHeader
          batches={headerBatches}
          selectedBatchId={selectedBatchId}
          onSelectBatch={handleSelectBatch}
          selectedDate={formatISTDisplay(selectedDate)}
          selectedDateRaw={selectedDate}
          onSelectDate={(newDate) => {
            setSelectedDate(newDate);
            setIsSaved(false);
          }}
          presentCount={presentCount}
          absentCount={absentCount}
          unmarkedCount={unmarkedCount}
          onMarkAllPresent={handleMarkAllPresent}
          loadingBatches={batchesLoading}
        />

        {/* Attendance List Header */}
        <div className="flex items-center justify-between px-0.5 pt-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-bold text-slate-900 tracking-tight">
              Student Checklist ({currentBatchStudents.length})
            </h2>
            <span className="text-[11px] font-semibold text-slate-400">
              Tap P or A to toggle
            </span>
          </div>
          <button
            type="button"
            onClick={() =>
              fetchBatchStudentsAndAttendance(selectedBatchId, selectedTeacherFilter, selectedDate, true)
            }
            disabled={studentsLoading || !selectedBatchId}
            className="tap-bounce text-slate-400 hover:text-slate-600 p-1 disabled:opacity-40"
            title="Reload students"
            aria-label="Reload students"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${studentsLoading ? "animate-spin text-blue-600" : ""}`}
            />
          </button>
        </div>

        {/* Batches Loading State */}
        {batchesLoading ? (
          <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-xs">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-500">Loading authorized batches...</p>
          </div>
        ) : batches.length === 0 ? (
          /* Empty Batches State */
          <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-xs">
            <Layers className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-700">No active batches found</p>
            <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
              {userProfile?.role === "teacher"
                ? "No batches are currently assigned to your teacher account. Contact the institute owner."
                : "Create your first batch in Admissions to start tracking student attendance."}
            </p>
          </div>
        ) : studentsLoading ? (
          /* Students Loading Skeleton */
          <div className="space-y-2.5 animate-pulse">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded-2xl border border-slate-100 bg-white p-3.5 flex items-center justify-between gap-3 shadow-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-11 w-11 rounded-2xl bg-slate-200" />
                  <div className="space-y-1.5">
                    <div className="h-4 w-28 bg-slate-200 rounded" />
                    <div className="h-3 w-36 bg-slate-200 rounded" />
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-10 w-16 bg-slate-200 rounded-xl" />
                  <div className="h-10 w-16 bg-slate-200 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        ) : currentBatchStudents.length > 0 ? (
          /* Student Checklist Rows */
          <div className="space-y-2.5">
            {currentBatchStudents.map((student) => {
              const status = attendanceMap[student.id] || "unmarked";
              return (
                <StudentAttendanceRow
                  key={student.id}
                  student={student}
                  status={status}
                  onToggleStatus={handleToggleStatus}
                />
              );
            })}
          </div>
        ) : (
          /* Empty Batch Roster State */
          <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-xs">
            <Users className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-700">
              No students enrolled in this batch
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Select another batch or enroll new students in Admissions.
            </p>
          </div>
        )}
      </div>

      {/* Sticky Bottom Save Action Bar */}
      {currentBatchStudents.length > 0 && (
        <StickySaveBar
          presentCount={presentCount}
          absentCount={absentCount}
          unmarkedCount={unmarkedCount}
          onSave={handleSaveAndNotify}
          isSaved={isSaved}
          saving={saving}
        />
      )}
    </div>
  );
}
