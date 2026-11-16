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

let feeCreationLockInitPromise: Promise<unknown> | null = null;

// Module-scoped cache and in-flight promise tracker for lock index verification
const verifiedLockIndexModels = new WeakSet<object>();
let isDefaultLockIndexVerified = false;
let inFlightLockIndexVerification: Promise<boolean> | null = null;
const inFlightModelVerifications = new WeakMap<object, Promise<boolean>>();

/**
 * Resets the in-memory lock index verification cache.
 * Useful for test suites and testing retry on failure.
 */
export function resetLockIndexVerificationCache(): void {
  isDefaultLockIndexVerified = false;
  inFlightLockIndexVerification = null;
}

interface LockModelLike {
  collection?: {
    indexes?: () => Promise<unknown[]>;
    listIndexes?: () => { toArray?: () => Promise<unknown[]> } | Promise<unknown[]>;
    createIndex?: (key: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
    conn?: { readyState?: number };
  };
  db?: { readyState?: number };
  createIndexes?: () => Promise<unknown>;
  hasUniqueLockIndex?: () => Promise<boolean> | boolean;
  hasTtlIndex?: () => Promise<boolean> | boolean;
  enforceUniqueness?: boolean;
}

async function syncFeeCreationLockIndexes(targetModel: unknown): Promise<void> {
  const modelObj = targetModel as LockModelLike | undefined;
  const collection = modelObj?.collection;
  const isConnected =
    modelObj?.db?.readyState === 1 ||
    collection?.conn?.readyState === 1 ||
    mongoose.connection?.readyState === 1;

  if (isConnected) {
    try {
      if (!feeCreationLockInitPromise) {
        const buildCall = (async () => {
          // 1. Model-level index build (bypasses autoIndex check)
          if (typeof modelObj?.createIndexes === "function") {
            try {
              await modelObj.createIndexes();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn("[FeeCreationLock] createIndexes notice:", msg);
            }
          }
          // 2. Direct collection-level creation of unique index on lockKey
          if (collection && typeof collection.createIndex === "function") {
            try {
              await collection.createIndex(
                { lockKey: 1 },
                { unique: true, name: "lockKey_1" }
              );
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn("[FeeCreationLock] createIndex unique notice:", msg);
            }
          }
          // 3. Direct collection-level creation of TTL index on expiresAt
          if (collection && typeof collection.createIndex === "function") {
            try {
              await collection.createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 600, name: "expiresAt_1" }
              );
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn("[FeeCreationLock] createIndex TTL notice:", msg);
            }
          }
        })();

        const timeoutCall = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        feeCreationLockInitPromise = Promise.race([buildCall, timeoutCall]);
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
export async function verifyLockIndexIntegrity(model?: unknown): Promise<boolean> {
  const targetModel = (model || FeeCreationLock) as LockModelLike | undefined;
  if (!targetModel) return false;

  const isDefault = !model || targetModel === (FeeCreationLock as unknown);

  // 1. Check cache first
  if (isDefault) {
    if (isDefaultLockIndexVerified) {
      return true;
    }
    if (inFlightLockIndexVerification) {
      return await inFlightLockIndexVerification;
    }
  } else if (typeof targetModel === "object" && targetModel !== null) {
    if (verifiedLockIndexModels.has(targetModel)) {
      return true;
    }
    const existingInFlight = inFlightModelVerifications.get(targetModel);
    if (existingInFlight) {
      return await existingInFlight;
    }
  }

  // 2. Perform verification and share in-flight promise
  const performVerification = async (): Promise<boolean> => {
    try {
      if (typeof targetModel.hasUniqueLockIndex === "function") {
        const res = await targetModel.hasUniqueLockIndex();
        if (res) {
          if (isDefault) {
            isDefaultLockIndexVerified = true;
          } else if (typeof targetModel === "object" && targetModel !== null) {
            verifiedLockIndexModels.add(targetModel);
          }
          return true;
        }
        return false;
      }
      const collection = targetModel.collection;
      if (collection) {
        const inspectIndexes = async () => {
          let indexes: unknown[] = [];
          if (typeof collection.indexes === "function") {
            indexes = await collection.indexes();
          } else if (typeof collection.listIndexes === "function") {
            const cursor = collection.listIndexes();
            const cursorObj = cursor as { toArray?: () => Promise<unknown[]> } | null;
            indexes =
              cursorObj && typeof cursorObj.toArray === "function"
                ? await cursorObj.toArray()
                : await (cursor as Promise<unknown[]>);
          }
          if (Array.isArray(indexes)) {
            return indexes.some((idx: unknown) => {
              const record = idx as { key?: Record<string, unknown>; unique?: boolean };
              return record?.key?.lockKey === 1 && record?.unique === true;
            });
          }
          return false;
        };

        const hasIndex = await inspectIndexes();
        if (hasIndex) {
          if (isDefault) {
            isDefaultLockIndexVerified = true;
          } else if (typeof targetModel === "object" && targetModel !== null) {
            verifiedLockIndexModels.add(targetModel);
          }
          return true;
        }

        // When autoIndex is false in production, attempt to build/sync schema indexes on the fly
        await syncFeeCreationLockIndexes(targetModel);
        const verifiedAfterInit = await inspectIndexes();
        if (verifiedAfterInit) {
          if (isDefault) {
            isDefaultLockIndexVerified = true;
          } else if (typeof targetModel === "object" && targetModel !== null) {
            verifiedLockIndexModels.add(targetModel);
          }
          return true;
        }
      }
      if (targetModel.enforceUniqueness !== undefined) {
        const res = Boolean(targetModel.enforceUniqueness);
        if (res) {
          if (isDefault) {
            isDefaultLockIndexVerified = true;
          } else if (typeof targetModel === "object" && targetModel !== null) {
            verifiedLockIndexModels.add(targetModel);
          }
          return true;
        }
        return false;
      }
    } catch {
      return false;
    }
    return false;
  };

  if (isDefault) {
    inFlightLockIndexVerification = performVerification().finally(() => {
      inFlightLockIndexVerification = null;
    });
    return await inFlightLockIndexVerification;
  } else {
    const promise = performVerification().finally(() => {
      if (typeof targetModel === "object" && targetModel !== null) {
        inFlightModelVerifications.delete(targetModel);
      }
    });
    if (typeof targetModel === "object" && targetModel !== null) {
      inFlightModelVerifications.set(targetModel, promise);
    }
    return await promise;
  }
}

/**
 * Verifies whether the TTL index on 'expiresAt' is active and enforced on the collection.
 */
export async function verifyFeeCreationLockTtlIndexIntegrity(model?: unknown): Promise<boolean> {
  const targetModel = (model || FeeCreationLock) as LockModelLike | undefined;
  if (!targetModel) return false;

  try {
    if (typeof targetModel.hasTtlIndex === "function") {
      return await targetModel.hasTtlIndex();
    }
    const collection = targetModel.collection;
    if (collection) {
      const inspectTtl = async () => {
        let indexes: unknown[] = [];
        if (typeof collection.indexes === "function") {
          indexes = await collection.indexes();
        } else if (typeof collection.listIndexes === "function") {
          const cursor = collection.listIndexes();
          const cursorObj = cursor as { toArray?: () => Promise<unknown[]> } | null;
          indexes =
            cursorObj && typeof cursorObj.toArray === "function"
              ? await cursorObj.toArray()
              : await (cursor as Promise<unknown[]>);
        }

        if (Array.isArray(indexes)) {
          return indexes.some((idx: unknown) => {
            const record = idx as { key?: Record<string, unknown>; expireAfterSeconds?: number; expires?: unknown };
            if (!record || !record.key || typeof record.key !== "object") return false;
            return (
              record.key.expiresAt === 1 &&
              (typeof record.expireAfterSeconds === "number" || typeof record.expires !== "undefined")
            );
          });
        }
        return false;
      };

      const hasTtl = await inspectTtl();
      if (hasTtl) return true;

      // When autoIndex is false in production, attempt to build/sync schema indexes on the fly
      await syncFeeCreationLockIndexes(targetModel);
      const verifiedAfterInit = await inspectTtl();
      if (verifiedAfterInit) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export default FeeCreationLock;

