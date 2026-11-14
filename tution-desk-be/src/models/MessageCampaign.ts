import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type CampaignStatus =
  | "pending"
  | "approved"
  | "in_progress"
  | "paused"
  | "cancelled"
  | "completed"
  | "failed_partial";

export type MessageDeliveryStatus =
  | "pending"
  | "sent"
  | "simulated"
  | "failed"
  | "skipped";

export interface ICampaignMessage {
  _id?: Types.ObjectId;
  phone: string;
  message: string;
  studentId?: Types.ObjectId | null;
  studentName?: string;
  parentName?: string;
  status: MessageDeliveryStatus;
  messageId?: string;
  dispatchedAt?: Date | null;
  error?: string;
  sourceType?: string;
  sourceId?: string;
  isArchived?: boolean;
  archivedAt?: Date | null;
}

export interface ICampaignStats {
  total: number;
  sent: number;
  simulated: number;
  failed: number;
  pending: number;
}

export interface IMessageCampaign {
  centerId: string;
  title: string;
  campaignType: "attendance_alert" | "fee_reminder" | "custom_announcement" | string;
  status: CampaignStatus;
  messages: ICampaignMessage[];
  createdBy: string;
  createdRole: string;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  scheduledAt?: Date | null;
  completedAt?: Date | null;
  stats: ICampaignStats;
  isArchived?: boolean;
  archivedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMessageCampaignDocument extends IMessageCampaign, Document {}

const CampaignMessageSchema = new Schema<ICampaignMessage>(
  {
    phone: {
      type: String,
      required: [true, "Recipient phone number is required"],
      trim: true,
    },
    message: {
      type: String,
      required: [true, "Message body is required"],
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      default: null,
    },
    studentName: {
      type: String,
      trim: true,
      default: "",
    },
    parentName: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "sent", "simulated", "failed", "skipped"],
      default: "pending",
      index: true,
    },
    messageId: {
      type: String,
      trim: true,
      default: "",
    },
    dispatchedAt: {
      type: Date,
      default: null,
    },
    error: {
      type: String,
      trim: true,
      default: "",
    },
    sourceType: {
      type: String,
      trim: true,
      default: "",
    },
    sourceId: {
      type: String,
      trim: true,
      default: "",
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true }
);

const MessageCampaignSchema = new Schema<IMessageCampaignDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, "Campaign title is required"],
      trim: true,
    },
    campaignType: {
      type: String,
      required: [true, "Campaign type is required"],
      default: "custom_announcement",
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "approved",
        "in_progress",
        "paused",
        "cancelled",
        "completed",
        "failed_partial",
      ],
      default: "pending",
      index: true,
    },
    messages: [CampaignMessageSchema],
    createdBy: {
      type: String,
      required: [true, "Creator ID is required"],
      trim: true,
    },
    createdRole: {
      type: String,
      required: [true, "Creator role is required"],
      trim: true,
    },
    approvedBy: {
      type: String,
      default: null,
      trim: true,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      simulated: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for multi-tenant query performance
MessageCampaignSchema.index({ centerId: 1, status: 1 });
MessageCampaignSchema.index({ centerId: 1, createdAt: -1 });
MessageCampaignSchema.index({ centerId: 1, isArchived: 1, createdAt: -1 });

if (mongoose.models.MessageCampaign) {
  delete mongoose.models.MessageCampaign;
}

export const MessageCampaign: Model<IMessageCampaignDocument> =
  (mongoose.models.MessageCampaign as Model<IMessageCampaignDocument>) ||
  mongoose.model<IMessageCampaignDocument>("MessageCampaign", MessageCampaignSchema);

export default MessageCampaign;
