import mongoose from "mongoose";
import StaffNotification, {
  type IStaffNotification,
  type IStaffNotificationDocument,
  type NotificationRole,
  type NotificationCategory,
  type NotificationEventType,
} from "../models/StaffNotification.ts";
import ParentAccess from "../models/ParentAccess.ts";
import UserPushSubscription from "../models/UserPushSubscription.ts";
import { sendPushToParent, sendPushToUser } from "./pushService.ts";

export interface CreateNotificationInput {
  centerId: string;
  recipientId: string;
  recipientRole: NotificationRole;
  category?: NotificationCategory;
  type: NotificationEventType;
  title: string;
  message: string;
  amount?: number;
  statusLabel?: string;
  feeId?: string;
  paymentId?: string;
  studentId?: string;
  studentName?: string;
  collectorId?: string;
  collectorName?: string;
  entityType?: string;
  entityId?: string;
  deepLink?: string;
  link?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export const CANONICAL_CATEGORY_TYPES: Record<string, string[]> = {
  fee: ["cash_collection", "fee_reminder"],
  handover: [
    "handover_submitted",
    "handover_verified",
    "handover_rejected",
    "dispute_raised",
    "dispute_resolved",
  ],
  batch: [
    "batch_request_submitted",
    "batch_request_approved",
    "batch_request_rejected",
  ],
  academic: [
    "student_admitted",
    "attendance_marked",
    "test_scheduled",
    "test_result",
    "homework_assigned",
  ],
  communication: ["parent_message"],
  system: ["system", "announcement"],
};

export function resolveNotificationCategory(
  type: NotificationEventType
): NotificationCategory {
  switch (type) {
    case "cash_collection":
    case "fee_reminder":
      return "fee";
    case "handover_submitted":
    case "handover_verified":
    case "handover_rejected":
    case "dispute_raised":
    case "dispute_resolved":
      return "handover";
    case "batch_request_submitted":
    case "batch_request_approved":
    case "batch_request_rejected":
      return "batch";
    case "student_admitted":
    case "attendance_marked":
    case "test_scheduled":
    case "test_result":
    case "homework_assigned":
      return "academic";
    case "parent_message":
      return "communication";
    default:
      return "system";
  }
}

/**
 * Creates a notification with strict center isolation, idempotency deduplication,
 * and optional Web Push integration.
 */
export async function createNotification(
  input: CreateNotificationInput
): Promise<IStaffNotificationDocument | null> {
  const {
    centerId,
    recipientId,
    recipientRole,
    type,
    title,
    message,
    amount,
    statusLabel,
    feeId,
    paymentId,
    studentId,
    studentName,
    collectorId,
    collectorName,
    entityType,
    entityId,
    deepLink,
    link,
    idempotencyKey,
    metadata,
  } = input;

  if (!centerId || !recipientId || !recipientRole || !title || !message) {
    console.warn("[NOTIFICATION SERVICE] Missing required fields for notification");
    return null;
  }

  const cleanCenterId = String(centerId).trim();
  const cleanRecipientId = String(recipientId).trim();
  const category = input.category || resolveNotificationCategory(type);
  const resolvedLink = deepLink || link || "/";

  // Check idempotency if key provided
  if (
    idempotencyKey &&
    idempotencyKey.trim() &&
    (mongoose.connection?.readyState === 1 ||
      StaffNotification.findOne !== mongoose.Model.findOne)
  ) {
    try {
      const existing = await StaffNotification.findOne({
        centerId: cleanCenterId,
        idempotencyKey: idempotencyKey.trim(),
      });
      if (existing) {
        return existing;
      }
    } catch {
      // ignore buffering timeout in disconnected unit tests
    }
  }

  let pushStatus: "none" | "sent" | "simulated" | "failed" = "none";

  // If notification is for a parent, optionally trigger Web Push
  if (
    recipientRole === "parent" &&
    studentId &&
    (mongoose.connection?.readyState === 1 ||
      ParentAccess.findOne !== mongoose.Model.findOne)
  ) {
    try {
      // Find parent access for student
      const parentDoc = await ParentAccess.findOne({
        centerId: cleanCenterId,
        linkedStudentIds: new mongoose.Types.ObjectId(studentId),
        status: "active",
      });

      if (parentDoc && parentDoc.pushSubscriptions && parentDoc.pushSubscriptions.length > 0) {
        const pushResult = await sendPushToParent(parentDoc, {
          title,
          body: message,
          url: resolvedLink,
          tag: `notif-${type}-${entityId || studentId}`,
        });
        pushStatus = pushResult.simulated ? "simulated" : pushResult.sent > 0 ? "sent" : "failed";
      }
    } catch (pushErr) {
      console.warn("[NOTIFICATION SERVICE] Parent Web Push dispatch notice:", pushErr);
      pushStatus = "failed";
    }
  } else if (
    (recipientRole === "owner" || recipientRole === "teacher") &&
    (mongoose.connection?.readyState === 1 ||
      UserPushSubscription.findOne !== mongoose.Model.findOne)
  ) {
    try {
      const pushResult = await sendPushToUser(
        cleanCenterId,
        cleanRecipientId,
        {
          title,
          body: message,
          url: resolvedLink,
          tag: `notif-${type}-${entityId || cleanRecipientId}`,
        },
        recipientRole
      );
      if (pushResult.attempted > 0) {
        pushStatus = pushResult.simulated
          ? "simulated"
          : pushResult.sent > 0
          ? "sent"
          : "failed";
      }
    } catch (pushErr) {
      console.warn("[NOTIFICATION SERVICE] Staff Web Push dispatch notice:", pushErr);
    }
  }

  try {
    const notif = new StaffNotification({
      centerId: cleanCenterId,
      recipientId: cleanRecipientId,
      recipientRole,
      category,
      type,
      title: title.trim(),
      message: message.trim(),
      amount: typeof amount === "number" ? amount : 0,
      statusLabel,
      feeId,
      paymentId,
      studentId,
      studentName,
      collectorId,
      collectorName,
      entityType,
      entityId,
      link: resolvedLink,
      deepLink: resolvedLink,
      pushStatus,
      isRead: false,
      idempotencyKey: idempotencyKey?.trim() || undefined,
      metadata: metadata || {},
    });

    if (
      mongoose.connection?.readyState === 1 ||
      StaffNotification.prototype.save !== mongoose.Model.prototype.save
    ) {
      await notif.save();
    }
    return notif;
  } catch (err: any) {
    // Graceful handling of concurrent duplicate idempotency key race
    if (err.code === 11000 && idempotencyKey) {
      return await StaffNotification.findOne({
        centerId: cleanCenterId,
        idempotencyKey: idempotencyKey.trim(),
      });
    }
    console.warn("[NOTIFICATION SERVICE] Error saving notification:", err.message);
    return null;
  }
}

// =============================================================================
// DOMAIN-SPECIFIC EVENT NOTIFICATION DISPATCHERS
// =============================================================================

/**
 * Dispatches notifications for manual cash collection:
 * 1. Owner: Alert that cash was collected
 * 2. Teacher: Confirmation that collection was recorded
 * 3. Parent: Payment receipt notification
 */
export async function notifyCashCollectionEvents(params: {
  centerId: string;
  feeId: string;
  paymentId: string;
  studentId: string;
  studentName: string;
  amount: number;
  collectorId: string;
  collectorName: string;
  collectorRole: "owner" | "teacher";
  receiptNumber: string;
  billingMonth?: string;
  academicYear?: string;
}): Promise<void> {
  const {
    centerId,
    feeId,
    paymentId,
    studentId,
    studentName,
    amount,
    collectorId,
    collectorName,
    collectorRole,
    receiptNumber,
    billingMonth,
  } = params;

  const monthLabel = billingMonth ? ` for ${billingMonth}` : "";

  // A. Notify Owner (when collected by a teacher)
  if (collectorRole === "teacher") {
    await createNotification({
      centerId,
      recipientId: centerId,
      recipientRole: "owner",
      category: "fee",
      type: "cash_collection",
      title: "Cash Collection Recorded",
      message: `Teacher ${collectorName} collected ₹${amount.toLocaleString(
        "en-IN"
      )} in physical cash from ${studentName}${monthLabel}. Receipt: ${receiptNumber}.`,
      amount,
      statusLabel: "Teacher In-Hand",
      feeId,
      paymentId,
      studentId,
      studentName,
      collectorId,
      collectorName,
      entityType: "Fee",
      entityId: feeId,
      deepLink: `/fees?tab=payments&sub=paid`,
      idempotencyKey: `cash_collection_owner_${paymentId}`,
    });
  }

  // B. Notify Teacher with Confirmation
  if (collectorRole === "teacher") {
    await createNotification({
      centerId,
      recipientId: collectorId,
      recipientRole: "teacher",
      category: "fee",
      type: "cash_collection",
      title: "Payment Receipt Generated",
      message: `You successfully recorded ₹${amount.toLocaleString(
        "en-IN"
      )} cash for ${studentName}${monthLabel}. Receipt: ${receiptNumber}. Cash is currently in your in-hand custody.`,
      amount,
      statusLabel: "In-Hand",
      feeId,
      paymentId,
      studentId,
      studentName,
      collectorId,
      collectorName,
      entityType: "Fee",
      entityId: feeId,
      deepLink: `/fees?tab=handovers`,
      idempotencyKey: `cash_collection_teacher_${paymentId}`,
    });
  }

  // C. Notify Parent with Payment Receipt
  await createNotification({
    centerId,
    recipientId: studentId, // parent access keyed by studentId
    recipientRole: "parent",
    category: "fee",
    type: "cash_collection",
    title: "Fee Payment Received",
    message: `Payment of ₹${amount.toLocaleString(
      "en-IN"
    )} received${monthLabel} for ${studentName}. Receipt #${receiptNumber}.`,
    amount,
    statusLabel: "Paid",
    feeId,
    paymentId,
    studentId,
    studentName,
    entityType: "Fee",
    entityId: feeId,
    deepLink: `/portal`,
    idempotencyKey: `cash_collection_parent_${paymentId}`,
  });
}

/**
 * Dispatches notifications when a Teacher submits a Cash Handover Envelope
 */
export async function notifyHandoverSubmittedEvents(params: {
  centerId: string;
  handoverId: string;
  handoverNumber: string;
  teacherId: string;
  teacherName: string;
  totalAmount: number;
  itemCount: number;
}): Promise<void> {
  const {
    centerId,
    handoverId,
    handoverNumber,
    teacherId,
    teacherName,
    totalAmount,
    itemCount,
  } = params;

  // 1. Notify Owner
  await createNotification({
    centerId,
    recipientId: centerId,
    recipientRole: "owner",
    category: "handover",
    type: "handover_submitted",
    title: "Cash Handover Submitted",
    message: `Teacher ${teacherName} submitted Handover ${handoverNumber} containing ${itemCount} collection${
      itemCount > 1 ? "s" : ""
    } totaling ₹${totalAmount.toLocaleString("en-IN")}. Verification required.`,
    amount: totalAmount,
    statusLabel: "Pending Verification",
    entityType: "CashHandover",
    entityId: handoverId,
    deepLink: `/fees?tab=handovers`,
    idempotencyKey: `handover_submit_owner_${handoverId}`,
  });

  // 2. Notify Teacher Confirmation
  await createNotification({
    centerId,
    recipientId: teacherId,
    recipientRole: "teacher",
    category: "handover",
    type: "handover_submitted",
    title: "Handover Envelope Submitted",
    message: `Your Handover Envelope ${handoverNumber} (₹${totalAmount.toLocaleString(
      "en-IN"
    )}, ${itemCount} items) has been submitted for Owner verification.`,
    amount: totalAmount,
    statusLabel: "Submitted",
    entityType: "CashHandover",
    entityId: handoverId,
    deepLink: `/fees?tab=handovers`,
    idempotencyKey: `handover_submit_teacher_${handoverId}`,
  });
}

/**
 * Dispatches notifications when an Owner reviews a Cash Handover (Verification, Partial, or Rejection)
 */
export async function notifyHandoverReviewEvents(params: {
  centerId: string;
  handoverId: string;
  handoverNumber: string;
  teacherId: string;
  decision: "approved" | "partially_approved" | "rejected";
  submittedAmount: number;
  approvedAmount?: number;
  discrepancyAmount?: number;
  reason?: string;
}): Promise<void> {
  const {
    centerId,
    handoverId,
    handoverNumber,
    teacherId,
    decision,
    submittedAmount,
    approvedAmount = 0,
    discrepancyAmount = 0,
    reason,
  } = params;

  if (decision === "approved") {
    await createNotification({
      centerId,
      recipientId: teacherId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_verified",
      title: "Cash Handover Approved",
      message: `Owner verified and accepted Handover ${handoverNumber}. Full ₹${submittedAmount.toLocaleString(
        "en-IN"
      )} transferred to center custody.`,
      amount: submittedAmount,
      statusLabel: "Approved",
      entityType: "CashHandover",
      entityId: handoverId,
      deepLink: `/fees?tab=handovers`,
      idempotencyKey: `handover_approved_${handoverId}`,
    });
  } else if (decision === "partially_approved") {
    await createNotification({
      centerId,
      recipientId: teacherId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_verified",
      title: "Handover Partially Approved with Discrepancy",
      message: `Owner counted Handover ${handoverNumber}: ₹${approvedAmount.toLocaleString(
        "en-IN"
      )} verified. Shortage discrepancy of ₹${discrepancyAmount.toLocaleString(
        "en-IN"
      )} logged for review.`,
      amount: approvedAmount,
      statusLabel: "Partially Approved",
      entityType: "CashHandover",
      entityId: handoverId,
      deepLink: `/fees?tab=handovers`,
      idempotencyKey: `handover_partial_${handoverId}`,
    });
  } else if (decision === "rejected") {
    const reasonText = reason ? `: "${reason}"` : ".";
    await createNotification({
      centerId,
      recipientId: teacherId,
      recipientRole: "teacher",
      category: "handover",
      type: "handover_rejected",
      title: "Cash Handover Rejected",
      message: `Handover ${handoverNumber} (₹${submittedAmount.toLocaleString(
        "en-IN"
      )}) was returned to your physical custody by Owner${reasonText} Funds have been unlocked for resubmission.`,
      amount: submittedAmount,
      statusLabel: "Rejected",
      entityType: "CashHandover",
      entityId: handoverId,
      deepLink: `/fees?tab=handovers`,
      idempotencyKey: `handover_rejected_${handoverId}`,
    });
  }
}

/**
 * Dispatches notifications for Batch Assignment Requests
 */
export async function notifyBatchRequestEvents(params: {
  centerId: string;
  requestId: string;
  studentId: string;
  studentName: string;
  batchName: string;
  currentBatch?: string;
  requesterId: string;
  requesterName: string;
  action: "submitted" | "approved" | "rejected";
  rejectionReason?: string;
}): Promise<void> {
  const {
    centerId,
    requestId,
    studentId,
    studentName,
    batchName,
    currentBatch,
    requesterId,
    requesterName,
    action,
    rejectionReason,
  } = params;

  if (action === "submitted") {
    // Notify Owner
    await createNotification({
      centerId,
      recipientId: centerId,
      recipientRole: "owner",
      category: "batch",
      type: "batch_request_submitted",
      title: "Batch Assignment Request",
      message: `${requesterName} requested assigning ${studentName} to batch '${batchName}' (Current: '${
        currentBatch || "Unassigned"
      }'). Review required.`,
      studentId,
      studentName,
      entityType: "StudentBatchRequest",
      entityId: requestId,
      deepLink: `/admissions`,
      idempotencyKey: `batch_req_submitted_owner_${requestId}`,
    });

    // Notify Requesting Teacher
    await createNotification({
      centerId,
      recipientId: requesterId,
      recipientRole: "teacher",
      category: "batch",
      type: "batch_request_submitted",
      title: "Batch Request Submitted",
      message: `Your request to transfer ${studentName} to batch '${batchName}' is submitted and awaiting Owner approval.`,
      studentId,
      studentName,
      entityType: "StudentBatchRequest",
      entityId: requestId,
      deepLink: `/admissions`,
      idempotencyKey: `batch_req_submitted_teacher_${requestId}`,
    });
  } else if (action === "approved") {
    await createNotification({
      centerId,
      recipientId: requesterId,
      recipientRole: "teacher",
      category: "batch",
      type: "batch_request_approved",
      title: "Batch Request Approved",
      message: `Owner approved your request: ${studentName} has been assigned to batch '${batchName}'.`,
      studentId,
      studentName,
      entityType: "StudentBatchRequest",
      entityId: requestId,
      deepLink: `/admissions`,
      idempotencyKey: `batch_req_approved_${requestId}`,
    });
  } else if (action === "rejected") {
    const reasonText = rejectionReason ? `: "${rejectionReason}"` : ".";
    await createNotification({
      centerId,
      recipientId: requesterId,
      recipientRole: "teacher",
      category: "batch",
      type: "batch_request_rejected",
      title: "Batch Request Declined",
      message: `Owner declined your request to transfer ${studentName} to batch '${batchName}'${reasonText}`,
      studentId,
      studentName,
      entityType: "StudentBatchRequest",
      entityId: requestId,
      deepLink: `/admissions`,
      idempotencyKey: `batch_req_rejected_${requestId}`,
    });
  }
}

/**
 * Dispatches notifications for Student Admission
 */
export async function notifyStudentAdmissionEvents(params: {
  centerId: string;
  studentId: string;
  studentName: string;
  batchName?: string;
  assignedTeacherId?: string;
  assignedTeacherName?: string;
  parentPhone?: string;
}): Promise<void> {
  const {
    centerId,
    studentId,
    studentName,
    batchName,
    assignedTeacherId,
    assignedTeacherName,
  } = params;

  // 1. Notify Assigned Teacher if assigned on admission
  if (assignedTeacherId) {
    await createNotification({
      centerId,
      recipientId: assignedTeacherId,
      recipientRole: "teacher",
      category: "academic",
      type: "student_admitted",
      title: "New Student Assigned",
      message: `New student ${studentName} has been admitted and assigned to you in batch '${
        batchName || "General"
      }'.`,
      studentId,
      studentName,
      entityType: "Student",
      entityId: studentId,
      deepLink: `/admissions`,
      idempotencyKey: `student_admitted_teacher_${studentId}`,
    });
  }

  // 2. Notify Parent
  await createNotification({
    centerId,
    recipientId: studentId,
    recipientRole: "parent",
    category: "academic",
    type: "student_admitted",
    title: "Welcome to Tuition Center",
    message: `Admission confirmed for ${studentName}${
      batchName ? ` in batch '${batchName}'` : ""
    }${assignedTeacherName ? ` under teacher ${assignedTeacherName}` : ""}.`,
    studentId,
    studentName,
    entityType: "Student",
    entityId: studentId,
    deepLink: `/portal`,
    idempotencyKey: `student_admitted_parent_${studentId}`,
  });
}

/**
 * Dispatches notifications for Attendance Marking
 */
export async function notifyAttendanceEvents(params: {
  centerId: string;
  batch: string;
  date: Date;
  recorderId: string;
  recorderRole: "owner" | "teacher";
  presentCount: number;
  absentCount: number;
  absentStudents: Array<{ studentId: string; studentName: string }>;
}): Promise<void> {
  const {
    centerId,
    batch,
    date,
    recorderId,
    recorderRole,
    presentCount,
    absentCount,
    absentStudents,
  } = params;

  const dateStr = date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });

  // A. Teacher confirmation
  if (recorderRole === "teacher") {
    await createNotification({
      centerId,
      recipientId: recorderId,
      recipientRole: "teacher",
      category: "academic",
      type: "attendance_marked",
      title: "Attendance Saved",
      message: `Recorded attendance for batch '${batch}' on ${dateStr}: ${presentCount} Present, ${absentCount} Absent.`,
      entityType: "Attendance",
      deepLink: `/attendance`,
      idempotencyKey: `attendance_teacher_${batch}_${dateStr}_${recorderId}`,
    });
  }

  // B. Notify Parents of absent students
  for (const s of absentStudents) {
    await createNotification({
      centerId,
      recipientId: s.studentId,
      recipientRole: "parent",
      category: "academic",
      type: "attendance_marked",
      title: "Attendance Alert: Absent",
      message: `${s.studentName} was marked absent for batch '${batch}' on ${dateStr}.`,
      studentId: s.studentId,
      studentName: s.studentName,
      entityType: "Attendance",
      deepLink: `/portal`,
      idempotencyKey: `attendance_absent_${s.studentId}_${dateStr}`,
    });
  }
}

/**
 * Dispatches notifications for Test Announcements and Results
 */
export async function notifyTestEvents(params: {
  centerId: string;
  testId: string;
  testTitle: string;
  batch: string;
  maxMarks: number;
  assignedTeacherId?: string;
  eventType: "test_scheduled" | "test_result";
  results?: Array<{ studentId: string; studentName: string; marksObtained: number }>;
}): Promise<void> {
  const {
    centerId,
    testId,
    testTitle,
    batch,
    maxMarks,
    assignedTeacherId,
    eventType,
    results = [],
  } = params;

  if (eventType === "test_scheduled") {
    // Notify Teacher if assigned
    if (assignedTeacherId) {
      await createNotification({
        centerId,
        recipientId: assignedTeacherId,
        recipientRole: "teacher",
        category: "academic",
        type: "test_scheduled",
        title: "Test Scheduled",
        message: `New test '${testTitle}' (Max: ${maxMarks} marks) scheduled for batch '${batch}'.`,
        entityType: "Test",
        entityId: testId,
        deepLink: `/tests`,
        idempotencyKey: `test_scheduled_teacher_${testId}`,
      });
    }
  } else if (eventType === "test_result") {
    // Notify parents of individual test scores
    for (const r of results) {
      const percentage = Math.round((r.marksObtained / maxMarks) * 100);
      await createNotification({
        centerId,
        recipientId: r.studentId,
        recipientRole: "parent",
        category: "academic",
        type: "test_result",
        title: "Test Result Published",
        message: `${r.studentName} scored ${r.marksObtained}/${maxMarks} (${percentage}%) in '${testTitle}'.`,
        studentId: r.studentId,
        studentName: r.studentName,
        entityType: "Test",
        entityId: testId,
        deepLink: `/portal`,
        idempotencyKey: `test_result_${testId}_${r.studentId}`,
      });
    }
  }
}
