import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type AdmissionWelcomeJobStatus =
  | "pending"
  | "processing"
  | "sent"
  | "simulated"
  | "ambiguous"
  | "held_for_access"
  | "failed"
  | "skipped";

export type ParentAccessProvisionStatus =
  | "provisioned"
  | "existing_active"
  | "blocked_index"
  | "failed";

export interface IAdmissionWelcomeJob {
  centerId: string;
  studentId: Types.ObjectId;
  campaignId?: Types.ObjectId | null;
  idempotencyKey: string;
  parentPhone: string;
  studentName: string;
  batchName: string;
  status: AdmissionWelcomeJobStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptedAt?: Date | null;
  nextRetryAt?: Date | null;
  lockedAt?: Date | null;
  lockExpiresAt?: Date | null;
  parentAccessId?: Types.ObjectId | null;
  parentAccessStatus: ParentAccessProvisionStatus;
  // Encrypted invitation credentials (AES-256-GCM) — NEVER plaintext tokens
  encryptedInvitationToken?: {
    iv: string;
    authTag: string;
    ciphertext: string;
  } | null;
  tokenPrefix?: string | null;
  messageId?: string | null;
  simulated: boolean;
  dispatchedAt?: Date | null;
  failureReason?: string | null;
  isArchived?: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAdmissionWelcomeJobDocument
  extends IAdmissionWelcomeJob,
    Document {}

const AdmissionWelcomeJobSchema = new Schema<IAdmissionWelcomeJobDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      trim: true,
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: [true, "Student ID is required"],
      index: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "MessageCampaign",
      default: null,
    },
    idempotencyKey: {
      type: String,
      required: [true, "Idempotency key is required"],
      unique: true,
      trim: true,
      index: true,
    },
    parentPhone: {
      type: String,
      required: [true, "Parent phone number is required"],
      trim: true,
    },
    studentName: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    batchName: {
      type: String,
      required: [true, "Batch name is required"],
      trim: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "sent",
        "simulated",
        "ambiguous",
        "held_for_access",
        "failed",
        "skipped",
      ],
      default: "pending",
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
      min: 1,
    },
    lastAttemptedAt: {
      type: Date,
      default: null,
    },
    nextRetryAt: {
      type: Date,
      default: null,
      index: true,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    lockExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    parentAccessId: {
      type: Schema.Types.ObjectId,
      ref: "ParentAccess",
      default: null,
    },
    parentAccessStatus: {
      type: String,
      enum: ["provisioned", "existing_active", "blocked_index", "failed"],
      default: "blocked_index",
    },
    encryptedInvitationToken: {
      type: {
        iv: { type: String, required: true },
        authTag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    tokenPrefix: {
      type: String,
      default: null,
      trim: true,
    },
    messageId: {
      type: String,
      default: null,
      trim: true,
    },
    simulated: {
      type: Boolean,
      default: true,
    },
    dispatchedAt: {
      type: Date,
      default: null,
    },
    failureReason: {
      type: String,
      default: null,
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
    autoIndex: false,
  }
);

// Compound indexes for polling and recovery
AdmissionWelcomeJobSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
AdmissionWelcomeJobSchema.index({ centerId: 1, studentId: 1 });
AdmissionWelcomeJobSchema.index({ centerId: 1, isArchived: 1, createdAt: -1 });

if (mongoose.models.AdmissionWelcomeJob) {
  delete mongoose.models.AdmissionWelcomeJob;
}

export const AdmissionWelcomeJob: Model<IAdmissionWelcomeJobDocument> =
  (mongoose.models.AdmissionWelcomeJob as Model<IAdmissionWelcomeJobDocument>) ||
  mongoose.model<IAdmissionWelcomeJobDocument>(
    "AdmissionWelcomeJob",
    AdmissionWelcomeJobSchema
  );

let admissionWelcomeJobInitPromise: Promise<any> | null = null;

async function syncAdmissionWelcomeJobIndexes(targetModel: any): Promise<void> {
  const isConnected =
    targetModel?.db?.readyState === 1 ||
    targetModel?.collection?.conn?.readyState === 1 ||
    mongoose.connection?.readyState === 1;

  if (isConnected && typeof targetModel?.init === "function") {
    try {
      if (!admissionWelcomeJobInitPromise) {
        const initCall = targetModel.init().catch((err: any) => {
          admissionWelcomeJobInitPromise = null;
          console.warn("[AdmissionWelcomeJob] Index sync notice:", err?.message || err);
        });
        const timeoutCall = new Promise<void>((resolve) => setTimeout(resolve, 3000));
        admissionWelcomeJobInitPromise = Promise.race([initCall, timeoutCall]);
      }
      await admissionWelcomeJobInitPromise;
    } catch {
      admissionWelcomeJobInitPromise = null;
    }
  }
}

/**
 * Verifies whether the unique index on 'idempotencyKey' is active and enforced on the collection.
 * When Mongoose autoIndex is false (standard in production), unique constraints are NOT automatically
 * created by Mongoose and require explicit database index verification.
 */
export async function verifyAdmissionWelcomeJobIndexIntegrity(model?: any): Promise<boolean> {
  const targetModel = model || AdmissionWelcomeJob;
  if (!targetModel) return false;

  try {
    if (typeof targetModel.hasUniqueIdempotencyIndex === "function") {
      return await targetModel.hasUniqueIdempotencyIndex();
    }
    const collection = targetModel.collection;
    if (collection) {
      const inspectIndexes = async () => {
        let indexes: any[] = [];
        if (typeof collection.indexes === "function") {
          indexes = await collection.indexes();
        } else if (typeof collection.listIndexes === "function") {
          const cursor = collection.listIndexes();
          indexes =
            typeof cursor.toArray === "function" ? await cursor.toArray() : await cursor;
        }

        if (Array.isArray(indexes)) {
          return indexes.some((idx: any) => {
            if (!idx || !idx.key || typeof idx.key !== "object") return false;
            const keyProps = Object.keys(idx.key);
            // Strict verification: exactly one key field 'idempotencyKey' with sort 1, and unique: true.
            // Reject compound indexes (e.g. { idempotencyKey: 1, centerId: 1 }) and partial matches.
            return (
              keyProps.length === 1 &&
              keyProps[0] === "idempotencyKey" &&
              idx.key.idempotencyKey === 1 &&
              idx.unique === true
            );
          });
        }
        return false;
      };

      const hasIndex = await inspectIndexes();
      if (hasIndex) return true;

      // When autoIndex is false in production, attempt to build/sync schema indexes on the fly
      if (typeof targetModel.init === "function") {
        await syncAdmissionWelcomeJobIndexes(targetModel);
        const verifiedAfterInit = await inspectIndexes();
        if (verifiedAfterInit) return true;
      }
    }
    if (targetModel.enforceUniqueness !== undefined) {
      return Boolean(targetModel.enforceUniqueness);
    }
  } catch {
    return false;
  }
  return false;
}

export default AdmissionWelcomeJob;
