"use client";

import { memo, useMemo } from "react";
import Link from "next/link";
import {
  CalendarCheck,
  Send,
  ClipboardList,
  ChevronRight,
  Loader2,
} from "lucide-react";

interface QuickActionsProps {
  onSendFeeReminders?: () => void;
  isSendingReminders?: boolean;
  overdueCount?: number;
}

function QuickActionsComponent({
  onSendFeeReminders,
  isSendingReminders = false,
  overdueCount,
}: QuickActionsProps) {
  const actions = useMemo(
    () => [
      {
        id: "attendance",
        title: "Mark Today's Attendance",
        subtitle: "Live batch roll-call & attendance",
        icon: CalendarCheck,
        href: "/attendance",
        bgColor: "bg-blue-600 active:bg-blue-700 shadow-md shadow-blue-600/20",
        iconBg: "bg-white/20",
        textColor: "text-white",
        subtextColor: "text-blue-100",
        isButton: false,
      },
      {
        id: "fees",
        title: isSendingReminders ? "Sending Reminders..." : "Send Fee Reminders",
        subtitle: isSendingReminders
          ? "Connecting to WhatsApp & dispatching..."
          : `${overdueCount ?? 0} overdue parents via 1-tap WhatsApp`,
        icon: isSendingReminders ? Loader2 : Send,
        href: "/fees",
        bgColor:
          "bg-orange-500 hover:bg-orange-600 active:bg-orange-700 shadow-md shadow-orange-500/20",
        iconBg: "bg-white/20",
        textColor: "text-white",
        subtextColor: "text-orange-100",
        isButton: Boolean(onSendFeeReminders),
        onClick: onSendFeeReminders,
      },
      {
        id: "tests",
        title: "Enter Test Marks",
        subtitle: "Classroom test marks & rankings",
        icon: ClipboardList,
        href: "/tests",
        bgColor: "bg-emerald-600 active:bg-emerald-700 shadow-md shadow-emerald-600/20",
        iconBg: "bg-white/20",
        textColor: "text-white",
        subtextColor: "text-emerald-100",
        isButton: false,
      },
    ],
    [onSendFeeReminders, isSendingReminders, overdueCount]
  );

  return (
    <div className="space-y-2.5">
      <h2 className="text-[12px] font-bold uppercase tracking-wider text-slate-500 px-0.5">
        Quick Actions
      </h2>

      <div className="space-y-2.5">
        {actions.map((act) => {
          const Icon = act.icon;

          if (act.isButton) {
            return (
              <button
                key={act.id}
                type="button"
                onClick={act.onClick}
                disabled={isSendingReminders}
                className={`tap-bounce flex w-full items-center justify-between rounded-2xl p-4 transition-transform text-left ${act.bgColor} disabled:opacity-75`}
              >
                <div className="flex items-center gap-3.5">
                  <div
                    className={`flex h-11 w-11 items-center justify-center rounded-xl ${act.iconBg} backdrop-blur-sm`}
                  >
                    <Icon
                      className={`h-5 w-5 ${act.textColor} ${
                        isSendingReminders ? "animate-spin" : ""
                      }`}
                    />
                  </div>
                  <div>
                    <h3 className={`text-[15px] font-bold ${act.textColor}`}>
                      {act.title}
                    </h3>
                    <p className={`text-[12px] ${act.subtextColor}`}>
                      {act.subtitle}
                    </p>
                  </div>
                </div>
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full bg-white/10 ${act.textColor}`}
                >
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            );
          }

          return (
            <Link
              key={act.id}
              href={act.href}
              className={`tap-bounce flex items-center justify-between rounded-2xl p-4 transition-transform ${act.bgColor}`}
            >
              <div className="flex items-center gap-3.5">
                <div
                  className={`flex h-11 w-11 items-center justify-center rounded-xl ${act.iconBg} backdrop-blur-sm`}
                >
                  <Icon className={`h-5 w-5 ${act.textColor}`} />
                </div>
                <div>
                  <h3 className={`text-[15px] font-bold ${act.textColor}`}>
                    {act.title}
                  </h3>
                  <p className={`text-[12px] ${act.subtextColor}`}>
                    {act.subtitle}
                  </p>
                </div>
              </div>
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full bg-white/10 ${act.textColor}`}
              >
                <ChevronRight className="h-4 w-4" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default memo(QuickActionsComponent);
