import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type FeeStatusType =
  | "Pending"
  | "Paid"
  | "Verification Pending"
  | "Partial Paid";

export type FeeType =
  | "monthly_recurring"
  | "advance"
  | "adhoc"
  | "registration";

export type AllocationStatusType =
  | "pending_verification"
  | "verified"
  | "rejected"
  | "disputed"
  | "shortage_confirmed";

export type PaymentModeType =
  | "Cash"
  | "UPI"
  | "Online"
  | "Cheque"
  | "Bank Transfer";

export type CustodyStatusType =
  | "teacher_custody"
  | "teacher_in_hand"
  | "owner_pending"
  | "owner_verified"
  | "owner_custody"
  | "shortage_deficit"
  | "split_custody";

export interface IPaymentTransaction {
  txnId: string;
  amount: number;
  date?: Date;
  mode?: string;
  status?: string;
}

export interface IPaymentAllocation {
  _id?: Types.ObjectId;
  allocationId?: Types.ObjectId;
  handoverId: Types.ObjectId;
  handoverNumber?: string;
  allocatedAmount: number;
  allocatedAt?: Date;
  allocatedBy?: Types.ObjectId;
  status: AllocationStatusType;
  verifiedAmount?: number;
  verifiedAt?: Date | null;
  verifiedBy?: Types.ObjectId | null;
  rejectionReason?: string;
  disputeId?: Types.ObjectId | null;
  notes?: string;
}

export interface IPaymentEntry {
  _id?: Types.ObjectId;
  paymentId?: Types.ObjectId;
  amount: number;
  paymentDate: Date;
  paymentMode: PaymentModeType | string;
  receiptNumber: string;
  finalReceiptNumber?: string;
  isProvisional?: boolean;
  idempotencyKey?: string | null;
  receivedBy: Types.ObjectId;
  receivedByRole: "owner" | "teacher" | "gateway_direct" | string;
  recordedBy: Types.ObjectId;
  recordedByRole: "owner" | "teacher" | "system" | string;
  recordedAt?: Date;
  assignedTeacherAtPayment?: Types.ObjectId | null;
  batchAtPayment?: string;
  custodyStatus?: CustodyStatusType | string;
  allocations?: IPaymentAllocation[];
  notes?: string;
  createdAt?: Date;
}

export interface IPaymentCustodyBreakdown {
  totalAmount: number;
  teacherInHandAmount: number;
  ownerPendingVerificationAmount: number;
  ownerVerifiedAmount: number;
  disputedDiscrepancyAmount: number;
  custodyLabel:
  | "owner_verified"
  | "owner_pending"
  | "teacher_in_hand"
  | "shortage_deficit"
  | "split_custody";
}


export interface IFee {
  centerId: string;
  studentId: Types.ObjectId;
  billingMonth?: string; // Canonical YYYY-MM format (e.g., "2026-10")
  month: string; // Human-readable or legacy label
  title?: string;
  originalAmountDue?: number; // Full invoiced rate supporting fee balance & partial-payment tracking (unresolved DEC-MSEC-02 void/refund policy independent)
  amountDue: number;
  paidAmount?: number;
  dueDate: Date;
  status: FeeStatusType;
  feeType?: FeeType;
  lastReminderSentAt?: Date;
  reminderCount?: number;
  reminderPaused?: boolean;
  reminderLockUntil?: Date;
  utrNumber?: string;
  upiTransactionId?: string;
  processedTxnIds?: string[];
  paymentTransactions?: IPaymentTransaction[];
  paymentHistory?: IPaymentEntry[]; // Structured payment line items (Phase 4)
  paymentDate?: Date | null;
  paidDate?: Date | null;
  paidAt?: Date | null;
  paymentMode?: string;
  receiptNumber?: string;
  isAdvance?: boolean;
  notes?: string;
  assignedTeacherId?: Types.ObjectId | null;
  assignedTeacherAtPayment?: Types.ObjectId | null;
  batchAtPayment?: string;
  receivedBy?: Types.ObjectId | null;
  receivedByRole?: "owner" | "teacher" | "gateway_direct" | "system" | null;
  recordedBy?: Types.ObjectId;
  recordedByRole?: "owner" | "teacher" | "system";
  recordedAt?: Date;
  hasPaymentProof?: boolean;
  latestPaymentProofId?: Types.ObjectId | null;
  proofUploadLockUntil?: Date | null;
  rejectionReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IFeeDocument extends IFee, Document { }

export const PaymentAllocationSchema = new Schema<IPaymentAllocation>(
  {
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    allocationId: {
      type: Schema.Types.ObjectId,
      default: function (this: IPaymentAllocation) {
        return this._id || new Types.ObjectId();
      },
    },
    handoverId: {
      type: Schema.Types.ObjectId,
      ref: "CashHandover",
      required: [true, "Handover ID is required"],
      index: true,
    },
    handoverNumber: {
      type: String,
      trim: true,
      default: "",
    },
    allocatedAmount: {
      type: Number,
      required: [true, "Allocated amount is required"],
      min: [0.01, "Allocated amount must be greater than zero"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Allocated amount must be a finite positive number",
      },
    },
    allocatedAt: {
      type: Date,
      default: Date.now,
    },
    allocatedBy: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
    },
    status: {
      type: String,
      enum: {
        values: [
          "pending_verification",
          "verified",
          "rejected",
          "disputed",
          "shortage_confirmed",
        ],
        message: "{VALUE} is not a valid allocation status",
      },
      default: "pending_verification",
      required: [true, "Allocation status is required"],
    },
    verifiedAmount: {
      type: Number,
      min: [0, "Verified amount cannot be negative"],
      validate: {
        validator: function (this: IPaymentAllocation, v?: number) {
          if (v === undefined || v === null) return true;
          return Number.isFinite(v) && v >= 0;
        },
        message: "Verified amount must be a finite non-negative number",
      },
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: "",
    },
    disputeId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: true }
);

export const PaymentEntrySchema = new Schema<IPaymentEntry>(
  {
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      default: function (this: IPaymentEntry) {
        return this._id || new Types.ObjectId();
      },
    },
    amount: {
      type: Number,
      required: [true, "Payment amount is required"],
      min: [0.01, "Payment amount must be greater than zero"],
      validate: {
        validator: (v: number) => Number.isFinite(v) && v > 0,
        message: "Payment amount must be a finite positive number",
      },
    },
    paymentDate: {
      type: Date,
      required: [true, "Payment date is required"],
      default: Date.now,
    },
    paymentMode: {
      type: String,
      required: [true, "Payment mode is required"],
      default: "Cash",
      trim: true,
    },
    receiptNumber: {
      type: String,
      required: [true, "Receipt number is required"],
      trim: true,
    },
    finalReceiptNumber: {
      type: String,
      trim: true,
      default: "",
    },
    isProvisional: {
      type: Boolean,
      default: false,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
    },
    // Immutable collection attribution (DEC-MSEC-01)
    receivedBy: {
      type: Schema.Types.ObjectId,
      required: [true, "receivedBy is required"],
      immutable: true,
      index: true,
    },
    receivedByRole: {
      type: String,
      required: [true, "receivedByRole is required"],
      immutable: true,
      enum: {
        values: ["owner", "teacher", "gateway_direct"],
        message: "{VALUE} is not a valid receivedByRole",
      },
    },
    recordedBy: {
      type: Schema.Types.ObjectId,
      required: [true, "recordedBy is required"],
      immutable: true,
      index: true,
    },
    recordedByRole: {
      type: String,
      required: [true, "recordedByRole is required"],
      immutable: true,
      enum: {
        values: ["owner", "teacher", "system"],
        message: "{VALUE} is not a valid recordedByRole",
      },
    },
    recordedAt: {
      type: Date,
      default: Date.now,
    },
    assignedTeacherAtPayment: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
      index: true,
    },
    batchAtPayment: {
      type: String,
      trim: true,
      default: "",
    },
    custodyStatus: {
      type: String,
      enum: {
        values: [
          "teacher_custody",
          "teacher_in_hand",
          "owner_pending",
          "owner_verified",
          "owner_custody",
          "shortage_deficit",
          "split_custody",
        ],
        message: "{VALUE} is not a valid custody status",
      },
      default: "teacher_custody",
    },
    allocations: {
      type: [PaymentAllocationSchema],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

/**
 * Calculates the active locked currency amount for an allocation.
 * - "rejected": 0 (funds released for re-submission)
 * - "verified": verifiedAmount ?? allocatedAmount (releases unverified discrepancy on partial approvals)
 * - "pending_verification": full allocatedAmount (locked in transit)
 * - "disputed" / "shortage_confirmed": full allocatedAmount (locked; prevents duplicate re-allocation)
 */
export function getLockedAllocationAmount(alloc: IPaymentAllocation): number {
  if (alloc.status === "rejected") {
    return 0;
  }
  if (alloc.status === "verified") {
    return Number(alloc.verifiedAmount ?? alloc.allocatedAmount) || 0;
  }
  return Number(alloc.allocatedAmount) || 0;
}

// PaymentEntry level invariant: active allocations cannot exceed payment amount
PaymentEntrySchema.pre("validate", function () {
  const entry = this as unknown as IPaymentEntry;
  if (!entry.paymentId && entry._id) {
    entry.paymentId = entry._id;
  }
  if (entry.allocations && entry.allocations.length > 0) {
    const activeAllocated = entry.allocations.reduce((sum: number, a: IPaymentAllocation) => {
      return sum + getLockedAllocationAmount(a);
    }, 0);
    if (typeof entry.amount === "number" && activeAllocated > entry.amount + 0.001) {
      this.invalidate(
        "allocations",
        `Total active allocated amount (${activeAllocated}) cannot exceed payment amount (${entry.amount})`
      );
    }
  }
});

/**
 * Safely matches a payment entry against a target identifier.
 * Checks both entry._id and entry.paymentId safely to avoid JavaScript truthy
 * short-circuit evaluation bugs (e.g. `p._id || p.paymentId`) when _id and paymentId
 * are distinct ObjectIds.
 */
export function matchPaymentEntry(
  entry: IPaymentEntry | { _id?: unknown; paymentId?: unknown } | null | undefined,
  targetId: string | Types.ObjectId | unknown
): boolean {
  if (!entry || !targetId) return false;
  const targetStr = String(targetId).trim();
  if (!targetStr) return false;
  const idStr = entry._id ? String(entry._id).trim() : "";
  const paymentIdStr = entry.paymentId ? String(entry.paymentId).trim() : "";
  return (idStr.length > 0 && idStr === targetStr) || (paymentIdStr.length > 0 && paymentIdStr === targetStr);
}

/**
 * Safely matches a payment allocation against a target allocation identifier or handoverId.
 */
export function matchPaymentAllocation(
  alloc: IPaymentAllocation | { _id?: unknown; allocationId?: unknown; handoverId?: unknown } | null | undefined,
  targetAllocationId?: string | Types.ObjectId | unknown,
  targetHandoverId?: string | Types.ObjectId | unknown
): boolean {
  if (!alloc) return false;
  const allocTargetStr = targetAllocationId ? String(targetAllocationId).trim() : "";
  const handoverTargetStr = targetHandoverId ? String(targetHandoverId).trim() : "";

  if (allocTargetStr) {
    const idStr = alloc._id ? String(alloc._id).trim() : "";
    const allocationIdStr = alloc.allocationId ? String(alloc.allocationId).trim() : "";
    if ((idStr.length > 0 && idStr === allocTargetStr) || (allocationIdStr.length > 0 && allocationIdStr === allocTargetStr)) {
      return true;
    }
  }

  if (handoverTargetStr) {
    const handoverIdStr = alloc.handoverId ? String(alloc.handoverId).trim() : "";
    if (handoverIdStr.length > 0 && handoverIdStr === handoverTargetStr) {
      return true;
    }
  }

  return false;
}

const FeeSchema = new Schema<IFeeDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      index: true,
      trim: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: [true, "Student ID is required"],
      index: true,
    },
    month: {
      type: String,
      required: [true, "Fee month is required"],
      trim: true,
    },
    billingMonth: {
      type: String,
      trim: true,
      match: [/^\d{4}-\d{2}$/, "Invalid billing month format (expected YYYY-MM)"],
    },
    feeType: {
      type: String,
      enum: {
        values: ["monthly_recurring", "advance", "adhoc", "registration"],
        message: "{VALUE} is not a valid fee type",
      },
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    originalAmountDue: {
      type: Number,
      min: [0, "Original amount due cannot be negative"],
    },
    amountDue: {
      type: Number,
      required: [true, "Amount due is required"],
      min: [0, "Amount due cannot be negative"],
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: [0, "Paid amount cannot be negative"],
    },
    dueDate: {
      type: Date,
      required: [true, "Due date is required"],
    },
    status: {
      type: String,
      enum: {
        values: ["Pending", "Paid", "Verification Pending", "Partial Paid"],
        message: "{VALUE} is not a valid fee status",
      },
      default: "Pending",
      required: [true, "Fee status is required"],
    },
    lastReminderSentAt: {
      type: Date,
    },
    reminderCount: {
      type: Number,
      default: 0,
      min: [0, "Reminder count cannot be negative"],
    },
    reminderPaused: {
      type: Boolean,
      default: false,
    },
    reminderLockUntil: {
      type: Date,
    },
    utrNumber: {
      type: String,
      trim: true,
      default: "",
    },
    upiTransactionId: {
      type: String,
      trim: true,
      default: "",
    },
    processedTxnIds: {
      type: [String],
      default: [],
    },
    paymentTransactions: [
      {
        txnId: { type: String, trim: true },
        amount: { type: Number },
        date: { type: Date },
        mode: { type: String, default: "Online/UPI" },
        status: { type: String, default: "SUCCESS" },
      },
    ],
    // Structured line-item payment history (Phase 4)
    paymentHistory: {
      type: [PaymentEntrySchema],
      default: [],
    },
    paymentDate: {
      type: Date,
    },
    paidDate: {
      type: Date,
    },
    paidAt: {
      type: Date,
    },
    paymentMode: {
      type: String,
      trim: true,
      default: "Manual/Cash",
    },
    receiptNumber: {
      type: String,
      trim: true,
      default: "",
    },
    isAdvance: {
      type: Boolean,
      default: false,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    // Academic attribution & historical snapshot (CONFIRMED DEC-MSEC-03)
    assignedTeacherId: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
      index: true,
    },
    assignedTeacherAtPayment: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
      index: true,
    },
    batchAtPayment: {
      type: String,
      trim: true,
    },
    // Payment custody & audit
    receivedBy: {
      type: Schema.Types.ObjectId,
      index: true,
    },
    receivedByRole: {
      type: String,
      enum: ["owner", "teacher", "gateway_direct", "system"],
    },
    recordedBy: {
      type: Schema.Types.ObjectId,
      index: true,
    },
    recordedByRole: {
      type: String,
      enum: ["owner", "teacher", "system"],
    },
    recordedAt: {
      type: Date,
      default: Date.now,
    },
    hasPaymentProof: {
      type: Boolean,
      default: false,
      index: true,
    },
    latestPaymentProofId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentProof",
      default: null,
    },
    proofUploadLockUntil: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
    autoIndex: false,
  }
);

// Fee-level invariant validation: active allocations cannot exceed payment entry amount
FeeSchema.pre("validate", function () {
  const fee = this as unknown as IFee;
  if (fee.paymentHistory && fee.paymentHistory.length > 0) {
    for (let i = 0; i < fee.paymentHistory.length; i++) {
      const entry = fee.paymentHistory[i];
      if (entry.allocations && entry.allocations.length > 0) {
        const activeAllocated = entry.allocations.reduce((sum: number, a: IPaymentAllocation) => {
          return sum + getLockedAllocationAmount(a);
        }, 0);
        if (typeof entry.amount === "number" && activeAllocated > entry.amount + 0.001) {
          this.invalidate(
            `paymentHistory.${i}.allocations`,
            `Total active allocated amount (${activeAllocated}) cannot exceed payment amount (${entry.amount})`
          );
        }
      }
    }
  }
});

// Compound indexes for multi-tenant querying
FeeSchema.index({ centerId: 1, studentId: 1, month: 1 });
FeeSchema.index({ centerId: 1, status: 1 });
FeeSchema.index(
  { centerId: 1, utrNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      utrNumber: { $type: "string", $gt: "" },
    },
  }
);
FeeSchema.index({ centerId: 1, assignedTeacherAtPayment: 1, paymentDate: 1 });
FeeSchema.index({ centerId: 1, receivedBy: 1, paymentDate: 1 });
FeeSchema.index({ centerId: 1, recordedBy: 1, recordedAt: 1 });
FeeSchema.index({ centerId: 1, "paymentHistory.receivedBy": 1 });
FeeSchema.index({ centerId: 1, "paymentHistory.allocations.handoverId": 1 });
FeeSchema.index({ centerId: 1, "paymentHistory.receiptNumber": 1 });
FeeSchema.index(
  { centerId: 1, "paymentHistory.idempotencyKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "paymentHistory.idempotencyKey": { $type: "string", $gt: "" },
    },
  }
);

/**
 * Derives amount-level custody breakdown for a payment entry.
 * Strictly separates physical custody from verification status.
 */
export function calculatePaymentCustody(payment: IPaymentEntry): IPaymentCustodyBreakdown {
  const totalAmount = Number(payment.amount) || 0;
  let ownerVerifiedAmount = 0;
  let ownerPendingVerificationAmount = 0;
  let disputedDiscrepancyAmount = 0;

  if (payment.allocations && payment.allocations.length > 0) {
    for (const alloc of payment.allocations) {
      if (alloc.status === "verified") {
        ownerVerifiedAmount += Number(alloc.verifiedAmount ?? alloc.allocatedAmount) || 0;
      } else if (alloc.status === "pending_verification") {
        // Cash delivered to Owner, awaiting verification count
        ownerPendingVerificationAmount += Number(alloc.allocatedAmount) || 0;
      } else if (alloc.status === "disputed" || alloc.status === "shortage_confirmed") {
        const allocated = Number(alloc.allocatedAmount) || 0;
        const verified = Number(alloc.verifiedAmount) || 0;
        ownerVerifiedAmount += verified;
        disputedDiscrepancyAmount += Math.max(0, allocated - verified);
      }
      // "rejected" allocations release funds and contribute 0 to locked amounts
    }
  }

  // Teacher in-hand amount is strictly the unallocated cash not yet submitted in any handover
  const teacherInHandAmount = Math.max(
    0,
    totalAmount - ownerVerifiedAmount - ownerPendingVerificationAmount - disputedDiscrepancyAmount
  );

  let custodyLabel:
    | "owner_verified"
    | "owner_pending"
    | "teacher_in_hand"
    | "shortage_deficit"
    | "split_custody" = "teacher_in_hand";
  if (totalAmount > 0 && Math.abs(ownerVerifiedAmount - totalAmount) < 0.001) {
    custodyLabel = "owner_verified";
  } else if (totalAmount > 0 && Math.abs(ownerPendingVerificationAmount - totalAmount) < 0.001) {
    custodyLabel = "owner_pending";
  } else if (totalAmount > 0 && Math.abs(teacherInHandAmount - totalAmount) < 0.001) {
    custodyLabel = "teacher_in_hand";
  } else if (totalAmount > 0 && Math.abs(disputedDiscrepancyAmount - totalAmount) < 0.001) {
    custodyLabel = "shortage_deficit";
  } else {
    custodyLabel = "split_custody";
  }

  return {
    totalAmount,
    teacherInHandAmount,
    ownerPendingVerificationAmount,
    ownerVerifiedAmount,
    disputedDiscrepancyAmount,
    custodyLabel,
  };
}

/**
 * Synthesizes virtual approved line-item payment entries for legacy Fee documents
 * created before Phase 4. Guarantees zero database migrations and zero false liabilities.
 */
export function getFeePaymentEntries(fee: IFee | IFeeDocument): IPaymentEntry[] {
  // If modern line items exist, return them directly
  if (fee.paymentHistory && fee.paymentHistory.length > 0) {
    return fee.paymentHistory;
  }

  // If legacy fee has recorded payments, synthesize a virtual legacy approved entry
  const paidAmount = Number(fee.paidAmount) || 0;
  if ((fee.status === "Paid" || fee.status === "Partial Paid") && paidAmount > 0) {
    const feeDoc = fee as IFee & { _id?: Types.ObjectId };
    const feeId = feeDoc._id || new Types.ObjectId();
    const reliablePaymentDate =
      fee.paymentDate || fee.paidDate || fee.paidAt;
    const fallbackDate = reliablePaymentDate
      ? new Date(reliablePaymentDate)
      : (undefined as unknown as Date);
    const fallbackCollector =
      fee.receivedBy ||
      fee.recordedBy ||
      fee.assignedTeacherAtPayment ||
      fee.assignedTeacherId ||
      new Types.ObjectId();
    const fallbackRecorder = fee.recordedBy || fee.receivedBy || new Types.ObjectId();

    return [
      {
        _id: feeId,
        paymentId: feeId,
        amount: paidAmount,
        paymentDate: fallbackDate,
        paymentMode: fee.paymentMode || "Cash",
        receiptNumber: fee.receiptNumber || "LEGACY-RCPT",
        isProvisional: false,
        receivedBy: fallbackCollector,
        receivedByRole: fee.receivedByRole || "owner",
        recordedBy: fallbackRecorder,
        recordedByRole: fee.recordedByRole || "owner",
        recordedAt: fee.recordedAt || fallbackDate,
        assignedTeacherAtPayment: fee.assignedTeacherAtPayment ?? null,
        batchAtPayment: fee.batchAtPayment || "",
        custodyStatus: "owner_custody",
        allocations: [
          {
            _id: feeId,
            allocationId: feeId,
            handoverId: feeId,
            handoverNumber: "LEGACY-SETTLED",
            allocatedAmount: paidAmount,
            allocatedAt: fallbackDate || new Date(0),
            allocatedBy: fallbackCollector,
            status: "verified",
            verifiedAmount: paidAmount,
            verifiedAt: fallbackDate || new Date(0),
            verifiedBy: fallbackRecorder,
          },
        ],
      },
    ];
  }

  return [];
}

/**
 * Calculates live custody breakdown for a Fee document from its structured payment entries.
 */
export function calculateFeeCustody(
  fee: IFee | IFeeDocument
): IPaymentCustodyBreakdown | null {
  const entries = getFeePaymentEntries(fee);
  if (!entries || entries.length === 0) return null;

  let totalAmount = 0;
  let teacherInHandAmount = 0;
  let ownerPendingVerificationAmount = 0;
  let ownerVerifiedAmount = 0;
  let disputedDiscrepancyAmount = 0;

  for (const entry of entries) {
    const c = calculatePaymentCustody(entry);
    totalAmount += c.totalAmount;
    teacherInHandAmount += c.teacherInHandAmount;
    ownerPendingVerificationAmount += c.ownerPendingVerificationAmount;
    ownerVerifiedAmount += c.ownerVerifiedAmount;
    disputedDiscrepancyAmount += c.disputedDiscrepancyAmount;
  }

  let custodyLabel:
    | "owner_verified"
    | "owner_pending"
    | "teacher_in_hand"
    | "shortage_deficit"
    | "split_custody" = "teacher_in_hand";
  if (totalAmount > 0 && Math.abs(ownerVerifiedAmount - totalAmount) < 0.001) {
    custodyLabel = "owner_verified";
  } else if (
    totalAmount > 0 &&
    Math.abs(ownerPendingVerificationAmount - totalAmount) < 0.001
  ) {
    custodyLabel = "owner_pending";
  } else if (
    totalAmount > 0 &&
    Math.abs(teacherInHandAmount - totalAmount) < 0.001
  ) {
    custodyLabel = "teacher_in_hand";
  } else if (
    totalAmount > 0 &&
    Math.abs(disputedDiscrepancyAmount - totalAmount) < 0.001
  ) {
    custodyLabel = "shortage_deficit";
  } else {
    custodyLabel = "split_custody";
  }

  return {
    totalAmount,
    teacherInHandAmount,
    ownerPendingVerificationAmount,
    ownerVerifiedAmount,
    disputedDiscrepancyAmount,
    custodyLabel,
  };
}

if (
  process.env.NODE_ENV !== "production" &&
  mongoose.models.Fee &&
  (!mongoose.models.Fee.schema.path("billingMonth") ||
    !mongoose.models.Fee.schema.path("feeType") ||
    !mongoose.models.Fee.schema.path("assignedTeacherAtPayment") ||
    !mongoose.models.Fee.schema.path("paymentHistory") ||
    !mongoose.models.Fee.schema.path("originalAmountDue") ||
    !(
      ((mongoose.models.Fee.schema.path("paymentHistory") as any)?.schema
        ?.path("custodyStatus") as any)?.enumValues || []
    ).includes("owner_pending") ||
    !(
      (mongoose.models.Fee.schema.path("recordedByRole") as any)?.enumValues || []
    ).includes("system"))
) {
  delete (mongoose.models as Record<string, unknown>).Fee;
}

export const Fee: Model<IFeeDocument> =
  (mongoose.models.Fee as Model<IFeeDocument>) ||
  mongoose.model<IFeeDocument>("Fee", FeeSchema);

export default Fee;
