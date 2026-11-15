import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../lib/db.ts";
import Fee, { getFeePaymentEntries } from "../../../models/Fee.ts";
import Student from "../../../models/Student.ts";
import Center from "../../../models/Center.ts";
import Teacher from "../../../models/Teacher.ts";
import { getAuthenticatedUser } from "../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../lib/cors.ts";
import { generateOrGetMonthlyFee } from "../../../lib/feeService.ts";
import { sanitizeStudentForRole } from "../../../lib/privacyUtils.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, POST, OPTIONS");
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
    // Strictly derive centerId from verified JWT; never trust client payload
    const targetCenterId = user.centerId;

    // Explicit feeType validation and resolution
    let feeType = body.feeType;

    if (!feeType) {
      if (body.isAdvance || /advance/i.test(body.title || "") || /advance/i.test(body.month || "")) {
        feeType = "advance";
      } else if (body.billingMonth) {
        feeType = "monthly_recurring";
      } else if (body.type === "registration" || /registration|admission/i.test(body.title || "")) {
        feeType = "registration";
      } else if (body.type === "adhoc" || /adhoc|material|exam|book/i.test(body.title || "")) {
        feeType = "adhoc";
      } else if (body.studentId && body.month && !body.title) {
        // Standard manual monthly billing creation
        feeType = "monthly_recurring";
      } else {
        return NextResponse.json(
          {
            success: false,
            error:
              "Ambiguous fee creation request: 'feeType' is required. Supported types: 'monthly_recurring', 'advance', 'adhoc', 'registration'.",
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    const validFeeTypes = ["monthly_recurring", "advance", "adhoc", "registration"];
    if (!validFeeTypes.includes(feeType)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid feeType: '${feeType}'. Supported types: ${validFeeTypes.join(", ")}.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate amountDue for all fee types
    if (body.amountDue !== undefined) {
      const parsedAmount = Number(body.amountDue);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return NextResponse.json(
          {
            success: false,
            error: "Amount due must be a valid positive number greater than 0",
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // If recurring monthly fee, route through idempotent feeService
    if (feeType === "monthly_recurring") {
      if (!body.studentId) {
        return NextResponse.json(
          { success: false, error: "studentId is required for monthly recurring fees" },
          { status: 400, headers: corsHeaders }
        );
      }

      let targetBillingMonth = body.billingMonth;
      if (!targetBillingMonth && body.month && /^\d{4}-\d{2}$/.test(String(body.month).trim())) {
        targetBillingMonth = String(body.month).trim();
      }

      const res = await generateOrGetMonthlyFee({
        centerId: targetCenterId,
        studentId: body.studentId,
        billingMonth: targetBillingMonth,
        amountDue:
          body.amountDue !== undefined ? Number(body.amountDue) : undefined,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
        isManual: true,
      });

      if (!res.success) {
        return NextResponse.json(
          {
            success: false,
            error:
              res.conflictReason ||
              res.error ||
              "Failed to process monthly fee request",
            status: res.status,
          },
          { status: res.status === "reconciliation_required" ? 409 : 400, headers: corsHeaders }
        );
      }

      return NextResponse.json(
        {
          success: true,
          data: res.fee,
          wasCreated: res.wasCreated,
          status: res.status,
        },
        { status: res.wasCreated ? 201 : 200, headers: corsHeaders }
      );
    }

    // For non-recurring fee types (adhoc, registration, advance),
    // ensure amountDue is explicitly provided and greater than 0
    const nonRecurringAmount = Number(body.amountDue);
    if (body.amountDue === undefined || isNaN(nonRecurringAmount) || nonRecurringAmount <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Amount due is required and must be a valid positive number greater than 0",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Determine assignedTeacherId based on caller role
    let assignedTeacherId: mongoose.Types.ObjectId | null = null;
    if (user.role === "teacher") {
      assignedTeacherId = mongoose.Types.ObjectId.isValid(String(user.teacherId))
        ? new mongoose.Types.ObjectId(String(user.teacherId))
        : null;
    } else if (body.assignedTeacherId && mongoose.Types.ObjectId.isValid(String(body.assignedTeacherId))) {
      assignedTeacherId = new mongoose.Types.ObjectId(String(body.assignedTeacherId));
    }

    // Snapshot academic responsibility at payment time (DEC-MSEC-03).
    let batchAtPayment = "";
    if (body.studentId && mongoose.Types.ObjectId.isValid(String(body.studentId))) {
      try {
        const studentForSnapshot = await Student.findById(String(body.studentId));
        if (studentForSnapshot && studentForSnapshot.centerId === targetCenterId) {
          batchAtPayment = studentForSnapshot.batch ?? "";
        }
      } catch {
        // Non-fatal: snapshot defaults to empty string if student lookup fails
      }
    }

    // ensure billingMonth is NOT set so it cannot suppress legitimate monthly recurring billing
    const cleanBody: Record<string, unknown> = { ...body };
    delete cleanBody.billingMonth;
    delete cleanBody.paymentHistory;
    delete cleanBody.originalAmountDue;
    delete cleanBody.recordedBy;
    delete cleanBody.recordedByRole;
    delete cleanBody.receivedBy;
    delete cleanBody.receivedByRole;

    const newFee = await Fee.create({
      ...cleanBody,
      originalAmountDue: nonRecurringAmount,
      amountDue: nonRecurringAmount,
      paidAmount: 0,
      paymentHistory: [],
      feeType,
      isAdvance: feeType === "advance" ? true : Boolean(body.isAdvance),
      centerId: targetCenterId,
      assignedTeacherId,
      assignedTeacherAtPayment: assignedTeacherId,
      batchAtPayment,
      // Automatic receiver attribution (DEC-MSEC-01): derived exclusively from
      // verified JWT claims. Client-supplied recordedBy/receivedBy are discarded.
      recordedBy: new mongoose.Types.ObjectId(user.userId),
      recordedByRole: user.role,
      receivedBy: new mongoose.Types.ObjectId(user.userId),
      receivedByRole: user.role,
      recordedAt: new Date(),
    });

    return NextResponse.json(
      { success: true, data: newFee, wasCreated: true },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create fee record";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
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

    await connectDB();

    const { searchParams } = request.nextUrl;
    // Strictly derive centerId from verified JWT; never trust client-supplied centerId
    const centerId = user.centerId;
    const filter: Record<string, unknown> = { centerId };

    // 2. Role-based scoping for Fee ledger
    if (user.role === "teacher") {
      // Teachers can ONLY view fees for students assigned to their own teacherId
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }
      const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);
      const teacherIdentities: mongoose.Types.ObjectId[] = [teacherObjectId];
      if (
        user.userId &&
        String(user.userId) !== String(user.teacherId) &&
        mongoose.Types.ObjectId.isValid(user.userId)
      ) {
        teacherIdentities.push(new mongoose.Types.ObjectId(user.userId));
      }

      const scopedStudentIds = await Student.find({
        centerId,
        assignedTeacherId: teacherObjectId,
      }).distinct("_id");

      filter.$or = [
        { assignedTeacherId: teacherObjectId },
        { studentId: { $in: scopedStudentIds } },
        { "paymentHistory.receivedBy": { $in: teacherIdentities } },
        { "paymentHistory.recordedBy": { $in: teacherIdentities } },
        { receivedBy: { $in: teacherIdentities } },
        { recordedBy: { $in: teacherIdentities } },
      ];
    } else {
      // Owner can view all fees across the institute, or filter by teacher
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          const ownerStudentIds = await Student.find({
            centerId,
            $or: [{ assignedTeacherId: null }, { assignedTeacherId: { $exists: false } }],
          }).distinct("_id");

          filter.$or = [
            { assignedTeacherId: null },
            { assignedTeacherId: { $exists: false } },
            { studentId: { $in: ownerStudentIds } },
          ];
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          const targetTeacherId = new mongoose.Types.ObjectId(assignedTeacherParam);
          const teacherStudentIds = await Student.find({
            centerId,
            assignedTeacherId: targetTeacherId,
          }).distinct("_id");

          filter.$or = [
            { assignedTeacherId: targetTeacherId },
            { studentId: { $in: teacherStudentIds } },
          ];
        } else {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacher query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
      }
    }

    // Additional query filters
    const studentId = searchParams.get("studentId");
    const month = searchParams.get("month");
    const status = searchParams.get("status");
    const feeType = searchParams.get("feeType");

    if (studentId) filter.studentId = studentId;
    if (month) filter.month = month;
    if (feeType) filter.feeType = feeType;
    if (status) {
      if (status.includes(",")) {
        const statusList = status.split(",").map((s) => s.trim());
        filter.status = { $in: statusList };
        // Pending Dues: exclude fees without an active outstanding balance (> 0)
        if (!statusList.includes("Paid") && !statusList.includes("Verification Pending")) {
          filter.amountDue = { $gt: 0 };
        }
      } else {
        filter.status = status;
        if (status === "Pending" || status === "Partial Paid") {
          filter.amountDue = { $gt: 0 };
        }
      }
    }

    const isAllRequested = searchParams.get("all") === "true";
    const limitParam = searchParams.get("limit");
    const pageParam = searchParams.get("page");
    const skipParam = searchParams.get("skip");

    const defaultLimit = studentId ? 500 : 50;
    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(Math.max(1, parseInt(limitParam, 10) || defaultLimit), 500)
      : defaultLimit;

    let skip = 0;
    if (skipParam) {
      skip = Math.max(0, parseInt(skipParam, 10) || 0);
    } else {
      skip = (page - 1) * limit;
    }

    let feeQuery: any = Fee.find(filter)
      .populate("studentId", "name batch parentWhatsApp phone")
      .sort({ createdAt: -1 });

    if (!isAllRequested && feeQuery && typeof feeQuery.skip === "function") {
      feeQuery = feeQuery.skip(skip).limit(limit);
    }

    let totalCount = 0;
    try {
      if (typeof Fee.countDocuments === "function") {
        totalCount = await Fee.countDocuments(filter);
      }
    } catch {
      totalCount = 0;
    }

    const fees = await feeQuery;
    const total = totalCount > 0 ? totalCount : (fees ? fees.length : 0);
    const totalPages = isAllRequested ? 1 : Math.max(1, Math.ceil(total / limit));

    // 3. Resolve Center & Teacher Entities for human-readable labels
    const [centerDoc, teachers] = await Promise.all([
      Center.findOne({ centerId }).select("_id name ownerName phone"),
      Teacher.find({ centerId }).select("_id name phone loginId role"),
    ]);

    const ownerDisplayName = centerDoc?.ownerName || centerDoc?.name || "Institute Owner";
    const ownerCenterId = centerDoc?._id?.toString();

    const teacherMap = new Map<string, string>();
    teachers.forEach((t) => {
      teacherMap.set(t._id.toString(), t.name);
    });

    // 4. Enrich fee records with human-readable collector & academic teacher attribution
    const enrichedFees = fees.map((feeDoc: any) => {
      const fee = feeDoc.toObject ? feeDoc.toObject() : { ...feeDoc };

      // Resolve collector identity (Physical / Digital Cash Custody)
      const rawReceiverId = fee.receivedBy ? String(fee.receivedBy) : null;
      let collectorRole: "owner" | "teacher" = fee.receivedByRole || "owner";
      if (rawReceiverId && ownerCenterId && rawReceiverId === ownerCenterId) {
        collectorRole = "owner";
      }

      let collectorName = ownerDisplayName;
      if (collectorRole === "teacher" && rawReceiverId && teacherMap.has(rawReceiverId)) {
        collectorName = teacherMap.get(rawReceiverId)!;
      } else if (rawReceiverId && teacherMap.has(rawReceiverId)) {
        collectorRole = "teacher";
        collectorName = teacherMap.get(rawReceiverId)!;
      } else {
        collectorRole = "owner";
        collectorName = `${ownerDisplayName} (Owner)`;
      }

      // Resolve academic responsibility snapshot at payment time (DEC-MSEC-03)
      const rawAcademicTeacherId = (fee.assignedTeacherAtPayment || fee.assignedTeacherId)
        ? String(fee.assignedTeacherAtPayment || fee.assignedTeacherId)
        : null;

      let academicTeacherName = `${ownerDisplayName} (Owner)`;
      if (rawAcademicTeacherId && teacherMap.has(rawAcademicTeacherId)) {
        academicTeacherName = teacherMap.get(rawAcademicTeacherId)!;
      }

      // Resolve student batch at payment snapshot
      const studentObj =
        typeof fee.studentId === "object" &&
        fee.studentId !== null &&
        "batch" in (fee.studentId as object)
          ? (fee.studentId as { batch?: string })
          : null;
      const batchAtPayment = fee.batchAtPayment || studentObj?.batch || "";

      const originalAmountDue =
        fee.originalAmountDue !== undefined && fee.originalAmountDue !== null
          ? fee.originalAmountDue
          : (Number(fee.amountDue || 0) + Number(fee.paidAmount || 0));

      const paymentHistory = getFeePaymentEntries(fee);

      // REQ-02: Sanitize student contact info for teacher
      const sanitizedStudent =
        fee.studentId && typeof fee.studentId === "object"
          ? sanitizeStudentForRole(fee.studentId as any, user.role)
          : fee.studentId;

      return {
        ...fee,
        studentId: sanitizedStudent,
        originalAmountDue,
        paymentHistory,
        receivedByName: collectorName,
        receivedByRole: collectorRole,
        assignedTeacherName: academicTeacherName,
        batchAtPayment,
      };
    });

    return NextResponse.json(
      {
        success: true,
        count: enrichedFees.length,
        data: enrichedFees,
        pagination: {
          page: isAllRequested ? 1 : page,
          limit: isAllRequested ? enrichedFees.length : limit,
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
      error instanceof Error ? error.message : "Failed to fetch fee records";

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}
