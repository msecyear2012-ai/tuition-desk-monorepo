import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../../lib/db.ts";
import Student from "../../../../../models/Student.ts";
import Attendance from "../../../../../models/Attendance.ts";
import Fee from "../../../../../models/Fee.ts";
import Test from "../../../../../models/Test.ts";
import Center from "../../../../../models/Center.ts";
import {
  getCorsHeaders,
  handleCorsPreflight,
  validateRequestOrigin,
} from "../../../../../lib/cors.ts";
import {
  resolvePortalToken,
  validateParentSession,
  verifyParentPassword,
  portalSecurityHeaders,
} from "../../../../../lib/parentAccessService.ts";
import { signToken } from "../../../../../lib/auth.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, OPTIONS");
}

function calculateDaysLate(dueDate?: Date | string | null): number {
  if (!dueDate) return 0;
  const due = new Date(dueDate);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)
  );
  return Math.max(0, diffDays);
}

/**
 * POST /api/parent/portal/exchange
 * Exchanges a raw portal token transmitted via POST JSON body for a secure HttpOnly session.
 * Alternatively, restores or switches children within an existing active session.
 * Guarantees:
 * - Zero URL token exposure
 * - Zero server/proxy access log token leakage
 * - Automatic HttpOnly session issuance
 * - Live MongoDB sibling unlink isolation
 * - Strict no-cache and no-referrer headers
 */
export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    // 0. Strict Origin Validation Preflight (Defense-in-depth against unauthorized cross-origin POSTs)
    const originCheck = validateRequestOrigin(request);
    if (!originCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Cross-origin request forbidden: Origin is not authorized",
        },
        { status: 403, headers: responseHeaders }
      );
    }

    await connectDB();

    const body = await request.json().catch(() => ({}));
    const rawToken = typeof body?.token === "string" ? body.token.trim() : "";
    const requestedStudentId =
      typeof body?.studentId === "string" ? body.studentId.trim() : "";

    let parentAccess: any = null;
    let initialPasswordRequired = false;

    // 1. Dual Mode Resolution: Token Exchange vs Existing Session
    if (rawToken) {
      // Token resolution: Never log rawToken
      const tokenResult = await resolvePortalToken(rawToken);

      if (!tokenResult.valid) {
        if (tokenResult.reason === "locked") {
          return NextResponse.json(
            {
              success: false,
              locked: true,
              lockoutUntil: tokenResult.lockoutUntil,
              error:
                "Portal access temporarily locked due to excessive failed password attempts. Please try again later.",
            },
            { status: 429, headers: responseHeaders }
          );
        }

        if (tokenResult.reason === "revoked") {
          return NextResponse.json(
            {
              success: false,
              revoked: true,
              error:
                "This portal access link has been revoked by the tuition center. Please contact the center for a new link.",
            },
            { status: 403, headers: responseHeaders }
          );
        }

        return NextResponse.json(
          {
            success: false,
            error: "Invalid or unrecognized portal access token.",
          },
          { status: 404, headers: responseHeaders }
        );
      }

      parentAccess = tokenResult.parentAccess!;

      // Password Protection Gate (if configured by parent)
      if (parentAccess.isPasswordProtected) {
        const sessionCookie = request.cookies.get("parent_portal_session")?.value;
        const authHeader = request.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "");
        const sessionToken = sessionCookie || authHeader;

        let isSessionAuthorized = false;
        if (sessionToken) {
          const sessionResult = await validateParentSession(sessionToken);
          if (
            sessionResult.valid &&
            String(sessionResult.parentAccess?._id) === String(parentAccess._id) &&
            sessionResult.parentAccess?.centerId === parentAccess.centerId
          ) {
            isSessionAuthorized = true;
          }
        }

        if (!isSessionAuthorized) {
          initialPasswordRequired = true;
        }
      }
    } else {
      // Session restoration / child switch mode
      const sessionCookie = request.cookies.get("parent_portal_session")?.value;
      const authHeader = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "");
      const sessionToken = sessionCookie || authHeader;

      if (!sessionToken) {
        return NextResponse.json(
          {
            success: false,
            error: "Authentication required: Active parent session or token required",
          },
          { status: 401, headers: responseHeaders }
        );
      }

      const sessionResult = await validateParentSession(sessionToken);
      if (!sessionResult.valid) {
        return NextResponse.json(
          {
            success: false,
            error: sessionResult.error || "Session invalidated or expired",
            revoked: sessionResult.statusCode === 403,
          },
          { status: sessionResult.statusCode || 401, headers: responseHeaders }
        );
      }

      parentAccess = sessionResult.parentAccess!;
    }

    // 2. Center Profile
    const centerDoc = await Center.findOne({ centerId: parentAccess.centerId }).lean();
    const centerName = centerDoc?.name || "Tuition Center";
    const center = centerDoc
      ? {
          name: centerDoc.name,
          ownerName: centerDoc.ownerName,
          phone: centerDoc.phone,
          upiId: centerDoc.upiId || "9876543210@paytm",
        }
      : {
          name: "Tuition Center",
          ownerName: "Center Head",
          phone: "9876543210",
          upiId: "9876543210@paytm",
        };

    // If password prompt is required for token entry, challenge user without revealing data
    if (initialPasswordRequired) {
      return NextResponse.json(
        {
          success: true,
          requirePassword: true,
          isPasswordProtected: true,
          parentAccessId: String(parentAccess._id),
          center: {
            name: centerName,
            phone: center.phone,
          },
        },
        { status: 200, headers: responseHeaders }
      );
    }

    // 3. Update lastAccessedAt (non-blocking)
    parentAccess.lastAccessedAt = new Date();
    await parentAccess.save().catch(() => {});

    // 4. Fetch all explicitly linked students strictly within this center
    const linkedStudentsDocs = await Student.find({
      _id: { $in: parentAccess.linkedStudentIds },
      centerId: parentAccess.centerId,
    }).lean();

    if (linkedStudentsDocs.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No active student records found for this portal access link.",
        },
        { status: 404, headers: responseHeaders }
      );
    }

    // 5. Sibling Unlink Isolation Verification
    let targetStudent = linkedStudentsDocs[0];
    if (requestedStudentId && mongoose.Types.ObjectId.isValid(requestedStudentId)) {
      const match = linkedStudentsDocs.find(
        (s) => String(s._id) === requestedStudentId
      );
      if (!match) {
        return NextResponse.json(
          {
            success: false,
            error: "Access denied: Student is not linked to this parent access",
          },
          { status: 403, headers: responseHeaders }
        );
      }
      targetStudent = match;
    }

    const studentObjectId = targetStudent._id;

    // 6. Aggregate student attendance, fees, and test results
    const [attendanceRecords, feeRecords, testsList] = await Promise.all([
      Attendance.find({ studentId: studentObjectId }).sort({ date: -1 }).lean(),
      Fee.find({ studentId: studentObjectId }).sort({ dueDate: -1 }).lean(),
      Test.find({
        centerId: parentAccess.centerId,
        "results.studentId": studentObjectId,
      })
        .sort({ date: -1 })
        .lean(),
    ]);

    const totalClasses = attendanceRecords.length;
    const attended = attendanceRecords.filter((a) => a.status === "Present").length;
    const missed = totalClasses - attended;
    const attendancePercentage =
      totalClasses > 0 ? Math.round((attended / totalClasses) * 100) : 100;

    const attendanceStats = {
      percentage: attendancePercentage,
      totalClasses,
      attended,
      missed,
      history: attendanceRecords.map((a) => ({
        id: String(a._id),
        date: a.date ? new Date(a.date).toISOString() : new Date().toISOString(),
        batch: a.batch,
        status: a.status,
      })),
    };

    const pendingFee = feeRecords.find(
      (f) => f.status === "Pending" || f.status === "Verification Pending"
    );
    const pendingAmount = pendingFee ? Number(pendingFee.amountDue) || 0 : 0;
    const dueDate = pendingFee?.dueDate
      ? new Date(pendingFee.dueDate).toISOString()
      : null;
    const daysLate = calculateDaysLate(dueDate);

    const fees = {
      feeId: pendingFee ? String(pendingFee._id) : null,
      amountDue: pendingAmount,
      pendingAmount,
      dueDate,
      daysLate,
      status: pendingFee ? pendingFee.status : "Paid",
      utrNumber: pendingFee?.utrNumber || "",
      month: pendingFee?.month || "Current Cycle",
      history: feeRecords.map((f) => ({
        id: String(f._id),
        month: f.month,
        title: f.title || f.month,
        amountDue: f.amountDue,
        paidAmount: typeof f.paidAmount === "number" ? f.paidAmount : (Number(f.paidAmount) || 0),
        dueDate: f.dueDate ? new Date(f.dueDate).toISOString() : null,
        status: f.status,
        utrNumber: f.utrNumber,
        receiptNumber: f.receiptNumber || "",
        paymentDate: f.paymentDate ? new Date(f.paymentDate).toISOString() : null,
        paidDate: f.paidDate ? new Date(f.paidDate).toISOString() : f.paymentDate,
        paidAt: f.paidAt ? new Date(f.paidAt).toISOString() : null,
        paymentMode: f.paymentMode || "UPI",
        createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
      })),
    };

    const testResults = testsList.map((test) => {
      const studentResult = test.results?.find(
        (r: any) => String(r.studentId) === String(studentObjectId)
      );
      const marksObtained = studentResult ? Number(studentResult.marksObtained) : 0;
      const isAbsent = studentResult ? Boolean(studentResult.isAbsent) : false;
      const percentage =
        test.maxMarks && test.maxMarks > 0
          ? Math.round((marksObtained / test.maxMarks) * 100)
          : 0;

      return {
        id: String(test._id),
        title: test.title,
        batch: test.batch,
        date: test.date ? new Date(test.date).toISOString() : new Date().toISOString(),
        maxMarks: test.maxMarks,
        marksObtained,
        isAbsent,
        percentage,
      };
    });

    // 7. Issue HttpOnly parent_portal_session cookie bound to credential version
    const sessionToken = await signToken({
      parentAccessId: String(parentAccess._id),
      centerId: parentAccess.centerId,
      tokenPrefix: parentAccess.tokenPrefix,
      role: "parent",
      linkedStudentIds: linkedStudentsDocs.map((s) => String(s._id)),
    });

    const response = NextResponse.json(
      {
        success: true,
        requirePassword: false,
        parent: {
          id: String(parentAccess._id),
          parentName: parentAccess.parentName,
          parentPhone: parentAccess.parentPhone,
          tokenPrefix: parentAccess.tokenPrefix,
          isPasswordProtected: Boolean(parentAccess.isPasswordProtected),
          linkedStudents: linkedStudentsDocs.map((s) => ({
            _id: String(s._id),
            name: s.name,
            batch: s.batch,
            rollNumber: s.rollNumber,
          })),
          selectedStudentId: String(targetStudent._id),
        },
        student: {
          _id: String(targetStudent._id),
          centerId: targetStudent.centerId,
          name: targetStudent.name,
          batch: targetStudent.batch,
          parentWhatsApp: targetStudent.parentWhatsApp,
          isActive: targetStudent.isActive,
          monthlyFee: targetStudent.monthlyFee,
          billingCycleDate: targetStudent.billingCycleDate,
          joiningDate: targetStudent.joiningDate,
        },
        center,
        attendanceStats,
        fees,
        testResults,
        sessionToken,
      },
      { status: 200, headers: responseHeaders }
    );

    response.cookies.set({
      name: "parent_portal_session",
      value: sessionToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    return response;
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to exchange portal token";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: responseHeaders }
    );
  }
}
