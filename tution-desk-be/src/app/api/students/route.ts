import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import Student from "../../../models/Student.ts";
import Batch from "../../../models/Batch.ts";
import Center from "../../../models/Center.ts";
import Teacher from "../../../models/Teacher.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";
import {
  enqueueAdmissionWelcomeJob,
  processPendingAdmissionWelcomeJobs,
  buildAdmissionWelcomeIdempotencyKey,
} from "../../../lib/admissionWelcomeQueue.ts";
import {
  getOrCreateParentAccess,
  getRecoverableInvitationToken,
} from "../../../lib/parentAccessService.ts";
import { encryptToken } from "../../../lib/tokenCipher.ts";
import {
  getAppBaseUrl,
  sendAdmissionWelcomeMessage,
} from "../../../lib/whatsappService.ts";
import {
  resolvePortalAppBaseUrl,
  buildPortalActivationUrl,
  isProductionEnvironment,
} from "../../../lib/portalLinks.ts";
import { AdmissionWelcomeJob } from "../../../models/AdmissionWelcomeJob.ts";
import {
  sanitizeStudentForRole,
  sanitizeStudentListForRole,
} from "../../../lib/privacyUtils.ts";
import { notifyStudentAdmissionEvents } from "../../../lib/notificationService.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
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

    // 2. Connect to database only after authentication and authorization
    await connectDB();

    const { searchParams } = request.nextUrl;
    const filter: Record<string, unknown> = { centerId: user.centerId };

    // 3. Role-based scoping for student roster
    if (user.role === "teacher") {
      // Teachers can ONLY view students assigned to their own teacherId
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      filter.assignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    } else {
      // Owner can view all students in institute, or filter by teacher
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          // Explicit Owner filter matches explicit null or missing field (legacy students)
          filter.$or = [
            { assignedTeacherId: null },
            { assignedTeacherId: { $exists: false } },
          ];
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          filter.assignedTeacherId = new mongoose.Types.ObjectId(assignedTeacherParam);
        } else {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacher query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
      }
    }

    // Optional batchId or batch filter
    const batchId = searchParams.get("batchId");
    if (batchId && batchId.trim()) {
      const cleanBatchId = batchId.trim();
      if (mongoose.Types.ObjectId.isValid(cleanBatchId)) {
        const batchQuery: Record<string, unknown> = {
          _id: new mongoose.Types.ObjectId(cleanBatchId),
          centerId: user.centerId,
          isActive: { $ne: false },
        };

        // If Teacher, ensure the batch is in the teacher's authorized scope
        if (user.role === "teacher") {
          const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);
          const [teacherStudents, teacherDoc] = await Promise.all([
            Student.find({
              centerId: user.centerId,
              assignedTeacherId: teacherObjectId,
              isActive: { $ne: false },
            }).select("batch"),
            Teacher.findOne({
              _id: teacherObjectId,
              centerId: user.centerId,
            }).select("assignedBatches"),
          ]);

          const allowedBatchNames = Array.from(
            new Set([
              ...(teacherDoc?.assignedBatches || []),
              ...teacherStudents.map((s) => s.batch).filter(Boolean),
            ])
          );

          batchQuery.name = { $in: allowedBatchNames };
        }

        const batchDoc = await Batch.findOne(batchQuery).select("name");

        if (batchDoc) {
          filter.batch = batchDoc.name;
        } else {
          // Batch does not exist, was deleted, or is unauthorized
          filter.batch = "__NON_EXISTENT_BATCH__";
        }
      } else if (cleanBatchId.startsWith("orphan_")) {
        filter.batch = decodeURIComponent(cleanBatchId.slice(7));
      } else {
        filter.batch = "__NON_EXISTENT_BATCH__";
      }
    } else {
      const batch = searchParams.get("batch");
      if (batch && batch.trim()) {
        filter.batch = batch.trim();
      }
    }

    // Optional active status filter
    const isActive = searchParams.get("isActive");
    if (isActive !== null) {
      filter.isActive = isActive === "true";
    }

    // Optional student search (Teacher: strictly name/rollNumber only; Owner: name/phone/rollNumber)
    const search =
      searchParams.get("search") ||
      searchParams.get("query") ||
      searchParams.get("q");
    if (search && search.trim()) {
      const sanitized = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(sanitized, "i");
      const searchOrConditions: Array<Record<string, unknown>> = [
        { name: { $regex: searchRegex } },
        { rollNumber: { $regex: searchRegex } },
      ];

      // Security defense: Teachers must never be able to probe full phone numbers via search regex
      if (user.role !== "teacher") {
        searchOrConditions.push({ parentWhatsApp: { $regex: searchRegex } });
      }

      const searchCondition = { $or: searchOrConditions };

      if (filter.$or) {
        const existingOr = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: existingOr }, searchCondition];
      } else if (filter.$and && Array.isArray(filter.$and)) {
        filter.$and.push(searchCondition);
      } else {
        filter.$or = searchCondition.$or;
      }
    }

    // Pagination parameters (P0 Optimization)
    const isAllRequested = searchParams.get("all") === "true";
    const pageParam = searchParams.get("page");
    const limitParam = searchParams.get("limit");

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 50))
      : 50;
    const skip = (page - 1) * limit;

    let studentQuery: any = Student.find(filter);
    if (studentQuery && typeof studentQuery.select === "function") {
      studentQuery = studentQuery.select(
        "_id centerId name rollNumber batch phone parentWhatsApp parentPhone parentName monthlyFee billingCycleDate assignedTeacherId isActive createdAt updatedAt"
      );
    }
    if (studentQuery && typeof studentQuery.sort === "function") {
      studentQuery = studentQuery.sort({ createdAt: -1 });
    }
    if (!isAllRequested && studentQuery && typeof studentQuery.skip === "function") {
      studentQuery = studentQuery.skip(skip).limit(limit);
    }

    let totalCount = 0;
    try {
      if (typeof Student.countDocuments === "function") {
        totalCount = await Student.countDocuments(filter);
      }
    } catch {
      totalCount = 0;
    }

    const students = await studentQuery;
    const total = totalCount > 0 ? totalCount : students.length;
    const totalPages = isAllRequested ? 1 : Math.max(1, Math.ceil(total / limit));

    // REQ-02: Sanitize student phone numbers for teacher roles
    const sanitizedStudents = sanitizeStudentListForRole(
      students.map((s: any) => (s && typeof s.toObject === "function" ? s.toObject() : { ...s })),
      user.role
    );

    return NextResponse.json(
      {
        success: true,
        count: sanitizedStudents.length,
        data: sanitizedStudents,
        pagination: {
          page: isAllRequested ? 1 : page,
          limit: isAllRequested ? sanitizedStudents.length : limit,
          total,
          totalPages,
          hasNextPage: isAllRequested ? false : page * limit < total,
          hasPreviousPage: isAllRequested ? false : page > 1,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch students";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
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

    // 2. Connect to database only after authentication and authorization
    await connectDB();

    const body = await request.json().catch(() => ({}));
    const {
      name,
      batch,
      parentWhatsApp,
      isActive,
      joiningDate,
      monthlyFee,
      billingCycleDate,
      assignedTeacherId: requestedTeacherId,
    } = body;

    // Validate required fields
    if (!name || !String(name).trim() || !batch || !String(batch).trim() || !parentWhatsApp) {
      return NextResponse.json(
        {
          success: false,
          error: "name, batch, and parentWhatsApp are required",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const cleanParentWhatsApp = String(parentWhatsApp).replace(/\D/g, "");
    if (cleanParentWhatsApp.length < 10 || cleanParentWhatsApp.length > 15) {
      return NextResponse.json(
        {
          success: false,
          error: "parentWhatsApp must be a valid 10 to 15 digit phone number",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Determine assignedTeacherId based on authenticated role
    let finalAssignedTeacherId: mongoose.Types.ObjectId | null = null;

    if (user.role === "teacher") {
      // Teachers MUST be automatically assigned to themselves; client-supplied ID is strictly ignored
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      finalAssignedTeacherId = new mongoose.Types.ObjectId(user.teacherId);
    } else {
      // Owner can assign to Owner (null) or an active Teacher in the same institute
      if (
        requestedTeacherId !== undefined &&
        requestedTeacherId !== null &&
        requestedTeacherId !== "" &&
        requestedTeacherId !== "owner"
      ) {
        if (!mongoose.Types.ObjectId.isValid(String(requestedTeacherId))) {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacherId format" },
            { status: 400, headers: corsHeaders }
          );
        }

        const targetTeacher = await Teacher.findOne({
          _id: requestedTeacherId,
          centerId: user.centerId,
        });

        if (!targetTeacher) {
          return NextResponse.json(
            { success: false, error: "Teacher not found in this institute" },
            { status: 400, headers: corsHeaders }
          );
        }

        if (!targetTeacher.isActive) {
          return NextResponse.json(
            { success: false, error: "Cannot assign student to an inactive teacher" },
            { status: 400, headers: corsHeaders }
          );
        }

        finalAssignedTeacherId = targetTeacher._id as mongoose.Types.ObjectId;
      }
    }

    // 4. Create student strictly scoped to user's authenticated centerId
    const newStudent = await Student.create({
      centerId: user.centerId,
      name: String(name).trim(),
      batch: String(batch).trim(),
      parentWhatsApp: cleanParentWhatsApp,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      joiningDate: joiningDate ? new Date(joiningDate) : new Date(),
      monthlyFee: monthlyFee !== undefined ? Number(monthlyFee) : 0,
      billingCycleDate:
        billingCycleDate !== undefined ? Number(billingCycleDate) : 5,
      assignedTeacherId: finalAssignedTeacherId,
    });

    // 5. Single Student Admission: Auto-generate portal link -> Send WhatsApp Welcome Message INSTANTLY
    try {
      const cleanCenterId = String(user.centerId).trim();

      // Ensure proper country code structure (defaulting to 91 for standard Indian mobile numbers)
      let formattedPhone = cleanParentWhatsApp;
      if (formattedPhone.length === 10) {
        formattedPhone = `91${formattedPhone}`;
      } else if (formattedPhone.length === 11 && formattedPhone.startsWith("0")) {
        formattedPhone = `91${formattedPhone.slice(1)}`;
      }

      let portalUrl: string | null = null;
      let isExistingActivePortal = false;
      let invitationToken: string | null = null;
      let encryptedToken: { iv: string; authTag: string; ciphertext: string } | null = null;

      // Programmatically call parentAccessService to auto-generate portal access token
      try {
        const accessResult = await getOrCreateParentAccess(
          cleanCenterId,
          newStudent._id,
          {
            parentPhone: formattedPhone,
            parentName: newStudent.name,
          }
        );
        // Prefer the token just created; otherwise reuse the token already
        // issued to this student's ParentAccess (never regenerated).
        invitationToken =
          accessResult?.rawToken ||
          getRecoverableInvitationToken(accessResult?.parentAccess);

        if (invitationToken) {
          encryptedToken = encryptToken(invitationToken);
          const urlRes = resolvePortalAppBaseUrl();
          if (urlRes.success) {
            portalUrl = buildPortalActivationUrl(invitationToken, urlRes.url);
          } else if (!isProductionEnvironment()) {
            portalUrl = buildPortalActivationUrl(invitationToken, "http://localhost:3000");
          } else {
            console.warn(
              `[ADMISSION WELCOME] Skipping portal link generation in production due to invalid app URL: ${urlRes.error}`
            );
          }
        } else if (accessResult && !accessResult.created) {
          isExistingActivePortal = true;
        }
      } catch (accessErr) {
        console.warn(
          "[ADMISSION WELCOME] ParentAccess token generation notice:",
          accessErr instanceof Error ? accessErr.message : accessErr
        );
      }

      // Fetch institute/center name cleanly
      const centerDoc = await Center.findOne({
        $or: [
          { centerId: cleanCenterId },
          { centerId: cleanCenterId.toLowerCase() },
          ...(mongoose.Types.ObjectId.isValid(cleanCenterId)
            ? [{ _id: new mongoose.Types.ObjectId(cleanCenterId) }]
            : []),
        ],
      }).select("name");
      const instituteName = centerDoc?.name || "Tuition Center";

      // Dispatch WhatsApp Welcome Message INSTANTLY
      let dispatchRes: any = null;
      try {
        dispatchRes = await sendAdmissionWelcomeMessage({
          centerId: cleanCenterId,
          phone: formattedPhone,
          studentName: newStudent.name,
          instituteName,
          batchName: newStudent.batch,
          portalUrl,
          isExistingActivePortal,
        });

        if (!dispatchRes?.success && !dispatchRes?.simulated) {
          console.error(
            `[ADMISSION WELCOME] Dispatch failed for student ${newStudent._id} (${newStudent.name}):`,
            dispatchRes?.error || "Unknown dispatch error"
          );
        }
      } catch (sendErr) {
        console.error(
          `[ADMISSION WELCOME] Direct dispatch exception for student ${newStudent._id} (${newStudent.name}):`,
          sendErr instanceof Error ? sendErr.message : sendErr
        );
        dispatchRes = {
          success: false,
          error: sendErr instanceof Error ? sendErr.message : "Dispatch exception",
        };
      }

      // Record durable job status in AdmissionWelcomeJob for tracking & queue compatibility
      try {
        const idempotencyKey = buildAdmissionWelcomeIdempotencyKey(
          cleanCenterId,
          newStudent._id
        );

        // Check if job already exists (idempotency guard)
        const existingJob = await AdmissionWelcomeJob.findOne({ idempotencyKey });
        if (!existingJob) {
          const isLiveSent = Boolean(dispatchRes?.success && !dispatchRes?.simulated && dispatchRes?.accepted);
          const isSimulated = Boolean(dispatchRes?.simulated);

          // If dispatch failed or was offline, preserve job as 'pending' with retry backoff
          const jobStatus = isSimulated
            ? "simulated"
            : isLiveSent
            ? "sent"
            : "pending";

          const nextRetryAt = jobStatus === "pending"
            ? new Date(Date.now() + 60000) // retry in 1 minute
            : null;

          await AdmissionWelcomeJob.create({
            centerId: cleanCenterId,
            studentId: newStudent._id,
            idempotencyKey,
            parentPhone: formattedPhone,
            studentName: newStudent.name,
            batchName: newStudent.batch,
            status: jobStatus,
            attempts: 1,
            maxAttempts: 3,
            nextRetryAt,
            parentAccessStatus: portalUrl
              ? "provisioned"
              : isExistingActivePortal
              ? "existing_active"
              : "failed",
            encryptedInvitationToken: isLiveSent ? null : encryptedToken,
            tokenPrefix: invitationToken ? invitationToken.slice(0, 8) : null,
            messageId: dispatchRes?.messageId || null,
            dispatchedAt: (isLiveSent || isSimulated) ? new Date() : null,
            simulated: isSimulated,
            failureReason: isLiveSent ? null : dispatchRes?.error || (jobStatus === "pending" ? "Initial dispatch unavailable; queued for automatic retry" : null),
          });

          // If direct dispatch could not complete, immediately trigger background queue processing
          if (jobStatus === "pending") {
            processPendingAdmissionWelcomeJobs(cleanCenterId, 1).catch((retryErr) => {
              console.warn(
                "[ADMISSION WELCOME] Immediate queue processing trigger notice:",
                retryErr instanceof Error ? retryErr.message : retryErr
              );
            });
          }
        }
      } catch (jobErr: any) {
        if (jobErr && jobErr.code === 11000) {
          // E11000 duplicate idempotency key on concurrent retry - safe no-op
        } else {
          console.warn(
            "[ADMISSION WELCOME] Direct job creation notice (falling back to enqueue):",
            jobErr instanceof Error ? jobErr.message : jobErr
          );
          enqueueAdmissionWelcomeJob({
            centerId: cleanCenterId,
            studentId: newStudent._id,
            parentPhone: formattedPhone,
            studentName: newStudent.name,
            batchName: newStudent.batch,
          })
            .then(() => processPendingAdmissionWelcomeJobs(cleanCenterId, 1))
            .catch(() => {});
        }
      }
    } catch (welcomeErr) {
      console.error(
        "[ADMISSION WELCOME] Instant welcome dispatch notice (non-blocking):",
        welcomeErr instanceof Error ? welcomeErr.message : welcomeErr
      );
    }

    // Event Notification Dispatch (Assigned Teacher & Parent)
    try {
      await notifyStudentAdmissionEvents({
        centerId: String(user.centerId).trim(),
        studentId: String(newStudent._id),
        studentName: newStudent.name || "Student",
        batchName: newStudent.batch,
        assignedTeacherId: finalAssignedTeacherId ? String(finalAssignedTeacherId) : undefined,
        parentPhone: cleanParentWhatsApp,
      });
    } catch (notifErr) {
      console.warn("[STUDENT ADMISSION] Notification dispatch error:", notifErr);
    }

    const sanitizedNewStudent = sanitizeStudentForRole(
      newStudent.toObject ? newStudent.toObject() : { ...newStudent },
      user.role
    );

    return NextResponse.json(
      { success: true, data: sanitizedNewStudent },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create student";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
