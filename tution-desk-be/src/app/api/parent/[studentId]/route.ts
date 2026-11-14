import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/db";
import Student from "@/models/Student";
import Attendance from "@/models/Attendance";
import Fee from "@/models/Fee";
import Test from "@/models/Test";
import Center from "@/models/Center";
import ParentAccess from "@/models/ParentAccess";
import { getCorsHeaders, handleCorsPreflight } from "@/lib/cors";
import {
  resolvePortalToken,
  validateParentSession,
  portalSecurityHeaders,
} from "@/lib/parentAccessService";
import { signToken } from "@/lib/auth";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ studentId: string }> }
) {
  const corsHeaders = getCorsHeaders(request);
  const responseHeaders = { ...corsHeaders, ...portalSecurityHeaders };

  try {
    await connectDB();

    const { studentId } = await context.params;

    if (!studentId || !studentId.trim()) {
      return NextResponse.json(
        { success: false, error: "Identifier is required" },
        { status: 400, headers: responseHeaders }
      );
    }

    const cleanId = studentId.trim();

    // 1. If identifier is a high-entropy portal token (starts with pt_ or matches token hash)
    if (cleanId.startsWith("pt_")) {
      const tokenResult = await resolvePortalToken(cleanId);
      if (!tokenResult.valid) {
        if (tokenResult.reason === "locked") {
          return NextResponse.json(
            {
              success: false,
              locked: true,
              lockoutUntil: tokenResult.lockoutUntil,
              error:
                "Portal access temporarily locked due to excessive failed password attempts.",
            },
            { status: 429, headers: responseHeaders }
          );
        }
        if (tokenResult.reason === "revoked") {
          return NextResponse.json(
            {
              success: false,
              revoked: true,
              error: "This portal access link has been revoked by the tuition center.",
            },
            { status: 403, headers: responseHeaders }
          );
        }
        return NextResponse.json(
          { success: false, error: "Invalid or unrecognized portal access link." },
          { status: 404, headers: responseHeaders }
        );
      }

      const parentAccess = tokenResult.parentAccess!;

      // Center
      const centerDoc = await Center.findOne({ centerId: parentAccess.centerId }).lean();
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

      // Password check
      if (parentAccess.isPasswordProtected) {
        const sessionCookie = request.cookies.get("parent_portal_session")?.value;
        const authHeader = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
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
          return NextResponse.json(
            {
              success: true,
              requirePassword: true,
              isPasswordProtected: true,
              center: { name: center.name, phone: center.phone },
            },
            { status: 200, headers: responseHeaders }
          );
        }
      }

      // Resolve linked students
      const linkedStudentsDocs = await Student.find({
        _id: { $in: parentAccess.linkedStudentIds },
        centerId: parentAccess.centerId,
      }).lean();

      if (linkedStudentsDocs.length === 0) {
        return NextResponse.json(
          { success: false, error: "No active student records found for this link." },
          { status: 404, headers: corsHeaders }
        );
      }

      const { searchParams } = request.nextUrl;
      const requestedChildId = searchParams.get("studentId");
      let targetStudent = linkedStudentsDocs[0];
      if (requestedChildId && mongoose.Types.ObjectId.isValid(requestedChildId)) {
        const match = linkedStudentsDocs.find(
          (s) => String(s._id) === requestedChildId
        );
        if (match) targetStudent = match;
      }

      const studentObjectId = targetStudent._id;

      // Concurrently query related records
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
          paidDate: f.paidDate
            ? new Date(f.paidDate).toISOString()
            : f.paymentDate
            ? new Date(f.paymentDate).toISOString()
            : null,
          paidAt: f.paidAt ? new Date(f.paidAt).toISOString() : null,
          paymentMode: f.paymentMode || "Manual/Cash",
          createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
        })),
      };

      const testResults = testsList.map((test) => {
        const resultEntry = (test.results || []).find(
          (r: any) => String(r.studentId) === String(studentObjectId)
        );
        const marksObtained = resultEntry ? Number(resultEntry.marksObtained) || 0 : 0;
        const isAbsent = Boolean(resultEntry?.isAbsent);
        const percentage =
          test.maxMarks > 0
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
    }

    // 2. Fallback: legacy studentId (ObjectId)
    if (!mongoose.Types.ObjectId.isValid(cleanId)) {
      return NextResponse.json(
        { success: false, error: "Invalid identifier" },
        { status: 404, headers: responseHeaders }
      );
    }

    const student = await Student.findById(cleanId).lean();

    if (!student) {
      return NextResponse.json(
        { success: false, error: "Student record not found" },
        { status: 404, headers: responseHeaders }
      );
    }

    // Check if ParentAccess exists for this student and enforces revocation or password
    const parentAccess = await ParentAccess.findOne({
      centerId: student.centerId,
      linkedStudentIds: student._id,
    });

    if (parentAccess) {
      // Immediate revocation enforcement
      if (parentAccess.status === "revoked") {
        return NextResponse.json(
          {
            success: false,
            revoked: true,
            error: "This portal access link has been revoked by the tuition center.",
          },
          { status: 403, headers: responseHeaders }
        );
      }

      const sessionCookie = request.cookies.get("parent_portal_session")?.value;
      const authHeader = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const sessionToken = sessionCookie || authHeader;

      if (sessionToken) {
        const sessionResult = await validateParentSession(sessionToken);
        if (!sessionResult.valid) {
          return NextResponse.json(
            {
              success: false,
              error: sessionResult.error || "Session invalidated",
              revoked: sessionResult.statusCode === 403,
            },
            { status: sessionResult.statusCode || 401, headers: responseHeaders }
          );
        }

        if (
          !sessionResult.parentAccess!.linkedStudentIds.some(
            (id) => String(id) === String(student._id)
          )
        ) {
          return NextResponse.json(
            {
              success: false,
              error: "Access denied to this student record",
            },
            { status: 403, headers: responseHeaders }
          );
        }
      } else if (parentAccess.isPasswordProtected) {
        const centerDoc = await Center.findOne({ centerId: student.centerId }).lean();
        return NextResponse.json(
          {
            success: true,
            requirePassword: true,
            isPasswordProtected: true,
            center: { name: centerDoc?.name || "Tuition Center", phone: centerDoc?.phone || "" },
          },
          { status: 200, headers: responseHeaders }
        );
      }
    }

    const studentObjectId = student._id;

    const [attendanceRecords, feeRecords, testsList, centerDoc] =
      await Promise.all([
        Attendance.find({
          studentId: studentObjectId,
        })
          .sort({ date: -1 })
          .lean(),

        Fee.find({
          studentId: studentObjectId,
        })
          .sort({ dueDate: -1 })
          .lean(),

        Test.find({
          centerId: student.centerId,
          "results.studentId": studentObjectId,
        })
          .sort({ date: -1 })
          .lean(),

        Center.findOne({ centerId: student.centerId }).lean(),
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
        paymentDate: f.paymentDate
          ? new Date(f.paymentDate).toISOString()
          : null,
        paidDate: f.paidDate
          ? new Date(f.paidDate).toISOString()
          : f.paymentDate
          ? new Date(f.paymentDate).toISOString()
          : null,
        paidAt: f.paidAt ? new Date(f.paidAt).toISOString() : null,
        paymentMode: f.paymentMode || "Manual/Cash",
        createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
      })),
    };

    const testResults = testsList.map((test) => {
      const resultEntry = (test.results || []).find(
        (r: any) => String(r.studentId) === String(studentObjectId)
      );

      const marksObtained = resultEntry ? Number(resultEntry.marksObtained) || 0 : 0;
      const isAbsent = Boolean(resultEntry?.isAbsent);
      const percentage =
        test.maxMarks > 0
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

    return NextResponse.json(
      {
        success: true,
        data: {
          student: {
            _id: String(student._id),
            centerId: student.centerId,
            name: student.name,
            batch: student.batch,
            parentWhatsApp: student.parentWhatsApp,
            isActive: student.isActive,
            monthlyFee: student.monthlyFee,
            billingCycleDate: student.billingCycleDate,
            joiningDate: student.joiningDate,
          },
          center,
          attendanceStats,
          fees,
          testResults,
        },
      },
      {
        status: 200,
        headers: {
          ...responseHeaders,
          "X-Portal-Migrated": "false",
        },
      }
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to load parent portal data";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: responseHeaders }
    );
  }
}
