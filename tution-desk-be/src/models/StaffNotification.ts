import mongoose, { Schema, Document, Model } from "mongoose";

export type NotificationRole = "owner" | "teacher" | "parent";

export type NotificationCategory =
  | "fee"
  | "handover"
  | "academic"
  | "batch"
  | "communication"
  | "system";

export type NotificationEventType =
  | "cash_collection"
  | "handover_submitted"
  | "handover_verified"
  | "handover_rejected"
  | "dispute_raised"
  | "dispute_resolved"
  | "batch_request_submitted"
  | "batch_request_approved"
  | "batch_request_rejected"
  | "student_admitted"
  | "attendance_marked"
  | "test_scheduled"
  | "test_result"
  | "homework_assigned"
  | "fee_reminder"
  | "parent_message"
  | "system";

export interface IStaffNotification {
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
  link?: string;
  deepLink?: string;
  pushStatus?: "none" | "sent" | "simulated" | "failed";
  isRead: boolean;
  readAt?: Date;
  isDismissed?: boolean;
  dismissedAt?: Date;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IStaffNotificationDocument extends IStaffNotification, Document {}

const StaffNotificationSchema = new Schema<IStaffNotificationDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      trim: true,
      index: true,
    },
    recipientId: {
      type: String,
      required: [true, "Recipient ID is required"],
      trim: true,
      index: true,
    },
    recipientRole: {
      type: String,
      enum: ["owner", "teacher", "parent"],
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["fee", "handover", "academic", "batch", "communication", "system"],
      default: "system",
      index: true,
    },
    type: {
      type: String,
      enum: [
        "cash_collection",
        "handover_submitted",
        "handover_verified",
        "handover_rejected",
        "dispute_raised",
        "dispute_resolved",
        "batch_request_submitted",
        "batch_request_approved",
        "batch_request_rejected",
        "student_admitted",
        "attendance_marked",
        "test_scheduled",
        "test_result",
        "homework_assigned",
        "fee_reminder",
        "parent_message",
        "system",
      ],
      default: "system",
      index: true,
    },
    title: {
      type: String,
      required: [true, "Notification title is required"],
      trim: true,
    },
    message: {
      type: String,
      required: [true, "Notification message is required"],
      trim: true,
    },
    amount: {
      type: Number,
      default: 0,
    },
    statusLabel: {
      type: String,
      trim: true,
    },
    feeId: {
      type: String,
      trim: true,
      index: true,
    },
    paymentId: {
      type: String,
      trim: true,
      index: true,
    },
    studentId: {
      type: String,
      trim: true,
    },
    studentName: {
      type: String,
      trim: true,
    },
    collectorId: {
      type: String,
      trim: true,
    },
    collectorName: {
      type: String,
      trim: true,
    },
    entityType: {
      type: String,
      trim: true,
    },
    entityId: {
      type: String,
      trim: true,
      index: true,
    },
    link: {
      type: String,
      trim: true,
    },
    deepLink: {
      type: String,
      trim: true,
    },
    pushStatus: {
      type: String,
      enum: ["none", "sent", "simulated", "failed"],
      default: "none",
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
    },
    isDismissed: {
      type: Boolean,
      default: false,
      index: true,
    },
    dismissedAt: {
      type: Date,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

StaffNotificationSchema.index({ centerId: 1, recipientRole: 1, createdAt: -1 });
StaffNotificationSchema.index({ centerId: 1, recipientId: 1, createdAt: -1 });
StaffNotificationSchema.index({ centerId: 1, recipientId: 1, isRead: 1, createdAt: -1 });
StaffNotificationSchema.index({ centerId: 1, recipientId: 1, isDismissed: 1, createdAt: -1 });
StaffNotificationSchema.index({ centerId: 1, category: 1, createdAt: -1 });
StaffNotificationSchema.index({ idempotencyKey: 1 }, { sparse: true });

if (
  process.env.NODE_ENV !== "production" &&
  mongoose.models.StaffNotification &&
  (!mongoose.models.StaffNotification.schema.path("category") ||
    !(
      (mongoose.models.StaffNotification.schema.path("recipientRole") as any)
        ?.enumValues || []
    ).includes("parent"))
) {
  delete (mongoose.models as Record<string, unknown>).StaffNotification;
}

const StaffNotification: Model<IStaffNotificationDocument> =
  mongoose.models.StaffNotification ||
  mongoose.model<IStaffNotificationDocument>(
    "StaffNotification",
    StaffNotificationSchema
  );

export default StaffNotification;
