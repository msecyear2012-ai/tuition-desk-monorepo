import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IStudentBatchRequest {
  centerId: string;
  studentId: Types.ObjectId;
  batchName: string;
  batchId?: Types.ObjectId;
  requesterId: Types.ObjectId;
  requesterRole: "teacher" | "owner";
  requesterName: string;
  status: "pending" | "approved" | "rejected";
  currentBatch?: string;
  requestNotes?: string;
  reviewedBy?: Types.ObjectId;
  reviewedByName?: string;
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IStudentBatchRequestDocument
  extends IStudentBatchRequest,
    Document {}

const StudentBatchRequestSchema = new Schema<IStudentBatchRequestDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: [true, "Student ID is required"],
      index: true,
    },
    batchName: {
      type: String,
      required: [true, "Target batch name is required"],
      trim: true,
    },
    batchId: {
      type: Schema.Types.ObjectId,
      ref: "Batch",
    },
    requesterId: {
      type: Schema.Types.ObjectId,
      required: [true, "Requester ID is required"],
      index: true,
    },
    requesterRole: {
      type: String,
      enum: ["teacher", "owner"],
      required: [true, "Requester role is required"],
    },
    requesterName: {
      type: String,
      required: [true, "Requester name is required"],
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    currentBatch: {
      type: String,
      trim: true,
    },
    requestNotes: {
      type: String,
      trim: true,
      default: "",
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
    },
    reviewedByName: {
      type: String,
      trim: true,
    },
    reviewedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Query indexes for tenant isolation, status filtering, and teacher lookup
StudentBatchRequestSchema.index({ centerId: 1, status: 1 });
StudentBatchRequestSchema.index({ centerId: 1, requesterId: 1, status: 1 });
StudentBatchRequestSchema.index({ centerId: 1, createdAt: -1 });

// Prevent duplicate active/pending requests for the same student in a tuition center
StudentBatchRequestSchema.index(
  { centerId: 1, studentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);

// Next.js hot-reloading cache clear
if (
  process.env.NODE_ENV !== "production" &&
  mongoose.models.StudentBatchRequest
) {
  delete (mongoose.models as Record<string, unknown>).StudentBatchRequest;
}

export const StudentBatchRequest: Model<IStudentBatchRequestDocument> =
  (mongoose.models.StudentBatchRequest as Model<IStudentBatchRequestDocument>) ||
  mongoose.model<IStudentBatchRequestDocument>(
    "StudentBatchRequest",
    StudentBatchRequestSchema
  );

export default StudentBatchRequest;
