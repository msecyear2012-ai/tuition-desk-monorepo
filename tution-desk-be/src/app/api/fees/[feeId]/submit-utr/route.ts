import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Fee from "../../../../../models/Fee.ts";
import Student from "../../../../../models/Student.ts";
import { getAuthenticatedUser } from "../../../../../lib/auth.ts";
import {
  validateParentSession,
  resolvePortalToken,
} from "../../../../../lib/parentAccessService.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, PUT, OPTIONS");
}

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

    const body = await request.json().catch(() => ({}));
    const { utrNumber, fallbackClaim } = body;

    await connectDB();

    // 1. Resolve Authentication: Parent Portal or Staff (Owner / Teacher)
    let authCenterId: string | null = null;
    let authorizedForStudent = false;

    // A. Check Parent Portal Session Token (Cookie or Authorization: Bearer header)
    const sessionCookie = request.cookies.get("parent_portal_session")?.value;
    const authHeader = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const sessionToken = sessionCookie || authHeader;

    const rawToken =
      (request.nextUrl ? request.nextUrl.searchParams.get("token") : null) ||
      request.headers.get("x-portal-token") ||
      (typeof body.token === "string" ? body.token.trim() : null);

    let parentAccessRecord: any = null;

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

    // B. Check Staff Authentication (Owner or Teacher) if not resolved as parent
    let staffUser: any = null;
    if (!authCenterId) {
      staffUser = await getAuthenticatedUser(request);
      if (staffUser && staffUser.centerId) {
        authCenterId = String(staffUser.centerId);
      }
    }

    // Fail closed: Reject unauthenticated callers immediately before database lookups
    if (!authCenterId) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required to submit payment reference",
        },
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Fetch Fee Document
    const fee = await Fee.findById(feeId);
    if (!fee) {
      return NextResponse.json(
        { success: false, error: "Fee record not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. Strict Tenant Isolation: Ensure fee belongs to the authenticated center
    if (String(fee.centerId).trim() !== String(authCenterId).trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Cross-tenant fee submission is strictly forbidden",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 4. Verify Authorization for this Specific Student
    const targetStudentId = String(fee.studentId);

    if (parentAccessRecord) {
      const linked = parentAccessRecord.linkedStudentIds.map((id: any) =>
        String(id)
      );
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
          error: "Access denied: You are not authorized to submit payments for this student",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 5. Prevent Inappropriate State Transitions
    if (fee.status === "Paid") {
      return NextResponse.json(
        {
          success: false,
          error: "Fee is already marked as paid. UTR submission not allowed.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if ((fee.status as string) === "Cancelled" || (fee.status as string) === "Waived") {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot submit payment for cancelled or waived fee.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 6. Validate & Sanitize UTR Input
    const isFallback = Boolean(fallbackClaim || body.isDelayedFallback);
    let cleanUtr = typeof utrNumber === "string" ? utrNumber.trim() : "";

    if (!cleanUtr && isFallback) {
      cleanUtr = `CLAIM_DELAYED_${Date.now().toString().slice(-6)}`;
    } else if (!cleanUtr) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Please enter a valid 12-digit UTR / Reference number or submit fallback claim",
        },
        { status: 400, headers: corsHeaders }
      );
    } else {
      // Validate alphanumeric UTR (min 6, max 30 characters)
      const sanitized = cleanUtr.replace(/[^a-zA-Z0-9_-]/g, "");
      if (sanitized.length < 6 || sanitized.length > 30) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Please enter a valid 12-digit UTR / Reference number (minimum 6 alphanumeric characters)",
          },
          { status: 400, headers: corsHeaders }
        );
      }
      cleanUtr = sanitized;
    }

    // 7. Update Fee Document
    fee.status = "Verification Pending";
    fee.utrNumber = cleanUtr;
    fee.paymentDate = new Date();
    fee.paidDate = new Date();
    fee.paymentMode = "Online/UPI";

    await fee.save();

    const populatedFee = await Fee.findById(fee._id)
      .populate("studentId")
      .lean();

    return NextResponse.json(
      {
        success: true,
        message:
          "UTR submitted successfully. Verification pending with center admin.",
        data: populatedFee,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to submit UTR reference";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

export const POST = PUT;

