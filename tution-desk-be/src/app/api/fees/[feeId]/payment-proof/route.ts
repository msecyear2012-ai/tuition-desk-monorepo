import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Fee from "../../../../../models/Fee.ts";
import Student from "../../../../../models/Student.ts";
import PaymentProof from "../../../../../models/PaymentProof.ts";
import Center from "../../../../../models/Center.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import {
  validateParentSession,
  resolvePortalToken,
} from "../../../../../lib/parentAccessService.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";
import {
  validateImageFile,
  uploadProofToImageKit,
  deleteFromImageKit,
  generateSignedImageUrl,
} from "../../../../../lib/imagekitService.ts";
import { creditAdvanceToStudentWallet } from "../../../../../lib/walletService.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, GET, PUT, PATCH, OPTIONS");
}

/**
 * Resolves caller identity with strict tenant isolation:
 * - Prioritizes Staff (Owner / Teacher) via verified JWT auth token to prevent
 *   stale parent portal session cookies in the same browser from hijacking staff calls.
 * - Resolves Parent Portal via session cookie, Bearer header, or portal token when no staff session exists.
 */
async function resolveAuth(request: NextRequest, bodyOrParamToken?: string | null) {
  let authCenterId: string | null = null;
  let parentAccessRecord: any = null;
  let staffUser: any = null;

  // 1. Prioritize Staff Authentication (Owner or Teacher) from verified JWT
  const verifiedStaff = await getAuthenticatedUser(request);
  if (
    verifiedStaff &&
    (verifiedStaff.role === "owner" || verifiedStaff.role === "teacher") &&
    verifiedStaff.centerId
  ) {
    staffUser = verifiedStaff;
    authCenterId = String(verifiedStaff.centerId);
    return { authCenterId, parentAccessRecord: null, staffUser };
  }

  // 2. Check Parent Portal Session Token (Cookie or Authorization: Bearer header)
  const sessionCookie = request.cookies.get("parent_portal_session")?.value;
  const authHeader = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  const sessionToken = sessionCookie || authHeader;

  const rawToken =
    (request.nextUrl ? request.nextUrl.searchParams.get("token") : null) ||
    request.headers.get("x-portal-token") ||
    (typeof bodyOrParamToken === "string" ? bodyOrParamToken.trim() : null);

  if (sessionToken) {
    const sessionResult = await validateParentSession(sessionToken);
    if (sessionResult.valid && sessionResult.parentAccess) {
      parentAccessRecord = sessionResult.parentAccess;
      authCenterId = sessionResult.parentAccess.centerId;
    }
  } else if (rawToken) {
    const tokenResult = await resolvePortalToken(String(rawToken).trim());
    if (tokenResult.valid && tokenResult.parentAccess) {
      parentAccessRecord = tokenResult.parentAccess;
      authCenterId = tokenResult.parentAccess.centerId;
    }
  }

  return { authCenterId, parentAccessRecord, staffUser: null };
}

/**
 * POST /api/fees/[feeId]/payment-proof
 *
 * Secure Payment Proof Upload Endpoint.
 * Uploads screenshot to ImageKit server-side, validates content & size,
 * stores ImageKit file reference in PaymentProof Mongoose model,
 * and transitions fee to "Verification Pending" without marking Paid.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ feeId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const { feeId } = await context.params;

    if (!feeId || !mongoose.Types.ObjectId.isValid(feeId)) {
      return NextResponse.json(
        { success: false, error: "Invalid fee ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    // 1. Determine Content-Type and Extract Payload
    const contentType = request.headers.get("content-type") || "";
    let fileBuffer: Buffer | null = null;
    let declaredMime = "";
    let originalFileName = "";
    let submittedUtr = "";
    let notes = "";
    let submittedAmount: number | undefined = undefined;
    let extractedToken: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData().catch(() => null);
      if (!formData) {
        return NextResponse.json(
          { success: false, error: "Malformed multipart form data" },
          { status: 400, headers: corsHeaders }
        );
      }

      const fileEntry = formData.get("file") || formData.get("screenshot") || formData.get("image");
      if (fileEntry && typeof fileEntry === "object" && "arrayBuffer" in fileEntry) {
        const fileObj = fileEntry as File;
        fileBuffer = Buffer.from(await fileObj.arrayBuffer());
        declaredMime = fileObj.type || "";
        originalFileName = fileObj.name || "";
      }

      submittedUtr = String(formData.get("utrNumber") || formData.get("utr") || "").trim();
      notes = String(formData.get("notes") || "").trim();
      const rawAmt = formData.get("amount") || formData.get("submittedAmount");
      if (rawAmt && !isNaN(Number(rawAmt))) {
        submittedAmount = Number(rawAmt);
      }
      extractedToken = String(formData.get("token") || "").trim() || null;
    } else {
      // JSON body with base64 payload
      const body = await request.json().catch(() => ({}));
      const rawFile = body.file || body.screenshot || body.imageBase64 || body.image;

      if (typeof rawFile === "string" && rawFile.trim()) {
        const cleanBase64 = rawFile.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, "").trim();
        fileBuffer = Buffer.from(cleanBase64, "base64");

        const dataUriMatch = rawFile.match(/^data:(image\/[a-z0-9+.-]+);base64,/i);
        if (dataUriMatch) {
          declaredMime = dataUriMatch[1];
        }
      }

      originalFileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
      submittedUtr = typeof body.utrNumber === "string" ? body.utrNumber.trim() : (typeof body.utr === "string" ? body.utr.trim() : "");
      notes = typeof body.notes === "string" ? body.notes.trim() : "";
      if (body.amount !== undefined && !isNaN(Number(body.amount))) {
        submittedAmount = Number(body.amount);
      }
      extractedToken = typeof body.token === "string" ? body.token.trim() : null;
    }

    // 2. Authentication Verification
    const { authCenterId, parentAccessRecord, staffUser } = await resolveAuth(request, extractedToken);

    if (!authCenterId) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required: Please log in or use your personalized parent portal link.",
        },
        { status: 401, headers: corsHeaders }
      );
    }

    // 3. Retrieve Target Fee
    const fee = await Fee.findById(feeId);
    if (!fee) {
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. Strict Tenant Isolation
    if (String(fee.centerId).trim() !== String(authCenterId).trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Cross-tenant fee submission is strictly forbidden",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 5. Verify Student Authorization
    let authorizedForStudent = false;
    const targetStudentId = String(fee.studentId);

    if (parentAccessRecord) {
      const linked = (parentAccessRecord.linkedStudentIds || []).map((id: any) => String(id));
      if (linked.includes(targetStudentId)) {
        authorizedForStudent = true;
      }
    } else if (staffUser) {
      if (staffUser.role === "owner") {
        authorizedForStudent = true;
      } else if (staffUser.role === "teacher") {
        const studentDoc = await Student.findById(fee.studentId)
          .select("assignedTeacherId")
          .lean();
        const teacherId = staffUser.teacherId || staffUser.userId;
        if (
          studentDoc &&
          String((studentDoc as any).assignedTeacherId) === String(teacherId)
        ) {
          authorizedForStudent = true;
        }
      }
    }

    if (!authorizedForStudent) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: You are not authorized to submit payment proofs for this student",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 6. Fee Lifecycle Invariants (Never alter Paid records)
    if (fee.status === "Paid") {
      return NextResponse.json(
        {
          success: false,
          error: "Fee has already been paid and verified. Payment proof upload is not permitted.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if ((fee.status as string) === "Cancelled" || (fee.status as string) === "Waived") {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot submit payment proof for a cancelled or waived fee.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 7. Duplicate Submission Prevention & Atomic Reservation Lock
    // A. Debounce check: Reject rapid re-submissions if a proof is already pending review from < 60s ago
    const recentPendingProof = await PaymentProof.findOne({
      feeId: fee._id,
      status: "pending_review",
    }).sort({ createdAt: -1 });

    if (recentPendingProof) {
      const msSinceLastUpload = Date.now() - new Date(recentPendingProof.createdAt || 0).getTime();
      if (msSinceLastUpload < 60 * 1000) {
        return NextResponse.json(
          {
            success: false,
            code: "DUPLICATE_SUBMISSION",
            error:
              "A payment proof was recently submitted for this fee and is currently pending review. Please wait before submitting another.",
          },
          { status: 409, headers: corsHeaders }
        );
      }
    }

    // B. Atomic Reservation Lock on Fee: Serializes concurrent uploads and prevents duplicate active proofs
    const now = new Date();
    const lockDurationMs = 120 * 1000; // 120-second TTL
    const lockExpiry = new Date(now.getTime() + lockDurationMs);

    const lockedFee = await Fee.findOneAndUpdate(
      {
        _id: fee._id,
        $or: [
          { proofUploadLockUntil: { $exists: false } },
          { proofUploadLockUntil: null },
          { proofUploadLockUntil: { $lte: now } }, // Expired lock safe recovery
        ],
      },
      {
        $set: { proofUploadLockUntil: lockExpiry },
      },
      { new: true }
    );

    if (!lockedFee) {
      return NextResponse.json(
        {
          success: false,
          code: "CONCURRENT_UPLOAD_IN_PROGRESS",
          error:
            "Another payment proof upload is currently in progress for this fee. Please wait a moment and try again.",
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 8. Content Validation: Require either Screenshot or UTR Reference
    const hasScreenshot = Boolean(fileBuffer && fileBuffer.length > 0);
    const hasRawUtr = Boolean(submittedUtr && String(submittedUtr).trim());

    if (!hasScreenshot && !hasRawUtr) {
      // Release reservation lock before early exit
      await Fee.updateOne({ _id: fee._id, proofUploadLockUntil: lockExpiry }, { $unset: { proofUploadLockUntil: 1 } });
      return NextResponse.json(
        { success: false, error: "Either a valid UTR / transaction reference or a payment screenshot is required." },
        { status: 400, headers: corsHeaders }
      );
    }

    let cleanUtr = "";
    if (hasRawUtr) {
      cleanUtr = String(submittedUtr).trim().toUpperCase().replace(/[^a-zA-Z0-9_-]/g, "");
      if (cleanUtr.length < 6 || cleanUtr.length > 30) {
        await Fee.updateOne({ _id: fee._id, proofUploadLockUntil: lockExpiry }, { $unset: { proofUploadLockUntil: 1 } });
        return NextResponse.json(
          {
            success: false,
            error: "Please enter a valid 12-digit UTR / Reference number (minimum 6 alphanumeric characters)",
          },
          { status: 400, headers: corsHeaders }
        );
      }

      const forbiddenPlaceholders = [
        "NOT_FETCHED", "NOTFETCHED", "UTR_NOT_FETCHED", "UTRNOTFETCHED",
        "SUCCESS", "FAILURE", "SUBMITTED", "PENDING", "CANCELLED",
        "TRUE", "FALSE", "UNDEFINED", "NULL", "NONE"
      ];
      if (forbiddenPlaceholders.includes(cleanUtr) || cleanUtr.startsWith("FEE-") || cleanUtr.startsWith("FEE_")) {
        await Fee.updateOne({ _id: fee._id, proofUploadLockUntil: lockExpiry }, { $unset: { proofUploadLockUntil: 1 } });
        return NextResponse.json(
          {
            success: false,
            error: "A placeholder or status phrase cannot be submitted as a UTR. If UTR was not fetched, please attach a payment screenshot.",
          },
          { status: 400, headers: corsHeaders }
        );
      }

      // Duplicate UTR check within tenant scope
      const existingVerifiedFee = await Fee.findOne({
        centerId: fee.centerId,
        _id: { $ne: fee._id },
        $or: [
          { utrNumber: cleanUtr, status: { $in: ["Paid", "Partial Paid"] } },
          { processedTxnIds: cleanUtr },
        ],
      });
      if (existingVerifiedFee) {
        await Fee.updateOne({ _id: fee._id, proofUploadLockUntil: lockExpiry }, { $unset: { proofUploadLockUntil: 1 } });
        return NextResponse.json(
          {
            success: false,
            code: "DUPLICATE_UTR_VERIFIED",
            error: "This UTR / transaction reference has already been verified and recorded for another payment.",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      const existingVerifiedProof = await PaymentProof.findOne({
        centerId: fee.centerId,
        feeId: { $ne: fee._id },
        submittedUtr: cleanUtr,
        status: "verified",
      });
      if (existingVerifiedProof) {
        await Fee.updateOne({ _id: fee._id, proofUploadLockUntil: lockExpiry }, { $unset: { proofUploadLockUntil: 1 } });
        return NextResponse.json(
          {
            success: false,
            code: "DUPLICATE_UTR_VERIFIED",
            error: "This UTR / transaction reference has already been verified and recorded for another payment.",
          },
          { status: 409, headers: corsHeaders }
        );
      }

      const existingPendingProof = await PaymentProof.findOne({
        centerId: fee.centerId,
        feeId: { $ne: fee._id },
        submittedUtr: cleanUtr,
        status: "pending_review",
      });
      if (existingPendingProof) {
        await Fee.updateOne({ _id: fee._id, proofUploadLockUntil: lockExpiry }, { $unset: { proofUploadLockUntil: 1 } });
        return NextResponse.json(
          {
            success: false,
            code: "DUPLICATE_UTR_PENDING",
            error: "This UTR / transaction reference is already pending verification on another fee record.",
          },
          { status: 409, headers: corsHeaders }
        );
      }
    }

    // 8.1. Atomic UTR Reservation within Center Scope
    // Leverages MongoDB's unique compound index on { centerId: 1, utrNumber: 1 } (FeeSchema.index)
    // to guarantee mutual exclusion across different Fee documents under concurrent requests.
    let utrClaimAcquired = false;
    const previousUtr = fee.utrNumber || "";

    if (cleanUtr) {
      // Stale recovery: If an expired reservation exists for this UTR on another fee that never completed
      const staleFee = await Fee.findOne({
        centerId: fee.centerId,
        _id: { $ne: fee._id },
        utrNumber: cleanUtr,
        proofUploadLockUntil: { $lte: now },
        hasPaymentProof: { $ne: true },
      });

      if (staleFee) {
        const activeProof = await PaymentProof.findOne({
          feeId: staleFee._id,
          submittedUtr: cleanUtr,
          status: { $in: ["pending_review", "verified"] },
        });
        if (!activeProof) {
          // Safely release stale uncompleted reservation from crashed/interrupted upload
          await Fee.updateOne(
            { _id: staleFee._id, proofUploadLockUntil: staleFee.proofUploadLockUntil },
            { $set: { utrNumber: "" }, $unset: { proofUploadLockUntil: 1 } }
          );
        }
      }

      // Atomic reservation attempt on Fee document
      try {
        const claimDoc = await Fee.findOneAndUpdate(
          {
            _id: fee._id,
            proofUploadLockUntil: lockExpiry,
          },
          {
            $set: { utrNumber: cleanUtr },
          },
          { new: true }
        );

        if (!claimDoc) {
          return NextResponse.json(
            {
              success: false,
              code: "LOCK_LOST",
              error: "Fee upload lock was lost or expired. Please try again.",
            },
            { status: 409, headers: corsHeaders }
          );
        }
        utrClaimAcquired = true;
      } catch (claimErr: any) {
        // Release fee reservation lock
        await Fee.updateOne(
          { _id: fee._id, proofUploadLockUntil: lockExpiry },
          { $unset: { proofUploadLockUntil: 1 } }
        );

        if (claimErr && (claimErr.code === 11000 || String(claimErr).includes("E11000"))) {
          return NextResponse.json(
            {
              success: false,
              code: "DUPLICATE_UTR_CONCURRENT",
              error: "This UTR / transaction reference is already in use or currently being processed for another payment.",
            },
            { status: 409, headers: corsHeaders }
          );
        }

        throw claimErr;
      }
    }

    let validation: any = { valid: true, mimeType: "none", fileSizeBytes: 0, error: "" };
    let uploadResult: any = { fileId: "", fileUrl: "", thumbnailUrl: "", filePath: "", size: 0, mimeType: "none" };
    let uploadFileName = "";

    if (hasScreenshot) {
      validation = validateImageFile(fileBuffer!, declaredMime);
      if (!validation.valid || !validation.mimeType) {
        // Release reservation lock before early exit
        if (utrClaimAcquired) {
          await Fee.updateOne(
            { _id: fee._id, proofUploadLockUntil: lockExpiry },
            { $set: { utrNumber: previousUtr }, $unset: { proofUploadLockUntil: 1 } }
          );
        } else {
          await Fee.updateOne(
            { _id: fee._id, proofUploadLockUntil: lockExpiry },
            { $unset: { proofUploadLockUntil: 1 } }
          );
        }
        return NextResponse.json(
          { success: false, error: validation.error || "Invalid file content" },
          { status: 400, headers: corsHeaders }
        );
      }

      // 9. Upload to ImageKit Server-Side
      const ext = validation.mimeType === "image/png" ? "png" : validation.mimeType === "image/webp" ? "webp" : "jpg";
      uploadFileName = `proof_${fee.centerId}_${fee._id}_${Date.now()}.${ext}`;
      const targetFolder = `/payment-proofs/${fee.centerId}`;

      try {
        uploadResult = await uploadProofToImageKit({
          fileBuffer: fileBuffer!,
          fileName: uploadFileName,
          folder: targetFolder,
          tags: ["payment_proof", fee.centerId, String(fee._id)],
        });
      } catch (uploadErr: unknown) {
        // Release reservation lock immediately upon ImageKit upload failure
        try {
          if (utrClaimAcquired) {
            await Fee.updateOne(
              { _id: fee._id, proofUploadLockUntil: lockExpiry },
              { $set: { utrNumber: previousUtr }, $unset: { proofUploadLockUntil: 1 } }
            );
          } else {
            await Fee.updateOne(
              { _id: fee._id, proofUploadLockUntil: lockExpiry },
              { $unset: { proofUploadLockUntil: 1 } }
            );
          }
        } catch (lockErr) {
          console.warn("[PaymentProof] Failed to release lock after upload error:", lockErr);
        }

        const msg = uploadErr instanceof Error ? uploadErr.message : "Failed to upload image to storage service";
        return NextResponse.json(
          { success: false, error: msg },
          { status: 502, headers: corsHeaders }
        );
      }
    }

    // 10. Database Persistence with Safe Two-Phase Compensation & Reconciliation
    let paymentProofDoc: any = null;
    let imageKitDeleted = false;
    let mongoDeleted = false;

    try {
      paymentProofDoc = await PaymentProof.create({
        centerId: fee.centerId,
        feeId: fee._id,
        studentId: fee.studentId,
        fileId: uploadResult.fileId || "",
        fileUrl: uploadResult.fileUrl || "",
        thumbnailUrl: uploadResult.thumbnailUrl || "",
        filePath: uploadResult.filePath || "",
        fileSizeBytes: validation.fileSizeBytes || 0,
        mimeType: validation.mimeType || "none",
        originalFileName: originalFileName ? originalFileName.slice(0, 100) : uploadFileName,
        submittedUtr: cleanUtr || "",
        submittedAmount: submittedAmount !== undefined ? submittedAmount : fee.amountDue,
        notes: notes ? notes.slice(0, 500) : "",
        status: "pending_review",
        uploadedByRole: parentAccessRecord ? "parent" : (staffUser?.role || "parent"),
        uploadedById: parentAccessRecord ? String(parentAccessRecord._id) : (staffUser?.userId || ""),
        parentPhone: parentAccessRecord ? parentAccessRecord.parentPhone : "",
        whatsappNotificationStatus: "pending",
      });

      // Replacement handling: Transition any older pending proofs for this fee to 'superseded'
      await PaymentProof.updateMany(
        {
          feeId: fee._id,
          status: "pending_review",
          _id: { $ne: paymentProofDoc._id },
        },
        {
          $set: {
            status: "superseded",
            notes: "Superseded by newer payment proof submission",
          },
        }
      );

      // Update Fee Document without modifying financial balance or marking Paid
      fee.status = "Verification Pending";
      fee.hasPaymentProof = true;
      fee.latestPaymentProofId = paymentProofDoc._id;
      if (cleanUtr) {
        fee.utrNumber = cleanUtr;
      } else {
        fee.utrNumber = "";
      }
      if (!fee.paymentMode || fee.paymentMode === "Manual/Cash") {
        fee.paymentMode = "Online/UPI";
      }
      // Release reservation lock upon successful update
      fee.proofUploadLockUntil = null;
      await fee.save();

    } catch (dbErr: unknown) {
      const dbErrorMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error("[PaymentProof] Database persistence failed. Initiating compensation. Error:", dbErrorMsg);

      // 1. Compensate ImageKit asset
      if (uploadResult.fileId) {
        try {
          imageKitDeleted = await deleteFromImageKit(uploadResult.fileId);
        } catch (ikCleanupErr) {
          console.error("[PaymentProof:Reconciliation] Failed to delete ImageKit asset during compensation:", {
            fileId: uploadResult.fileId,
            error: ikCleanupErr instanceof Error ? ikCleanupErr.message : String(ikCleanupErr),
          });
        }
      }

      // 2. Compensate MongoDB: delete ONLY this specific newly inserted PaymentProof record
      if (paymentProofDoc && paymentProofDoc._id) {
        try {
          const delResult = await PaymentProof.findByIdAndDelete(paymentProofDoc._id);
          mongoDeleted = !!delResult;
        } catch (mongoDelErr) {
          console.error("[PaymentProof:Reconciliation] Failed to delete PaymentProof document during compensation:", {
            proofId: paymentProofDoc._id,
            error: mongoDelErr instanceof Error ? mongoDelErr.message : String(mongoDelErr),
          });

          // Fallback: If delete fails, mark record as rejected with reconciliation flag
          // so it never appears as an active pending_review proof
          try {
            await PaymentProof.findByIdAndUpdate(paymentProofDoc._id, {
              status: "rejected",
              rejectionReason: `COMPENSATION_FAILED: Fee update failed (${dbErrorMsg}). Reconciliation required.`,
            });
          } catch (markErr) {
            console.error("[PaymentProof:Reconciliation] Critical: Failed to update dangling proof status:", markErr);
          }
        }
      }

      // 3. Release fee reservation lock and revert UTR reservation
      try {
        if (utrClaimAcquired) {
          await Fee.updateOne(
            { _id: fee._id, proofUploadLockUntil: lockExpiry },
            { $set: { utrNumber: previousUtr }, $unset: { proofUploadLockUntil: 1 } }
          );
        } else {
          await Fee.updateOne(
            { _id: fee._id, proofUploadLockUntil: lockExpiry },
            { $unset: { proofUploadLockUntil: 1 } }
          );
        }
      } catch (lockReleaseErr) {
        console.warn("[PaymentProof] Failed to release fee lock during compensation:", lockReleaseErr);
      }

      // 4. Structured reconciliation audit log
      const reconciliationReport = {
        incident: "PAYMENT_PROOF_PERSISTENCE_FAILURE",
        feeId: String(fee._id),
        proofId: paymentProofDoc ? String(paymentProofDoc._id) : null,
        fileId: uploadResult.fileId,
        imageKitDeleted,
        mongoDeleted: paymentProofDoc ? mongoDeleted : true,
        error: dbErrorMsg,
        timestamp: new Date().toISOString(),
      };
      console.error("[PaymentProof:ReconciliationReport]", JSON.stringify(reconciliationReport));

      return NextResponse.json(
        {
          success: false,
          code: "PERSISTENCE_COMPENSATED",
          error: `Failed to update fee record with payment proof. Uploaded file and record were safely compensated: ${dbErrorMsg}`,
          reconciliation: {
            fileRemoved: imageKitDeleted,
            recordRemoved: mongoDeleted,
            feeId: String(fee._id),
          },
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // 11. Sanitized User-Facing Response with Expiring Signed URLs
    let signedFileUrl = paymentProofDoc.fileUrl || "";
    let signedThumbnailUrl = paymentProofDoc.thumbnailUrl || "";
    let urlExpiresAt: string | null = null;

    if (paymentProofDoc.fileUrl) {
      try {
        const signed = generateSignedImageUrl(paymentProofDoc.fileUrl, 3600);
        signedFileUrl = signed.signedUrl;
        urlExpiresAt = new Date(signed.expiresAt * 1000).toISOString();
        if (paymentProofDoc.thumbnailUrl) {
          signedThumbnailUrl = generateSignedImageUrl(paymentProofDoc.thumbnailUrl, 3600).signedUrl;
        }
      } catch (signErr) {
        console.warn("[PaymentProof] URL signing fallback:", signErr);
      }
    }

    return NextResponse.json(
      {
        success: true,
        message: "Payment proof uploaded successfully. Your payment is pending review by center staff.",
        data: {
          proofId: paymentProofDoc._id,
          feeId: fee._id,
          fileUrl: signedFileUrl,
          thumbnailUrl: signedThumbnailUrl,
          fileSizeBytes: paymentProofDoc.fileSizeBytes,
          mimeType: paymentProofDoc.mimeType,
          status: paymentProofDoc.status,
          submittedUtr: paymentProofDoc.submittedUtr,
          submittedAt: paymentProofDoc.createdAt,
          urlExpiresAt,
        },
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : "Unexpected error during payment proof upload";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}



/**
 * GET /api/fees/[feeId]/payment-proof
 *
 * Retrieves proof metadata for a given fee record.
 * Accessible to authenticated Parents (for their student) and authenticated Staff.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ feeId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const { feeId } = await context.params;

    if (!feeId || !mongoose.Types.ObjectId.isValid(feeId)) {
      return NextResponse.json(
        { success: false, error: "Invalid fee ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    const { authCenterId, parentAccessRecord, staffUser } = await resolveAuth(request);

    if (!authCenterId) {
      return NextResponse.json(
        { success: false, error: "Authentication required to view payment proof" },
        { status: 401, headers: corsHeaders }
      );
    }

    const fee = await Fee.findById(feeId);
    if (!fee) {
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (String(fee.centerId).trim() !== String(authCenterId).trim()) {
      return NextResponse.json(
        { success: false, error: "Access denied: Cross-tenant fee access is strictly forbidden" },
        { status: 403, headers: corsHeaders }
      );
    }

    if (parentAccessRecord) {
      const linked = (parentAccessRecord.linkedStudentIds || []).map((id: any) => String(id));
      if (!linked.includes(String(fee.studentId))) {
        return NextResponse.json(
          { success: false, error: "Access denied: You are not authorized to view proofs for this student" },
          { status: 403, headers: corsHeaders }
        );
      }
    } else if (staffUser && staffUser.role === "teacher") {
      const studentDoc = await Student.findById(fee.studentId)
        .select("assignedTeacherId")
        .lean();
      const teacherId = staffUser.teacherId || staffUser.userId;
      if (
        !studentDoc ||
        String((studentDoc as any).assignedTeacherId) !== String(teacherId)
      ) {
        return NextResponse.json(
          { success: false, error: "Access denied: You are not authorized to view proofs for this student" },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    const proofs = await PaymentProof.find({ feeId: fee._id })
      .select("-imageBuffer")
      .sort({ createdAt: -1 })
      .lean();

    // Dynamically generate signed expiring URLs (valid for 1 hour) so raw CDN URLs are never exposed
    const proofsWithSignedUrls = proofs.map((proof: any) => {
      let signedUrl = proof.fileUrl || "";
      let signedThumb = proof.thumbnailUrl || "";
      let urlExpiresAt: string | null = null;

      if (proof.fileUrl) {
        try {
          const signed = generateSignedImageUrl(proof.fileUrl, 3600);
          signedUrl = signed.signedUrl;
          urlExpiresAt = new Date(signed.expiresAt * 1000).toISOString();
          if (proof.thumbnailUrl) {
            signedThumb = generateSignedImageUrl(proof.thumbnailUrl, 3600).signedUrl;
          }
        } catch (signErr) {
          console.warn("[PaymentProof] Failed to sign URL for proof:", proof._id, signErr);
        }
      }

      return {
        ...proof,
        fileUrl: signedUrl,
        thumbnailUrl: signedThumb,
        urlExpiresAt,
      };
    });

    return NextResponse.json(
      {
        success: true,
        data: proofsWithSignedUrls,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : "Failed to fetch payment proof";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * PUT /api/fees/[feeId]/payment-proof
 *
 * Owner Review Endpoint:
 * Allows authorized Owners to approve or reject a submitted payment proof.
 * - action: "approve" -> Marks proof as "verified", updates fee to "Paid", creates official receipt, appends paymentHistory.
 * - action: "reject" -> Requires non-empty rejectionReason. Marks proof as "rejected", reverts fee status to "Pending", preserves financial ledger.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ feeId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const { feeId } = await context.params;

    if (!feeId || !mongoose.Types.ObjectId.isValid(feeId)) {
      return NextResponse.json(
        { success: false, error: "Invalid fee ID" },
        { status: 400, headers: corsHeaders }
      );
    }

    await connectDB();

    // 1. Authenticate user strictly from verified staff JWT (cookies or Authorization header)
    const staffUser = await getAuthenticatedUser(request);
    if (!staffUser) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Authorize role: Only Institute Owners are authorized to review payment proofs
    if (staffUser.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Only center owners are authorized to review payment proofs.",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const authCenterId = String(staffUser.centerId || "").trim();
    if (!authCenterId) {
      return NextResponse.json(
        { success: false, error: "Invalid center identification in session" },
        { status: 401, headers: corsHeaders }
      );
    }

    // 3. Verify Fee existence and enforce strict tenant isolation
    const fee = await Fee.findById(feeId);
    if (!fee) {
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (String(fee.centerId).trim().toLowerCase() !== authCenterId.toLowerCase()) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Cross-tenant fee review is strictly forbidden",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = String(
      body.action ||
        (body.status === "Paid"
          ? "approve"
          : body.status === "rejected" || body.status === "Pending"
          ? "reject"
          : "")
    )
      .toLowerCase()
      .trim();

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid action. Supported actions: 'approve' or 'reject'.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const now = new Date();

    if (action === "approve") {
      // Prevent duplicate approval
      if (fee.status === "Paid") {
        return NextResponse.json(
          {
            success: false,
            error: "Fee has already been paid and verified. Duplicate approval is rejected.",
          },
          { status: 400, headers: corsHeaders }
        );
      }

      const paymentMode = String(body.paymentMode || fee.paymentMode || "Online/UPI");
      const receiptNumber =
        fee.receiptNumber ||
        body.receiptNumber ||
        `RCPT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      const settledAmount =
        body.paidAmount !== undefined
          ? Number(body.paidAmount)
          : Number(fee.amountDue) || Number(fee.paidAmount) || 0;

      if (body.paidAmount !== undefined && Number(body.paidAmount) > (Number(fee.amountDue) || 0)) {
        return NextResponse.json(
          {
            success: false,
            error: `Approved amount (₹${body.paidAmount}) cannot exceed the outstanding balance (₹${fee.amountDue}).`,
          },
          { status: 400, headers: corsHeaders }
        );
      }

      const remainingBalance = Math.max(0, (Number(fee.amountDue) || 0) - settledAmount);
      fee.paidAmount = (Number(fee.paidAmount) || 0) + settledAmount;
      fee.amountDue = remainingBalance;
      if (remainingBalance === 0) {
        fee.status = "Paid";
      } else {
        fee.status = "Partial Paid";
      }
      fee.paymentMode = paymentMode;
      fee.paidDate = now;
      fee.paidAt = now;
      fee.paymentDate = now;
      fee.receiptNumber = receiptNumber;
      fee.rejectionReason = null;
      fee.proofUploadLockUntil = null;

      // Append structured owner settlement entry - resolve valid ObjectId (never undefined/null)
      let ownerCollectorId: mongoose.Types.ObjectId;
      if (staffUser.userId && mongoose.Types.ObjectId.isValid(staffUser.userId)) {
        ownerCollectorId = new mongoose.Types.ObjectId(staffUser.userId);
      } else if (staffUser.teacherId && mongoose.Types.ObjectId.isValid(staffUser.teacherId)) {
        ownerCollectorId = new mongoose.Types.ObjectId(staffUser.teacherId);
      } else if ((staffUser as any).id && mongoose.Types.ObjectId.isValid((staffUser as any).id)) {
        ownerCollectorId = new mongoose.Types.ObjectId((staffUser as any).id);
      } else {
        const centerDoc = await Center.findOne({ centerId: authCenterId }).select("_id").lean();
        if (centerDoc && centerDoc._id && mongoose.Types.ObjectId.isValid(String(centerDoc._id))) {
          ownerCollectorId = new mongoose.Types.ObjectId(String(centerDoc._id));
        } else {
          ownerCollectorId = new mongoose.Types.ObjectId();
        }
      }

      const ownerPaymentId = new mongoose.Types.ObjectId();
      const ownerPaymentEntry: any = {
        _id: ownerPaymentId,
        paymentId: ownerPaymentId,
        amount: settledAmount,
        paymentDate: now,
        paymentMode,
        receiptNumber,
        isProvisional: false,
        receivedBy: ownerCollectorId,
        receivedByRole: "owner",
        recordedBy: ownerCollectorId,
        recordedByRole: "owner",
        recordedAt: now,
        assignedTeacherAtPayment: fee.assignedTeacherId ?? null,
        batchAtPayment: fee.batchAtPayment || "",
        custodyStatus: "owner_custody",
        allocations: [],
        notes: body.notes ? String(body.notes).trim() : "Approved via Owner Payment Proof Review",
      };

      if (!fee.paymentHistory) {
        fee.paymentHistory = [];
      }
      fee.paymentHistory.push(ownerPaymentEntry);

      // Ensure all items in paymentHistory satisfy required receivedBy/recordedBy constraints
      for (const entry of fee.paymentHistory) {
        if (!entry.receivedBy) entry.receivedBy = ownerCollectorId;
        if (!entry.recordedBy) entry.recordedBy = ownerCollectorId;
        if (!entry.receivedByRole) entry.receivedByRole = "owner";
        if (!entry.recordedByRole) entry.recordedByRole = "owner";
        if (!entry.receiptNumber) entry.receiptNumber = `REC-${fee._id}-${Date.now()}`;
      }

      if (!fee.recordedBy) {
        fee.recordedBy = ownerCollectorId;
        fee.recordedByRole = "owner";
      }
      if (!fee.receivedBy) {
        fee.receivedBy = ownerCollectorId;
        fee.receivedByRole = "owner";
      }
      if (!fee.recordedAt) {
        fee.recordedAt = now;
      }

      await fee.save();

      // Smart Advance Wallet: If this is an advance fee and owner approved it, credit student wallet
      if (
        (fee.isAdvance || fee.feeType === "advance") &&
        !fee.walletRechargeCredited &&
        fee.status === "Paid"
      ) {
        const studentObjId =
          (fee.studentId as unknown as { _id?: unknown })?._id ||
          fee.studentId;
        const creditAmt =
          settledAmount > 0
            ? settledAmount
            : Number(fee.paidAmount) || Number(fee.amountDue) || 0;

        if (creditAmt > 0 && studentObjId) {
          try {
            await creditAdvanceToStudentWallet({
              centerId: fee.centerId,
              studentId: String(studentObjId),
              amount: creditAmt,
              feeId: String(fee._id),
            });
            fee.walletRechargeCredited = true;
          } catch (walletErr) {
            console.error("[PAYMENT PROOF APPROVAL] Error crediting advance wallet:", walletErr);
          }
        }
      }

      // Mark payment proof as verified
      const proofConditions: Record<string, unknown> = {
        feeId: fee._id,
        status: "pending_review",
      };
      if (body.proofId && mongoose.Types.ObjectId.isValid(body.proofId)) {
        proofConditions._id = body.proofId;
      }

      await PaymentProof.updateMany(proofConditions, {
        $set: {
          status: "verified",
          reviewedBy: ownerCollectorId,
          reviewedAt: now,
        },
      });

      return NextResponse.json(
        {
          success: true,
          message: "Payment proof verified and fee marked as Paid.",
          data: fee,
        },
        { status: 200, headers: corsHeaders }
      );
    } else {
      // action === "reject"
      const rejectionReason = String(body.rejectionReason || body.reason || body.notes || "").trim();
      if (!rejectionReason) {
        return NextResponse.json(
          {
            success: false,
            error: "Rejection reason is required. Please provide a clear explanation for the parent.",
          },
          { status: 400, headers: corsHeaders }
        );
      }

      // Revert fee to Pending (or Partial Paid if previous partial payments exist) and save rejectionReason
      fee.status = (fee.paidAmount && Number(fee.paidAmount) > 0) ? "Partial Paid" : "Pending";
      fee.rejectionReason = rejectionReason;
      fee.utrNumber = "";
      fee.proofUploadLockUntil = null;
      await fee.save();

      // Mark proof as rejected, preserve ImageKit asset and record for audit
      const proofConditions: Record<string, unknown> = {
        feeId: fee._id,
        status: "pending_review",
      };
      if (body.proofId && mongoose.Types.ObjectId.isValid(body.proofId)) {
        proofConditions._id = body.proofId;
      }

      const reviewerId = (staffUser.userId && mongoose.Types.ObjectId.isValid(staffUser.userId))
        ? new mongoose.Types.ObjectId(staffUser.userId)
        : undefined;

      const proofUpdateFields: Record<string, unknown> = {
        status: "rejected",
        rejectionReason,
        reviewedAt: now,
      };
      if (reviewerId) {
        proofUpdateFields.reviewedBy = reviewerId;
      }

      await PaymentProof.updateMany(proofConditions, {
        $set: proofUpdateFields,
      });

      return NextResponse.json(
        {
          success: true,
          message: "Payment proof rejected and fee returned to Pending.",
          data: fee,
        },
        { status: 200, headers: corsHeaders }
      );
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : "Failed to review payment proof";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}

export const PATCH = PUT;



