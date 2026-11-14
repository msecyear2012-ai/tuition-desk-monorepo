import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type HandoverStatusType =
  | "pending_approval"
  | "approved"
  | "partially_approved"
  | "rejected";

export type HandoverDiscrepancyStatusType =
  | "none"
  | "disputed"
  | "resolved"
  | "shortage_confirmed";

export type DisputeResolutionType =
  | "cash_received"
  | "accounting_adjustment"
  | "shortage_confirmed";

export interface IHandoverItemAllocation {
  allocationId: Types.ObjectId;
  paymentId: Types.ObjectId;
  feeId: Types.ObjectId;
  studentId: Types.ObjectId;
  studentName?: string;
  amount: number;
  receiptNumber: string;
}

export interface IHandoverDisputeEntry {
  _id: Types.ObjectId;
  initiatedBy: Types.ObjectId;
  initiatedByRole: "owner" | "teacher";
  notes: string;
  evidenceUrl?: string;
  timestamp: Date;
}

export interface IHandoverResolutionEntry {
  _id: Types.ObjectId;
  resolutionType: DisputeResolutionType;
  amount: number;
  resolvedBy: Types.ObjectId;
  resolvedAt: Date;
  reason: string;
  auditReference: string;
  notes?: string;
}

export interface IHandoverIncrementalSettlement {
  _id: Types.ObjectId;
  amountReceived: number;
  receivedAt: Date;
  receivedBy: Types.ObjectId;
  remainingDiscrepancy: number;
  notes?: string;
}

export interface ICashHandover {
  centerId: string;
  handoverNumber: string;
  teacherId: Types.ObjectId;
  submittedAmount: number;
  approvedAmount: number;
  discrepancyAmount: number;
  status: HandoverStatusType;
  discrepancyStatus: HandoverDiscrepancyStatusType;
  items: IHandoverItemAllocation[];
  submittedAt: Date;
  submissionNotes?: string;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
  rejectedAt?: Date;
  disputes?: IHandoverDisputeEntry[];
  resolutions?: IHandoverResolutionEntry[];
  incrementalSettlements?: IHandoverIncrementalSettlement[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ICashHandoverDocument extends ICashHandover, Document {}

const HandoverItemSchema = new Schema<IHandoverItemAllocation>(
  {
    allocationId: {
      type: Schema.Types.ObjectId,
      required: [true, "Allocation ID is required"],
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      required: [true, "Payment ID is required"],
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
    studentName: {
      type: String,
      trim: true,
      default: "",
    },
    amount: {
      type: Number,
      required: [true, "Item amount is required"],
      min: [0.01, "Item amount must be greater than zero"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Item amount must be a finite positive number",
      },
    },
    receiptNumber: {
      type: String,
      required: [true, "Receipt number is required"],
      trim: true,
    },
  },
  { _id: false }
);

const HandoverDisputeSchema = new Schema<IHandoverDisputeEntry>(
  {
    initiatedBy: {
      type: Schema.Types.ObjectId,
      required: [true, "Dispute initiator ID is required"],
    },
    initiatedByRole: {
      type: String,
      enum: {
        values: ["owner", "teacher"],
        message: "{VALUE} is not a valid dispute initiator role",
      },
      required: [true, "Dispute initiator role is required"],
    },
    notes: {
      type: String,
      required: [true, "Dispute notes are required"],
      trim: true,
    },
    evidenceUrl: {
      type: String,
      trim: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { _id: true }
);

const HandoverResolutionSchema = new Schema<IHandoverResolutionEntry>(
  {
    resolutionType: {
      type: String,
      enum: {
        values: ["cash_received", "accounting_adjustment", "shortage_confirmed"],
        message: "{VALUE} is not a valid resolution type",
      },
      required: [true, "Resolution type is required"],
    },
    amount: {
      type: Number,
      required: [true, "Resolution amount is required"],
      min: [0, "Resolution amount cannot be negative"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v >= 0,
        message: "Resolution amount must be a finite non-negative number",
      },
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      required: [true, "Resolver ID is required"],
    },
    resolvedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    reason: {
      type: String,
      required: [true, "Mandatory documented reason is required for resolution"],
      trim: true,
    },
    auditReference: {
      type: String,
      required: [true, "Mandatory audit reference is required for resolution"],
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { _id: true }
);

const HandoverIncrementalSettlementSchema = new Schema<IHandoverIncrementalSettlement>(
  {
    amountReceived: {
      type: Number,
      required: [true, "Amount received is required"],
      min: [0.01, "Amount received must be greater than zero"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Amount received must be a finite positive number",
      },
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    receivedBy: {
      type: Schema.Types.ObjectId,
      required: [true, "Receiver ID is required"],
    },
    remainingDiscrepancy: {
      type: Number,
      required: [true, "Remaining discrepancy is required"],
      min: [0, "Remaining discrepancy cannot be negative"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v >= 0,
        message: "Remaining discrepancy must be a finite non-negative number",
      },
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { _id: true }
);

const CashHandoverSchema = new Schema<ICashHandoverDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    handoverNumber: {
      type: String,
      required: [true, "Handover number is required"],
      trim: true,
      index: true,
    },
    teacherId: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      required: [true, "Teacher ID is required"],
      index: true,
    },
    submittedAmount: {
      type: Number,
      required: [true, "Submitted amount is required"],
      min: [0.01, "Submitted amount must be greater than zero"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Submitted amount must be a finite positive number",
      },
    },
    approvedAmount: {
      type: Number,
      default: 0,
      min: [0, "Approved amount cannot be negative"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v >= 0,
        message: "Approved amount must be a finite non-negative number",
      },
    },
    discrepancyAmount: {
      type: Number,
      default: 0,
      min: [0, "Discrepancy amount cannot be negative"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v >= 0,
        message: "Discrepancy amount must be a finite non-negative number",
      },
    },
    status: {
      type: String,
      enum: {
        values: ["pending_approval", "approved", "partially_approved", "rejected"],
        message: "{VALUE} is not a valid handover status",
      },
      default: "pending_approval",
      required: [true, "Handover status is required"],
      index: true,
    },
    discrepancyStatus: {
      type: String,
      enum: {
        values: ["none", "disputed", "resolved", "shortage_confirmed"],
        message: "{VALUE} is not a valid discrepancy status",
      },
      default: "none",
      required: true,
    },
    items: {
      type: [HandoverItemSchema],
      required: [true, "Handover items are required"],
      validate: [
        {
          validator: (items: IHandoverItemAllocation[]) => Array.isArray(items) && items.length > 0,
          message: "Handover must contain at least one item",
        },
      ],
    },
    submittedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    submissionNotes: {
      type: String,
      trim: true,
      default: "",
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
    },
    approvedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
    rejectedAt: {
      type: Date,
    },
    disputes: {
      type: [HandoverDisputeSchema],
      default: [],
    },
    resolutions: {
      type: [HandoverResolutionSchema],
      default: [],
    },
    incrementalSettlements: {
      type: [HandoverIncrementalSettlementSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    autoIndex: false,
  }
);

// Mathematical Invariant 1: submittedAmount must equal sum of line-item amounts
CashHandoverSchema.path("items").validate(function (items: IHandoverItemAllocation[]) {
  if (!items || items.length === 0) return true;
  const parent = this as unknown as ICashHandover;
  if (parent.submittedAmount === undefined || parent.submittedAmount === null) return true;

  const totalItemsAmount = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return Math.abs(totalItemsAmount - Number(parent.submittedAmount)) <= 0.001;
}, "Submitted amount must exactly match the sum of line-item amounts");

// Mathematical Invariant 2: Verification balance and rejection reason validation
CashHandoverSchema.pre("validate", function () {
  const doc = this as unknown as ICashHandoverDocument;

  if (doc.status === "approved") {
    if (doc.approvedAmount !== undefined && doc.submittedAmount !== undefined) {
      if (Math.abs(Number(doc.approvedAmount) - Number(doc.submittedAmount)) > 0.001) {
        this.invalidate("approvedAmount", "Approved amount must equal submitted amount on full approval");
      }
    }
    if (doc.discrepancyAmount !== undefined && Number(doc.discrepancyAmount) !== 0) {
      this.invalidate("discrepancyAmount", "Discrepancy amount must be zero on full approval");
    }
  } else if (doc.status === "partially_approved") {
    if (
      doc.approvedAmount !== undefined &&
      doc.discrepancyAmount !== undefined &&
      doc.submittedAmount !== undefined
    ) {
      const sum = (Number(doc.approvedAmount) || 0) + (Number(doc.discrepancyAmount) || 0);
      if (Math.abs(sum - Number(doc.submittedAmount)) > 0.001) {
        this.invalidate(
          "discrepancyAmount",
          "Approved amount plus discrepancy amount must equal submitted amount on partial approval"
        );
      }
    }
  } else if (doc.status === "rejected") {
    if (!doc.rejectionReason || doc.rejectionReason.trim().length === 0) {
      this.invalidate("rejectionReason", "Rejection reason is mandatory when handover status is rejected");
    }
  }

  // Mathematical Invariant 3: Incremental settlements cannot exceed discrepancy amount
  if (doc.incrementalSettlements && doc.incrementalSettlements.length > 0) {
    const baseDiscrepancy = Number(doc.discrepancyAmount) || 0;
    let cumulativeSettled = 0;

    for (let i = 0; i < doc.incrementalSettlements.length; i++) {
      const settlement = doc.incrementalSettlements[i];
      const amountReceived = Number(settlement.amountReceived) || 0;
      cumulativeSettled += amountReceived;

      const expectedRemaining = Math.max(0, baseDiscrepancy - cumulativeSettled);
      if (
        settlement.remainingDiscrepancy !== undefined &&
        Math.abs(Number(settlement.remainingDiscrepancy) - expectedRemaining) > 0.001
      ) {
        this.invalidate(
          `incrementalSettlements.${i}.remainingDiscrepancy`,
          `Settlement remaining discrepancy (${settlement.remainingDiscrepancy}) must match calculated balance (${expectedRemaining})`
        );
      }
    }

    if (cumulativeSettled > baseDiscrepancy + 0.001) {
      this.invalidate(
        "incrementalSettlements",
        `Total incremental settlements (${cumulativeSettled}) cannot exceed handover discrepancy amount (${baseDiscrepancy})`
      );
    }
  }
});

// Compound indexes for multi-tenant querying
CashHandoverSchema.index({ centerId: 1, handoverNumber: 1 }, { unique: true });
CashHandoverSchema.index({ centerId: 1, teacherId: 1, submittedAt: -1 });
CashHandoverSchema.index({ centerId: 1, status: 1 });
CashHandoverSchema.index({ centerId: 1, "items.feeId": 1 });

if (process.env.NODE_ENV !== "production" && mongoose.models.CashHandover) {
  delete (mongoose.models as Record<string, unknown>).CashHandover;
}

export const CashHandover: Model<ICashHandoverDocument> =
  (mongoose.models.CashHandover as Model<ICashHandoverDocument>) ||
  mongoose.model<ICashHandoverDocument>("CashHandover", CashHandoverSchema);

export default CashHandover;
