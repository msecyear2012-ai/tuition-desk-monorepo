import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Attendance from "@/models/Attendance";
import Center from "@/models/Center";
import MessageCampaign from "@/models/MessageCampaign";
import { sendPushToStudentParents } from "@/lib/pushService";
import Student from "@/models/Student";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { getISTDayRange } from "@/lib/dateUtils";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to record attendance" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    if (
      user.role === "teacher" &&
      (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId))
    ) {
      return NextResponse.json(
        { success: false, error: "Teacher profile invalid" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));

    // Ingest bulk records from either body array or body.records
    let items: Array<Record<string, unknown>>;
    if (Array.isArray(body)) {
      items = body;
    } else if (Array.isArray(body.records)) {
      items = body.records;
    } else {
      items = [body];
    }

    if (items.length === 0) {
      return NextResponse.json(
        { success: false, error: "Attendance records are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate item shapes
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.studentId || !mongoose.Types.ObjectId.isValid(String(item.studentId))) {
        return NextResponse.json(
          { success: false, error: `Invalid studentId at index ${i}` },
          { status: 400, headers: corsHeaders }
        );
      }
      if (!item.batch || !String(item.batch).trim()) {
        return NextResponse.json(
          { success: false, error: `Batch is required at index ${i}` },
          { status: 400, headers: corsHeaders }
        );
      }
      const statusLower = String(item.status || "").toLowerCase();
      if (statusLower !== "present" && statusLower !== "absent") {
        return NextResponse.json(
          { success: false, error: `Status must be Present or Absent at index ${i}` },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // 2. Strict Roster & Center Authorization Validation
    const studentIds = Array.from(new Set(items.map((i) => String(i.studentId))));

    const studentQuery: Record<string, unknown> = {
      _id: { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) },
      centerId: user.centerId,
    };

    if (user.role === "teacher") {
      studentQuery.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    }

    const validStudents = await Student.find(studentQuery).select(
      "_id centerId assignedTeacherId batch name parentWhatsApp"
    );
    const validStudentIdSet = new Set(validStudents.map((s) => String(s._id)));

    // Prevent bulk requests from bypassing individual student authorization
    const hasUnauthorizedStudent = studentIds.some(
      (sId) => !validStudentIdSet.has(sId)
    );

    if (hasUnauthorizedStudent) {
      return NextResponse.json(
        {
          success: false,
          error:
            user.role === "teacher"
              ? "Access denied: Cannot record attendance for students not assigned to your account"
              : "One or more student records do not exist in this institute",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const studentMap = new Map(validStudents.map((s) => [String(s._id), s]));

    // Process attendance records (update existing record for same student & day if present, else create)
    const savedRecords = [];
    for (const item of items) {
      const student = studentMap.get(String(item.studentId));
      const assignedTeacherId =
        user.role === "teacher"
          ? new mongoose.Types.ObjectId(user.teacherId)
          : (student?.assignedTeacherId || null);

      const normalizedStatus =
        String(item.status).toLowerCase() === "absent" ? "Absent" : "Present";
      const recordDate =
        item.date && !isNaN(new Date(String(item.date)).getTime())
          ? new Date(String(item.date))
          : new Date();

      const { startOfDay, endOfDay } = getISTDayRange(recordDate);

      let existing = await Attendance.findOne({
        centerId: user.centerId,
        studentId: new mongoose.Types.ObjectId(String(item.studentId)),
        date: { $gte: startOfDay, $lte: endOfDay },
      });

      if (existing) {
        existing.status = normalizedStatus;
        existing.batch = String(item.batch).trim();
        existing.assignedTeacherId = assignedTeacherId;
        await existing.save();
        savedRecords.push(existing);
      } else {
        const created = await Attendance.create({
          centerId: user.centerId,
          studentId: new mongoose.Types.ObjectId(String(item.studentId)),
          assignedTeacherId,
          batch: String(item.batch).trim(),
          date: recordDate,
          status: normalizedStatus,
        });
        savedRecords.push(created);
      }
    }

    // 3. Parent Notifications Integration
    const notificationSummary = {
      attempted: 0,
      sent: 0,
      simulated: 0,
      failed: 0,
      status: "none",
      message: "Parent notifications not requested",
    };

    const shouldNotify = Boolean(body.notifyParents);
    const scope = body.notificationScope || "absent";

    if (shouldNotify) {
      const studentsToNotify = items.filter((item) => {
        const status = String(item.status).toLowerCase();
        if (scope === "all") return true;
        return status === "absent";
      });

      if (studentsToNotify.length > 0) {
        const centerDoc = await Center.findOne({ centerId: user.centerId }).select("name");
        const centerName = centerDoc?.name || "Tuition Center";

        const dateFormatted = new Date().toLocaleDateString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        });

        const campaignMessages: Array<{
          phone: string;
          message: string;
          studentId: mongoose.Types.ObjectId;
          studentName: string;
          status: "sent";
          dispatchedAt: Date;
        }> = [];

        for (const item of studentsToNotify) {
          const studentDoc = studentMap.get(String(item.studentId));
          if (!studentDoc) continue;

          notificationSummary.attempted++;

          const statusText =
            String(item.status).toLowerCase() === "absent" ? "Absent" : "Present";
          const statusEmoji = statusText === "Absent" ? "⚠️" : "✅";
          const alertMessage = `${centerName}: Your child ${studentDoc.name} has been marked ${statusEmoji} ${statusText} for batch ${String(item.batch)} on ${dateFormatted}.`;

          campaignMessages.push({
            phone: studentDoc.parentWhatsApp || "",
            message: alertMessage,
            studentId: studentDoc._id as mongoose.Types.ObjectId,
            studentName: studentDoc.name,
            status: "sent",
            dispatchedAt: new Date(),
          });

          // Dispatch Browser / PWA Push Notification (Fail-safe: errors do not affect attendance save or inbox)
          try {
            await sendPushToStudentParents(user.centerId, studentDoc._id, {
              title: `${centerName} — Attendance Alert`,
              body: `${studentDoc.name} was marked ${statusText} for batch ${item.batch}. Tap to view portal.`,
              url: "/portal",
              tag: `attendance-${studentDoc._id}-${Date.now()}`,
              data: {
                type: "attendance_alert",
                studentId: String(studentDoc._id),
                batch: String(item.batch),
                status: statusText,
              },
            });
            notificationSummary.sent++;
          } catch (pushErr) {
            console.warn("[ATTENDANCE PUSH WARNING]", pushErr);
          }
        }

        // Persist notifications permanently in MessageCampaign for the Parent Portal Inbox
        if (campaignMessages.length > 0) {
          try {
            await MessageCampaign.create({
              centerId: user.centerId,
              title: `Daily Attendance — ${dateFormatted}`,
              campaignType: "attendance_alert",
              status: "completed",
              messages: campaignMessages,
              createdBy: user.userId,
              createdRole: user.role,
              approvedBy: user.userId,
              approvedAt: new Date(),
              completedAt: new Date(),
              stats: {
                total: campaignMessages.length,
                sent: campaignMessages.length,
                simulated: 0,
                failed: 0,
                pending: 0,
              },
            });
          } catch (inboxErr) {
            console.warn("[ATTENDANCE INBOX PERSISTENCE WARNING]", inboxErr);
          }
        }

        notificationSummary.status = "sent";
        notificationSummary.message = `Dispatched portal & push notifications for ${campaignMessages.length} student(s).`;
      }
    }

    return NextResponse.json(
      {
        success: true,
        count: savedRecords.length,
        data: savedRecords,
        notifications: notificationSummary,
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create bulk attendance records";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
