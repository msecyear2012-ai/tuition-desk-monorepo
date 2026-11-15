import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type PaymentProofStatus =
  | "pending_review"
  | "verified"
  | "rejected"
  | "superseded";
export type PaymentProofMimeType = "image/jpeg" | "image/png" | "image/webp" | "none" | "";

export interface IPaymentProof {
  centerId: string;
  feeId: Types.ObjectId;
  studentId: Types.ObjectId;
  fileId?: string; // ImageKit file ID (e.g. "629f123456789...") or empty if UTR-only
  fileUrl?: string; // ImageKit secure CDN URL or empty if UTR-only
  thumbnailUrl?: string; // ImageKit generated thumbnail URL
  filePath?: string; // ImageKit path in folder structure
  fileSizeBytes?: number; // File size in bytes (max 3MB = 3,145,728 bytes)
  mimeType?: PaymentProofMimeType;
  originalFileName?: string;
  submittedUtr?: string;
  submittedAmount?: number;
  notes?: string;
  status: PaymentProofStatus;
  uploadedByRole: "parent" | "teacher" | "owner";
  uploadedById?: string; // ParentAccess ID or staff User ID
  parentPhone?: string;
  rejectionReason?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  whatsappNotificationStatus?: "pending" | "sent" | "simulated" | "failed";
  whatsappMessageId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPaymentProofDocument extends IPaymentProof, Document {}

const PaymentProofSchema = new Schema<IPaymentProofDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    feeId: {
      type: Schema.Types.ObjectId,
      ref: "Fee",
      required: [true, "Fee ID is required"],
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: [true, "Student ID is required"],
      index: true,
    },
    fileId: {
      type: String,
      trim: true,
      default: "",
    },
    fileUrl: {
      type: String,
      trim: true,
      default: "",
    },
    thumbnailUrl: {
      type: String,
      trim: true,
      default: "",
    },
    filePath: {
      type: String,
      trim: true,
      default: "",
    },
    fileSizeBytes: {
      type: Number,
      default: 0,
      min: [0, "File size cannot be negative"],
      max: [3 * 1024 * 1024, "File size cannot exceed 3MB"],
    },
    mimeType: {
      type: String,
      enum: {
        values: ["image/jpeg", "image/png", "image/webp", "none", ""],
        message: "Only JPEG, PNG, and WebP images are supported",
      },
      trim: true,
      default: "",
    },
    originalFileName: {
      type: String,
      trim: true,
      default: "",
    },
    submittedUtr: {
      type: String,
      trim: true,
      default: "",
    },
    submittedAmount: {
      type: Number,
      min: [0, "Submitted amount must be non-negative"],
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending_review", "verified", "rejected", "superseded"],
      default: "pending_review",
      index: true,
    },
    uploadedByRole: {
      type: String,
      enum: ["parent", "teacher", "owner"],
      default: "parent",
    },
    uploadedById: {
      type: String,
      trim: true,
      default: "",
    },
    parentPhone: {
      type: String,
      trim: true,
      default: "",
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: "",
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    whatsappNotificationStatus: {
      type: String,
      enum: ["pending", "sent", "simulated", "failed"],
      default: "pending",
    },
    whatsappMessageId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
    autoIndex: false,
  }
);

// Invariant: At least one payment identifier (either screenshot or UTR) is required
PaymentProofSchema.pre("validate", function () {
  const hasScreenshot = Boolean(this.fileUrl && String(this.fileUrl).trim());
  const hasUtr = Boolean(this.submittedUtr && String(this.submittedUtr).trim());
  if (!hasScreenshot && !hasUtr) {
    throw new Error("Either a valid UTR reference number or a payment screenshot is required.");
  }
});

// Compound queries optimization (defined for index integrity verification)
PaymentProofSchema.index({ feeId: 1, createdAt: -1 });
PaymentProofSchema.index({ centerId: 1, status: 1 });
PaymentProofSchema.index({ studentId: 1, feeId: 1 });

const PaymentProof: Model<IPaymentProofDocument> =
  mongoose.models.PaymentProof ||
  mongoose.model<IPaymentProofDocument>("PaymentProof", PaymentProofSchema);

export default PaymentProof;
