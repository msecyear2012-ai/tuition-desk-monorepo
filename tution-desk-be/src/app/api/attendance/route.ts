import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import Attendance from "../../../models/Attendance.ts";
import Center from "../../../models/Center.ts";
import MessageCampaign from "../../../models/MessageCampaign.ts";
import { sendPushToStudentParents } from "../../../lib/pushService.ts";
import Student from "../../../models/Student.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";
import { getISTDayRange } from "../../../lib/dateUtils.ts";
import { sanitizePopulatedStudentDoc } from "../../../lib/privacyUtils.ts";
import { notifyAttendanceEvents } from "../../../lib/notificationService.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate caller strictly from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access attendance" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner" && user.role !== "teacher") {
      return NextResponse.json(
        { success: false, error: "Access denied: Unauthorized role" },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const { searchParams } = request.nextUrl;

    // 2. Strict Center Isolation derived exclusively from JWT claims
    const filter: Record<string, unknown> = { centerId: user.centerId };

    // 3. Teacher Scoping vs Owner Institute-wide Visibility
    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      // Teachers are strictly restricted to students assigned to their teacherId.
      // Batch filtering alone is never sufficient!
      const teacherStudents = await Student.find({
        centerId: user.centerId,
        assignedTeacherId: new mongoose.Types.ObjectId(user.teacherId),
      }).select("_id");

      const teacherStudentIds = teacherStudents.map((s) => s._id);

      const requestedStudentId = searchParams.get("studentId");
      if (requestedStudentId) {
        if (!mongoose.Types.ObjectId.isValid(requestedStudentId)) {
          return NextResponse.json(
            { success: false, error: "Invalid studentId parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
        const isAssigned = teacherStudentIds.some(
          (id) => String(id) === requestedStudentId
        );
        if (!isAssigned) {
          // Student is not assigned to this teacher - return empty array
          return NextResponse.json(
            { success: true, count: 0, data: [] },
            { status: 200, headers: corsHeaders }
          );
        }
        filter.studentId = new mongoose.Types.ObjectId(requestedStudentId);
      } else {
        filter.studentId = { $in: teacherStudentIds };
      }
    } else {
      // Owner retains institute-wide visibility and can filter by Owner or a specific Teacher
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          const ownerStudents = await Student.find({
            centerId: user.centerId,
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
            ],
          }).select("_id");
          filter.studentId = { $in: ownerStudents.map((s) => s._id) };
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          const teacherStudents = await Student.find({
            centerId: user.centerId,
            assignedTeacherId: new mongoose.Types.ObjectId(assignedTeacherParam),
          }).select("_id");
          filter.studentId = { $in: teacherStudents.map((s) => s._id) };
        } else {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacher query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
      }

      const requestedStudentId = searchParams.get("studentId");
      if (requestedStudentId) {
        if (!mongoose.Types.ObjectId.isValid(requestedStudentId)) {
          return NextResponse.json(
            { success: false, error: "Invalid studentId parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
        if (
          filter.studentId &&
          typeof filter.studentId === "object" &&
          "$in" in filter.studentId
        ) {
          const allowedList = (filter.studentId as { $in: unknown[] }).$in;
          const isAllowed = allowedList.some((id) => String(id) === requestedStudentId);
          if (!isAllowed) {
            return NextResponse.json(
              { success: true, count: 0, data: [] },
              { status: 200, headers: corsHeaders }
            );
          }
        }
        filter.studentId = new mongoose.Types.ObjectId(requestedStudentId);
      }
    }

    // Optional batch filter
    const batch = searchParams.get("batch");
    if (batch && batch.trim()) {
      filter.batch = batch.trim();
    }

    // Optional date filter (aligned with Asia/Kolkata IST day range)
    const date = searchParams.get("date");
    if (date) {
      const parsedDate = new Date(date);
      if (!isNaN(parsedDate.getTime())) {
        const { startOfDay, endOfDay } = getISTDayRange(date.trim());
        filter.date = { $gte: startOfDay, $lte: endOfDay };
      }
    }

    const attendanceRecords = await Attendance.find(filter)
      .populate("studentId")
      .sort({ date: -1, createdAt: -1 });

    const sanitizedRecords = attendanceRecords.map((doc) =>
      sanitizePopulatedStudentDoc(
        doc.toObject ? doc.toObject() : { ...doc },
        "studentId",
        user.role
      )
    );

    return NextResponse.json(
      { success: true, count: sanitizedRecords.length, data: sanitizedRecords },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch attendance records";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
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

    // Ingest either single record or bulk records
    let items: Array<Record<string, unknown>>;
    let isBulk = false;

    if (Array.isArray(body)) {
      items = body;
      isBulk = true;
    } else if (Array.isArray(body.records)) {
      items = body.records;
      isBulk = true;
    } else {
      items = [body];
      isBulk = false;
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

    // Prevent bulk or single requests from bypassing individual student authorization
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
    const scope = body.notificationScope || "absent"; // default to notifying absentees

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

    // Event Notification Dispatch (Teacher confirmation & Parent absent alerts)
    try {
      const presentCount = items.filter(
        (i) => String(i.status).toLowerCase() === "present"
      ).length;
      const absentItems = items.filter(
        (i) => String(i.status).toLowerCase() === "absent"
      );
      const absentStudents = absentItems.map((ai) => {
        const stud = validStudents.find(
          (vs) => String(vs._id) === String(ai.studentId)
        );
        return {
          studentId: String(ai.studentId),
          studentName: stud?.name || "Student",
        };
      });

      await notifyAttendanceEvents({
        centerId: user.centerId,
        batch: String(items[0]?.batch || "General"),
        date: savedRecords[0]?.date || new Date(),
        recorderId:
          user.role === "teacher"
            ? String(user.teacherId)
            : String(user.userId),
        recorderRole: user.role,
        presentCount,
        absentCount: absentItems.length,
        absentStudents,
      });
    } catch (notifErr) {
      console.warn("[ATTENDANCE] In-app notification error:", notifErr);
    }

    if (!isBulk) {
      return NextResponse.json(
        {
          success: true,
          data: savedRecords[0],
          notifications: notificationSummary,
        },
        { status: 201, headers: corsHeaders }
      );
    } else {
      return NextResponse.json(
        {
          success: true,
          count: savedRecords.length,
          data: savedRecords,
          notifications: notificationSummary,
        },
        { status: 201, headers: corsHeaders }
      );
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create attendance record";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
