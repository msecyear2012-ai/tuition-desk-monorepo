import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IParentPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  subscribedAt: Date;
  lastUsedAt?: Date | null;
}

export interface IParentAccess {
  centerId: string;
  parentPhone: string;
  parentName?: string;
  linkedStudentIds: Types.ObjectId[];
  tokenHash: string; // SHA-256 hash of high-entropy token (NEVER store raw tokens)
  tokenPrefix: string; // First 8 characters of raw token for owner reference/audit (e.g. "pt_a8f9b2")
  /**
   * AES-256-GCM encrypted copy of the current raw portal token.
   *
   * Required so the SAME working invitation link can be rebuilt and re-sent
   * (fee reminders, receipts, owner "copy link") without calling
   * regenerateParentAccess(), which would invalidate the link the parent
   * already has. The key lives only in the environment (TOKEN_ENCRYPTION_SECRET);
   * plaintext tokens are never persisted.
   */
  invitationTokenCipher?: {
    iv: string;
    authTag: string;
    ciphertext: string;
  } | null;
  status: "active" | "revoked";
  isPasswordProtected: boolean;
  passwordHash?: string; // bcrypt hash for optional parent-chosen password
  failedPasswordAttempts: number;
  lockoutUntil?: Date | null;
  lastAccessedAt?: Date | null;
  revokedAt?: Date | null;
  revocationReason?: string;
  pushSubscriptions?: IParentPushSubscription[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IParentAccessDocument extends IParentAccess, Document {}

const ParentAccessSchema = new Schema<IParentAccessDocument>(
  {
    centerId: {
      type: String,
      required: [true, "Center ID is required"],
      ref: "Center",
      trim: true,
      index: true,
    },
    parentPhone: {
      type: String,
      required: [true, "Parent phone number is required"],
      trim: true,
      index: true,
    },
    parentName: {
      type: String,
      trim: true,
      default: "",
    },
    linkedStudentIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Student",
        required: true,
      },
    ],
    tokenHash: {
      type: String,
      required: [true, "Token hash is required"],
      unique: true,
      index: true,
    },
    tokenPrefix: {
      type: String,
      required: [true, "Token prefix is required"],
      trim: true,
    },
    invitationTokenCipher: {
      type: {
        iv: { type: String, required: true },
        authTag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
      index: true,
    },
    isPasswordProtected: {
      type: Boolean,
      default: false,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    failedPasswordAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockoutUntil: {
      type: Date,
      default: null,
    },
    lastAccessedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revocationReason: {
      type: String,
      trim: true,
      default: "",
    },
    pushSubscriptions: [
      {
        endpoint: {
          type: String,
          required: true,
          trim: true,
        },
        keys: {
          p256dh: { type: String, required: true, trim: true },
          auth: { type: String, required: true, trim: true },
        },
        userAgent: {
          type: String,
          default: "",
          trim: true,
        },
        subscribedAt: {
          type: Date,
          default: Date.now,
        },
        lastUsedAt: {
          type: Date,
          default: null,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Compound indexes for multi-tenant querying and fast authorization
ParentAccessSchema.index({ centerId: 1, parentPhone: 1 });
ParentAccessSchema.index({ centerId: 1, linkedStudentIds: 1 });
ParentAccessSchema.index({ centerId: 1, status: 1 });
ParentAccessSchema.index(
  { "pushSubscriptions.endpoint": 1 },
  { sparse: true }
);

// Ensure model re-compilation in Next.js development
if (mongoose.models.ParentAccess) {
  delete mongoose.models.ParentAccess;
}

export const ParentAccess: Model<IParentAccessDocument> =
  (mongoose.models.ParentAccess as Model<IParentAccessDocument>) ||
  mongoose.model<IParentAccessDocument>("ParentAccess", ParentAccessSchema);

export default ParentAccess;
