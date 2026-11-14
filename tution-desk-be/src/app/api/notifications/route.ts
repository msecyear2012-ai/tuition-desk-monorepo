import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import Fee from "../../../models/Fee.ts";
import Attendance from "../../../models/Attendance.ts";
import StaffNotification from "../../../models/StaffNotification.ts";
import { getAuthenticatedUser, getAuthenticatedCenterId } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";
import { CANONICAL_CATEGORY_TYPES } from "../../../lib/notificationService.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, PATCH, OPTIONS");
}

interface SmartAlert {
  id: string;
  type: "warning" | "error" | "info" | "success";
  title: string;
  message: string;
  link?: string;
  time: string;
  isRead?: boolean;
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    await connectDB();

    const authUser = await getAuthenticatedUser(request);
    const authCenterId = authUser?.centerId || (await getAuthenticatedCenterId(request));
    const centerId =
      authCenterId ||
      request.headers.get("x-center-id") ||
      request.nextUrl.searchParams.get("centerId");

    if (!centerId) {
      return NextResponse.json(
        { success: false, error: "Authentication or centerId is required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const cleanCenterId = String(centerId).trim();
    const alerts: SmartAlert[] = [];
    const isOwner = authUser?.role === "owner";

    // Check if dynamic smart alerts were dismissed by this recipient for today
    const todayStr = new Date().toISOString().slice(0, 10);
    const dismissalRecipientId = String(
      authUser?.teacherId || authUser?.userId || cleanCenterId
    );
    const dismissalKey = `dismiss_alerts_${cleanCenterId}_${dismissalRecipientId}_${todayStr}`;
    let areSmartAlertsDismissed = false;

    if (
      mongoose.connection?.readyState === 1 ||
      StaffNotification.findOne !== mongoose.Model.findOne
    ) {
      try {
        const dismissedDoc = await StaffNotification.findOne({
          centerId: cleanCenterId,
          idempotencyKey: dismissalKey,
        });
        areSmartAlertsDismissed = Boolean(dismissedDoc);
      } catch {
        areSmartAlertsDismissed = false;
      }
    }

    let overdueCount = 0;
    let isWhatsappConnected: boolean | null = null;

    // Strict Role Scoping: Administrative Smart Alerts (WhatsApp, Overdue Fees, Attendance Checklists)
    // are strictly Owner-Only. Teachers must NEVER receive WhatsApp QR or integration alerts.
    if (isOwner && !areSmartAlertsDismissed) {
      // 1. Alert for Overdue Fees (Owner Only)
      if (
        mongoose.connection?.readyState === 1 ||
        Fee.countDocuments !== mongoose.Model.countDocuments
      ) {
        try {
          overdueCount = await Fee.countDocuments({
            centerId: cleanCenterId,
            status: "Pending",
          });
        } catch {
          overdueCount = 0;
        }
      }

      if (overdueCount > 0) {
        alerts.push({
          id: "alert-overdue-fees",
          type: "warning",
          title: "Overdue Fees Pending",
          message: `You have ${overdueCount} overdue fee${
            overdueCount > 1 ? "s" : ""
          } pending collection.`,
          link: "/fees?tab=payments&sub=pending",
          time: "Action Required",
        });
      }

      // 2. Alert for WhatsApp Microservice Status (Strictly Owner-Only)
      try {
        const whatsappServiceUrl = (
          process.env.WHATSAPP_SERVICE_URL || "http://localhost:3005"
        ).replace(/\/+$/, "");
        const internalSecret = process.env.WHATSAPP_INTERNAL_SECRET;
        const headers: Record<string, string> = {};
        if (internalSecret && internalSecret.trim()) {
          headers["x-internal-secret"] = internalSecret.trim();
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        const waRes = await fetch(
          `${whatsappServiceUrl}/status/${encodeURIComponent(cleanCenterId)}`,
          {
            headers,
            signal: controller.signal,
          }
        );
        clearTimeout(timeoutId);

        const waData = await waRes.json().catch(() => null);
        isWhatsappConnected = waData?.status === "connected";
      } catch {
        isWhatsappConnected = false;
      }

      if (isWhatsappConnected === false) {
        alerts.push({
          id: "alert-whatsapp-disconnected",
          type: "error",
          title: "WhatsApp Offline",
          message: "WhatsApp Engine is disconnected. Scan QR to reconnect.",
          link: "/settings",
          time: "Engine Alert",
        });
      } else if (isWhatsappConnected === true) {
        alerts.push({
          id: "alert-whatsapp-online",
          type: "success",
          title: "WhatsApp Active",
          message: "Engine is linked and actively sending automated messages.",
          link: "/settings",
          time: "Connected",
        });
      }

      // 3. Alert for Today's Attendance (Owner Daily Checklist)
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      let todayAttendanceCount = 1;
      if (
        mongoose.connection?.readyState === 1 ||
        Attendance.countDocuments !== mongoose.Model.countDocuments
      ) {
        try {
          todayAttendanceCount = await Attendance.countDocuments({
            centerId: cleanCenterId,
            date: { $gte: startOfDay, $lte: endOfDay },
          });
        } catch {
          todayAttendanceCount = 1;
        }
      }

      if (todayAttendanceCount === 0) {
        alerts.push({
          id: "alert-daily-attendance",
          type: "info",
          title: "Mark Daily Attendance",
          message: "Today's batch attendance has not been recorded yet.",
          link: "/attendance",
          time: "Today",
        });
      }
    }

    // 4. Query Persistent Staff Notifications (Scoped to Role & Recipient)
    let staffNotifications: unknown[] = [];
    let totalNotificationCount = 0;
    const categoryParam = request.nextUrl.searchParams.get("category")?.trim();
    const statusParam = request.nextUrl.searchParams.get("status")?.trim();
    const includeDismissed =
      request.nextUrl.searchParams.get("includeDismissed") === "true";
    const limitParam = Math.min(
      100,
      Math.max(1, parseInt(request.nextUrl.searchParams.get("limit") || "50", 10))
    );
    const skipParam = Math.max(
      0,
      parseInt(request.nextUrl.searchParams.get("skip") || "0", 10)
    );

    if (
      authUser &&
      (authUser.role === "owner" ||
        authUser.role === "teacher" ||
        authUser.role === "parent")
    ) {
      const recipientIds: string[] = [String(authUser.userId)];
      if (authUser.teacherId) {
        recipientIds.push(String(authUser.teacherId));
      }

      const recipientOr: Record<string, unknown>[] = [
        { recipientId: { $in: recipientIds } },
      ];

      if (authUser.role === "owner" || authUser.role === "teacher") {
        recipientOr.push(
          { recipientId: cleanCenterId },
          { recipientId: { $exists: false } },
          { recipientId: null }
        );
      }

      const notifQuery: Record<string, unknown> = {
        centerId: cleanCenterId,
        recipientRole: authUser.role,
        $or: recipientOr,
      };

      if (categoryParam && categoryParam !== "all") {
        const canonicalTypes =
          CANONICAL_CATEGORY_TYPES[categoryParam.toLowerCase()] || [];
        if (canonicalTypes.length > 0) {
          notifQuery.$and = [
            {
              $or: [
                { category: categoryParam.toLowerCase() },
                { type: { $in: canonicalTypes } },
              ],
            },
          ];
        } else {
          notifQuery.category = categoryParam.toLowerCase();
        }
      }

      if (!includeDismissed) {
        notifQuery.isDismissed = { $ne: true };
      }

      if (statusParam === "unread") {
        notifQuery.isRead = false;
      } else if (statusParam === "read") {
        notifQuery.isRead = true;
      }

      try {
        totalNotificationCount = await StaffNotification.countDocuments(notifQuery);
        const rawNotifs = await StaffNotification.find(notifQuery)
          .sort({ createdAt: -1 })
          .skip(skipParam)
          .limit(limitParam);

        staffNotifications = rawNotifs;

        // Convert staff notifications to smart alert format and add to alerts
        for (const notif of rawNotifs) {
          alerts.push({
            id: String(notif._id),
            type:
              notif.type === "dispute_raised" || notif.type === "handover_rejected"
                ? "warning"
                : "info",
            title: notif.title,
            message: notif.message,
            link: notif.deepLink || notif.link || "/fees?tab=payments&sub=paid",
            time: formatRelativeTime(notif.createdAt || new Date()),
            isRead: notif.isRead,
          });
        }
      } catch (e) {
        console.warn("[NOTIFICATIONS] Failed to load staff notifications:", e);
      }
    }

    // Accurate unread count across all persistent, active notifications for this recipient
    let persistentUnreadCount = 0;
    if (
      authUser &&
      (authUser.role === "owner" ||
        authUser.role === "teacher" ||
        authUser.role === "parent")
    ) {
      const recipientIds: string[] = [String(authUser.userId)];
      if (authUser.teacherId) {
        recipientIds.push(String(authUser.teacherId));
      }
      const recipientOr: Record<string, unknown>[] = [
        { recipientId: { $in: recipientIds } },
      ];
      if (authUser.role === "owner" || authUser.role === "teacher") {
        recipientOr.push(
          { recipientId: cleanCenterId },
          { recipientId: { $exists: false } },
          { recipientId: null }
        );
      }
      persistentUnreadCount = await StaffNotification.countDocuments({
        centerId: cleanCenterId,
        recipientRole: authUser.role,
        isRead: false,
        isDismissed: { $ne: true },
        $or: recipientOr,
      }).catch(() => 0);
    }

    const unreadCount =
      persistentUnreadCount +
      alerts.filter(
        (a) =>
          !a.id.startsWith("alert-") ? false : a.type === "warning" || a.type === "error"
      ).length;

    return NextResponse.json(
      {
        success: true,
        alerts,
        notifications: staffNotifications,
        staffNotifications,
        unreadCount,
        totalCount: totalNotificationCount,
        overdueCount,
        isWhatsappConnected,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to generate alerts";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    await connectDB();

    const authUser = await getAuthenticatedUser(request);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const cleanCenterId = String(authUser.centerId).trim();
    const body = await request.json().catch(() => ({}));
    const { notificationId, markAllRead, clearAll, dismissAll, dismiss } = body;

    const now = new Date();

    if (clearAll || dismissAll) {
      if (
        authUser.role === "owner" ||
        authUser.role === "teacher" ||
        authUser.role === "parent"
      ) {
        const recipientIds: string[] = [String(authUser.userId)];
        if (authUser.teacherId) {
          recipientIds.push(String(authUser.teacherId));
        }

        const dismissAllFilter: Record<string, unknown> = {
          centerId: cleanCenterId,
          recipientRole: authUser.role,
          isDismissed: { $ne: true },
        };

        if (authUser.role === "teacher") {
          dismissAllFilter.$or = [
            { recipientId: { $in: recipientIds } },
            { recipientId: cleanCenterId },
          ];
        } else if (authUser.role === "parent") {
          dismissAllFilter.recipientId = { $in: recipientIds };
        }

        await StaffNotification.updateMany(dismissAllFilter, {
          $set: {
            isRead: true,
            readAt: now,
            isDismissed: true,
            dismissedAt: now,
          },
        });

        // Suppress dynamic smart alerts for the rest of today for this recipient
        const todayStr = now.toISOString().slice(0, 10);
        const dismissalRecipientId = String(
          authUser.teacherId || authUser.userId || cleanCenterId
        );
        const dismissalKey = `dismiss_alerts_${cleanCenterId}_${dismissalRecipientId}_${todayStr}`;

        try {
          await StaffNotification.findOneAndUpdate(
            { centerId: cleanCenterId, idempotencyKey: dismissalKey },
            {
              $setOnInsert: {
                centerId: cleanCenterId,
                recipientId: dismissalRecipientId,
                recipientRole: authUser.role,
                title: "Smart Alerts Dismissed",
                message: "Daily smart alerts dismissed for today",
                category: "system",
                type: "announcement",
                priority: "low",
                isRead: true,
                readAt: now,
                isDismissed: true,
                dismissedAt: now,
                idempotencyKey: dismissalKey,
              },
            },
            { upsert: true }
          );
        } catch {
          // ignore duplicate key
        }
      }

      return NextResponse.json(
        { success: true, message: "All notifications and alerts cleared" },
        { status: 200, headers: corsHeaders }
      );
    }

    if (markAllRead) {
      if (
        authUser.role === "owner" ||
        authUser.role === "teacher" ||
        authUser.role === "parent"
      ) {
        const recipientIds: string[] = [String(authUser.userId)];
        if (authUser.teacherId) {
          recipientIds.push(String(authUser.teacherId));
        }

        const markAllFilter: Record<string, unknown> = {
          centerId: cleanCenterId,
          recipientRole: authUser.role,
          isRead: false,
        };

        if (authUser.role === "teacher") {
          markAllFilter.$or = [
            { recipientId: { $in: recipientIds } },
            { recipientId: cleanCenterId },
          ];
        } else if (authUser.role === "parent") {
          markAllFilter.recipientId = { $in: recipientIds };
        }

        if (body.category && body.category !== "all") {
          const canonicalTypes =
            CANONICAL_CATEGORY_TYPES[body.category.toLowerCase()] || [];
          if (canonicalTypes.length > 0) {
            markAllFilter.$or = [
              ...(Array.isArray(markAllFilter.$or) ? markAllFilter.$or : []),
              { category: body.category.toLowerCase() },
              { type: { $in: canonicalTypes } },
            ];
          } else {
            markAllFilter.category = body.category.toLowerCase();
          }
        }

        await StaffNotification.updateMany(markAllFilter, {
          $set: {
            isRead: true,
            readAt: now,
          },
        });
      }

      return NextResponse.json(
        { success: true, message: "All notifications marked as read" },
        { status: 200, headers: corsHeaders }
      );
    }

    if (notificationId) {
      if (typeof notificationId === "string" && notificationId.startsWith("alert-")) {
        // If an ephemeral alert is dismissed, register daily suppression
        const todayStr = now.toISOString().slice(0, 10);
        const dismissalRecipientId = String(
          authUser.teacherId || authUser.userId || cleanCenterId
        );
        const dismissalKey = `dismiss_alerts_${cleanCenterId}_${dismissalRecipientId}_${todayStr}`;
        try {
          await StaffNotification.findOneAndUpdate(
            { centerId: cleanCenterId, idempotencyKey: dismissalKey },
            {
              $setOnInsert: {
                centerId: cleanCenterId,
                recipientId: dismissalRecipientId,
                recipientRole: authUser.role,
                title: "Smart Alerts Dismissed",
                message: "Daily smart alerts dismissed for today",
                category: "system",
                type: "announcement",
                priority: "low",
                isRead: true,
                readAt: now,
                isDismissed: true,
                dismissedAt: now,
                idempotencyKey: dismissalKey,
              },
            },
            { upsert: true }
          );
        } catch {
          // ignore
        }

        return NextResponse.json(
          { success: true, message: "Alert dismissed" },
          { status: 200, headers: corsHeaders }
        );
      }

      const recipientIds: string[] = [String(authUser.userId)];
      if (authUser.teacherId) {
        recipientIds.push(String(authUser.teacherId));
      }

      const singleFilter: Record<string, unknown> = {
        _id: notificationId,
        centerId: cleanCenterId,
      };

      if (authUser.role === "teacher") {
        singleFilter.$or = [
          { recipientId: { $in: recipientIds } },
          { recipientId: cleanCenterId },
        ];
      } else if (authUser.role === "parent") {
        singleFilter.recipientId = { $in: recipientIds };
      }

      const updateFields: Record<string, unknown> = {
        isRead: true,
        readAt: now,
      };

      if (dismiss === true) {
        updateFields.isDismissed = true;
        updateFields.dismissedAt = now;
      }

      const updated = await StaffNotification.findOneAndUpdate(
        singleFilter,
        { $set: updateFields },
        { new: true }
      );

      if (!updated) {
        return NextResponse.json(
          { success: false, error: "Notification not found" },
          { status: 404, headers: corsHeaders }
        );
      }

      return NextResponse.json(
        {
          success: true,
          message: dismiss ? "Notification dismissed" : "Notification marked as read",
          data: updated,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: false, error: "notificationId, markAllRead, or clearAll is required" },
      { status: 400, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to update notification";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
