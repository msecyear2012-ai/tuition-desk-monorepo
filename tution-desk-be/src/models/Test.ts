import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITestResult {
  studentId: mongoose.Types.ObjectId | string;
  marksObtained: number;
  isAbsent?: boolean;
}

export interface ITest {
  centerId: string;
  title: string;
  batch: string;
  date: Date;
  maxMarks: number;
  results: ITestResult[];
  assignedTeacherId?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ITestDocument extends ITest, Document {}

const TestResultSchema = new Schema<ITestResult>(
  {
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    marksObtained: {
      type: Number,
      default: 0,
      min: [0, "Marks cannot be negative"],
    },
    isAbsent: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const TestSchema = new Schema<ITestDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      index: true,
      trim: true,
    },
    title: {
      type: String,
      required: [true, "Test title is required"],
      trim: true,
    },
    batch: {
      type: String,
      required: [true, "Batch is required"],
      trim: true,
      index: true,
    },
    date: {
      type: Date,
      required: [true, "Test date is required"],
      default: Date.now,
    },
    maxMarks: {
      type: Number,
      required: [true, "Max marks is required"],
      min: [1, "Max marks must be at least 1"],
      default: 100,
    },
    results: {
      type: [TestResultSchema],
      default: [],
    },
    // Academic attribution: null represents the Institute Owner, or references Teacher _id
    assignedTeacherId: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for multi-tenant querying
TestSchema.index({ centerId: 1, date: -1 });
TestSchema.index({ centerId: 1, assignedTeacherId: 1, date: -1 });
TestSchema.index(
  { centerId: 1, "results.studentId": 1, date: -1 },
  { name: "centerId_1_results.studentId_1_date_-1" }
);

// In development, reset cached model to support hot reloads if schema path changed
if (
  process.env.NODE_ENV !== "production" &&
  mongoose.models.Test &&
  !mongoose.models.Test.schema.path("assignedTeacherId")
) {
  delete (mongoose.models as Record<string, unknown>).Test;
}

export const Test: Model<ITestDocument> =
  (mongoose.models.Test as Model<ITestDocument>) ||
  mongoose.model<ITestDocument>("Test", TestSchema);

export default Test;
