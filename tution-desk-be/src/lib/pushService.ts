import webpush from "web-push";
import type { Types } from "mongoose";
import ParentAccess from "../models/ParentAccess.ts";
import UserPushSubscription from "../models/UserPushSubscription.ts";
import type {
  IParentAccessDocument,
  IParentPushSubscription,
} from "../models/ParentAccess.ts";

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
  tag?: string;
  data?: Record<string, any>;
  renotify?: boolean;
}

export interface PushDispatchResult {
  attempted: number;
  sent: number;
  failed: number;
  pruned: number;
  simulated: boolean;
  errors?: string[];
}

let vapidConfigured = false;

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@tuitiondesk.com";

  if (!publicKey || !privateKey) {
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
    return true;
  } catch (err: any) {
    console.error("[PUSH SERVICE] Error setting VAPID details:", err.message);
    return false;
  }
}

/**
 * Dispatches a Web Push notification to all active browser/PWA subscriptions of a parent.
 * Automatically prunes expired/invalidated subscriptions (HTTP 404 or 410) from the database.
 */
export async function sendPushToParent(
  parentAccessOrId: IParentAccessDocument | string,
  payload: PushNotificationPayload
): Promise<PushDispatchResult> {
  let parentDoc: IParentAccessDocument | null = null;

  if (typeof parentAccessOrId === "string") {
    parentDoc = await ParentAccess.findById(parentAccessOrId);
  } else {
    parentDoc = parentAccessOrId;
  }

  if (!parentDoc || parentDoc.status !== "active") {
    return { attempted: 0, sent: 0, failed: 0, pruned: 0, simulated: false };
  }

  const subscriptions: IParentPushSubscription[] = parentDoc.pushSubscriptions || [];
  if (subscriptions.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, pruned: 0, simulated: false };
  }

  const isVapidReady = ensureVapidConfigured();

  const formattedPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || "/icons/icon-192x192.png",
    badge: payload.badge || "/icons/icon-192x192.png",
    url: payload.url || "/portal",
    tag: payload.tag || "tuitiondesk-alert",
    renotify: payload.renotify ?? true,
    data: {
      url: payload.url || "/portal",
      ...payload.data,
    },
  });

  // If web-push is missing or VAPID keys not configured, run safely in simulation mode
  if (!isVapidReady) {
    console.log(
      `[PUSH SIMULATION] Parent: ${parentDoc.parentPhone} | Subscriptions: ${subscriptions.length} | Title: "${payload.title}"`
    );
    return {
      attempted: subscriptions.length,
      sent: subscriptions.length,
      failed: 0,
      pruned: 0,
      simulated: true,
    };
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  const expiredEndpoints: string[] = [];
  const errors: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys.p256dh,
              auth: sub.keys.auth,
            },
          },
          formattedPayload
        );
        sent++;
        sub.lastUsedAt = new Date();
      } catch (err: any) {
        failed++;
        const statusCode = err.statusCode || err.status;
        errors.push(`Endpoint error (${statusCode || "unknown"}): ${err.message}`);

        // HTTP 404 (Not Found) or 410 (Gone) indicates unsubscribed or expired subscription
        if (statusCode === 404 || statusCode === 410) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  // Prune expired or invalidated endpoints from DB
  if (expiredEndpoints.length > 0) {
    parentDoc.pushSubscriptions = (parentDoc.pushSubscriptions || []).filter(
      (s) => !expiredEndpoints.includes(s.endpoint)
    );
    pruned = expiredEndpoints.length;
    await parentDoc.save().catch((saveErr) => {
      console.warn("[PUSH SERVICE] Failed to prune expired subscriptions:", saveErr.message);
    });
  } else if (sent > 0) {
    // Save updated lastUsedAt timestamps
    await parentDoc.save().catch(() => {});
  }

  return {
    attempted: subscriptions.length,
    sent,
    failed,
    pruned,
    simulated: false,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Dispatches Web Push notifications to all verified parents linked to a given student.
 */
export async function sendPushToStudentParents(
  centerId: string,
  studentId: string | Types.ObjectId,
  payload: PushNotificationPayload
): Promise<PushDispatchResult> {
  const parents = await ParentAccess.find({
    centerId,
    linkedStudentIds: studentId,
    status: "active",
  });

  if (!parents || parents.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, pruned: 0, simulated: false };
  }

  let totalAttempted = 0;
  let totalSent = 0;
  let totalFailed = 0;
  let totalPruned = 0;
  let isSimulated = false;

  for (const parent of parents) {
    const res = await sendPushToParent(parent, payload);
    totalAttempted += res.attempted;
    totalSent += res.sent;
    totalFailed += res.failed;
    totalPruned += res.pruned;
    if (res.simulated) isSimulated = true;
  }

  return {
    attempted: totalAttempted,
    sent: totalSent,
    failed: totalFailed,
    pruned: totalPruned,
    simulated: isSimulated,
  };
}

/**
 * Sanitizes push notification payload for lockscreen display.
 * Strips phone numbers, currency amounts, and private PII to prevent lockscreen leaks.
 */
export function sanitizeLockscreenPayload(
  payload: PushNotificationPayload,
  isSensitive: boolean = false
): PushNotificationPayload {
  if (!isSensitive && !payload.body) {
    return payload;
  }

  // Scrub phone numbers (10+ digits) and explicit rupee amounts
  const scrubbedBody = (payload.body || "")
    .replace(/\b[6-9]\d{9}\b/g, "[Redacted]")
    .replace(/₹\s*[\d,]+(\.\d+)?/g, "an amount")
    .replace(/Rs\.?\s*[\d,]+(\.\d+)?/gi, "an amount");

  return {
    ...payload,
    body: scrubbedBody,
  };
}

/**
 * Dispatches Web Push notification to registered device subscriptions of a user.
 * Automatically prunes expired endpoints (HTTP 404 or 410).
 */
export async function sendPushToUser(
  centerId: string,
  userId: string,
  payload: PushNotificationPayload,
  userRole?: "owner" | "teacher" | "parent"
): Promise<PushDispatchResult> {
  const query: Record<string, unknown> = {
    centerId: String(centerId).trim(),
    userId: String(userId).trim(),
  };
  if (userRole) {
    query.userRole = userRole;
  }

  const subscriptions = await UserPushSubscription.find(query);
  if (!subscriptions || subscriptions.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, pruned: 0, simulated: false };
  }

  const isVapidReady = ensureVapidConfigured();
  const safePayload = sanitizeLockscreenPayload(payload);

  const formattedPayload = JSON.stringify({
    title: safePayload.title,
    body: safePayload.body,
    icon: safePayload.icon || "/icons/icon-192x192.png",
    badge: safePayload.badge || "/icons/icon-192x192.png",
    url: safePayload.url || "/notifications",
    tag: safePayload.tag || "tuitiondesk-alert",
    renotify: safePayload.renotify ?? true,
    data: {
      url: safePayload.url || "/notifications",
      ...safePayload.data,
    },
  });

  if (!isVapidReady) {
    console.log(
      `[PUSH SIMULATION] User: ${userId} (${userRole || "any"}) | Subscriptions: ${subscriptions.length} | Title: "${safePayload.title}"`
    );
    return {
      attempted: subscriptions.length,
      sent: subscriptions.length,
      failed: 0,
      pruned: 0,
      simulated: true,
    };
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  const expiredEndpoints: string[] = [];
  const errors: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys.p256dh,
              auth: sub.keys.auth,
            },
          },
          formattedPayload
        );
        sent++;
        sub.lastUsedAt = new Date();
        await sub.save().catch(() => {});
      } catch (err: any) {
        failed++;
        const statusCode = err.statusCode || err.status;
        errors.push(`Endpoint error (${statusCode || "unknown"}): ${err.message}`);

        if (statusCode === 404 || statusCode === 410) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  if (expiredEndpoints.length > 0) {
    await UserPushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } }).catch(
      (err) => {
        console.warn("[PUSH SERVICE] Failed to prune expired UserPushSubscriptions:", err.message);
      }
    );
    pruned = expiredEndpoints.length;
  }

  return {
    attempted: subscriptions.length,
    sent,
    failed,
    pruned,
    simulated: false,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Dispatches Web Push notification to all active device subscriptions of staff (owners/teachers).
 */
export async function sendPushToStaff(
  centerId: string,
  role: "owner" | "teacher" | "all",
  payload: PushNotificationPayload
): Promise<PushDispatchResult> {
  const query: Record<string, unknown> = {
    centerId: String(centerId).trim(),
  };
  if (role !== "all") {
    query.userRole = role;
  } else {
    query.userRole = { $in: ["owner", "teacher"] };
  }

  const subscriptions = await UserPushSubscription.find(query);
  if (!subscriptions || subscriptions.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, pruned: 0, simulated: false };
  }

  const isVapidReady = ensureVapidConfigured();
  const safePayload = sanitizeLockscreenPayload(payload);

  const formattedPayload = JSON.stringify({
    title: safePayload.title,
    body: safePayload.body,
    icon: safePayload.icon || "/icons/icon-192x192.png",
    badge: safePayload.badge || "/icons/icon-192x192.png",
    url: safePayload.url || "/notifications",
    tag: safePayload.tag || "tuitiondesk-alert",
    renotify: safePayload.renotify ?? true,
    data: {
      url: safePayload.url || "/notifications",
      ...safePayload.data,
    },
  });

  if (!isVapidReady) {
    console.log(
      `[PUSH SIMULATION] Staff (${role}) | Subscriptions: ${subscriptions.length} | Title: "${safePayload.title}"`
    );
    return {
      attempted: subscriptions.length,
      sent: subscriptions.length,
      failed: 0,
      pruned: 0,
      simulated: true,
    };
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  const expiredEndpoints: string[] = [];
  const errors: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys.p256dh,
              auth: sub.keys.auth,
            },
          },
          formattedPayload
        );
        sent++;
        sub.lastUsedAt = new Date();
        await sub.save().catch(() => {});
      } catch (err: any) {
        failed++;
        const statusCode = err.statusCode || err.status;
        errors.push(`Endpoint error (${statusCode || "unknown"}): ${err.message}`);

        if (statusCode === 404 || statusCode === 410) {
          expiredEndpoints.push(sub.endpoint);
        }
      }
    })
  );

  if (expiredEndpoints.length > 0) {
    await UserPushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } }).catch(
      (err) => {
        console.warn("[PUSH SERVICE] Failed to prune expired UserPushSubscriptions:", err.message);
      }
    );
    pruned = expiredEndpoints.length;
  }

  return {
    attempted: subscriptions.length,
    sent,
    failed,
    pruned,
    simulated: false,
    errors: errors.length > 0 ? errors : undefined,
  };
}
