import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUserPushSubscriptionDocument extends Document {
  centerId: string;
  userId: string;
  userRole: "owner" | "teacher" | "parent";
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  subscribedAt: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserPushSubscriptionSchema = new Schema<IUserPushSubscriptionDocument>(
  {
    centerId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    userRole: {
      type: String,
      required: true,
      enum: ["owner", "teacher", "parent"],
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    keys: {
      p256dh: {
        type: String,
        required: true,
        trim: true,
      },
      auth: {
        type: String,
        required: true,
        trim: true,
      },
    },
    userAgent: {
      type: String,
      trim: true,
    },
    subscribedAt: {
      type: Date,
      default: Date.now,
    },
    lastUsedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

UserPushSubscriptionSchema.index({ centerId: 1, userId: 1 });
UserPushSubscriptionSchema.index({ centerId: 1, userRole: 1 });

const UserPushSubscription: Model<IUserPushSubscriptionDocument> =
  mongoose.models.UserPushSubscription ||
  mongoose.model<IUserPushSubscriptionDocument>(
    "UserPushSubscription",
    UserPushSubscriptionSchema
  );

export default UserPushSubscription;
