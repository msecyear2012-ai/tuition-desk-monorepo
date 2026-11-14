import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITeacher {
  centerId: string;
  name: string;
  loginId: string;
  phone: string;
  email?: string;
  password: string;
  role: "teacher";
  subjects?: string[];
  assignedBatches?: string[];
  isActive: boolean;
  mustChangePassword?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ITeacherDocument extends ITeacher, Document {}

const TeacherSchema = new Schema<ITeacherDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Teacher name is required"],
      trim: true,
    },
    loginId: {
      type: String,
      required: [true, "Login ID is required"],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    password: {
      type: String,
      required: [true, "Password is required"],
    },
    role: {
      type: String,
      enum: ["teacher"],
      default: "teacher",
    },
    subjects: {
      type: [String],
      default: [],
    },
    assignedBatches: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for multi-tenant isolation and fast lookup
TeacherSchema.index({ centerId: 1, loginId: 1 }, { unique: true });
TeacherSchema.index({ centerId: 1, phone: 1 });
TeacherSchema.index({ centerId: 1, isActive: 1 });

// Ensure model is recompiled in Next.js development hot-reloading
if (process.env.NODE_ENV !== "production" && mongoose.models.Teacher) {
  delete (mongoose.models as Record<string, unknown>).Teacher;
}

export const Teacher: Model<ITeacherDocument> =
  (mongoose.models.Teacher as Model<ITeacherDocument>) ||
  mongoose.model<ITeacherDocument>("Teacher", TeacherSchema);

export default Teacher;
