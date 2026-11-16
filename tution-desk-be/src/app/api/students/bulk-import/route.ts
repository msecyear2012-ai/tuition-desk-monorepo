import { NextRequest, NextResponse } from "next/server";
import { runBackgroundTask } from "@/lib/serverlessTask";
import crypto from "node:crypto";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Student from "@/models/Student";
import Teacher from "@/models/Teacher";
import Batch from "@/models/Batch";
import Center, { DEFAULT_ADMISSION_TEMPLATE } from "@/models/Center";
import MessageCampaign from "@/models/MessageCampaign";
import { AdmissionWelcomeJob } from "@/models/AdmissionWelcomeJob";
import ImportBatchLock, {
  getLockLeaseDurationMs,
  getHeartbeatIntervalMs,
  verifyImportLockIndexIntegrity,
} from "@/models/ImportBatchLock";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import { generateErrorCsv } from "@/lib/csvParser";
import {
  computeRowsHash,
  verifyPreviewToken,
  type NormalizedStudentRow,
  type RowValidationError,
} from "@/lib/bulkImport";
import { buildAdmissionWelcomeIdempotencyKey } from "@/lib/admissionWelcomeQueue";
import {
  getOrCreateParentAccess,
  getRecoverableInvitationToken,
} from "@/lib/parentAccessService";
import { encryptToken } from "@/lib/tokenCipher";
import {
  formatAdmissionWelcomeMessage,
  formatTemplate,
  getAppBaseUrl,
} from "@/lib/whatsappService";
import {
  resolvePortalAppBaseUrl,
  buildPortalActivationUrl,
  isProductionEnvironment,
} from "@/lib/portalLinks";
import { dispatchCampaign } from "@/lib/campaignDispatcher";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT before database connection
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

    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 2. Parse request body
    const body = await request.json().catch(() => ({}));
    const { previewToken, rows, targetTeacherId, recoverAbandoned } = body;

    if (!previewToken || typeof previewToken !== "string") {
      return NextResponse.json(
        { success: false, error: "previewToken is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!Array.isArray(rows)) {
      return NextResponse.json(
        { success: false, error: "rows array is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Cryptographic Preview Token Verification
    const tokenPayload = await verifyPreviewToken(previewToken);
    if (!tokenPayload) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired preview token" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Enforce tenant isolation and identity continuity between preview and confirm
    if (tokenPayload.centerId !== user.centerId) {
      return NextResponse.json(
        { success: false, error: "Tenant mismatch between preview and confirmation" },
        { status: 403, headers: corsHeaders }
      );
    }

    if (tokenPayload.userId !== user.userId) {
      return NextResponse.json(
        { success: false, error: "User identity mismatch between preview and confirmation" },
        { status: 403, headers: corsHeaders }
      );
    }

    if (tokenPayload.role !== user.role) {
      return NextResponse.json(
        { success: false, error: "Role mismatch between preview and confirmation" },
        { status: 403, headers: corsHeaders }
      );
    }

    // 4. Anti-Tampering Check: Validate submitted rows against preview hash
    if (rows.length !== tokenPayload.validCount) {
      return NextResponse.json(
        {
          success: false,
          error: `Import data integrity check failed: submitted rows count (${rows.length}) does not match preview count (${tokenPayload.validCount})`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const computedHash = computeRowsHash(rows as NormalizedStudentRow[]);
    if (computedHash !== tokenPayload.rowsHash) {
      return NextResponse.json(
        {
          success: false,
          error: "Import data tampering detected: submitted rows do not match preview",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 5. Connect to database only after authentication and cryptographic verification
    await connectDB();

    // 5b. Validate Cryptographically Bound Batch (Tenant & Existence check)
    let verifiedBatchName: string | undefined = tokenPayload.batchName;

    if (tokenPayload.batchId) {
      if (!mongoose.Types.ObjectId.isValid(tokenPayload.batchId)) {
        return NextResponse.json(
          { success: false, error: "Invalid batchId format in preview token" },
          { status: 400, headers: corsHeaders }
        );
      }

      const boundBatch = await Batch.findOne({
        _id: tokenPayload.batchId,
        centerId: user.centerId,
        isActive: { $ne: false },
      });

      if (!boundBatch) {
        return NextResponse.json(
          {
            success: false,
            error:
              "The batch selected during preview no longer exists or has been deactivated in this institute.",
          },
          { status: 400, headers: corsHeaders }
        );
      }

      verifiedBatchName = boundBatch.name;
    }

    // Anti-Tampering Check: If client explicitly passed batch identifiers, verify they match token
    const clientSelectedBatchId = body.selectedBatchId;
    const clientSelectedBatchName = body.selectedBatch;

    if (
      clientSelectedBatchId &&
      tokenPayload.batchId &&
      String(clientSelectedBatchId).trim() !== String(tokenPayload.batchId).trim()
    ) {
      return NextResponse.json(
        { success: false, error: "Batch tampering detected: batchId does not match preview token" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (
      clientSelectedBatchName &&
      tokenPayload.batchName &&
      String(clientSelectedBatchName).trim().toLowerCase() !==
        String(tokenPayload.batchName).trim().toLowerCase()
    ) {
      return NextResponse.json(
        { success: false, error: "Batch tampering detected: batchName does not match preview token" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 6. Enforce Assignment Attribution (DEC-MSEC-05) before reservation
    let finalAssignedTeacherId: mongoose.Types.ObjectId | null = null;
    let assignedTo: { id: string | null; name: string; role: string };

    if (user.role === "teacher") {
      finalAssignedTeacherId = new mongoose.Types.ObjectId(user.teacherId!);
      assignedTo = {
        id: user.teacherId!,
        name: user.name || "Teacher",
        role: "teacher",
      };
    } else {
      if (
        targetTeacherId !== undefined &&
        targetTeacherId !== null &&
        targetTeacherId !== "" &&
        targetTeacherId !== "owner"
      ) {
        if (!mongoose.Types.ObjectId.isValid(String(targetTeacherId))) {
          return NextResponse.json(
            { success: false, error: "Invalid targetTeacherId format" },
            { status: 400, headers: corsHeaders }
          );
        }

        const targetTeacher = await Teacher.findOne({
          _id: targetTeacherId,
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
            { success: false, error: "Cannot assign students to an inactive teacher" },
            { status: 400, headers: corsHeaders }
          );
        }

        finalAssignedTeacherId = targetTeacher._id as mongoose.Types.ObjectId;
        assignedTo = {
          id: targetTeacher._id.toString(),
          name: targetTeacher.name,
          role: "teacher",
        };
      } else {
        finalAssignedTeacherId = null;
        assignedTo = {
          id: null,
          name: user.name || "Myself (Owner)",
          role: "owner",
        };
      }
    }

    // Preflight: verify that the unique compound index { centerId: 1, previewId: 1 } exists (SEC-07)
    let hasLockIndex = await verifyImportLockIndexIntegrity(ImportBatchLock);
    if (!hasLockIndex) {
      try {
        await ImportBatchLock.createIndexes();
        hasLockIndex = await verifyImportLockIndexIntegrity(ImportBatchLock);
      } catch (idxErr) {
        console.warn("[BULK IMPORT] Notice syncing ImportBatchLock indexes:", idxErr);
      }
    }

    if (!hasLockIndex) {
      try {
        if (ImportBatchLock.collection && typeof ImportBatchLock.collection.createIndex === "function") {
          await ImportBatchLock.collection.createIndex(
            { centerId: 1, previewId: 1 },
            { unique: true, name: "centerId_1_previewId_1" }
          );
          hasLockIndex = true;
        }
      } catch (collErr: any) {
        if (
          collErr?.code === 85 ||
          collErr?.code === 86 ||
          String(collErr?.message || collErr).includes("already exists")
        ) {
          hasLockIndex = true;
        } else {
          console.warn("[BULK IMPORT] Collection createIndex notice:", collErr?.message || collErr);
        }
      }
    }

    if (!hasLockIndex) {
      console.warn(
        "[BULK IMPORT] Warning: Import lock index could not be verified via listIndexes(). Proceeding under atomic database lock coordination."
      );
    }

    // 7. Atomic Import Batch Reservation & Concurrency Lease
    // Generate unique lease token (holderId) for this execution request
    const holderId = crypto.randomUUID();
    let currentLockVersion = 1;

    // Secondary defense: check if all students from this preview are already in DB
    const alreadyProcessedStudents = await Student.countDocuments({
      centerId: user.centerId,
      importedBatchId: tokenPayload.previewId,
    });

    if (
      alreadyProcessedStudents > 0 &&
      alreadyProcessedStudents >= tokenPayload.validCount
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "This import batch has already been processed",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // Attempt atomic lock creation
    try {
      const createdLock = await ImportBatchLock.create({
        centerId: user.centerId,
        previewId: tokenPayload.previewId,
        holderId,
        lockVersion: 1,
        status: "IN_PROGRESS",
        assignedTeacherId: finalAssignedTeacherId,
        assignedRole: assignedTo.role,
        userId: user.userId || "",
        lockedAt: new Date(),
        heartbeatAt: new Date(),
      });
      currentLockVersion = createdLock.lockVersion || 1;
    } catch (lockErr: unknown) {
      const mongoErr = lockErr as { code?: number };
      if (mongoErr?.code === 11000) {
        // Lock document exists. Inspect state to determine if completed, in progress, or failed.
        const existingLock = await ImportBatchLock.findOne({
          centerId: user.centerId,
          previewId: tokenPayload.previewId,
        });

        if (existingLock?.status === "COMPLETED") {
          return NextResponse.json(
            {
              success: false,
              error: "This import batch has already been processed",
            },
            { status: 409, headers: corsHeaders }
          );
        }

        if (existingLock?.status === "IN_PROGRESS") {
          // An IN_PROGRESS lock cannot be automatically reclaimed by arbitrary requests.
          // Only an explicit administrative recovery requested by the Owner can reclaim a genuinely stale lock.
          if (recoverAbandoned === true && user.role === "owner") {
            const leaseDurationMs = getLockLeaseDurationMs();
            const staleCutoff = new Date(Date.now() - leaseDurationMs);

            // Atomically reclaim ONLY if heartbeatAt is older than the configured lease duration
            const recovered = await ImportBatchLock.findOneAndUpdate(
              {
                centerId: user.centerId,
                previewId: tokenPayload.previewId,
                status: "IN_PROGRESS",
                holderId: existingLock.holderId,
                heartbeatAt: { $lt: staleCutoff },
              },
              {
                $set: {
                  holderId,
                  lockedAt: new Date(),
                  heartbeatAt: new Date(),
                  userId: user.userId || "",
                  assignedTeacherId: finalAssignedTeacherId,
                  assignedRole: assignedTo.role,
                },
                $inc: { lockVersion: 1 },
                $unset: { lastError: 1, failedAt: 1 },
              },
              { new: true }
            );

            if (!recovered) {
              return NextResponse.json(
                {
                  success: false,
                  error:
                    "This import batch is currently active. Recovery is only permitted for unresponsive batches exceeding the lease duration.",
                },
                { status: 409, headers: corsHeaders }
              );
            }
            currentLockVersion = recovered.lockVersion || 1;
          } else {
            return NextResponse.json(
              {
                success: false,
                error:
                  "This import batch is currently in progress. Automatic takeover is prohibited.",
              },
              { status: 409, headers: corsHeaders }
            );
          }
        } else if (existingLock?.status === "FAILED") {
          // Lock was explicitly released as FAILED by a previous attempt; safe to retry atomically
          const reclaimed = await ImportBatchLock.findOneAndUpdate(
            {
              centerId: user.centerId,
              previewId: tokenPayload.previewId,
              status: "FAILED",
            },
            {
              $set: {
                status: "IN_PROGRESS",
                holderId,
                lockedAt: new Date(),
                heartbeatAt: new Date(),
                userId: user.userId || "",
                assignedTeacherId: finalAssignedTeacherId,
                assignedRole: assignedTo.role,
              },
              $inc: { lockVersion: 1 },
              $unset: { lastError: 1, failedAt: 1 },
            },
            { new: true }
          );

          if (!reclaimed) {
            return NextResponse.json(
              {
                success: false,
                error:
                  "This import batch is currently being processed by another request",
              },
              { status: 409, headers: corsHeaders }
            );
          }
          currentLockVersion = reclaimed.lockVersion || 1;
        }
      } else {
        throw lockErr;
      }
    }

    // Start periodic heartbeat keepalive for genuinely active import
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isHeartbeatActive = true;
    let lockOwnershipLost = false;

    const heartbeatMs = getHeartbeatIntervalMs();
    heartbeatTimer = setInterval(async () => {
      if (!isHeartbeatActive) return;
      try {
        const beat = await ImportBatchLock.updateOne(
          {
            centerId: user.centerId,
            previewId: tokenPayload.previewId,
            status: "IN_PROGRESS",
            holderId,
            lockVersion: currentLockVersion,
          },
          { $set: { heartbeatAt: new Date() } }
        );
        if (beat.matchedCount === 0) {
          lockOwnershipLost = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        }
      } catch {
        // Transient error will be caught on next interval or transaction
      }
    }, heartbeatMs);

    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }

    const cleanupHeartbeat = () => {
      isHeartbeatActive = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    // 8. Re-check for duplicate collisions (including students partially inserted during prior failed attempt)
    const candidatePhones = (rows as NormalizedStudentRow[]).map(
      (r) => r.parentWhatsApp
    );

    const existingStudents = await Student.find({
      centerId: user.centerId,
      $or: [
        { parentWhatsApp: { $in: candidatePhones } },
        { importedBatchId: tokenPayload.previewId },
      ],
    }).select("name parentWhatsApp importedBatchId");

    const existingMap = new Set<string>();
    for (const s of existingStudents) {
      const cleanPhone = String(s.parentWhatsApp || "").replace(/\D/g, "");
      const cleanName = String(s.name || "").toLowerCase().trim();
      if (cleanPhone && cleanName) {
        existingMap.add(`${cleanPhone}:::${cleanName}`);
      }
    }

    const studentsToInsert: Array<{
      centerId: string;
      name: string;
      batch: string;
      parentWhatsApp: string;
      monthlyFee: number;
      billingCycleDate: number;
      rollNumber?: string;
      joiningDate: Date;
      assignedTeacherId: mongoose.Types.ObjectId | null;
      importedBatchId: string;
      isActive: boolean;
    }> = [];

    const lateSkippedErrors: RowValidationError[] = [];

    for (const r of rows as NormalizedStudentRow[]) {
      const collisionKey = `${r.parentWhatsApp}:::${r.name.toLowerCase().trim()}`;
      if (existingMap.has(collisionKey)) {
        lateSkippedErrors.push({
          row: r.row,
          name: r.name,
          reason: "Duplicate: Student already enrolled in this institute",
        });
        continue;
      }

      const effectiveBatch =
        (verifiedBatchName && verifiedBatchName.trim()) ||
        (tokenPayload.batchName && tokenPayload.batchName.trim()) ||
        r.batch.trim();

      studentsToInsert.push({
        centerId: user.centerId,
        name: r.name.trim(),
        batch: effectiveBatch,
        parentWhatsApp: r.parentWhatsApp.trim(),
        monthlyFee: Number(r.monthlyFee) || 0,
        billingCycleDate: Number(r.billingCycleDate) || 5,
        rollNumber: r.rollNumber ? r.rollNumber.trim() : undefined,
        joiningDate: r.joiningDate ? new Date(r.joiningDate) : new Date(),
        assignedTeacherId: finalAssignedTeacherId,
        importedBatchId: tokenPayload.previewId,
        isActive: true,
      });
    }

    if (lockOwnershipLost) {
      cleanupHeartbeat();
      return NextResponse.json(
        {
          success: false,
          error: "Import aborted: lock lease ownership was lost to another process",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 9. Execute Bulk Insertion with Database-Enforced Replica Set Transaction (SEC-06)
    let session: mongoose.ClientSession;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      cleanupHeartbeat();
      return NextResponse.json(
        {
          success: false,
          error:
            "Bulk import requires replica set transaction support to guarantee data integrity.",
        },
        { status: 503, headers: corsHeaders }
      );
    }

    let insertedStudents: any[] = [];
    try {
      // Verify lock ownership inside the transaction and acquire document write lock (SEC-08)
      const verifiedLock = await ImportBatchLock.findOneAndUpdate(
        {
          centerId: user.centerId,
          previewId: tokenPayload.previewId,
          status: "IN_PROGRESS",
          holderId,
          lockVersion: currentLockVersion,
        },
        { $set: { heartbeatAt: new Date() } },
        { session, new: true }
      );

      if (!verifiedLock) {
        throw new Error(
          "Lock ownership lost: batch lease was reclaimed before transaction execution"
        );
      }

      if (studentsToInsert.length > 0) {
        insertedStudents = await Student.insertMany(studentsToInsert, { session, ordered: false });
      }

      const compResult = await ImportBatchLock.updateOne(
        {
          centerId: user.centerId,
          previewId: tokenPayload.previewId,
          status: "IN_PROGRESS",
          holderId,
          lockVersion: currentLockVersion,
        },
        {
          $set: {
            status: "COMPLETED",
            importedCount: studentsToInsert.length + alreadyProcessedStudents,
            failedCount: lateSkippedErrors.length,
            completedAt: new Date(),
            heartbeatAt: new Date(),
          },
        },
        { session }
      );

      if (compResult.matchedCount === 0) {
        throw new Error("Lock ownership lost before transaction completion");
      }

      await session.commitTransaction();
    } catch (insertError: unknown) {
      if (session.inTransaction()) {
        await session.abortTransaction().catch(() => {});
      }

      // Mark reservation lock as FAILED strictly using holderId and lockVersion ownership (SEC-08)
      const errMsg =
        insertError instanceof Error
          ? insertError.message
          : "Bulk insertion failed";
      await ImportBatchLock.updateOne(
        {
          centerId: user.centerId,
          previewId: tokenPayload.previewId,
          status: "IN_PROGRESS",
          holderId,
          lockVersion: currentLockVersion,
        },
        {
          $set: {
            status: "FAILED",
            lastError: errMsg,
            failedAt: new Date(),
          },
        }
      ).catch(() => {});

      throw insertError;
    } finally {
      cleanupHeartbeat();
      await session.endSession().catch(() => {});
    }

    // 10. Auto-generate Parent Access tokens & queue welcome messages via Anti-Ban Queue / Smart Campaign Engine (non-blocking)
    if (insertedStudents.length > 0) {
      try {
        const centerDoc = await Center.findOne({ centerId: user.centerId }).select(
          "name welcomeMessageTemplate messagingTemplates"
        );
        const instituteName = centerDoc?.name || "Tuition Center";
        const welcomeTemplate =
          centerDoc?.messagingTemplates?.admission ||
          centerDoc?.welcomeMessageTemplate ||
          DEFAULT_ADMISSION_TEMPLATE;
        const urlRes = resolvePortalAppBaseUrl();
        const baseUrl = urlRes.success
          ? urlRes.url
          : (isProductionEnvironment() ? "" : "http://localhost:3000");

        const campaignMessages: Array<{
          phone: string;
          message: string;
          studentId: mongoose.Types.ObjectId;
          studentName: string;
          status: "pending";
          sourceType: "admission_welcome";
          sourceId?: string;
        }> = [];

        // Calculate valid lease expiry consistent with campaign lifecycle (Requirement 2)
        const totalWelcomeCount = insertedStudents.length;
        const BASE_CAMPAIGN_LEASE_MS = 15 * 60 * 1000; // 15-minute minimum base window
        const PER_MESSAGE_BUFFER_MS = 20 * 1000; // 20s per student anti-ban/dispatch buffer
        const calculatedLeaseMs = Math.max(
          BASE_CAMPAIGN_LEASE_MS,
          totalWelcomeCount * PER_MESSAGE_BUFFER_MS
        );
        const lockExpiresAt = new Date(Date.now() + calculatedLeaseMs);
        const createdJobIds: mongoose.Types.ObjectId[] = [];

        for (const student of insertedStudents) {
          let cleanPhone = String(student.parentWhatsApp || "").replace(/\D/g, "");
          if (!cleanPhone || cleanPhone.length < 10) continue;
          if (cleanPhone.length === 10) {
            cleanPhone = `91${cleanPhone}`;
          } else if (cleanPhone.length === 11 && cleanPhone.startsWith("0")) {
            cleanPhone = `91${cleanPhone.slice(1)}`;
          }

          let portalUrl: string | null = null;
          let isExistingActivePortal = false;
          let accessRecord: any = null;
          let rawInvitationToken: string | null = null;

          try {
            const accessRes = await getOrCreateParentAccess(user.centerId, student._id, {
              parentPhone: cleanPhone,
              parentName: student.name,
            });
            accessRecord = accessRes?.parentAccess;

            // Prefer the freshly created token, then fall back to the token that
            // was already issued to this student's ParentAccess record.
            // IMPORTANT: we never regenerate here, so a link already delivered to
            // an existing parent keeps working.
            const invitationToken =
              accessRes?.rawToken ||
              getRecoverableInvitationToken(accessRes?.parentAccess);

            if (invitationToken) {
              rawInvitationToken = invitationToken;
              portalUrl = baseUrl
                ? buildPortalActivationUrl(invitationToken, baseUrl)
                : null;
            } else if (accessRes && !accessRes.created) {
              isExistingActivePortal = true;
              portalUrl = baseUrl
                ? buildPortalActivationUrl(null, baseUrl)
                : null;
            }
          } catch (accessErr) {
            console.error(
              `[BULK ADMISSION WELCOME] Token generation notice for student ${student._id}:`,
              accessErr instanceof Error ? accessErr.message : accessErr
            );
          }

          // Use custom center template if available, with full placeholder substitution
          let messageText: string;
          if (welcomeTemplate && welcomeTemplate.trim()) {
            messageText = formatTemplate(welcomeTemplate, {
              studentName: student.name,
              parentName: student.name,
              instituteName,
              institute: instituteName,
              batchName: student.batch,
              batch: student.batch,
              magicLink: portalUrl || (baseUrl ? `${baseUrl}/portal` : ""),
              portalUrl: portalUrl || (baseUrl ? `${baseUrl}/portal` : ""),
            });
          } else {
            messageText = formatAdmissionWelcomeMessage({
              studentName: student.name,
              instituteName,
              batchName: student.batch,
              portalUrl,
              isExistingActivePortal,
              appBaseUrl: baseUrl || undefined,
            });
          }

          // Create / update AdmissionWelcomeJob with status: "processing" for durable audit trail
          // Setting status: "processing" guarantees that the cron worker won't pick it up (preventing double delivery)
          let jobIdString: string | undefined;
          try {
            const idempotencyKey = buildAdmissionWelcomeIdempotencyKey(
              user.centerId,
              student._id
            );
            const parentAccessStatus = rawInvitationToken
              ? "provisioned"
              : isExistingActivePortal
              ? "existing_active"
              : "failed";

            const encryptedInvitationToken = rawInvitationToken
              ? encryptToken(rawInvitationToken)
              : null;

            const job = await AdmissionWelcomeJob.findOneAndUpdate(
              { idempotencyKey },
              {
                $setOnInsert: {
                  centerId: user.centerId,
                  studentId: student._id,
                  idempotencyKey,
                  parentPhone: cleanPhone,
                  studentName: student.name,
                  batchName: student.batch || "General",
                  attempts: 0,
                  maxAttempts: 3,
                },
                $set: {
                  status: "processing",
                  lockedAt: new Date(),
                  lockExpiresAt,
                  parentAccessId: accessRecord?._id || null,
                  parentAccessStatus,
                  encryptedInvitationToken,
                  tokenPrefix: accessRecord?.tokenPrefix || null,
                  simulated: true,
                },
              },
              { upsert: true, new: true }
            );
            if (job?._id) {
              jobIdString = String(job._id);
              createdJobIds.push(job._id as mongoose.Types.ObjectId);
            }
          } catch (jobErr) {
            console.warn(
              `[BULK ADMISSION WELCOME] Could not record AdmissionWelcomeJob for student ${student._id}:`,
              jobErr instanceof Error ? jobErr.message : jobErr
            );
          }

          campaignMessages.push({
            phone: cleanPhone,
            message: messageText,
            studentId: student._id as mongoose.Types.ObjectId,
            studentName: student.name,
            status: "pending",
            sourceType: "admission_welcome",
            ...(jobIdString ? { sourceId: jobIdString } : {}),
          });
        }

        if (campaignMessages.length > 0) {
          const campaign = await MessageCampaign.create({
            centerId: user.centerId,
            title: `Bulk Admission Welcome — Batch ${tokenPayload.previewId}`,
            campaignType: "admission_welcome",
            status: "approved",
            messages: campaignMessages,
            createdBy: user.userId,
            createdRole: user.role,
            approvedBy: user.userId,
            approvedAt: new Date(),
            stats: {
              total: campaignMessages.length,
              sent: 0,
              simulated: 0,
              failed: 0,
              pending: campaignMessages.length,
            },
          });

          // Associate campaignId with bulk-created processing jobs for instant lookup and durable auditing
          if (createdJobIds.length > 0) {
            await AdmissionWelcomeJob.updateMany(
              { _id: { $in: createdJobIds } },
              { $set: { campaignId: campaign._id } }
            ).catch(() => {});
          }

          // Dispatch 1-by-1 with anti-ban delay via Smart Campaign Engine using safe background task
          runBackgroundTask(async () => {
            await dispatchCampaign(campaign._id, user.centerId);
          });
        }
      } catch (queueErr) {
        console.error(
          "[ADMISSION QUEUE] Failed to queue bulk admission welcome messages:",
          queueErr instanceof Error ? queueErr.message : queueErr
        );
      }
    }

    const errorCsv = generateErrorCsv(lateSkippedErrors);

    return NextResponse.json(
      {
        success: true,
        data: {
          previewId: tokenPayload.previewId,
          totalProcessed: tokenPayload.validCount,
          importedCount: studentsToInsert.length,
          failedCount: lateSkippedErrors.length,
          assignedTo,
          errors: lateSkippedErrors,
          errorCsv,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to execute bulk student import";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

