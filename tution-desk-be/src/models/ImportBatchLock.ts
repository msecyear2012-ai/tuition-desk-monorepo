import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IImportBatchLock {
  centerId: string;
  previewId: string;
  holderId: string; // Cryptographic UUID identifying the specific execution request holding the lease
  lockVersion?: number; // Monotonically increasing fencing version token
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  importedCount?: number;
  failedCount?: number;
  assignedTeacherId?: Types.ObjectId | null;
  assignedRole: string;
  userId: string;
  lastError?: string;
  lockedAt: Date;
  heartbeatAt: Date;
  completedAt?: Date;
  failedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IImportBatchLockDocument extends IImportBatchLock, Document {}

const ImportBatchLockSchema = new Schema<IImportBatchLockDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    previewId: {
      type: String,
      required: [true, "Preview ID is required"],
      trim: true,
    },
    holderId: {
      type: String,
      required: [true, "Holder ID is required"],
      trim: true,
    },
    lockVersion: {
      type: Number,
      default: 1,
    },
    status: {
      type: String,
      enum: ["IN_PROGRESS", "COMPLETED", "FAILED"],
      required: true,
      default: "IN_PROGRESS",
    },
    importedCount: {
      type: Number,
      default: 0,
    },
    failedCount: {
      type: Number,
      default: 0,
    },
    assignedTeacherId: {
      type: Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
    },
    assignedRole: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: String,
      required: true,
      trim: true,
    },
    lastError: {
      type: String,
      trim: true,
    },
    lockedAt: {
      type: Date,
      default: Date.now,
    },
    heartbeatAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
    },
    failedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index ensuring mutual exclusion per preview per institute
ImportBatchLockSchema.index({ centerId: 1, previewId: 1 }, { unique: true });

// Support hot module reloads in development
if (
  process.env.NODE_ENV !== "production" &&
  mongoose.models.ImportBatchLock
) {
  delete (mongoose.models as Record<string, unknown>).ImportBatchLock;
}

export const ImportBatchLock: Model<IImportBatchLockDocument> =
  (mongoose.models.ImportBatchLock as Model<IImportBatchLockDocument>) ||
  mongoose.model<IImportBatchLockDocument>(
    "ImportBatchLock",
    ImportBatchLockSchema
  );

let importBatchLockInitPromise: Promise<any> | null = null;

async function syncImportBatchLockIndexes(targetModel: any): Promise<void> {
  const collection = targetModel?.collection;
  const isConnected =
    targetModel?.db?.readyState === 1 ||
    collection?.conn?.readyState === 1 ||
    mongoose.connection?.readyState === 1;

  if (isConnected) {
    try {
      if (!importBatchLockInitPromise) {
        const buildCall = (async () => {
          // 1. Model-level index build (bypasses autoIndex check)
          if (typeof targetModel?.createIndexes === "function") {
            try {
              await targetModel.createIndexes();
            } catch (err: any) {
              console.warn("[ImportBatchLock] createIndexes notice:", err?.message || err);
            }
          }
          // 2. Direct collection-level creation of unique compound index { centerId: 1, previewId: 1 }
          if (collection && typeof collection.createIndex === "function") {
            try {
              await collection.createIndex(
                { centerId: 1, previewId: 1 },
                { unique: true, name: "centerId_1_previewId_1" }
              );
            } catch (err: any) {
              console.warn("[ImportBatchLock] createIndex unique notice:", err?.message || err);
            }
          }
        })();

        const timeoutCall = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        importBatchLockInitPromise = Promise.race([buildCall, timeoutCall]);
      }
      await importBatchLockInitPromise;
    } catch {
      importBatchLockInitPromise = null;
    }
  }
}

/**
 * Checks whether the unique compound index { centerId: 1, previewId: 1 }
 * exists on the collection. In production where Mongoose autoIndex may be disabled,
 * this provides preflight verification and auto-syncs the index if missing.
 */
export async function verifyImportLockIndexIntegrity(
  model?: any
): Promise<boolean> {
  const targetModel = model || ImportBatchLock;
  if (!targetModel) return false;

  const inspectIndexes = async (): Promise<boolean> => {
    try {
      const collection = targetModel.collection;
      if (!collection) return false;

      let indexes: any[] = [];
      if (typeof collection.indexes === "function") {
        indexes = await collection.indexes();
      } else if (typeof collection.listIndexes === "function") {
        const cursor = collection.listIndexes();
        indexes =
          typeof cursor.toArray === "function" ? await cursor.toArray() : await cursor;
      }

      if (!Array.isArray(indexes)) return false;

      return indexes.some((idx: any) => {
        if (!idx || !idx.key || typeof idx.key !== "object") return false;
        return (
          idx.unique === true &&
          idx.key.centerId === 1 &&
          idx.key.previewId === 1
        );
      });
    } catch {
      return false;
    }
  };

  const hasIndex = await inspectIndexes();
  if (hasIndex) return true;

  // If index is not yet built and model has sync/create capabilities, trigger active synchronization
  const canSync =
    typeof targetModel.createIndexes === "function" ||
    (targetModel.collection && typeof targetModel.collection.createIndex === "function");

  if (canSync) {
    await syncImportBatchLockIndexes(targetModel);
    return await inspectIndexes();
  }

  return false;
}

export const DEFAULT_LOCK_LEASE_MS = 60 * 1000; // 60 seconds
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 1000; // 10 seconds

export function getLockLeaseDurationMs(): number {
  const envVal = process.env.IMPORT_LOCK_LEASE_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LOCK_LEASE_MS;
}

export function getHeartbeatIntervalMs(): number {
  const envVal = process.env.IMPORT_LOCK_HEARTBEAT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS;
}

export default ImportBatchLock;
