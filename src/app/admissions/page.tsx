"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  Suspense,
  memo,
} from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  UserPlus,
  Upload,
  User,
  Users,
  Search,
  Pencil,
  Calendar,
  IndianRupee,
  Layers,
  CheckCircle2,
  ExternalLink,
  Loader2,
  GraduationCap,
  X,
  Clock,
  BookOpen,
  Trash2,
  Receipt,
  ArrowLeft,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { apiClient, getCurrentCenterId, getApiCache } from "@/lib/apiClient";
import { openParentPortalForStudent } from "@/lib/parentPortalLink";
import { StudentRecord, BatchRecord, TeacherRecord, StudentBatchRequestRecord } from "@/types";
import StudentPhoneMasked from "@/components/common/StudentPhoneMasked";
import { getAuthenticatedCenter, type CenterInfo } from "@/lib/centerProfile";

const StudentFormModal = dynamic(
  () => import("@/components/modals/StudentFormModal"),
  { ssr: false }
);
const CreateBatchModal = dynamic(
  () => import("@/components/modals/CreateBatchModal"),
  { ssr: false }
);
const BulkImportModal = dynamic(
  () => import("@/components/modals/BulkImportModal"),
  { ssr: false }
);
const StudentBatchRequestModal = dynamic(
  () => import("@/components/modals/StudentBatchRequestModal"),
  { ssr: false }
);
const BatchRequestsModal = dynamic(
  () => import("@/components/modals/BatchRequestsModal"),
  { ssr: false }
);

// Deterministic pastel avatar background colors
const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700 border-blue-200",
  "bg-indigo-100 text-indigo-700 border-indigo-200",
  "bg-emerald-100 text-emerald-700 border-emerald-200",
  "bg-amber-100 text-amber-700 border-amber-200",
  "bg-purple-100 text-purple-700 border-purple-200",
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

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function formatCurrency(amount: number): string {
  return "₹" + (amount || 0).toLocaleString("en-IN");
}

function formatJoiningDate(dateString?: string): string {
  if (!dateString) return "Recent";
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return "Recent";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function getCycleOrdinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

interface StudentRowItemProps {
  student: StudentRecord;
  assignedTeacherName?: string;
  userRole?: string;
  onEdit: (student: StudentRecord) => void;
  onDelete: (student: StudentRecord) => void;
  onOpenPortal: (studentId: string) => void;
  onTransfer?: (student: StudentRecord) => void;
}

const StudentRowItem = memo(function StudentRowItem({
  student,
  assignedTeacherName,
  userRole,
  onEdit,
  onDelete,
  onOpenPortal,
  onTransfer,
}: StudentRowItemProps) {
  const avatarClass = getAvatarColor(student.name);
  const initials = getInitials(student.name);
  const isStudentActive = student.isActive !== false;

  return (
    <div className="p-3.5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 w-full hover:bg-slate-50/60 transition-colors">
      {/* Student Info Left */}
      <div className="flex items-start gap-3 min-w-0">
        {/* Avatar */}
        <div
          className={`w-10 h-10 rounded-2xl flex items-center justify-center font-bold text-xs border flex-shrink-0 shadow-xs ${avatarClass}`}
        >
          {initials}
        </div>

        {/* Details */}
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/admissions/${student._id}`}
              className="text-sm font-bold text-slate-900 leading-tight hover:text-blue-600 hover:underline"
              title="View 360° Profile & Fee Ledger"
            >
              {student.name}
            </Link>

            {student.assignedTeacherId ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200/60"
                title={`Assigned to ${
                  assignedTeacherName || "Teacher"
                }`}
              >
                <GraduationCap className="w-3 h-3 text-indigo-500" />
                <span>
                  {assignedTeacherName || "Teacher"}
                </span>
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full border border-slate-200/80"
                title="Assigned to Institute Owner"
              >
                <User className="w-3 h-3 text-slate-400" />
                <span>Owner</span>
              </span>
            )}

            {!isStudentActive && (
              <span className="px-1.5 py-0.2 rounded-md bg-slate-100 text-slate-500 text-[10px] font-semibold">
                Inactive
              </span>
            )}
          </div>

          {/* WhatsApp Contact with Quick Actions */}
          <StudentPhoneMasked
            phone={student.parentWhatsApp}
            userRole={userRole}
            showQuickActions={true}
            textClassName="font-mono text-[11px] text-slate-600"
            className="flex items-center gap-2 text-xs text-slate-500"
          />

          {/* Badges: Joining Date + Fee Cycle */}
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 text-[10px] font-medium">
              <Calendar className="w-3 h-3 text-slate-400" />
              <span>{formatJoiningDate(student.joiningDate)}</span>
            </span>

            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-50 text-blue-700 text-[10px] font-semibold border border-blue-100">
              <IndianRupee className="w-3 h-3 text-blue-500" />
              <span>
                {formatCurrency(student.monthlyFee || 0)} / mo
              </span>
            </span>

            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 text-[10px] font-medium border border-indigo-100">
              <span>
                Due: {getCycleOrdinal(student.billingCycleDate || 5)}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Student Row Actions Right */}
      <div className="flex flex-wrap gap-2 w-full md:w-auto justify-start md:justify-end mt-2 md:mt-0">
        {/* 360° Fee Ledger */}
        <Link
          href={`/admissions/${student._id}`}
          className="tap-bounce text-xs md:text-sm px-2.5 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold flex items-center gap-1.5 transition-colors"
          title="View 360° Fee Ledger & Record Cash"
        >
          <Receipt className="w-3.5 h-3.5 text-emerald-600" />
          <span>Ledger</span>
        </Link>

        {/* Parent Portal (canonical token link) */}
        <button
          type="button"
          onClick={() => onOpenPortal(String(student._id))}
          className="tap-bounce text-xs md:text-sm px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 font-semibold flex items-center gap-1.5 transition-colors"
          title="Open the Parent Portal using the canonical portal link"
        >
          <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
          <span>Portal</span>
        </button>

        {/* Edit Button */}
        <button
          type="button"
          onClick={() => onEdit(student)}
          className="tap-bounce text-xs md:text-sm px-2.5 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold flex items-center gap-1.5 border border-blue-200/80 transition-colors"
        >
          <Pencil className="w-3.5 h-3.5" />
          <span>Edit</span>
        </button>

        {/* Request Batch Reassignment for Teachers */}
        {userRole === "teacher" && onTransfer && (
          <button
            type="button"
            onClick={() => onTransfer(student)}
            className="tap-bounce text-xs md:text-sm px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold flex items-center gap-1.5 border border-indigo-200/80 transition-colors"
            title="Request batch reassignment"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Transfer</span>
          </button>
        )}

        {/* Delete Student Button */}
        <button
          type="button"
          onClick={() => onDelete(student)}
          aria-label={`Delete student ${student.name}`}
          title={`Delete ${student.name}`}
          className="tap-bounce text-xs md:text-sm px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-700 font-bold flex items-center gap-1 border border-rose-200/80 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
});

function AdmissionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const batchIdParam = searchParams.get("batchId");
  const legacyBatchParam = searchParams.get("batch");

  const cachedStudents =
    getApiCache<StudentRecord[]>("/students", {
      centerId: typeof window !== "undefined" ? getCurrentCenterId() : "",
    }) || getApiCache<StudentRecord[]>("/students");
  const cachedBatches =
    getApiCache<BatchRecord[]>("/batches", {
      centerId: typeof window !== "undefined" ? getCurrentCenterId() : "",
    }) || getApiCache<BatchRecord[]>("/batches");

  const [students, setStudents] = useState<StudentRecord[]>(
    () => cachedStudents?.data || []
  );
  const [batches, setBatches] = useState<BatchRecord[]>(
    () => cachedBatches?.data || []
  );
  const [loading, setLoading] = useState(
    () => !cachedStudents && !cachedBatches
  );
  const [userProfile, setUserProfile] = useState<CenterInfo | null>(null);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);

  // Navigation & View Mode: tracked strictly by batchId
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(
    () => batchIdParam || null
  );

  // Filters for Batch Overview
  const [batchSearchQuery, setBatchSearchQuery] = useState("");
  const [selectedTeacherFilter, setSelectedTeacherFilter] = useState<string>("all");

  // Debounced Student Search in Batch Detail
  const [studentSearchInput, setStudentSearchInput] = useState("");
  const [isSearchingStudents, setIsSearchingStudents] = useState(false);
  const [searchedStudents, setSearchedStudents] = useState<StudentRecord[] | null>(null);
  const searchAbortControllerRef = useRef<AbortController | null>(null);
  const searchReqEpochRef = useRef(0);

  // Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [isBulkImportOpen, setIsBulkImportOpen] = useState(false);
  const [studentToEdit, setStudentToEdit] = useState<StudentRecord | null>(null);

  // Batch Assignment Requests (REQ-01)
  const [isBatchRequestsOpen, setIsBatchRequestsOpen] = useState(false);
  const [isStudentRequestOpen, setIsStudentRequestOpen] = useState(false);
  const [requestStudentTarget, setRequestStudentTarget] = useState<StudentRecord | null>(null);
  const [pendingRequestsCount, setPendingRequestsCount] = useState<number>(0);

  const fetchPendingRequestsCount = useCallback(async () => {
    try {
      const res = await apiClient<StudentBatchRequestRecord[]>("/batch-requests", {
        params: { status: "pending" },
      });
      setPendingRequestsCount(res.data?.length || 0);
    } catch {
      // Ignore background error
    }
  }, []);

  // Success Feedback Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  }, []);

  // Fetch real students from MongoDB backend
  const fetchStudents = useCallback(async (isRefresh = false) => {
    try {
      const res = await apiClient<StudentRecord[]>("/students", {
        params: { centerId: getCurrentCenterId() },
        skipCache: isRefresh,
      });
      setStudents(res.data || []);
    } catch (err) {
      console.error("Failed to fetch students:", err);
    }
  }, []);

  // Fetch real teachers from MongoDB backend (for Owner view)
  const fetchTeachers = useCallback(async () => {
    try {
      const res = await apiClient<{ data?: TeacherRecord[] }>(
        "/teachers?isActive=true"
      );
      const list = Array.isArray(res.data)
        ? res.data
        : res.data && "data" in res.data && Array.isArray(res.data.data)
        ? (res.data.data as TeacherRecord[])
        : [];
      setTeachers(list.filter((t) => t.isActive !== false));
    } catch (err) {
      console.error("Failed to fetch teachers:", err);
    }
  }, []);

  // Fetch real batches from MongoDB backend
  const fetchBatches = useCallback(async (isRefresh = false) => {
    try {
      const res = await apiClient<BatchRecord[]>("/batches", {
        params: { centerId: getCurrentCenterId() },
        skipCache: isRefresh,
      });
      setBatches(res.data || []);
    } catch (err) {
      console.error("Failed to fetch batches:", err);
    }
  }, []);

  useEffect(() => {
    async function loadInitialData() {
      if (!cachedStudents && !cachedBatches) {
        setLoading(true);
      }
      const profile = await getAuthenticatedCenter();
      setUserProfile(profile);

      const promises: Promise<void>[] = [fetchStudents(), fetchBatches()];
      if (profile?.role === "owner") {
        promises.push(fetchTeachers(), fetchPendingRequestsCount());
      }
      await Promise.all(promises);
      setLoading(false);
    }
    loadInitialData();
  }, [fetchStudents, fetchBatches, fetchTeachers, fetchPendingRequestsCount, cachedStudents, cachedBatches]);

  // Combine batches from Batch collection with any orphan student batches
  const displayBatches = useMemo(() => {
    const list: BatchRecord[] = [...batches];
    const knownNames = new Set(batches.map((b) => b.name));

    students.forEach((s) => {
      if (s.batch && !knownNames.has(s.batch)) {
        list.push({
          _id: `orphan_${encodeURIComponent(s.batch)}`,
          centerId: s.centerId || getCurrentCenterId(),
          name: s.batch,
          subject: "General",
          timing: "Flexible",
          isActive: true,
        });
        knownNames.add(s.batch);
      }
    });

    return list;
  }, [batches, students]);

  // Sync selectedBatchId when URL query parameter changes (browser back/forward & refresh)
  useEffect(() => {
    const currentBatchId = searchParams.get("batchId");
    const currentLegacyBatch = searchParams.get("batch");

    if (currentBatchId) {
      if (currentBatchId !== selectedBatchId) {
        setSelectedBatchId(currentBatchId);
        setStudentSearchInput("");
        setSearchedStudents(null);
      }
    } else if (currentLegacyBatch && displayBatches.length > 0) {
      const match = displayBatches.find((b) => b.name === currentLegacyBatch);
      if (match && match._id !== selectedBatchId) {
        setSelectedBatchId(match._id);
        setStudentSearchInput("");
        setSearchedStudents(null);
      }
    } else if (!currentBatchId && !currentLegacyBatch && selectedBatchId !== null) {
      setSelectedBatchId(null);
      setStudentSearchInput("");
      setSearchedStudents(null);
    }
  }, [searchParams, displayBatches, selectedBatchId]);

  // Resolve the currently active batch object from selectedBatchId
  const selectedBatch = useMemo(() => {
    if (selectedBatchId) {
      return displayBatches.find((b) => b._id === selectedBatchId) || null;
    }
    if (legacyBatchParam && displayBatches.length > 0) {
      return displayBatches.find((b) => b.name === legacyBatchParam) || null;
    }
    return null;
  }, [displayBatches, selectedBatchId, legacyBatchParam]);

  // Whether user requested a batchId that is invalid, deleted, or unauthorized
  const isInvalidBatch = Boolean(selectedBatchId && !loading && !selectedBatch);

  // Teacher map: ID -> Name
  const teacherMap = useMemo(() => {
    const map: Record<string, string> = {};
    teachers.forEach((t) => {
      map[t._id] = t.name;
    });
    return map;
  }, [teachers]);

  // 300ms Debounced Student Search inside selected batch with AbortController & epoch guard
  useEffect(() => {
    if (!selectedBatch) {
      setSearchedStudents(null);
      setIsSearchingStudents(false);
      return;
    }

    const trimmed = studentSearchInput.trim();
    if (!trimmed) {
      setSearchedStudents(null);
      setIsSearchingStudents(false);
      if (searchAbortControllerRef.current) {
        searchAbortControllerRef.current.abort();
        searchAbortControllerRef.current = null;
      }
      return;
    }

    setIsSearchingStudents(true);
    const reqEpoch = ++searchReqEpochRef.current;

    const timer = setTimeout(async () => {
      if (searchAbortControllerRef.current) {
        searchAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      searchAbortControllerRef.current = controller;

      try {
        const res = await apiClient<StudentRecord[]>("/students", {
          params: {
            centerId: getCurrentCenterId(),
            batchId: selectedBatch._id,
            batch: selectedBatch.name,
            search: trimmed,
          },
          signal: controller.signal,
          skipCache: true,
        });

        // Stale response guard: ensure this response matches the latest query epoch
        if (reqEpoch === searchReqEpochRef.current) {
          setSearchedStudents(res.data || []);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return; // Ignore intentionally aborted requests
        }
        // Fallback to client-side filter with stale response guard
        if (reqEpoch === searchReqEpochRef.current) {
          const q = trimmed.toLowerCase();
          const isTeacher = userProfile?.role === "teacher";
          const fallback = students.filter(
            (s) =>
              s.batch === selectedBatch.name &&
              (s.name.toLowerCase().includes(q) || (!isTeacher && s.parentWhatsApp.includes(trimmed)))
          );
          setSearchedStudents(fallback);
        }
      } finally {
        if (reqEpoch === searchReqEpochRef.current) {
          setIsSearchingStudents(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [studentSearchInput, selectedBatch, students]);

  // Overall metrics
  const totalStudentsCount = students.length;
  const activeStudentsCount = students.filter((s) => s.isActive !== false).length;
  const totalMonthlyPotential = students
    .filter((s) => s.isActive !== false)
    .reduce((acc, curr) => acc + (curr.monthlyFee || 0), 0);

  // Compute per-batch metrics
  const batchStatsMap = useMemo(() => {
    const stats: Record<
      string,
      {
        totalStudents: number;
        activeStudents: number;
        monthlyFee: number;
        meta?: BatchRecord;
      }
    > = {};

    displayBatches.forEach((b) => {
      stats[b._id] = {
        totalStudents: 0,
        activeStudents: 0,
        monthlyFee: 0,
        meta: b,
      };
    });

    students.forEach((student) => {
      const matchBatch = displayBatches.find((b) => b.name === student.batch);
      if (matchBatch) {
        const entry = stats[matchBatch._id];
        if (entry) {
          entry.totalStudents += 1;
          if (student.isActive !== false) {
            entry.activeStudents += 1;
            entry.monthlyFee += student.monthlyFee || 0;
          }
        }
      }
    });

    return stats;
  }, [displayBatches, students]);

  // Filtered batch list for Overview Grid
  const filteredBatches = useMemo(() => {
    const searchQ = batchSearchQuery.trim().toLowerCase();

    return displayBatches.filter((batch) => {
      // Filter by batch search query
      if (searchQ) {
        const matchName = batch.name.toLowerCase().includes(searchQ);
        const matchSubject = batch.subject?.toLowerCase().includes(searchQ);
        if (!matchName && !matchSubject) return false;
      }

      // Filter by Teacher / Faculty (Owner view)
      if (selectedTeacherFilter !== "all") {
        const batchStudents = students.filter((s) => s.batch === batch.name);
        if (selectedTeacherFilter === "owner") {
          return batchStudents.some((s) => !s.assignedTeacherId);
        } else {
          return batchStudents.some(
            (s) => s.assignedTeacherId === selectedTeacherFilter
          );
        }
      }

      return true;
    });
  }, [displayBatches, batchSearchQuery, selectedTeacherFilter, students]);

  // Active batch students (when a batch is selected)
  const currentBatchStudents = useMemo(() => {
    if (!selectedBatch) return [];

    if (searchedStudents !== null) {
      return searchedStudents;
    }

    return students.filter((s) => s.batch === selectedBatch.name);
  }, [selectedBatch, searchedStudents, students]);

  // Navigation handlers
  const handleSelectBatch = (batch: BatchRecord) => {
    setSelectedBatchId(batch._id);
    setStudentSearchInput("");
    setSearchedStudents(null);
    router.push(`/admissions?batchId=${encodeURIComponent(batch._id)}`, {
      scroll: false,
    });
  };

  const handleBackToBatches = () => {
    setSelectedBatchId(null);
    setStudentSearchInput("");
    setSearchedStudents(null);
    router.push("/admissions", { scroll: false });
  };

  // Handlers for Add & Edit
  const handleOpenAdd = () => {
    setStudentToEdit(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = useCallback((student: StudentRecord) => {
    setStudentToEdit(student);
    setIsModalOpen(true);
  }, []);

  const handleOpenPortal = useCallback(async (studentId: string) => {
    const result = await openParentPortalForStudent(studentId);
    if (!result.opened && result.message) {
      window.alert(result.message);
    }
  }, []);

  const handleOpenTransfer = useCallback((student: StudentRecord) => {
    setRequestStudentTarget(student);
    setIsStudentRequestOpen(true);
  }, []);

  const handleModalSuccess = (savedStudent: StudentRecord) => {
    fetchStudents(true);
    fetchBatches(true);
    const isEdit = Boolean(studentToEdit);
    showToast(
      isEdit
        ? `Successfully updated details for ${savedStudent.name}!`
        : `Admission confirmed! ${savedStudent.name} enrolled in ${savedStudent.batch}.`
    );
  };

  const handleBatchSuccess = (newBatch: BatchRecord) => {
    fetchBatches(true);
    showToast(`Batch "${newBatch.name}" created successfully!`);
  };

  const handleDeleteStudent = useCallback(
    async (student: StudentRecord) => {
      if (
        !window.confirm(
          `Are you sure you want to delete ${student.name}? This action cannot be undone.`
        )
      ) {
        return;
      }

      try {
        await apiClient(`/students/${student._id}`, {
          method: "DELETE",
        });
        showToast(`Student "${student.name}" deleted successfully.`);
        fetchStudents(true);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to delete student.";
        showToast(`Error: ${msg}`);
      }
    },
    [fetchStudents, showToast]
  );

  const handleDeleteBatch = async (batch: BatchRecord) => {
    if (
      !window.confirm(
        `Are you sure you want to delete batch "${batch.name}"? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      await apiClient(`/batches/${batch._id}`, {
        method: "DELETE",
      });
      showToast(`Batch "${batch.name}" deleted successfully.`);
      if (selectedBatchId === batch._id) {
        handleBackToBatches();
      }
      fetchBatches(true);
      fetchStudents(true);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to delete batch.";
      showToast(`Error: ${msg}`);
    }
  };

  const uniqueBatchNames = useMemo(
    () => displayBatches.map((b) => b.name),
    [displayBatches]
  );

  return (
    <div className="flex flex-col min-h-full">
      {/* Floating Success Feedback Toast */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 w-[92%] max-w-sm z-50 animate-bounce">
          <div className="rounded-2xl bg-slate-900 text-white p-3.5 shadow-2xl flex items-center gap-2.5 border border-slate-700">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex-1 text-xs font-semibold leading-snug">
              {toastMessage}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Container */}
      <div className="p-4 space-y-4">
        {/* ======================================================== */}
        {/* VIEW A: INVALID OR UNAUTHORIZED BATCH ID STATE           */}
        {/* ======================================================== */}
        {isInvalidBatch ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleBackToBatches}
                className="tap-bounce inline-flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold shadow-xs transition-all"
              >
                <ArrowLeft className="w-4 h-4 text-slate-500 stroke-[2.2]" />
                <span>Back to Batches</span>
              </button>
            </div>

            <div className="rounded-3xl border border-dashed border-rose-300 bg-rose-50/50 p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
                <AlertTriangle className="w-6 h-6 stroke-[2]" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Batch Not Found or Inaccessible
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                  The requested batch does not exist, has been deleted, or you do not have permission to view it.
                </p>
              </div>
              <button
                type="button"
                onClick={handleBackToBatches}
                className="tap-bounce inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Return to Batch Overview</span>
              </button>
            </div>
          </div>
        ) : !selectedBatch ? (
          /* ======================================================== */
          /* VIEW B: BATCH OVERVIEW (Main View)                       */
          /* ======================================================== */
          <>
            {/* Top Action & Title Banner */}
            <div className="flex flex-col gap-3.5">
              <div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <span>Student Admissions</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select a batch to inspect students, record attendance &amp; manage billing cycles
                </p>
              </div>

              {/* Owner Pending Requests Banner */}
              {userProfile?.role === "owner" && pendingRequestsCount > 0 && (
                <button
                  type="button"
                  onClick={() => setIsBatchRequestsOpen(true)}
                  className="w-full flex items-center justify-between p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-bold hover:bg-amber-100/70 transition-all shadow-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                    <span>
                      {pendingRequestsCount} Student Batch Assignment Request{pendingRequestsCount > 1 ? "s" : ""} pending review
                    </span>
                  </div>
                  <span className="text-amber-700 font-extrabold flex items-center gap-1 text-[11px] underline">
                    Review Inbox &rarr;
                  </span>
                </button>
              )}

              {/* Action Buttons: Create Batch (Owner Only), Batch Requests, Bulk Import & New Admission */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full">
                {userProfile?.role === "owner" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsBatchModalOpen(true)}
                      className="tap-bounce flex items-center justify-center gap-1.5 h-11 px-2 rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-bold text-xs shadow-xs transition-all active:scale-[0.98]"
                    >
                      <Layers className="w-4 h-4 text-indigo-600 stroke-[2.2]" />
                      <span className="truncate">+ Batch</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsBatchRequestsOpen(true)}
                      className="tap-bounce flex items-center justify-center gap-1.5 h-11 px-2 rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-bold text-xs shadow-xs transition-all active:scale-[0.98] relative"
                    >
                      <Layers className="w-4 h-4 text-amber-600 stroke-[2.2]" />
                      <span className="truncate">Requests</span>
                      {pendingRequestsCount > 0 && (
                        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-black flex items-center justify-center shadow-xs">
                          {pendingRequestsCount}
                        </span>
                      )}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsBatchRequestsOpen(true)}
                    className="tap-bounce flex items-center justify-center gap-1.5 h-11 px-2 rounded-2xl bg-white hover:bg-slate-50 border border-indigo-200/80 text-indigo-700 font-bold text-xs shadow-xs transition-all active:scale-[0.98]"
                  >
                    <Layers className="w-4 h-4 text-indigo-600 stroke-[2.2]" />
                    <span className="truncate">Batch Requests</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsBulkImportOpen(true)}
                  className="tap-bounce flex items-center justify-center gap-1.5 h-11 px-2 rounded-2xl bg-white hover:bg-slate-50 border border-indigo-200/80 text-indigo-700 font-bold text-xs shadow-xs transition-all active:scale-[0.98]"
                >
                  <Upload className="w-4 h-4 text-indigo-600 stroke-[2.2]" />
                  <span className="truncate">Bulk Import</span>
                </button>

                <button
                  type="button"
                  onClick={handleOpenAdd}
                  className="tap-bounce flex items-center justify-center gap-1.5 h-11 px-2 rounded-2xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold text-xs shadow-md shadow-blue-600/30 transition-all"
                >
                  <UserPlus className="w-4 h-4 stroke-[2.5]" />
                  <span className="truncate">+ Admission</span>
                </button>
              </div>
            </div>

            {/* Summary KPI Stat Cards */}
            <div className="grid grid-cols-3 gap-2">
              {/* Card 1: Total Students */}
              <div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Students
                  </span>
                  <Users className="w-3.5 h-3.5 text-blue-600" />
                </div>
                <div className="mt-1">
                  <div className="text-lg font-black text-slate-900">
                    {totalStudentsCount}
                  </div>
                  <span className="text-[10px] text-emerald-600 font-semibold">
                    {activeStudentsCount} Active
                  </span>
                </div>
              </div>

              {/* Card 2: Batches */}
              <div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Batches
                  </span>
                  <Layers className="w-3.5 h-3.5 text-indigo-600" />
                </div>
                <div className="mt-1">
                  <div className="text-lg font-black text-slate-900">
                    {displayBatches.length}
                  </div>
                  <span className="text-[10px] text-slate-500 font-semibold">
                    Class Groups
                  </span>
                </div>
              </div>

              {/* Card 3: Monthly Billing Potential */}
              <div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Monthly Fee
                  </span>
                  <IndianRupee className="w-3.5 h-3.5 text-emerald-600" />
                </div>
                <div className="mt-1">
                  <div className="text-sm sm:text-base font-black text-slate-900 truncate">
                    {formatCurrency(totalMonthlyPotential)}
                  </div>
                  <span className="text-[10px] text-blue-600 font-semibold">
                    Recurring
                  </span>
                </div>
              </div>
            </div>

            {/* Filter and Search Controls for Batches */}
            <div className="space-y-2">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Search className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={batchSearchQuery}
                  onChange={(e) => setBatchSearchQuery(e.target.value)}
                  placeholder="Filter batches by name or subject..."
                  className="w-full rounded-2xl border border-slate-200 bg-white pl-9 pr-9 py-2 text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 shadow-xs transition-all"
                />
                {batchSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setBatchSearchQuery("")}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Teacher / Faculty Filter Pills (Owner View Only) */}
              {userProfile?.role === "owner" && teachers.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs font-bold">
                  <span className="text-[11px] text-slate-400 font-medium whitespace-nowrap mr-0.5">
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
                    All Batches ({displayBatches.length})
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
                    My Students (Owner)
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
            </div>

            {/* Batch Cards Grid */}
            {loading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-3xl border border-slate-200 bg-white p-4 space-y-3 animate-pulse"
                  >
                    <div className="flex items-center justify-between">
                      <div className="h-4 w-32 bg-slate-200 rounded-md" />
                      <div className="h-4 w-12 bg-slate-200 rounded-md" />
                    </div>
                    <div className="h-8 bg-slate-100 rounded-xl w-full" />
                  </div>
                ))}
              </div>
            ) : filteredBatches.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
                  <GraduationCap className="w-6 h-6 stroke-[2]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {batchSearchQuery || selectedTeacherFilter !== "all"
                      ? "No matching batches found"
                      : "No batches created yet"}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                    {batchSearchQuery || selectedTeacherFilter !== "all"
                      ? "Try clearing your search query or faculty filter."
                      : "Create your academic batches and enroll students to automate attendance tracking and monthly fees."}
                  </p>
                </div>
                {batchSearchQuery || selectedTeacherFilter !== "all" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setBatchSearchQuery("");
                      setSelectedTeacherFilter("all");
                    }}
                    className="tap-bounce inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition-colors"
                  >
                    Reset Filters
                  </button>
                ) : (
                  <div className="flex items-center justify-center gap-2 pt-1">
                    {userProfile?.role === "owner" && (
                      <button
                        type="button"
                        onClick={() => setIsBatchModalOpen(true)}
                        className="tap-bounce inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-white border border-slate-200 text-slate-700 text-xs font-bold shadow-xs hover:bg-slate-50 transition-all"
                      >
                        <Layers className="w-4 h-4 text-indigo-600 stroke-[2.2]" />
                        <span>Create Batch</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleOpenAdd}
                      className="tap-bounce inline-flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-600/30 transition-all"
                    >
                      <UserPlus className="w-4 h-4 stroke-[2.2]" />
                      <span>Admit First Student</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {filteredBatches.map((batch) => {
                  const stats = batchStatsMap[batch._id] || {
                    totalStudents: 0,
                    activeStudents: 0,
                    monthlyFee: 0,
                  };

                  return (
                    <div
                      key={batch._id}
                      onClick={() => handleSelectBatch(batch)}
                      className="tap-bounce group relative rounded-3xl border border-slate-200/90 bg-white hover:border-blue-300 hover:shadow-md transition-all cursor-pointer p-4 flex flex-col justify-between gap-3.5"
                    >
                      {/* Top Header Row */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 group-hover:bg-blue-600 group-hover:text-white transition-colors flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-xs">
                            <Layers className="w-5 h-5 stroke-[2]" />
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-sm font-bold text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                              {batch.name}
                            </h3>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-500 truncate">
                              {batch.subject ? (
                                <span className="flex items-center gap-1 text-indigo-600 font-medium truncate">
                                  <BookOpen className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                                  <span>{batch.subject}</span>
                                </span>
                              ) : (
                                <span className="text-slate-400">General</span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Delete action for Owner / Admin */}
                        {batch._id && !batch._id.startsWith("orphan_") && userProfile?.role === "owner" && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteBatch(batch);
                            }}
                            title={`Delete batch "${batch.name}"`}
                            aria-label={`Delete batch ${batch.name}`}
                            className="w-7 h-7 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Middle Meta Details */}
                      {batch.timing && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-600 bg-slate-50/80 px-2.5 py-1.5 rounded-xl border border-slate-100">
                          <Clock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          <span className="truncate">{batch.timing}</span>
                        </div>
                      )}

                      {/* Footer Stats & Open CTA */}
                      <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-lg">
                            <Users className="w-3 h-3 text-slate-500" />
                            <span>
                              {stats.activeStudents}{" "}
                              {stats.activeStudents === 1 ? "student" : "students"}
                            </span>
                          </span>

                          <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-lg">
                            {formatCurrency(stats.monthlyFee)}
                          </span>
                        </div>

                        <div className="flex items-center gap-0.5 text-xs font-bold text-blue-600 group-hover:translate-x-0.5 transition-transform">
                          <span>View</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          /* ======================================================== */
          /* VIEW C: BATCH DETAIL & DEDICATED STUDENT LISTING        */
          /* ======================================================== */
          <div className="space-y-4">
            {/* Top Navigation Bar: Back Button */}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleBackToBatches}
                className="tap-bounce inline-flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold shadow-xs transition-all"
              >
                <ArrowLeft className="w-4 h-4 text-slate-500 stroke-[2.2]" />
                <span>Back to Batches</span>
              </button>

              <button
                type="button"
                onClick={handleOpenAdd}
                className="tap-bounce inline-flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-600/30 transition-all"
              >
                <UserPlus className="w-4 h-4 stroke-[2.5]" />
                <span>+ Add Student</span>
              </button>
            </div>

            {/* Selected Batch Header Card */}
            {(() => {
              const currentStats = batchStatsMap[selectedBatch._id] || {
                totalStudents: 0,
                activeStudents: 0,
                monthlyFee: 0,
              };

              return (
                <div className="p-4 rounded-3xl bg-gradient-to-r from-blue-900 to-indigo-900 text-white shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-200 bg-white/10 px-2 py-0.5 rounded-md">
                        Batch Details
                      </span>
                      {selectedBatch.subject && (
                        <span className="text-[10px] font-bold text-indigo-200 bg-indigo-500/20 px-2 py-0.5 rounded-md">
                          {selectedBatch.subject}
                        </span>
                      )}
                    </div>
                    <h2 className="text-xl font-black tracking-tight truncate">
                      {selectedBatch.name}
                    </h2>
                    {selectedBatch.timing && (
                      <p className="text-xs text-blue-200 flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-blue-300 flex-shrink-0" />
                        <span>{selectedBatch.timing}</span>
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-3 bg-white/10 p-2.5 rounded-2xl backdrop-blur-xs border border-white/10 flex-shrink-0">
                    <div className="text-center px-2">
                      <div className="text-xs text-blue-200 font-medium">Students</div>
                      <div className="text-lg font-black">{currentStats.totalStudents}</div>
                    </div>
                    <div className="h-7 w-px bg-white/20" />
                    <div className="text-center px-2">
                      <div className="text-xs text-blue-200 font-medium">Active</div>
                      <div className="text-lg font-black text-emerald-300">
                        {currentStats.activeStudents}
                      </div>
                    </div>
                    <div className="h-7 w-px bg-white/20" />
                    <div className="text-center px-2">
                      <div className="text-xs text-blue-200 font-medium">Monthly Fee</div>
                      <div className="text-sm sm:text-base font-black text-white">
                        {formatCurrency(currentStats.monthlyFee)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Debounced Search Bar */}
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                {isSearchingStudents ? (
                  <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </div>
              <input
                type="text"
                value={studentSearchInput}
                onChange={(e) => setStudentSearchInput(e.target.value)}
                placeholder={`Search students in ${selectedBatch.name} by name or WhatsApp...`}
                className="w-full rounded-2xl border border-slate-200 bg-white pl-9 pr-9 py-2.5 text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 shadow-xs transition-all"
              />
              {studentSearchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setStudentSearchInput("");
                    setSearchedStudents(null);
                  }}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Student Listing */}
            {isSearchingStudents && searchedStudents === null ? (
              <div className="p-8 text-center bg-white rounded-3xl border border-slate-200 flex items-center justify-center gap-2 text-xs text-slate-500 font-semibold">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                <span>Searching students...</span>
              </div>
            ) : currentBatchStudents.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
                  <Users className="w-6 h-6 stroke-[2]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {studentSearchInput
                      ? `No students found matching "${studentSearchInput}"`
                      : `No students enrolled in ${selectedBatch.name} yet`}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                    {studentSearchInput
                      ? "Check for typos or try clearing your search query."
                      : "Enroll students into this batch to begin tracking attendance, issuing fees, and sharing parent portal links."}
                  </p>
                </div>
                {studentSearchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setStudentSearchInput("");
                      setSearchedStudents(null);
                    }}
                    className="tap-bounce inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition-colors"
                  >
                    Clear Search
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleOpenAdd}
                    className="tap-bounce inline-flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-600/30 transition-all"
                  >
                    <UserPlus className="w-4 h-4 stroke-[2.2]" />
                    <span>Enroll Student into {selectedBatch.name}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-200/90 bg-white shadow-xs overflow-hidden divide-y divide-slate-100">
                {currentBatchStudents.map((student) => (
                  <StudentRowItem
                    key={student._id}
                    student={student}
                    assignedTeacherName={
                      student.assignedTeacherId
                        ? teacherMap[student.assignedTeacherId]
                        : undefined
                    }
                    userRole={userProfile?.role}
                    onEdit={handleOpenEdit}
                    onDelete={handleDeleteStudent}
                    onOpenPortal={handleOpenPortal}
                    onTransfer={handleOpenTransfer}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Single Admission & Edit Form Modal */}
      <StudentFormModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setStudentToEdit(null);
        }}
        onSuccess={handleModalSuccess}
        studentToEdit={studentToEdit}
        availableBatches={uniqueBatchNames}
        initialBatch={selectedBatch?.name || undefined}
      />

      {/* Create Batch Modal (Owner Only) */}
      {userProfile?.role === "owner" && (
        <CreateBatchModal
          isOpen={isBatchModalOpen}
          onClose={() => setIsBatchModalOpen(false)}
          onSuccess={handleBatchSuccess}
        />
      )}

      {/* Student Batch Assignment Request Modal */}
      <StudentBatchRequestModal
        isOpen={isStudentRequestOpen}
        onClose={() => {
          setIsStudentRequestOpen(false);
          setRequestStudentTarget(null);
        }}
        initialStudent={requestStudentTarget}
        students={students}
        batches={batches}
        onSuccess={() => {
          showToast("Batch assignment request submitted for Owner review!");
          fetchPendingRequestsCount();
        }}
      />

      {/* Batch Requests Inbox / Management Modal */}
      <BatchRequestsModal
        isOpen={isBatchRequestsOpen}
        onClose={() => setIsBatchRequestsOpen(false)}
        userRole={userProfile?.role}
        onRequestsUpdated={() => {
          fetchStudents(true);
          fetchPendingRequestsCount();
        }}
        onRequestNew={() => {
          setRequestStudentTarget(null);
          setIsStudentRequestOpen(true);
        }}
      />

      {/* Bulk Student Import Modal */}
      <BulkImportModal
        isOpen={isBulkImportOpen}
        onClose={() => setIsBulkImportOpen(false)}
        onSuccess={(importedCount) => {
          fetchStudents(true);
          fetchBatches(true);
          showToast(`Bulk import successful! ${importedCount} students added.`);
        }}
      />
    </div>
  );
}

export default function AdmissionsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
          <span>Loading admissions...</span>
        </div>
      }
    >
      <AdmissionsContent />
    </Suspense>
  );
}
