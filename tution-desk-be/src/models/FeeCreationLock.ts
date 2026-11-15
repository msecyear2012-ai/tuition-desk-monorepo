import mongoose, { Schema, Document, Model } from "mongoose";

export interface IFeeCreationLock {
  lockKey: string; // "centerId:studentId:billingMonth:feeType"
  centerId: string;
  studentId: string;
  billingMonth: string;
  feeType: string;
  lockedAt: Date;
  expiresAt: Date;
  holderId: string;
  status: "LOCKED" | "COMPLETED";
  feeId?: string;
}

export interface IFeeCreationLockDocument extends IFeeCreationLock, Document {}

const FeeCreationLockSchema = new Schema<IFeeCreationLockDocument>(
  {
    lockKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    centerId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    studentId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    billingMonth: {
      type: String,
      required: true,
      trim: true,
    },
    feeType: {
      type: String,
      required: true,
      default: "monthly_recurring",
    },
    lockedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: "10m" }, // TTL index as safety net
    },
    holderId: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["LOCKED", "COMPLETED"],
      required: true,
      default: "LOCKED",
    },
    feeId: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    autoIndex: false,
  }
);

// Ensure unique index on lockKey
FeeCreationLockSchema.index({ lockKey: 1 }, { unique: true });

export const FeeCreationLock: Model<IFeeCreationLockDocument> =
  (mongoose.models.FeeCreationLock as Model<IFeeCreationLockDocument>) ||
  mongoose.model<IFeeCreationLockDocument>("FeeCreationLock", FeeCreationLockSchema);

let feeCreationLockInitPromise: Promise<any> | null = null;

async function syncFeeCreationLockIndexes(targetModel: any): Promise<void> {
  const isConnected =
    targetModel?.db?.readyState === 1 ||
    targetModel?.collection?.conn?.readyState === 1 ||
    mongoose.connection?.readyState === 1;

  if (isConnected && typeof targetModel?.init === "function") {
    try {
      if (!feeCreationLockInitPromise) {
        const initCall = targetModel.init().catch((err: any) => {
          feeCreationLockInitPromise = null;
          console.warn("[FeeCreationLock] Index sync notice:", err?.message || err);
        });
        const timeoutCall = new Promise<void>((resolve) => setTimeout(resolve, 3000));
        feeCreationLockInitPromise = Promise.race([initCall, timeoutCall]);
      }
      await feeCreationLockInitPromise;
    } catch {
      feeCreationLockInitPromise = null;
    }
  }
}

/**
 * Verifies whether the unique index on 'lockKey' is active and enforced on the collection.
 * When Mongoose autoIndex is false (standard in production), unique constraints are NOT automatically
 * created by Mongoose and require explicit database index verification.
 */
export async function verifyLockIndexIntegrity(model?: any): Promise<boolean> {
  const targetModel = model || FeeCreationLock;
  if (!targetModel) return false;

  try {
    if (typeof targetModel.hasUniqueLockIndex === "function") {
      return await targetModel.hasUniqueLockIndex();
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
          return indexes.some(
            (idx: any) => idx.key && idx.key.lockKey === 1 && idx.unique === true
          );
        }
        return false;
      };

      const hasIndex = await inspectIndexes();
      if (hasIndex) return true;

      // When autoIndex is false in production, attempt to build/sync schema indexes on the fly
      if (typeof targetModel.init === "function") {
        await syncFeeCreationLockIndexes(targetModel);
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

/**
 * Verifies whether the TTL index on 'expiresAt' is active and enforced on the collection.
 */
export async function verifyFeeCreationLockTtlIndexIntegrity(model?: any): Promise<boolean> {
  const targetModel = model || FeeCreationLock;
  if (!targetModel) return false;

  try {
    if (typeof targetModel.hasTtlIndex === "function") {
      return await targetModel.hasTtlIndex();
    }
    const collection = targetModel.collection;
    if (collection) {
      const inspectTtl = async () => {
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
            return (
              idx.key.expiresAt === 1 &&
              (typeof idx.expireAfterSeconds === "number" || typeof idx.expires !== "undefined")
            );
          });
        }
        return false;
      };

      const hasTtl = await inspectTtl();
      if (hasTtl) return true;

      // When autoIndex is false in production, attempt to build/sync schema indexes on the fly
      if (typeof targetModel.init === "function") {
        await syncFeeCreationLockIndexes(targetModel);
        const verifiedAfterInit = await inspectTtl();
        if (verifiedAfterInit) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export default FeeCreationLock;

