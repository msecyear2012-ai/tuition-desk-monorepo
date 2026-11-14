"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  GraduationCap,
  UserPlus,
  Search,
  Pencil,
  Phone,
  Mail,
  User,
  BookOpen,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Loader2,
  X,
  ArrowLeft,
  ShieldCheck,
  Power,
  Users,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { getAuthenticatedCenter } from "@/lib/centerProfile";
import { TeacherRecord } from "@/types";
import TeacherFormModal from "@/components/modals/TeacherFormModal";

// Deterministic pastel avatar background colors
const AVATAR_COLORS = [
  "bg-indigo-100 text-indigo-700 border-indigo-200",
  "bg-blue-100 text-blue-700 border-blue-200",
  "bg-emerald-100 text-emerald-700 border-emerald-200",
  "bg-purple-100 text-purple-700 border-purple-200",
  "bg-amber-100 text-amber-700 border-amber-200",
  "bg-rose-100 text-rose-700 border-rose-200",
  "bg-cyan-100 text-cyan-700 border-cyan-200",
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export default function TeachersPage() {
  const router = useRouter();

  // Role Protection (DEC-MSEC-01/02): /teachers is strictly Owner-only
  useEffect(() => {
    getAuthenticatedCenter().then((center) => {
      if (center?.role === "teacher") {
        router.replace("/");
      }
    });
  }, [router]);

  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState<TeacherRecord | null>(null);

  // Action states
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((cur) => (cur === msg ? null : cur));
    }, 3500);
  }, []);

  const fetchTeachers = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await apiClient<{ data?: TeacherRecord[]; count?: number }>(
        "/teachers",
        { skipCache: isRefresh }
      );

      const list = Array.isArray(res.data)
        ? res.data
        : res.data && "data" in res.data && Array.isArray(res.data.data)
        ? (res.data.data as TeacherRecord[])
        : [];

      setTeachers(list);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load teachers.";
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTeachers();
  }, [fetchTeachers]);

  // Quick Active / Inactive Status Toggle
  const handleToggleStatus = async (teacher: TeacherRecord) => {
    setTogglingId(teacher._id);
    const newStatus = !teacher.isActive;

    try {
      await apiClient(`/teachers/${teacher._id}`, {
        method: "PUT",
        body: { isActive: newStatus },
      });

      setTeachers((prev) =>
        prev.map((t) => (t._id === teacher._id ? { ...t, isActive: newStatus } : t))
      );

      showToast(
        newStatus
          ? `${teacher.name} has been activated.`
          : `${teacher.name} has been deactivated.`
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to update teacher status.";
      showToast(`Error: ${msg}`);
    } finally {
      setTogglingId(null);
    }
  };

  // Callback after Add/Edit Modal
  const handleSaveSuccess = (savedTeacher: TeacherRecord) => {
    setTeachers((prev) => {
      const exists = prev.some((t) => t._id === savedTeacher._id);
      if (exists) {
        return prev.map((t) => (t._id === savedTeacher._id ? savedTeacher : t));
      }
      return [savedTeacher, ...prev];
    });

    showToast(
      editingTeacher
        ? `Teacher "${savedTeacher.name}" updated successfully.`
        : `Teacher "${savedTeacher.name}" created successfully.`
    );
  };

  // Derived filtered teachers
  const filteredTeachers = useMemo(() => {
    return teachers.filter((teacher) => {
      // 1. Status Filter
      if (statusFilter === "active" && !teacher.isActive) return false;
      if (statusFilter === "inactive" && teacher.isActive) return false;

      // 2. Search query filter
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();

      const nameMatch = teacher.name.toLowerCase().includes(q);
      const phoneMatch = teacher.phone.includes(q);
      const loginMatch = teacher.loginId.toLowerCase().includes(q);
      const emailMatch = teacher.email?.toLowerCase().includes(q);
      const subjectMatch = teacher.subjects?.some((s) =>
        s.toLowerCase().includes(q)
      );

      return Boolean(nameMatch || phoneMatch || loginMatch || emailMatch || subjectMatch);
    });
  }, [teachers, statusFilter, searchQuery]);

  // Counts for pills
  const totalCount = teachers.length;
  const activeCount = teachers.filter((t) => t.isActive).length;
  const inactiveCount = teachers.filter((t) => !t.isActive).length;

  return (
    <div className="p-4 sm:p-6 space-y-5 animate-fade-in pb-24">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-50 p-4 rounded-2xl bg-slate-900 text-white text-xs font-semibold shadow-xl flex items-center gap-2.5 animate-slide-down border border-slate-800">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="ml-2 text-slate-400 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <Link
            href="/"
            className="tap-bounce w-10 h-10 rounded-2xl bg-white border border-slate-200/90 flex items-center justify-center text-slate-600 hover:text-slate-900 shadow-xs hover:border-slate-300 transition-all flex-shrink-0"
            title="Return to Dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Teacher Management
              </h1>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-indigo-100 text-indigo-700 border border-indigo-200/60 uppercase">
                Owner Access
              </span>
            </div>
            <p className="text-xs text-slate-500 font-medium mt-0.5">
              Manage faculty logins, credentials, and subject assignments
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => fetchTeachers(true)}
            disabled={refreshing || loading}
            className="tap-bounce flex items-center gap-1.5 px-3 py-2.5 rounded-2xl bg-white border border-slate-200 text-xs font-semibold text-slate-700 hover:text-slate-900 hover:border-slate-300 shadow-xs transition-all disabled:opacity-50"
            title="Refresh list"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-slate-400 ${
                refreshing ? "animate-spin text-indigo-600" : ""
              }`}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          <button
            onClick={() => {
              setEditingTeacher(null);
              setIsModalOpen(true);
            }}
            className="tap-bounce flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-indigo-600 text-white text-xs font-bold shadow-md shadow-indigo-600/25 hover:bg-indigo-700 active:bg-indigo-800 transition-all"
          >
            <UserPlus className="w-4 h-4 stroke-[2.2]" />
            <span>Add Teacher</span>
          </button>
        </div>
      </div>

      {/* Stats Cards Row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3.5 sm:p-4 rounded-2xl bg-white border border-slate-200/90 shadow-2xs">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
            Total Faculty
          </span>
          <span className="text-lg sm:text-2xl font-black text-slate-900 mt-0.5 block">
            {totalCount}
          </span>
        </div>
        <div className="p-3.5 sm:p-4 rounded-2xl bg-emerald-50/60 border border-emerald-100 shadow-2xs">
          <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider block">
            Active
          </span>
          <span className="text-lg sm:text-2xl font-black text-emerald-900 mt-0.5 block">
            {activeCount}
          </span>
        </div>
        <div className="p-3.5 sm:p-4 rounded-2xl bg-slate-50 border border-slate-200/80 shadow-2xs">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
            Inactive
          </span>
          <span className="text-lg sm:text-2xl font-black text-slate-700 mt-0.5 block">
            {inactiveCount}
          </span>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="space-y-3">
        {/* Search Input */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, phone, login ID, or subject..."
            className="w-full pl-10 pr-9 py-2.5 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-xs sm:text-sm font-medium text-slate-800 placeholder:text-slate-400 shadow-2xs"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs font-bold no-scrollbar">
          <button
            onClick={() => setStatusFilter("all")}
            className={`tap-bounce px-3.5 py-1.5 rounded-full transition-all flex items-center gap-1.5 ${
              statusFilter === "all"
                ? "bg-slate-900 text-white shadow-xs"
                : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300"
            }`}
          >
            <span>All Teachers</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                statusFilter === "all" ? "bg-white/20" : "bg-slate-100"
              }`}
            >
              {totalCount}
            </span>
          </button>

          <button
            onClick={() => setStatusFilter("active")}
            className={`tap-bounce px-3.5 py-1.5 rounded-full transition-all flex items-center gap-1.5 ${
              statusFilter === "active"
                ? "bg-emerald-600 text-white shadow-xs shadow-emerald-600/20"
                : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>Active</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                statusFilter === "active" ? "bg-white/20" : "bg-slate-100"
              }`}
            >
              {activeCount}
            </span>
          </button>

          <button
            onClick={() => setStatusFilter("inactive")}
            className={`tap-bounce px-3.5 py-1.5 rounded-full transition-all flex items-center gap-1.5 ${
              statusFilter === "inactive"
                ? "bg-slate-700 text-white shadow-xs"
                : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            <span>Inactive</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                statusFilter === "inactive" ? "bg-white/20" : "bg-slate-100"
              }`}
            >
              {inactiveCount}
            </span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="py-16 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
          <p className="text-xs font-semibold text-slate-500">
            Loading teachers from directory...
          </p>
        </div>
      ) : error ? (
        <div className="p-6 rounded-3xl bg-rose-50 border border-rose-200 flex flex-col items-center text-center gap-3">
          <AlertCircle className="w-8 h-8 text-rose-600" />
          <div>
            <h3 className="text-sm font-bold text-rose-900">
              Failed to load teachers
            </h3>
            <p className="text-xs text-rose-700 mt-1">{error}</p>
          </div>
          <button
            onClick={() => fetchTeachers(true)}
            className="mt-2 px-4 py-2 rounded-xl bg-white border border-rose-300 text-xs font-bold text-rose-700 hover:bg-rose-100 transition-colors"
          >
            Try Again
          </button>
        </div>
      ) : filteredTeachers.length === 0 ? (
        <div className="py-14 px-6 rounded-3xl bg-white border border-slate-200/90 text-center space-y-3.5 shadow-2xs">
          <div className="w-14 h-14 mx-auto rounded-3xl bg-indigo-50 text-indigo-600 flex items-center justify-center ring-8 ring-indigo-50/50">
            <GraduationCap className="w-7 h-7 stroke-[2]" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              {searchQuery
                ? "No matching teachers found"
                : statusFilter !== "all"
                ? `No ${statusFilter} teachers found`
                : "No additional teachers enrolled yet"}
            </h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
              {searchQuery
                ? "Try searching with a different name, phone number, or login ID."
                : "Add teachers to allow staff to record attendance and collect fees."}
            </p>
          </div>

          {!searchQuery && statusFilter === "all" && (
            <button
              onClick={() => {
                setEditingTeacher(null);
                setIsModalOpen(true);
              }}
              className="tap-bounce inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-indigo-600 text-white text-xs font-bold shadow-md shadow-indigo-600/20 hover:bg-indigo-700 transition-all mt-2"
            >
              <UserPlus className="w-4 h-4" />
              <span>Add First Teacher</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredTeachers.map((teacher) => {
            const avatarColor = getAvatarColor(teacher.name);
            const initials = getInitials(teacher.name);
            const isToggling = togglingId === teacher._id;

            return (
              <div
                key={teacher._id}
                className="p-4 sm:p-5 rounded-2xl bg-white border border-slate-200/90 shadow-2xs hover:border-slate-300 hover:shadow-xs transition-all space-y-3.5 relative overflow-hidden"
              >
                {/* Status indicator ribbon */}
                <div
                  className={`absolute top-0 left-0 right-0 h-1 ${
                    teacher.isActive ? "bg-emerald-500" : "bg-slate-300"
                  }`}
                />

                {/* Top Row: Avatar, Name, Role & Status */}
                <div className="flex items-start justify-between gap-3 pt-1">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-11 h-11 rounded-2xl flex items-center justify-center font-black text-sm border flex-shrink-0 shadow-2xs ${avatarColor}`}
                    >
                      {initials}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className="text-sm sm:text-base font-bold text-slate-900 truncate">
                          {teacher.name}
                        </h3>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                          Teacher
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5 truncate">
                        <User className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <span className="font-mono text-slate-600 font-medium">
                          {teacher.loginId}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Status Pill */}
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-extrabold flex-shrink-0 ${
                      teacher.isActive
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200/80"
                        : "bg-slate-100 text-slate-600 border border-slate-200"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        teacher.isActive ? "bg-emerald-500" : "bg-slate-400"
                      }`}
                    />
                    {teacher.isActive ? "Active" : "Inactive"}
                  </span>
                </div>

                {/* Contact Information */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-600 bg-slate-50/70 p-3 rounded-xl border border-slate-100">
                  <div className="flex items-center gap-2 truncate">
                    <Phone className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    <span className="font-mono font-medium">{teacher.phone}</span>
                  </div>
                  {teacher.email ? (
                    <div className="flex items-center gap-2 truncate">
                      <Mail className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span className="truncate">{teacher.email}</span>
                    </div>
                  ) : (
                    <div className="text-slate-400 italic">No email registered</div>
                  )}
                </div>

                {/* Subjects & Batches */}
                {teacher.subjects && teacher.subjects.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Subjects
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {teacher.subjects.map((sub, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 text-[11px] font-semibold border border-indigo-100/80"
                        >
                          {sub}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions Footer */}
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                  {/* Status Toggle Button */}
                  <button
                    onClick={() => handleToggleStatus(teacher)}
                    disabled={isToggling}
                    className={`tap-bounce inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all disabled:opacity-50 ${
                      teacher.isActive
                        ? "text-slate-600 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 hover:border-rose-200"
                        : "text-emerald-700 hover:bg-emerald-50 border border-emerald-200"
                    }`}
                    title={
                      teacher.isActive
                        ? "Deactivate faculty login"
                        : "Activate faculty login"
                    }
                  >
                    {isToggling ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Power className="w-3.5 h-3.5" />
                    )}
                    <span>{teacher.isActive ? "Deactivate" : "Activate"}</span>
                  </button>

                  {/* Edit Profile Button */}
                  <button
                    onClick={() => {
                      setEditingTeacher(teacher);
                      setIsModalOpen(true);
                    }}
                    className="tap-bounce inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-bold shadow-2xs hover:bg-slate-800 transition-all"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>Edit Profile</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Teacher Form Modal (Add / Edit) */}
      <TeacherFormModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingTeacher(null);
        }}
        onSuccess={handleSaveSuccess}
        teacherToEdit={editingTeacher}
      />
    </div>
  );
}
