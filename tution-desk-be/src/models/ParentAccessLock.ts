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
    }
    if (targetModel.enforceUniqueness !== undefined) {
      return Boolean(targetModel.enforceUniqueness);
    }
  } catch {
    return false;
  }
  return false;
}

export default ParentAccessLock;
