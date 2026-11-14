import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Student from "../../../../models/Student.ts";
import ParentAccess from "../../../../models/ParentAccess.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";
import {
  getOrCreateParentAccess,
  regenerateParentAccess,
  revokeParentAccess,
  linkStudentToParentAccess,
  unlinkStudentFromParentAccess,
  getRecoverableInvitationToken,
  portalSecurityHeaders,
} from "../../../../lib/parentAccessService.ts";
import {
  buildPortalActivationUrl,
  getPortalAppBaseUrl,
} from "../../../../lib/portalLinks.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: responseHeaders }
      );
    }

    // Strict Owner-only authorization: Teachers must receive HTTP 403 for all management actions
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner authorization required" },
        { status: 403, headers: responseHeaders }
      );
    }

    await connectDB();

    const { searchParams } = request.nextUrl;
    const studentId = searchParams.get("studentId");
    const parentAccessId = searchParams.get("parentAccessId");

    const query: Record<string, unknown> = { centerId: user.centerId };

    if (parentAccessId && mongoose.Types.ObjectId.isValid(parentAccessId)) {
      query._id = new mongoose.Types.ObjectId(parentAccessId);
    } else if (studentId && mongoose.Types.ObjectId.isValid(studentId)) {
      query.linkedStudentIds = new mongoose.Types.ObjectId(studentId);
    } else {
      return NextResponse.json(
        { success: false, error: "studentId or parentAccessId is required" },
        { status: 400, headers: responseHeaders }
      );
    }

    const accessDoc = await ParentAccess.findOne(query).populate({
      path: "linkedStudentIds",
      select: "name batch rollNumber parentWhatsApp isActive",
    });

    if (!accessDoc) {
      return NextResponse.json(
        {
          success: true,
          exists: false,
          parentAccess: null,
          data: {
            success: true,
            exists: false,
            parentAccess: null,
          },
        },
        { status: 200, headers: responseHeaders }
      );
    }

    // Rebuild the canonical activation link from the encrypted token copy.
    // Non-destructive: the token is NOT rotated, so the link the parent already
    // holds keeps working.
    const recoverableToken = getRecoverableInvitationToken(accessDoc);
    const portalUrl = recoverableToken
      ? buildPortalActivationUrl(recoverableToken, getPortalAppBaseUrl())
      : null;

    const accessData = {
      id: String(accessDoc._id),
      centerId: accessDoc.centerId,
      parentPhone: accessDoc.parentPhone,
      parentName: accessDoc.parentName,
      tokenPrefix: accessDoc.tokenPrefix,
      status: accessDoc.status,
      isPasswordProtected: Boolean(accessDoc.isPasswordProtected),
      linkedStudents: accessDoc.linkedStudentIds,
      lastAccessedAt: accessDoc.lastAccessedAt,
      createdAt: accessDoc.createdAt,
      revokedAt: accessDoc.revokedAt,
      revocationReason: accessDoc.revocationReason,
      portalUrl,
    };

    return NextResponse.json(
      {
        success: true,
        exists: true,
        parentAccess: accessData,
        portalUrl,
        data: {
          success: true,
          exists: true,
          parentAccess: accessData,
          portalUrl,
        },
      },
      { status: 200, headers: responseHeaders }
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to load parent access";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: responseHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: responseHeaders }
      );
    }

    // Strict Owner-only authorization: Teachers must receive HTTP 403 for all management actions
    if (user.role !== "owner") {
      return NextResponse.json(
        { success: false, error: "Access denied: Owner authorization required" },
        { status: 403, headers: responseHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").toLowerCase();
    const baseUrl = getPortalAppBaseUrl();

    if (action === "generate") {
      const studentId = body.studentId;
      if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
        return NextResponse.json(
          { success: false, error: "Valid studentId is required" },
          { status: 400, headers: responseHeaders }
        );
      }

      const result = await getOrCreateParentAccess(user.centerId, studentId, {
        parentName: body.parentName,
        parentPhone: body.parentPhone,
      });

      // If already existed, reuse the link the parent already holds. Only
      // regenerate when no recoverable credential exists (legacy record),
      // because regeneration invalidates the previously delivered link.
      let rawToken = result.rawToken;
      let accessDoc = result.parentAccess;

      if (!rawToken) {
        const recoverableToken = getRecoverableInvitationToken(accessDoc);
        if (recoverableToken) {
          rawToken = recoverableToken;
        } else {
          const regenResult = await regenerateParentAccess(
            user.centerId,
            accessDoc._id
          );
          rawToken = regenResult.rawToken;
          accessDoc = regenResult.parentAccess;
        }
      }

      const portalUrl = `${baseUrl}/portal#token=${rawToken}`;

      const accessData = {
        id: String(accessDoc._id),
        parentPhone: accessDoc.parentPhone,
        parentName: accessDoc.parentName,
        tokenPrefix: accessDoc.tokenPrefix,
        status: accessDoc.status,
        isPasswordProtected: Boolean(accessDoc.isPasswordProtected),
        linkedStudentIds: accessDoc.linkedStudentIds,
      };

      const payload = {
        success: true,
        message: "Portal link generated successfully",
        portalUrl,
        rawToken,
        tokenPrefix: accessDoc.tokenPrefix,
        parentAccess: accessData,
      };

      return NextResponse.json(
        {
          ...payload,
          data: payload,
        },
        { status: 201, headers: responseHeaders }
      );
    } else if (action === "regenerate") {
      const parentAccessId = body.parentAccessId;
      if (!parentAccessId || !mongoose.Types.ObjectId.isValid(parentAccessId)) {
        return NextResponse.json(
          { success: false, error: "Valid parentAccessId is required" },
          { status: 400, headers: responseHeaders }
        );
      }

      const result = await regenerateParentAccess(user.centerId, parentAccessId);
      const portalUrl = `${baseUrl}/portal#token=${result.rawToken}`;

      const accessData = {
        id: String(result.parentAccess._id),
        parentPhone: result.parentAccess.parentPhone,
        parentName: result.parentAccess.parentName,
        tokenPrefix: result.parentAccess.tokenPrefix,
        status: result.parentAccess.status,
        isPasswordProtected: Boolean(result.parentAccess.isPasswordProtected),
        linkedStudentIds: result.parentAccess.linkedStudentIds,
      };

      const payload = {
        success: true,
        message: "Portal link regenerated successfully. Old link has been invalidated.",
        portalUrl,
        rawToken: result.rawToken,
        tokenPrefix: result.parentAccess.tokenPrefix,
        parentAccess: accessData,
      };

      return NextResponse.json(
        {
          ...payload,
          data: payload,
        },
        { status: 200, headers: responseHeaders }
      );
    } else if (action === "revoke") {
      const parentAccessId = body.parentAccessId;
      if (!parentAccessId || !mongoose.Types.ObjectId.isValid(parentAccessId)) {
        return NextResponse.json(
          { success: false, error: "Valid parentAccessId is required" },
          { status: 400, headers: responseHeaders }
        );
      }

      const accessDoc = await revokeParentAccess(
        user.centerId,
        parentAccessId,
        body.reason || "Revoked by institute owner"
      );

      const accessData = {
        id: String(accessDoc._id),
        status: accessDoc.status,
        revokedAt: accessDoc.revokedAt,
        revocationReason: accessDoc.revocationReason,
      };

      const payload = {
        success: true,
        message: "Portal access link revoked successfully.",
        parentAccess: accessData,
      };

      return NextResponse.json(
        {
          ...payload,
          data: payload,
        },
        { status: 200, headers: responseHeaders }
      );
    } else if (action === "link_student") {
      const { parentAccessId, studentIdToLink } = body;
      if (
        !parentAccessId ||
        !mongoose.Types.ObjectId.isValid(parentAccessId) ||
        !studentIdToLink ||
        !mongoose.Types.ObjectId.isValid(studentIdToLink)
      ) {
        return NextResponse.json(
          { success: false, error: "Valid parentAccessId and studentIdToLink are required" },
          { status: 400, headers: responseHeaders }
        );
      }

      const accessDoc = await linkStudentToParentAccess(
        user.centerId,
        parentAccessId,
        studentIdToLink
      );

      const accessData = {
        id: String(accessDoc._id),
        linkedStudentIds: accessDoc.linkedStudentIds,
      };

      const payload = {
        success: true,
        message: "Student linked to portal access successfully",
        parentAccess: accessData,
      };

      return NextResponse.json(
        {
          ...payload,
          data: payload,
        },
        { status: 200, headers: responseHeaders }
      );
    } else if (action === "unlink_student") {
      const { parentAccessId, studentIdToUnlink } = body;
      if (
        !parentAccessId ||
        !mongoose.Types.ObjectId.isValid(parentAccessId) ||
        !studentIdToUnlink ||
        !mongoose.Types.ObjectId.isValid(studentIdToUnlink)
      ) {
        return NextResponse.json(
          { success: false, error: "Valid parentAccessId and studentIdToUnlink are required" },
          { status: 400, headers: responseHeaders }
        );
      }

      const accessDoc = await unlinkStudentFromParentAccess(
        user.centerId,
        parentAccessId,
        studentIdToUnlink
      );

      const accessData = {
        id: String(accessDoc._id),
        linkedStudentIds: accessDoc.linkedStudentIds,
      };

      const payload = {
        success: true,
        message: "Student unlinked from portal access successfully",
        parentAccess: accessData,
      };

      return NextResponse.json(
        {
          ...payload,
          data: payload,
        },
        { status: 200, headers: responseHeaders }
      );
    } else {
      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid action. Expected 'generate', 'regenerate', 'revoke', 'link_student', or 'unlink_student'.",
        },
        { status: 400, headers: responseHeaders }
      );
    }
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to process parent access operation";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 400, headers: responseHeaders }
    );
  }
}
