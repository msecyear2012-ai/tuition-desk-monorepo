import { memo } from "react";
import { Check, Clock, CheckCircle2, Loader2, ShieldCheck, Sparkles, Trash2, Banknote, Receipt, UserCheck, GraduationCap, Camera, FileText, AlertTriangle } from "lucide-react";
import { OverdueFeeStudent } from "@/types";

interface OverdueStudentItemProps {
  student: OverdueFeeStudent;
  tabType?: "pending" | "review" | "paid";
  userRole?: string;
  onSendReminder?: (student: OverdueFeeStudent) => void;
  isReminderSent?: boolean;
  isSendingReminder?: boolean;
  onMarkPaid?: (student: OverdueFeeStudent) => void;
  isMarkingPaid?: boolean;
  onVerifyPaid?: (student: OverdueFeeStudent) => void;
  isVerifyingPaid?: boolean;
  onRejectFee?: (student: OverdueFeeStudent) => void;
  isRejectingFee?: boolean;
  onViewProof?: (student: OverdueFeeStudent) => void;
  onViewDetails?: (student: OverdueFeeStudent) => void;
  onViewReceipt?: (student: OverdueFeeStudent) => void;
}

function WhatsAppIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12.031 2c-5.507 0-9.982 4.475-9.982 9.982 0 1.761.458 3.483 1.332 5.006l-1.417 5.176 5.305-1.391c1.472.804 3.127 1.229 4.762 1.229 5.507 0 9.982-4.475 9.982-9.982 0-2.665-1.037-5.17-2.923-7.056-1.886-1.886-4.391-2.923-7.057-2.923zm5.823 14.127c-.244.686-1.424 1.31-1.954 1.365-.494.051-1.127.078-3.376-.848-2.696-1.11-4.442-3.844-4.577-4.024-.135-.18-1.096-1.458-1.096-2.781 0-1.323.693-1.975.94-2.242.247-.267.54-.334.72-.334.18 0 .36.002.518.01.168.009.394-.064.617.472.228.547.78 1.905.849 2.044.069.139.115.302.023.485-.092.183-.138.297-.275.457-.137.16-.289.358-.413.481-.138.137-.282.287-.121.564.161.277.717 1.182 1.541 1.916 1.059.943 1.953 1.236 2.23 1.373.277.137.439.115.601-.069.162-.184.693-.807.878-1.084.185-.277.369-.231.616-.139.247.092 1.568.739 1.838.874.27.135.45.202.517.316.067.115.067.666-.177 1.352z" />
    </svg>
  );
}

function OverdueStudentItem({
  student,
  tabType,
  userRole = "owner",
  onSendReminder,
  isReminderSent = false,
  isSendingReminder = false,
  onMarkPaid,
  isMarkingPaid = false,
  onVerifyPaid,
  isVerifyingPaid = false,
  onRejectFee,
  isRejectingFee = false,
  onViewProof,
  onViewDetails,
  onViewReceipt,
}: OverdueStudentItemProps) {
  const isCritical = student.daysLate >= 7;
  const isVerificationPending = student.status === "Verification Pending";
  const isPartialPaid = student.status === "Partial Paid";
  const isPaid = student.status === "Paid";

  const totalFeeAmount =
    student.totalAmount ?? (student.pendingAmount + (student.paidAmount || 0));
  const amountPaidSoFar = student.paidAmount || 0;
  const remainingBalance = student.pendingAmount;

  const isReviewTab = tabType === "review" || isVerificationPending;
  const isPaidTab = tabType === "paid" || isPaid;
  const isCash = Boolean(student.paymentMode && /cash/i.test(student.paymentMode));

  // In Paid tab, display the actual paidAmount (or total settled amount)
  const displayAmount = isPaidTab
    ? (amountPaidSoFar > 0 ? amountPaidSoFar : (student.totalAmount || 0))
    : student.pendingAmount;

  // Check if fee title, batchName, or month indicates an Advance Payment
  const isAdvance = Boolean(
    (student.title && /advance/i.test(student.title)) ||
    (student.batchName && /advance/i.test(student.batchName)) ||
    (student.month && /advance/i.test(student.month))
  );

  return (
    <div
      className={`rounded-2xl p-3.5 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full max-w-full overflow-hidden ${
        isReviewTab
          ? "border-2 border-amber-400 bg-amber-50/80 shadow-md shadow-amber-500/5 ring-1 ring-amber-300/50"
          : isPaidTab
          ? "border border-emerald-100 bg-white shadow-xs hover:border-emerald-200"
          : isCritical
          ? "border border-rose-200 bg-white shadow-xs hover:border-rose-300"
          : "border border-slate-100 bg-white shadow-xs hover:border-slate-200 hover:shadow-sm"
      }`}
    >
      {/* Left: Initials Avatar + Student Details */}
      <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
        <div
          className={`h-11 w-11 flex-shrink-0 rounded-2xl flex items-center justify-center font-bold text-xs border shadow-2xs ${student.avatarColor}`}
        >
          {student.initials}
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[14px] font-bold text-slate-900 tracking-tight truncate max-w-[200px] min-[380px]:max-w-xs">
              {student.name}
            </h3>

            {/* Advance Payment Badge */}
            {isAdvance && (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-xs">
                <Sparkles className="h-3 w-3 stroke-[2.4]" />
                Advance Payment
              </span>
            )}

            {/* Status / Category Badges */}
            {isReviewTab ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold bg-amber-500 text-white shadow-xs animate-pulse">
                <ShieldCheck className="h-3 w-3 stroke-[2.6]" />
                Awaiting Review
              </span>
            ) : isPaidTab ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-200">
                <CheckCircle2 className="h-3 w-3 text-emerald-600 stroke-[2.6]" />
                Paid
              </span>
            ) : isPartialPaid ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold bg-amber-600 text-white shadow-xs">
                <ShieldCheck className="h-3 w-3 stroke-[2.6]" />
                Partial Paid
              </span>
            ) : (
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-extrabold border ${
                  isCritical
                    ? "bg-rose-100 text-rose-700 border-rose-200"
                    : "bg-amber-100 text-amber-800 border-amber-200"
                }`}
              >
                <Clock className="h-2.5 w-2.5" />
                {student.daysLate} {student.daysLate === 1 ? "Day" : "Days"} Late
              </span>
            )}
          </div>

          <p className="mt-0.5 text-[11px] text-slate-500 font-medium truncate">
            {student.batchName}
          </p>

          {/* Partial Payment Progress Breakdown */}
          {isPartialPaid && (
            <div
              className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]"
              data-testid="partial-paid-breakdown"
            >
              <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 font-medium text-amber-900 border border-amber-200/80">
                <span>
                  Total:{" "}
                  <strong className="font-semibold text-slate-800 font-mono">
                    ₹{totalFeeAmount.toLocaleString("en-IN")}
                  </strong>
                </span>
                <span className="text-amber-400">•</span>
                <span>
                  Paid:{" "}
                  <strong className="font-semibold text-emerald-700 font-mono">
                    ₹{amountPaidSoFar.toLocaleString("en-IN")}
                  </strong>
                </span>
                <span className="text-amber-400">•</span>
                <span>
                  Balance:{" "}
                  <strong className="font-semibold text-rose-700 font-mono">
                    ₹{remainingBalance.toLocaleString("en-IN")}
                  </strong>
                </span>
              </span>
            </div>
          )}

          {/* Prior Rejection Notice (if returned to Pending after proof rejection) */}
          {student.rejectionReason && !isReviewTab && !isPaidTab && !isPartialPaid && (
            <div className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 w-fit max-w-full">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600 flex-shrink-0" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-rose-600 flex-shrink-0">
                Rejected:
              </span>
              <span className="font-medium text-rose-900 text-[11px] truncate">
                &ldquo;{student.rejectionReason}&rdquo;
              </span>
            </div>
          )}

          {/* Prominent UTR & Screenshot Badge if Verification Pending / Awaiting Review */}
          {isReviewTab && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {student.utrNumber ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-xs shadow-2xs w-fit">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-800">
                    UTR / Ref:
                  </span>
                  <span className="font-mono font-black text-amber-950 tracking-wider select-all">
                    {student.utrNumber}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-200 text-xs shadow-2xs w-fit">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                    UTR:
                  </span>
                  <span className="font-medium text-slate-600 text-[11px]">
                    UTR Not Fetched
                  </span>
                </div>
              )}
              {student.hasPaymentProof && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-800 text-[11px] font-bold shadow-2xs">
                  <Camera className="w-3.5 h-3.5 text-indigo-600 stroke-[2.2]" />
                  <span>Screenshot Attached</span>
                </span>
              )}
            </div>
          )}

          {/* Prominent Receipt Display if Paid */}
          {isPaidTab && student.receiptNumber && (
            <div className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-xs shadow-2xs w-fit">
              <Receipt className="h-3.5 w-3.5 text-emerald-700" />
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-800">
                Receipt:
              </span>
              <span className="font-mono font-black text-emerald-950 tracking-wider select-all">
                {student.receiptNumber}
              </span>
            </div>
          )}

          {/* Paid Fee Attribution: Cash Collector & Academic Faculty Snapshots */}
          {isPaidTab && (
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5 sm:gap-2 text-[11px]"
              data-testid="paid-fee-attribution"
            >
              {/* Collected By (Physical/Digital Cash Custody) */}
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100/90 text-slate-700 border border-slate-200 shadow-2xs">
                <UserCheck className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0" />
                <span className="text-slate-500 font-medium">Collected By:</span>
                <strong className="text-slate-900 font-bold">
                  {student.receivedByName || (student.receivedByRole === "teacher" ? "Teacher" : "Owner")}
                </strong>
                <span className="text-[9.5px] px-1 py-0.2 rounded font-extrabold uppercase bg-white border border-slate-200 text-slate-600">
                  {student.receivedByRole === "teacher" ? "Teacher" : "Owner"}
                </span>
              </span>

              {/* Academic Teacher (Faculty at Payment Snapshot) */}
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-50/80 text-indigo-900 border border-indigo-200/80 shadow-2xs">
                <GraduationCap className="h-3.5 w-3.5 text-indigo-600 flex-shrink-0" />
                <span className="text-indigo-500 font-medium">Academic Teacher:</span>
                <strong className="text-indigo-950 font-bold">
                  {student.assignedTeacherName || "Owner"}
                </strong>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Right Side: Amount + Action Buttons */}
      <div
        className="flex flex-col sm:flex-row sm:items-center justify-between sm:justify-end gap-2.5 sm:gap-3 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-200/80 w-full sm:w-auto"
      >
        <div className="flex items-baseline justify-between sm:justify-end sm:block w-full sm:w-auto">
          <div className="text-[15px] sm:text-base font-extrabold text-slate-900 font-mono tracking-tight">
            ₹{displayAmount.toLocaleString("en-IN")}
          </div>
          {isPartialPaid ? (
            <div className="text-[10px] text-amber-800 text-right sm:text-right font-medium">
              <span className="font-bold text-amber-700 sm:block inline">Balance Due </span>
              <span className="text-slate-500 sm:block inline text-[9.5px]">
                (Paid ₹{amountPaidSoFar.toLocaleString("en-IN")} of ₹{totalFeeAmount.toLocaleString("en-IN")})
              </span>
            </div>
          ) : (
            <span className="text-[10px] font-semibold text-slate-400 block sm:text-right">
              {isReviewTab
                ? "Awaiting Approval"
                : isPaidTab
                ? "Settled"
                : "Due"}
            </span>
          )}
        </div>

        <div className={`flex items-center gap-1.5 sm:gap-2 flex-wrap sm:flex-nowrap ${isReviewTab ? "w-full sm:w-auto" : ""}`}>
          {/* Action 1: Green "Approve & Mark Paid" + Red "Reject" + "View Proof" for Awaiting Review (Owner Only) */}
          {isReviewTab ? (
            userRole === "owner" && (onVerifyPaid || onRejectFee || onViewProof) ? (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                {/* Secondary Actions Row: View Proof + Reject (50/50 on mobile, inline on desktop) */}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {onViewProof && (
                    <button
                      type="button"
                      onClick={() => onViewProof(student)}
                      disabled={isVerifyingPaid || isRejectingFee}
                      aria-label={`View payment proof screenshot for ${student.name}`}
                      title="View screenshot proof"
                      className="tap-bounce h-10 px-3 sm:px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-md shadow-indigo-600/25 disabled:opacity-50 flex-1 sm:flex-initial text-center cursor-pointer whitespace-nowrap"
                    >
                      {student.hasPaymentProof ? (
                        <>
                          <Camera className="h-4 w-4 text-white stroke-[2.2] flex-shrink-0" />
                          <span>View Proof</span>
                        </>
                      ) : (
                        <>
                          <FileText className="h-4 w-4 text-white stroke-[2.2] flex-shrink-0" />
                          <span>View Details</span>
                        </>
                      )}
                    </button>
                  )}

                  {onRejectFee && (
                    <button
                      type="button"
                      onClick={() => onRejectFee(student)}
                      disabled={isVerifyingPaid || isRejectingFee}
                      aria-label={`Reject and delete fee submission for ${student.name}`}
                      title="Reject & Delete (Remove invalid/fake submission)"
                      className="tap-bounce h-10 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-md shadow-rose-600/25 disabled:opacity-50 flex-1 sm:flex-initial text-center cursor-pointer whitespace-nowrap"
                    >
                      {isRejectingFee ? (
                        <Loader2 className="h-4 w-4 animate-spin text-white flex-shrink-0" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-white stroke-[2.2] flex-shrink-0" />
                      )}
                      <span>Reject</span>
                    </button>
                  )}
                </div>

                {/* Primary Action: Approve & Mark Paid (full-width on mobile, inline on desktop) */}
                {onVerifyPaid && (
                  <button
                    type="button"
                    onClick={() => onVerifyPaid(student)}
                    disabled={isVerifyingPaid || isRejectingFee}
                    aria-label={`Approve and mark fee for ${student.name} as paid`}
                    title="Approve & Mark Paid (Online/UPI)"
                    className="tap-bounce h-10 px-3.5 sm:px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-md shadow-emerald-600/25 disabled:opacity-50 w-full sm:w-auto text-center cursor-pointer whitespace-nowrap"
                  >
                    {isVerifyingPaid ? (
                      <Loader2 className="h-4 w-4 animate-spin text-white flex-shrink-0" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-white stroke-[2.5] flex-shrink-0" />
                    )}
                    <span>Approve &amp; Mark Paid</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-100 text-amber-900 border border-amber-300 text-xs font-bold">
                  <Clock className="w-3.5 h-3.5 text-amber-700" />
                  <span>Awaiting Owner Review</span>
                </span>
                {onViewDetails && (
                  <button
                    type="button"
                    onClick={() => onViewDetails(student)}
                    className="tap-bounce h-9 px-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1 shadow-2xs"
                  >
                    <span>Details</span>
                  </button>
                )}
              </div>
            )
          ) : isPaidTab ? (
            /* Action 2: Paid Tab Receipt Badge & Mode Indicator + View Receipt / Details */
            <div className="flex flex-wrap items-center justify-start sm:justify-end gap-1.5 sm:gap-2">
              {isCash ? (
                <span className="text-[11px] font-bold text-emerald-800 bg-emerald-100/90 px-2.5 py-1 rounded-xl border border-emerald-300 flex items-center gap-1 shadow-2xs">
                  <Banknote className="h-3.5 w-3.5 text-emerald-700" />
                  Cash
                </span>
              ) : (
                <span className="text-[11px] font-bold text-blue-800 bg-blue-50 px-2.5 py-1 rounded-xl border border-blue-200 shadow-2xs">
                  {student.paymentMode || "Online/UPI"}
                </span>
              )}

              {student.receiptNumber && (
                <span
                  className="text-[11px] font-mono font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-xl border border-slate-200/90 select-all shadow-2xs flex items-center gap-1"
                  title="Official Receipt Number"
                >
                  <Receipt className="h-3 w-3 text-slate-500" />
                  {student.receiptNumber}
                </span>
              )}

              {student.paidDate && (
                <span className="text-[11px] text-slate-500 font-medium inline-flex items-center gap-1 bg-slate-50 px-2.5 py-1 rounded-xl border border-slate-200 shadow-2xs">
                  <Clock className="h-3 w-3 text-slate-400" />
                  {student.paidDate}
                </span>
              )}

              {onViewReceipt && (
                <button
                  type="button"
                  onClick={() => onViewReceipt(student)}
                  className="tap-bounce h-8.5 px-2.5 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-bold flex items-center gap-1 shadow-2xs cursor-pointer"
                  title="View official receipt slip"
                >
                  <Receipt className="h-3.5 w-3.5 text-emerald-700" />
                  <span>Receipt</span>
                </button>
              )}

              {onViewDetails && (
                <button
                  type="button"
                  onClick={() => onViewDetails(student)}
                  className="tap-bounce h-8.5 px-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1 shadow-2xs cursor-pointer"
                  title="View complete payment history"
                >
                  <span>Details</span>
                </button>
              )}
            </div>
          ) : (
            /* Action 3: Pending Tab Actions (Record Payment Cash + Details + WhatsApp Reminder) */
            <div className="flex items-center justify-end gap-1.5 sm:gap-2 flex-wrap sm:flex-nowrap w-full sm:w-auto">
              {onMarkPaid && (
                <button
                  type="button"
                  onClick={() => onMarkPaid(student)}
                  disabled={isMarkingPaid}
                  aria-label={`Record payment for ${student.name}`}
                  title="Record manual payment (Cash)"
                  className="tap-bounce h-10 px-2.5 sm:px-3 rounded-xl bg-emerald-50 hover:bg-emerald-100 active:scale-95 text-emerald-800 border border-emerald-300/80 text-xs font-bold flex items-center justify-center gap-1 sm:gap-1.5 transition-all shadow-2xs disabled:opacity-50 cursor-pointer flex-1 sm:flex-initial"
                >
                  {isMarkingPaid ? (
                    <Loader2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin text-emerald-600 flex-shrink-0" />
                  ) : (
                    <Banknote className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-700 stroke-[2.3] flex-shrink-0" />
                  )}
                  <span className="hidden min-[380px]:inline whitespace-nowrap">Record Payment</span>
                  <span className="min-[380px]:hidden inline whitespace-nowrap">Pay</span>
                </button>
              )}

              {onViewDetails && (
                <button
                  type="button"
                  onClick={() => onViewDetails(student)}
                  className="tap-bounce h-10 px-2.5 sm:px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center gap-1 shadow-2xs cursor-pointer flex-shrink-0"
                  title="View fee details and payment history"
                >
                  <Receipt className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" />
                  <span className="hidden min-[360px]:inline whitespace-nowrap">Details</span>
                </button>
              )}

              {onSendReminder && (
                <button
                  type="button"
                  onClick={() => onSendReminder(student)}
                  disabled={isSendingReminder}
                  aria-label={`Send WhatsApp reminder to ${student.name}'s parent`}
                  className={`tap-bounce h-10 w-10 rounded-full flex items-center justify-center transition-all shadow-md flex-shrink-0 ${
                    isSendingReminder
                      ? "bg-slate-300 text-slate-600 cursor-not-allowed"
                      : isReminderSent
                      ? "bg-emerald-700 text-white shadow-emerald-700/25 ring-2 ring-emerald-200"
                      : "bg-emerald-500 hover:bg-emerald-600 active:scale-90 text-white shadow-emerald-500/30"
                  }`}
                >
                  {isSendingReminder ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isReminderSent ? (
                    <Check className="h-4 w-4 stroke-[2.8]" />
                  ) : (
                    <WhatsAppIcon className="h-4 w-4 sm:h-5 sm:w-5" />
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(OverdueStudentItem);
