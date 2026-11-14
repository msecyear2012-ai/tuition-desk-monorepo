import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import StudentBatchRequest from "../../../models/StudentBatchRequest.ts";
import Student from "../../../models/Student.ts";
import Batch from "../../../models/Batch.ts";
import Teacher from "../../../models/Teacher.ts";
import Center from "../../../models/Center.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";
import { notifyBatchRequestEvents } from "../../../lib/notificationService.ts";
import { sanitizePopulatedStudentDoc } from "../../../lib/privacyUtils.ts";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
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
    const centerId = user.centerId;
    const filter: Record<string, unknown> = { centerId };

    // Role-based scoping: Teachers can only view requests they submitted
    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      filter.requesterId = new mongoose.Types.ObjectId(user.teacherId);
    }

    // Optional status filter (e.g. ?status=pending)
    const statusParam = searchParams.get("status");
    if (statusParam && ["pending", "approved", "rejected"].includes(statusParam)) {
      filter.status = statusParam;
    }

    // Optional student filter
    const studentIdParam = searchParams.get("studentId");
    if (studentIdParam && mongoose.Types.ObjectId.isValid(studentIdParam)) {
      filter.studentId = new mongoose.Types.ObjectId(studentIdParam);
    }

    const requests = await StudentBatchRequest.find(filter)
      .populate("studentId")
      .sort({ createdAt: -1 });

    // Sanitize populated student contact details per REQ-02
    const sanitizedRequests = requests.map((reqDoc) => {
      const doc = reqDoc.toObject ? reqDoc.toObject() : { ...reqDoc };
      return sanitizePopulatedStudentDoc(doc, "studentId", user.role);
    });

    return NextResponse.json(
      {
        success: true,
        count: sanitizedRequests.length,
        data: sanitizedRequests,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch batch requests";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
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

    const body = await request.json().catch(() => ({}));
    const { studentId, batchName, requestNotes } = body;
    const centerId = user.centerId;

    if (!studentId || !mongoose.Types.ObjectId.isValid(String(studentId))) {
      return NextResponse.json(
        { success: false, error: "Valid studentId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!batchName || !String(batchName).trim()) {
      return NextResponse.json(
        { success: false, error: "Target batchName is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const trimmedBatchName = String(batchName).trim();
    const studentObjectId = new mongoose.Types.ObjectId(String(studentId));

    // 1. Locate student strictly within user's authenticated center
    const student = await Student.findOne({
      _id: studentObjectId,
      centerId,
    });

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student not found in this tuition center" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Validate teacher student assignment scoping
    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);
      if (
        student.assignedTeacherId &&
        !student.assignedTeacherId.equals(teacherObjectId)
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Access denied: You can only submit batch assignment requests for your assigned students.",
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 3. Validate target batch exists and is active within this center
    const targetBatch = await Batch.findOne({
      centerId,
      name: trimmedBatchName,
      isActive: { $ne: false },
    });

    if (!targetBatch) {
      return NextResponse.json(
        {
          success: false,
          error: "Target batch not found or inactive in this tuition center",
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. Prevent redundant assignment if student is already in target batch
    if (
      student.batch &&
      student.batch.toLowerCase().trim() === trimmedBatchName.toLowerCase()
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `Student is already assigned to batch '${student.batch}'`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 5. Prevent duplicate active/pending requests for the same student
    const existingPending = await StudentBatchRequest.findOne({
      centerId,
      studentId: studentObjectId,
      status: "pending",
    });

    if (existingPending) {
      return NextResponse.json(
        {
          success: false,
          error: `A pending batch assignment request already exists for this student (Target: '${existingPending.batchName}')`,
          existingRequestId: existingPending._id,
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 6. Resolve requester attribution
    let requesterId: mongoose.Types.ObjectId;
    let requesterName = "Teacher";

    if (user.role === "teacher") {
      requesterId = new mongoose.Types.ObjectId(user.teacherId!);
      const teacherDoc = await Teacher.findOne({
        _id: requesterId,
        centerId,
      }).select("name");
      requesterName = teacherDoc?.name || "Teacher";
    } else {
      requesterId = new mongoose.Types.ObjectId(user.userId);
      const centerDoc = await Center.findOne({ centerId }).select("ownerName name");
      requesterName = centerDoc?.ownerName || centerDoc?.name || "Institute Owner";
    }

    // 7. Create immutable request record
    const newRequest = await StudentBatchRequest.create({
      centerId,
      studentId: studentObjectId,
      batchName: targetBatch.name,
      batchId: targetBatch._id,
      requesterId,
      requesterRole: user.role,
      requesterName,
      status: "pending",
      currentBatch: student.batch,
      requestNotes: requestNotes ? String(requestNotes).trim() : "",
    });

    // 8. Event Notification Dispatch
    try {
      await notifyBatchRequestEvents({
        centerId,
        requestId: String(newRequest._id),
        studentId: String(student._id),
        studentName: student.name || "Student",
        batchName: targetBatch.name,
        currentBatch: student.batch,
        requesterId: String(requesterId),
        requesterName,
        action: "submitted",
      });
    } catch (notifErr) {
      console.warn("[BATCH REQUEST] Notification dispatch error:", notifErr);
    }

    return NextResponse.json(
      {
        success: true,
        message: "Batch assignment request submitted successfully",
        data: newRequest,
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    // Handle duplicate key error in case of concurrent submissions
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: number }).code === 11000
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "A pending batch assignment request already exists for this student",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    const errorMessage =
      error instanceof Error ? error.message : "Failed to create batch request";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
