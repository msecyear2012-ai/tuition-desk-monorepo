"use client";

import { useState, useEffect } from "react";
import {
  X,
  User,
  Phone,
  Mail,
  Lock,
  BookOpen,
  Loader2,
  AlertCircle,
  GraduationCap,
  Eye,
  EyeOff,
  CheckCircle2,
} from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { TeacherRecord } from "@/types";

interface TeacherFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (teacher: TeacherRecord) => void;
  teacherToEdit?: TeacherRecord | null;
}

export default function TeacherFormModal({
  isOpen,
  onClose,
  onSuccess,
  teacherToEdit,
}: TeacherFormModalProps) {
  const isEditMode = Boolean(teacherToEdit);

  const [name, setName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [subjectsText, setSubjectsText] = useState("");
  const [isActive, setIsActive] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync form state when modal opens or teacherToEdit changes
  useEffect(() => {
    if (isOpen) {
      if (teacherToEdit) {
        setName(teacherToEdit.name || "");
        setLoginId(teacherToEdit.loginId || "");
        setPhone(teacherToEdit.phone || "");
        setEmail(teacherToEdit.email || "");
        setPassword("");
        setShowPassword(false);
        setSubjectsText(
          Array.isArray(teacherToEdit.subjects)
            ? teacherToEdit.subjects.join(", ")
            : ""
        );
        setIsActive(teacherToEdit.isActive !== false);
      } else {
        setName("");
        setLoginId("");
        setPhone("");
        setEmail("");
        setPassword("");
        setShowPassword(false);
        setSubjectsText("");
        setIsActive(true);
      }
      setError(null);
    }
  }, [isOpen, teacherToEdit]);

  if (!isOpen) return null;

  // Auto-fill loginId from phone if loginId is empty or matches previous phone
  const handlePhoneChange = (val: string) => {
    const clean = val.replace(/\D/g, "").slice(0, 15);
    setPhone(clean);
    if (!isEditMode && (!loginId || loginId === phone)) {
      setLoginId(clean);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanName = name.trim();
    const cleanLoginId = loginId.trim();
    const cleanPhone = phone.trim();
    const cleanEmail = email.trim();
    const cleanPassword = password.trim();

    // Client-side validations
    if (!cleanName) {
      setError("Teacher name is required.");
      return;
    }

    if (!cleanLoginId) {
      setError("Login ID is required for teacher authentication.");
      return;
    }

    if (!cleanPhone || cleanPhone.length < 10) {
      setError("Please provide a valid mobile number (at least 10 digits).");
      return;
    }

    if (!isEditMode && (!cleanPassword || cleanPassword.length < 6)) {
      setError("Password is required and must be at least 6 characters.");
      return;
    }

    if (isEditMode && cleanPassword && cleanPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }

    const subjectsArray = subjectsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    setLoading(true);

    try {
      if (isEditMode && teacherToEdit) {
        // Edit Teacher (PUT /api/teachers/:id)
        const updatePayload: Record<string, unknown> = {
          name: cleanName,
          loginId: cleanLoginId,
          phone: cleanPhone,
          email: cleanEmail,
          subjects: subjectsArray,
          isActive,
        };

        if (cleanPassword) {
          updatePayload.password = cleanPassword;
        }

        const res = await apiClient<{ data?: TeacherRecord; teacher?: TeacherRecord }>(
          `/teachers/${teacherToEdit._id}`,
          {
            method: "PUT",
            body: updatePayload,
          }
        );

        const savedTeacher =
          (res.data && ("data" in res.data ? res.data.data : res.data)) ||
          teacherToEdit;

        onSuccess(savedTeacher as TeacherRecord);
        onClose();
      } else {
        // Create Teacher (POST /api/teachers)
        const res = await apiClient<{ data?: TeacherRecord }>(
          "/teachers",
          {
            method: "POST",
            body: {
              name: cleanName,
              loginId: cleanLoginId,
              phone: cleanPhone,
              email: cleanEmail,
              password: cleanPassword,
              subjects: subjectsArray,
              isActive,
            },
          }
        );

        const createdTeacher =
          res.data && "data" in res.data ? res.data.data : res.data;

        onSuccess(createdTeacher as TeacherRecord);
        onClose();
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to save teacher.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fade-in overflow-y-auto">
      <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200/90 overflow-hidden my-6">
        {/* Accent Bar */}
        <div className="h-1.5 w-full bg-gradient-to-r from-indigo-600 via-blue-600 to-cyan-500" />

        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-start justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-600/25 ring-2 ring-indigo-100">
              <GraduationCap className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 tracking-tight">
                {isEditMode ? "Edit Teacher Profile" : "Add New Teacher"}
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                {isEditMode
                  ? "Update teacher credentials, details or active status"
                  : "Create login access for additional coaching faculty"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200/80 flex items-start gap-2.5 text-xs text-rose-700 animate-shake">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
              <div className="flex-1 font-medium leading-relaxed">{error}</div>
            </div>
          )}

          {/* Full Name */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Full Name <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Rahul Sharma"
                className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-sm font-medium text-slate-800 placeholder:text-slate-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {/* Mobile Number */}
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Mobile Number <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  placeholder="10-digit mobile"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-sm font-medium text-slate-800 placeholder:text-slate-400"
                />
              </div>
            </div>

            {/* Login ID */}
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Login ID <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value.trim())}
                  placeholder="Unique login ID"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-sm font-medium text-slate-800 placeholder:text-slate-400"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {/* Email */}
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Email Address <span className="text-slate-400 font-normal lowercase">(optional)</span>
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teacher@example.com"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-sm font-medium text-slate-800 placeholder:text-slate-400"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                {isEditMode ? "Change Password" : "Password"}{" "}
                {!isEditMode && <span className="text-rose-500">*</span>}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    isEditMode
                      ? "Leave blank to keep current"
                      : "Min 6 characters"
                  }
                  className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-sm font-medium text-slate-800 placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Subjects */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Subjects Taught <span className="text-slate-400 font-normal lowercase">(comma separated)</span>
            </label>
            <div className="relative">
              <BookOpen className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={subjectsText}
                onChange={(e) => setSubjectsText(e.target.value)}
                placeholder="e.g. Physics, Chemistry, Mathematics"
                className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 text-sm font-medium text-slate-800 placeholder:text-slate-400"
              />
            </div>
          </div>

          {/* Active Status Checkbox */}
          <div className="pt-1">
            <label className="flex items-center gap-3 p-3 rounded-2xl bg-slate-50 border border-slate-200/80 cursor-pointer hover:bg-slate-100/70 transition-colors">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 text-indigo-600 rounded-md border-slate-300 focus:ring-indigo-500"
              />
              <div className="text-xs">
                <span className="font-bold text-slate-800 block">
                  Active Faculty Account
                </span>
                <span className="text-slate-500">
                  Allow this teacher to log in, view student lists, and record attendance
                </span>
              </div>
            </label>
          </div>

          {/* Footer Actions */}
          <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="tap-bounce flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold shadow-md shadow-indigo-600/20 hover:bg-indigo-700 active:bg-indigo-800 transition-all disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{isEditMode ? "Saving Changes..." : "Creating Account..."}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{isEditMode ? "Save Changes" : "Create Teacher"}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
