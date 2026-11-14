import React, { memo } from "react";
import { MessageCircle, Phone } from "lucide-react";
import {
  formatMaskedPhone,
  formatDisplayPhone,
  evaluateStudentPhoneDisplay,
} from "@/lib/studentPhoneMasked";

export { formatMaskedPhone, formatDisplayPhone };

export interface StudentPhoneMaskedProps {
  phone?: string | null;
  userRole?: "owner" | "teacher" | string | null;
  className?: string;
  textClassName?: string;
  showQuickActions?: boolean;
  actionIconSize?: "sm" | "md";
  emptyPlaceholder?: string;
  showCountryCode?: boolean;
}

function StudentPhoneMasked({
  phone,
  userRole = "teacher",
  className = "inline-flex items-center gap-1.5",
  textClassName = "font-mono font-semibold text-slate-800 text-xs sm:text-sm",
  showQuickActions = true,
  actionIconSize = "sm",
  emptyPlaceholder = "—",
  showCountryCode = true,
}: StudentPhoneMaskedProps) {
  const info = evaluateStudentPhoneDisplay(
    phone,
    userRole || "teacher",
    showQuickActions,
    showCountryCode
  );

  if (!phone || String(phone).trim() === "") {
    return <span className="text-slate-400 font-mono text-xs">{emptyPlaceholder}</span>;
  }

  // Security Perimeter (REQ-02): If role is teacher, NEVER render full numbers, tel: or wa.me links.
  if (info.isMasked) {
    return (
      <span className={className} aria-label={info.ariaLabel}>
        <span className={textClassName}>{info.displayText}</span>
      </span>
    );
  }

  // Owner Role: Full contact access with authorized quick actions
  const iconSizeClass = actionIconSize === "sm" ? "w-5 h-5" : "w-6 h-6";
  const glyphSizeClass = actionIconSize === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";

  return (
    <div className={className}>
      <span className={textClassName}>{info.displayText}</span>

      {info.hasWaLink && info.waHref && (
        <a
          href={info.waHref}
          target="_blank"
          rel="noopener noreferrer"
          className={`${iconSizeClass} rounded-full bg-emerald-50 text-emerald-600 hover:bg-emerald-100 flex items-center justify-center transition-colors`}
          title="Chat on WhatsApp"
          aria-label={info.ariaLabel}
        >
          <MessageCircle className={glyphSizeClass} />
        </a>
      )}

      {info.hasTelLink && info.telHref && (
        <a
          href={info.telHref}
          className={`${iconSizeClass} rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 flex items-center justify-center transition-colors`}
          title="Call parent"
          aria-label={info.ariaLabel}
        >
          <Phone className={glyphSizeClass} />
        </a>
      )}
    </div>
  );
}

export default memo(StudentPhoneMasked);
