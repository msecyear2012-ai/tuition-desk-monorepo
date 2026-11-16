import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IStudent {
  centerId: string;
  name: string;
  batch: string;
  parentWhatsApp: string;
  isActive: boolean;
  joiningDate?: Date;
  monthlyFee: number;
  billingCycleDate: number;
  assignedTeacherId?: Types.ObjectId | null;
  importedBatchId?: string;
  rollNumber?: string;
  advanceBalance?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IStudentDocument extends IStudent, Document {}

const StudentSchema = new Schema<IStudentDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      index: true,
      trim: true,
    },
    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    batch: {
      type: String,
      required: [true, "Batch is required"],
      trim: true,
      index: true,
    },
    parentWhatsApp: {
      type: String,
      required: [true, "Parent WhatsApp number is required"],
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    joiningDate: {
      type: Date,
      default: Date.now,
    },
    monthlyFee: {
      type: Number,
      required: [true, "Monthly fee is required"],
      min: [0, "Monthly fee cannot be negative"],
      default: 0,
    },
    billingCycleDate: {
      type: Number,
      required: [true, "Billing cycle date is required"],
      min: [1, "Billing cycle date must be between 1 and 31"],
      max: [31, "Billing cycle date must be between 1 and 31"],
      default: 5,
    },
    assignedTeacherId: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
      index: true,
    },
    importedBatchId: {
      type: String,
      trim: true,
      index: true,
    },
    rollNumber: {
      type: String,
      trim: true,
    },
    advanceBalance: {
      type: Number,
      required: true,
      min: [0, "Advance balance cannot be negative"],
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for multi-tenant isolation, assignment, and batch queries
StudentSchema.index({ centerId: 1, batch: 1 });
StudentSchema.index({ centerId: 1, assignedTeacherId: 1 });
StudentSchema.index({ centerId: 1, assignedTeacherId: 1, isActive: 1 });
StudentSchema.index({ centerId: 1, name: "text" });

// In development, ensure Mongoose reloads new schema properties
if (
  process.env.NODE_ENV !== "production" &&
  mongoose.models.Student &&
  (!mongoose.models.Student.schema.path("assignedTeacherId") ||
    !mongoose.models.Student.schema.path("advanceBalance"))
) {
  delete (mongoose.models as Record<string, unknown>).Student;
}

export const Student: Model<IStudentDocument> =
  (mongoose.models.Student as Model<IStudentDocument>) ||
  mongoose.model<IStudentDocument>("Student", StudentSchema);

export default Student;


