"use client";

import { useState, useEffect, useMemo } from "react";
import {
  X,
  UserPlus,
  UserCheck,
  User,
  Users,
  Phone,
  Calendar,
  IndianRupee,
  Loader2,
  AlertCircle,
  GraduationCap,
  Sparkles,
} from "lucide-react";
import { apiClient, getCurrentCenterId } from "@/lib/apiClient";
import { getAuthenticatedCenter, type CenterInfo } from "@/lib/centerProfile";
import { StudentRecord, BatchRecord, TeacherRecord } from "@/types";

export interface StudentFormData {
  _id?: string;
  centerId?: string;
  name: string;
  batch: string;
  parentWhatsApp: string;
  joiningDate?: string | Date;
  monthlyFee: number;
  billingCycleDate: number;
  assignedTeacherId?: string | null;
  isActive?: boolean;
}

interface StudentFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (student: StudentRecord) => void;
  studentToEdit?: StudentFormData | null;
  availableBatches?: string[];
  initialBatch?: string;
  existingStudents?: Array<{ _id: string; name: string; parentWhatsApp?: string }>;
}

const DEFAULT_FALLBACK_BATCHES = [
  "Class 10 - Science",
  "Class 10 - Mathematics",
  "Class 9 - Foundation",
  "Class 11 - Physics",
  "Class 12 - Chemistry",
];

const PRESET_FEES = [2000, 2500, 3000, 4000, 5000];
const PRESET_CYCLE_DAYS = [1, 5, 10, 15, 25];

export default function StudentFormModal({
  isOpen,
  onClose,
  onSuccess,
  studentToEdit,
  availableBatches = [],
  initialBatch,
  existingStudents = [],
}: StudentFormModalProps) {
  const isEditing = Boolean(studentToEdit?._id);

  // Form Fields
  const [name, setName] = useState("");
  const [batch, setBatch] = useState("");
  const [parentWhatsApp, setParentWhatsApp] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [monthlyFee, setMonthlyFee] = useState<number | string>(2500);
  const [billingCycleDate, setBillingCycleDate] = useState<number>(5);
  const [isActive, setIsActive] = useState(true);
  const [assignedTeacherId, setAssignedTeacherId] = useState<string>("");

  // Auto-detect sibling matching existing students by normalized phone (last 10 digits)
  const normalizedPhoneDigits = parentWhatsApp.replace(/\D/g, "");
  const matchingSibling = useMemo(() => {
    if (!existingStudents || normalizedPhoneDigits.length < 10) return null;
    const last10 = normalizedPhoneDigits.slice(-10);
    return existingStudents.find((s) => {
      if (studentToEdit && s._id === studentToEdit._id) return false;
      const sDigits = (s.parentWhatsApp || "").replace(/\D/g, "");
      return sDigits.slice(-10) === last10;
    });
  }, [existingStudents, normalizedPhoneDigits, studentToEdit]);

  // Batches state fetched from backend
  const [fetchedBatches, setFetchedBatches] = useState<string[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);

  // User Profile & Teacher Management states
  const [userProfile, setUserProfile] = useState<CenterInfo | null>(null);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [loadingTeachers, setLoadingTeachers] = useState(false);

  // UI States
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. Fetch real batches and user profile on mount / open
  useEffect(() => {
    async function loadInitialData() {
      if (!isOpen) return;
      try {
        setLoadingBatches(true);
        const [batchRes, profile] = await Promise.all([
          apiClient<BatchRecord[]>("/batches", {
            params: { centerId: getCurrentCenterId() },
          }),
          getAuthenticatedCenter(),
        ]);

        if (batchRes.data && batchRes.data.length > 0) {
          setFetchedBatches(batchRes.data.map((b) => b.name));
        }

        setUserProfile(profile);

        // If user is Owner, fetch active teachers for assignment dropdown
        if (profile?.role === "owner") {
          setLoadingTeachers(true);
          const teacherRes = await apiClient<{ data?: TeacherRecord[] }>(
            "/teachers?isActive=true"
          );
          const list = Array.isArray(teacherRes.data)
            ? teacherRes.data
            : teacherRes.data && "data" in teacherRes.data && Array.isArray(teacherRes.data.data)
            ? (teacherRes.data.data as TeacherRecord[])
            : [];
          setTeachers(list.filter((t) => t.isActive !== false));
        }
      } catch (err) {
        console.error("Failed to load batches or teachers:", err);
      } finally {
        setLoadingBatches(false);
        setLoadingTeachers(false);
      }
    }
    loadInitialData();
  }, [isOpen]);

  // Combine fetched batches, passed available batches, student batch, and fallbacks
  const batchOptions = Array.from(
    new Set([
      ...fetchedBatches,
      ...availableBatches,
      ...(studentToEdit?.batch ? [studentToEdit.batch] : []),
      ...(fetchedBatches.length === 0 && availableBatches.length === 0
        ? DEFAULT_FALLBACK_BATCHES
        : []),
    ])
  );

  // Initialize form fields when studentToEdit changes or modal opens
  useEffect(() => {
    const timer = setTimeout(() => {
      if (studentToEdit) {
        setName(studentToEdit.name || "");
        setBatch(studentToEdit.batch || (batchOptions[0] || "Class 10 - Science"));
        setParentWhatsApp(studentToEdit.parentWhatsApp || "");

        // Date format YYYY-MM-DD
        if (studentToEdit.joiningDate) {
          const d = new Date(studentToEdit.joiningDate);
          if (!isNaN(d.getTime())) {
            setJoiningDate(d.toISOString().split("T")[0]);
          } else {
            setJoiningDate(new Date().toISOString().split("T")[0]);
          }
        } else {
          setJoiningDate(new Date().toISOString().split("T")[0]);
        }

        setMonthlyFee(
          studentToEdit.monthlyFee !== undefined ? studentToEdit.monthlyFee : 2500
        );
        setBillingCycleDate(studentToEdit.billingCycleDate || 5);
        setIsActive(
          studentToEdit.isActive !== undefined ? studentToEdit.isActive : true
        );
        setAssignedTeacherId(studentToEdit.assignedTeacherId || "");
      } else {
        // Defaults for new admission
        setName("");
        setBatch(initialBatch || batchOptions[0] || "Class 10 - Science");
        setParentWhatsApp("");
        setJoiningDate(new Date().toISOString().split("T")[0]);
        setMonthlyFee(2500);
        setBillingCycleDate(5);
        setIsActive(true);
        // For Teacher: locks to their own account; for Owner: defaults to "" (Myself/Owner)
        setAssignedTeacherId(
          userProfile?.role === "teacher" ? userProfile.teacherId || "" : ""
        );
      }
      setError(null);
    }, 0);

    return () => clearTimeout(timer);
  }, [studentToEdit, isOpen, fetchedBatches.length, userProfile, initialBatch, batchOptions]);

  if (!isOpen) return null;

  const isTeacherUser = userProfile?.role === "teacher";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanName = name.trim();
    const finalBatch = batch.trim();
    const cleanPhone = parentWhatsApp.trim().replace(/\s+/g, "").replace(/^\+91/, "");
    const parsedFee = Number(monthlyFee);
    const parsedCycle = Number(billingCycleDate);

    // Validation
    if (!cleanName) {
      setError("Please enter the student's full name.");
      return;
    }

    if (!finalBatch) {
      setError("Please select an assigned batch from the dropdown.");
      return;
    }

    const isTeacherUser = userProfile?.role === "teacher";

    if (!isEditing || !isTeacherUser) {
      if (!cleanPhone || cleanPhone.length < 10) {
        setError("Please enter a valid 10-digit Parent WhatsApp number.");
        return;
      }
    }

    if (isNaN(parsedFee) || parsedFee < 0) {
      setError("Please enter a valid monthly tuition fee amount (₹).");
      return;
    }

    if (isNaN(parsedCycle) || parsedCycle < 1 || parsedCycle > 31) {
      setError("Billing cycle date must be a day of the month between 1 and 31.");
      return;
    }
    // For Owner: empty string or "owner" evaluates to null (Myself/Owner)
    const payloadTeacherId = isTeacherUser
      ? undefined
      : assignedTeacherId && assignedTeacherId !== "owner"
      ? assignedTeacherId
      : null;

    setLoading(true);

    try {
      if (isEditing && studentToEdit?._id) {
        // Edit existing student via PUT /api/students/[id]
        const updateBody: Record<string, unknown> = {
          name: cleanName,
          joiningDate,
          monthlyFee: parsedFee,
          billingCycleDate: parsedCycle,
          isActive,
        };

        if (!isTeacherUser) {
          updateBody.batch = finalBatch;
          updateBody.parentWhatsApp = cleanPhone;
          updateBody.assignedTeacherId = payloadTeacherId;
        }

        const res = await apiClient<StudentRecord>(
          `/students/${studentToEdit._id}`,
          {
            method: "PUT",
            body: updateBody,
          }
        );

        onSuccess(res.data);
      } else {
        // Add new student via POST /api/students
        const createBody: Record<string, unknown> = {
          centerId: getCurrentCenterId(),
          name: cleanName,
          batch: finalBatch,
          parentWhatsApp: cleanPhone,
          joiningDate,
          monthlyFee: parsedFee,
          billingCycleDate: parsedCycle,
          isActive: true,
        };

        if (!isTeacherUser) {
          createBody.assignedTeacherId = payloadTeacherId;
        }

        const res = await apiClient<StudentRecord>("/students", {
          method: "POST",
          body: createBody,
        });

        onSuccess(res.data);
      }

      onClose();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to save student record.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/65 backdrop-blur-sm animate-fade-in overflow-y-auto">
      <div className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200/90 my-auto sm:my-8 flex flex-col max-h-[92vh] overflow-hidden">
        {/* Modal Top Decorative Accent */}
        <div className="h-1.5 w-full bg-gradient-to-r from-blue-600 via-indigo-600 to-sky-500 flex-shrink-0" />

        {/* Modal Header */}
        <div className="p-5 sm:px-6 sm:py-5 border-b border-slate-100 flex items-start justify-between bg-slate-50/70 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shadow-md ${
                isEditing
                  ? "bg-indigo-600 text-white shadow-indigo-600/25 ring-2 ring-indigo-100"
                  : "bg-blue-600 text-white shadow-blue-600/25 ring-2 ring-blue-100"
              }`}
            >
              {isEditing ? (
                <UserCheck className="w-5 h-5 stroke-[2.2]" />
              ) : (
                <UserPlus className="w-5 h-5 stroke-[2.2]" />
              )}
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 leading-tight">
                {isEditing ? "Edit Student Admission" : "New Student Admission"}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {isEditing
                  ? "Update student enrollment, teacher assignment, and billing rules"
                  : "Enroll a new student with automated monthly fee rules"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-800 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error Alert Banner */}
        {error && (
          <div className="mx-5 sm:mx-6 mt-4 p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2.5 text-xs animate-shake flex-shrink-0">
            <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <span className="font-semibold leading-tight">{error}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-4 sm:space-y-5 overflow-y-auto flex-1">
          {/* Section: Basic Details (2-col on sm) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Field 1: Student Name */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                Student Full Name <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="e.g. Aryan Gupta"
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-4 py-2.5 text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            </div>

            {/* Field 2: Parent WhatsApp Number */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                Parent WhatsApp Number <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500 font-bold text-xs">
                  <Phone className="w-4 h-4 mr-1 text-slate-400" />
                  <span>+91</span>
                </div>
                {isEditing && isTeacherUser ? (
                  <input
                    type="text"
                    value={parentWhatsApp || "••••••••••"}
                    disabled
                    aria-label="Parent contact number masked for privacy"
                    className="w-full rounded-2xl border border-slate-200 bg-slate-100 pl-16 pr-4 py-2.5 text-sm font-semibold font-mono tracking-wide text-slate-500 cursor-not-allowed"
                  />
                ) : (
                  <input
                    type="tel"
                    value={parentWhatsApp}
                    onChange={(e) => {
                      setParentWhatsApp(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="98765 43210"
                    maxLength={10}
                    required
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-16 pr-4 py-2.5 text-sm font-semibold font-mono tracking-wide text-slate-900 placeholder:text-slate-400 placeholder:font-normal focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                  />
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Used for VIP Parent Magic Links and automated fee receipts.
              </p>
              {matchingSibling && !isEditing && (
                <div className="mt-2 p-2.5 rounded-xl bg-blue-50 border border-blue-200/80 text-[11px] font-medium text-blue-900 flex items-center gap-2 animate-fade-in">
                  <Sparkles className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                  <span>
                    Existing parent portal found for this number ({matchingSibling.name}) — student will be auto-linked on save.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Section: Academic Allocation (2-col on sm) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Field 3: Assigned Batch */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="student-batch-select"
                  className="block text-xs font-bold uppercase tracking-wider text-slate-600"
                >
                  Assigned Batch <span className="text-rose-500">*</span>
                </label>
                {loadingBatches && (
                  <span className="text-[10px] text-blue-600 flex items-center gap-1 font-semibold">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading...
                  </span>
                )}
              </div>

              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Users className="w-4 h-4" />
                </div>
                <select
                  id="student-batch-select"
                  value={batch}
                  disabled={isEditing && isTeacherUser}
                  onChange={(e) => {
                    setBatch(e.target.value);
                    if (error) setError(null);
                  }}
                  required
                  className={`w-full rounded-2xl border border-slate-200 pl-10 pr-8 py-2.5 text-sm font-semibold text-slate-800 transition-all ${
                    isEditing && isTeacherUser
                      ? "bg-slate-100/90 text-slate-500 cursor-not-allowed"
                      : "bg-slate-50/50 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 cursor-pointer"
                  }`}
                >
                  {batchOptions.length === 0 ? (
                    <option value="" disabled>
                      No batches available — create a batch first
                    </option>
                  ) : (
                    batchOptions.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))
                  )}
                </select>
                {isEditing && isTeacherUser && (
                  <p className="text-[10px] text-slate-400 mt-1 font-medium">
                    Batch cannot be directly modified by teachers. Submit a batch assignment request for Owner approval.
                  </p>
                )}
              </div>
            </div>

            {/* Field 4: Assigned Faculty / Teacher */}
            {userProfile?.role === "teacher" ? (
              <div className="flex flex-col justify-end">
                <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex-shrink-0 flex items-center justify-center font-bold text-xs shadow-xs">
                      <GraduationCap className="w-4 h-4 stroke-[2.2]" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block truncate">
                        Assigned Faculty
                      </span>
                      <span className="text-xs font-bold text-slate-900 truncate block">
                        {userProfile.teacherName || "Teacher"} (You)
                      </span>
                    </div>
                  </div>
                  <span className="text-[10px] font-extrabold text-indigo-700 bg-white px-2 py-0.5 rounded-full border border-indigo-200 shadow-2xs flex-shrink-0 ml-1">
                    LOCKED
                  </span>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="assigned-teacher-select"
                    className="block text-xs font-bold uppercase tracking-wider text-slate-600"
                  >
                    Assigned Faculty / Teacher
                  </label>
                  {loadingTeachers && (
                    <span className="text-[10px] text-indigo-600 flex items-center gap-1 font-semibold">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading...
                    </span>
                  )}
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <GraduationCap className="w-4 h-4" />
                  </div>
                  <select
                    id="assigned-teacher-select"
                    value={assignedTeacherId}
                    onChange={(e) => {
                      setAssignedTeacherId(e.target.value);
                      if (error) setError(null);
                    }}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-8 py-2.5 text-sm font-semibold text-slate-800 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all cursor-pointer"
                  >
                    <option value="">Myself (Owner)</option>
                    {teachers.map((t) => (
                      <option key={t._id} value={t._id}>
                        {t.name} ({t.loginId})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Section: Admission Date & Fee Setup (2-col on sm) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Field 5: Joining Date */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                Joining Date
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Calendar className="w-4 h-4" />
                </div>
                <input
                  type="date"
                  value={joiningDate}
                  onChange={(e) => setJoiningDate(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-3 py-2.5 text-sm font-semibold text-slate-800 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            </div>

            {/* Field 6: Monthly Fee Amount */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                Monthly Fee (₹) <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500 font-bold text-xs">
                  <IndianRupee className="w-4 h-4 mr-0.5 text-slate-400" />
                </div>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={monthlyFee}
                  onChange={(e) => setMonthlyFee(e.target.value)}
                  placeholder="2500"
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-3 py-2.5 text-sm font-bold text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 transition-all"
                />
              </div>
            </div>
          </div>

          {/* Quick Fee Amount Chips */}
          <div className="flex items-center gap-1.5 flex-wrap px-0.5">
            <span className="text-[11px] text-slate-400 font-medium">Quick fee:</span>
            {PRESET_FEES.map((fee) => (
              <button
                key={fee}
                type="button"
                onClick={() => setMonthlyFee(fee)}
                className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-colors ${
                  Number(monthlyFee) === fee
                    ? "bg-blue-600 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                ₹{fee.toLocaleString("en-IN")}
              </button>
            ))}
          </div>

          {/* Field 7: Billing Cycle Date (Day of Month 1-31) */}
          <div className="rounded-2xl border border-slate-200/90 bg-slate-50/60 p-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                  Billing Cycle Due Date
                </label>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Day of the month when monthly invoice is generated (1 to 31)
                </p>
              </div>
              <div className="relative w-20 flex-shrink-0">
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={billingCycleDate}
                  onChange={(e) => setBillingCycleDate(Number(e.target.value))}
                  required
                  className="w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-center text-sm font-bold text-slate-900 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 transition-all shadow-2xs"
                />
              </div>
            </div>

            {/* Quick Cycle Chips */}
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              <span className="text-[11px] text-slate-400 font-medium">
                Standard cycle:
              </span>
              {PRESET_CYCLE_DAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => setBillingCycleDate(day)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                    billingCycleDate === day
                      ? "bg-slate-900 text-white shadow-xs"
                      : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {day}
                  {day === 1 ? "st" : day === 2 ? "nd" : day === 3 ? "rd" : "th"} of month
                </button>
              ))}
            </div>
          </div>

          {/* Field 8: Active Student Status (if editing) */}
          {isEditing && (
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div>
                <span className="text-xs font-bold text-slate-800">
                  Enrollment Status
                </span>
                <p className="text-[11px] text-slate-500">
                  Active students appear in attendance &amp; automated billing
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsActive((prev) => !prev)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  isActive ? "bg-emerald-600" : "bg-slate-300"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    isActive ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-2 sm:pt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="tap-bounce flex-1 h-11 sm:h-12 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs sm:text-sm transition-colors"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={loading}
              className={`tap-bounce flex-1 h-11 sm:h-12 rounded-2xl text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg transition-all disabled:opacity-60 ${
                isEditing
                  ? "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/30"
                  : "bg-blue-600 hover:bg-blue-700 shadow-blue-600/30"
              }`}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : isEditing ? (
                <>
                  <UserCheck className="w-4 h-4 stroke-[2.2]" />
                  <span>Update Student</span>
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4 stroke-[2.2]" />
                  <span>Confirm Admission</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
