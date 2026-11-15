import mongoose, { Schema, Document, Model } from "mongoose";

export interface IParentAccessLock {
  lockKey: string; // "centerId:studentId:phone:parent_access_create"
  centerId: string;
  studentId: string;
  holderId: string;
  status: "LOCKED" | "COMPLETED";
  lockedAt: Date;
  expiresAt: Date;
}

export interface IParentAccessLockDocument extends IParentAccessLock, Document {}

const ParentAccessLockSchema = new Schema<IParentAccessLockDocument>(
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
  },
  {
    timestamps: true,
    autoIndex: false,
  }
);

// Ensure unique index definition on lockKey
ParentAccessLockSchema.index({ lockKey: 1 }, { unique: true });

// Ensure clean re-compilation during Next.js hot module replacement
if (mongoose.models.ParentAccessLock) {
  delete mongoose.models.ParentAccessLock;
}

export const ParentAccessLock: Model<IParentAccessLockDocument> =
  (mongoose.models.ParentAccessLock as Model<IParentAccessLockDocument>) ||
  mongoose.model<IParentAccessLockDocument>("ParentAccessLock", ParentAccessLockSchema);

let parentAccessLockInitPromise: Promise<any> | null = null;

async function syncParentAccessLockIndexes(targetModel: any): Promise<void> {
  const isConnected =
    targetModel?.db?.readyState === 1 ||
    targetModel?.collection?.conn?.readyState === 1 ||
    mongoose.connection?.readyState === 1;

  if (isConnected && typeof targetModel?.init === "function") {
    try {
      if (!parentAccessLockInitPromise) {
        const initCall = targetModel.init().catch((err: any) => {
          parentAccessLockInitPromise = null;
          console.warn("[ParentAccessLock] Index sync notice:", err?.message || err);
        });
        const timeoutCall = new Promise<void>((resolve) => setTimeout(resolve, 3000));
        parentAccessLockInitPromise = Promise.race([initCall, timeoutCall]);
      }
      await parentAccessLockInitPromise;
    } catch {
      parentAccessLockInitPromise = null;
    }
  }
}

/**
 * Verifies whether the unique index on 'lockKey' is active and enforced on the collection.
 * When Mongoose autoIndex is false (standard in production), unique constraints are NOT automatically
 * created by Mongoose and require explicit database index verification.
 */
export async function verifyParentAccessLockIndexIntegrity(model?: any): Promise<boolean> {
  const targetModel = model || ParentAccessLock;
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
          return indexes.some((idx: any) => {
            if (!idx || !idx.key || typeof idx.key !== "object") return false;
            const keyProps = Object.keys(idx.key);
            // Strict verification: exactly one key field 'lockKey' with sort 1, and unique: true.
            // Reject compound indexes (e.g. { lockKey: 1, centerId: 1 }) and partial matches.
            return (
              keyProps.length === 1 &&
              keyProps[0] === "lockKey" &&
              idx.key.lockKey === 1 &&
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
        await syncParentAccessLockIndexes(targetModel);
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
export async function verifyParentAccessLockTtlIndexIntegrity(model?: any): Promise<boolean> {
  const targetModel = model || ParentAccessLock;
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
        await syncParentAccessLockIndexes(targetModel);
        const verifiedAfterInit = await inspectTtl();
        if (verifiedAfterInit) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export default ParentAccessLock;
