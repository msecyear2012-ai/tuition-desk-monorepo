import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import Fee, {
  type IFeeDocument,
  type IPaymentEntry,
  calculatePaymentCustody,
  getFeePaymentEntries,
} from "../../../../models/Fee.ts";
import Student from "../../../../models/Student.ts";
import Teacher from "../../../../models/Teacher.ts";
import CashHandover, { type ICashHandoverDocument } from "../../../../models/CashHandover.ts";
import StaffNotification from "../../../../models/StaffNotification.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

export interface RecentCollectionItem {
  feeId: string;
  paymentId: string;
  amount: number;
  paymentDate: Date | string | null;
  receiptNumber: string;
  studentName: string;
  collectorName: string;
  collectorRole: string;
  custodyStatus: string;
}

interface QueryWithSelectLean<T> {
  select?: (fields: string) => { lean?: () => Promise<T> } | unknown;
  lean?: () => Promise<T>;
}

function safeSelectLean<T>(query: unknown, selectFields: string): Promise<T> {
  if (query && typeof query === "object") {
    const q = query as QueryWithSelectLean<T>;
    if (typeof q.select === "function") {
      const projected = q.select(selectFields);
      if (projected && typeof projected === "object" && "lean" in projected && typeof (projected as { lean?: unknown }).lean === "function") {
        return ((projected as { lean: () => Promise<T> }).lean)();
      }
      return Promise.resolve(projected as T);
    }
    if (typeof q.lean === "function") {
      return q.lean();
    }
  }
  return Promise.resolve(query as T);
}

function insertBoundedTop<T>(
  list: T[],
  item: T,
  getTime: (x: T) => number,
  maxItems: number
) {
  const itemTime = getTime(item);
  if (list.length < maxItems) {
    list.push(item);
    list.sort((a, b) => getTime(b) - getTime(a));
    return;
  }
  const lowestTime = getTime(list[list.length - 1]);
  if (itemTime > lowestTime) {
    list[list.length - 1] = item;
    list.sort((a, b) => getTime(b) - getTime(a));
  }
}

function extractPaymentDate(entry: IPaymentEntry, rawFee: IFeeDocument): Date | null {
  if (entry.paymentDate && !isNaN(new Date(entry.paymentDate).getTime())) {
    return new Date(entry.paymentDate);
  }
  if (entry.recordedAt && !isNaN(new Date(entry.recordedAt).getTime())) {
    return new Date(entry.recordedAt);
  }
  const feeRecord = rawFee as unknown as {
    paymentDate?: string | Date;
    paidDate?: string | Date;
    paidAt?: string | Date;
  };
  if (feeRecord.paymentDate && !isNaN(new Date(feeRecord.paymentDate).getTime())) {
    return new Date(feeRecord.paymentDate);
  }
  if (feeRecord.paidDate && !isNaN(new Date(feeRecord.paidDate).getTime())) {
    return new Date(feeRecord.paidDate);
  }
  if (feeRecord.paidAt && !isNaN(new Date(feeRecord.paidAt).getTime())) {
    return new Date(feeRecord.paidAt);
  }
  return null;
}

export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    // 1. Authenticate user from verified JWT
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required to access fees summary" },
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

    const trimmedCenterId = String(user.centerId).trim();
    const { searchParams } = request.nextUrl;

    let feeMatchCondition: Record<string, unknown> = {};

    // 2. Role-based scoping for Fee summary metrics
    if (user.role === "teacher") {
      if (!user.teacherId || !mongoose.Types.ObjectId.isValid(user.teacherId)) {
        return NextResponse.json(
          { success: false, error: "Teacher profile invalid" },
          { status: 403, headers: corsHeaders }
        );
      }

      const teacherObjectId = new mongoose.Types.ObjectId(user.teacherId);

      // Scoped students for this teacher
      const teacherStudents = await Student.find({
        centerId: trimmedCenterId,
        assignedTeacherId: teacherObjectId,
        isActive: { $ne: false },
      }).select("_id");

      const scopedStudentIds = teacherStudents.map((s) => s._id);

      feeMatchCondition = {
        $or: [
          { assignedTeacherId: teacherObjectId },
          ...(scopedStudentIds.length > 0 ? [{ studentId: { $in: scopedStudentIds } }] : []),
        ],
      };
    } else {
      // Owner: Institute-wide by default, or filtered by faculty parameter
      const assignedTeacherParam =
        searchParams.get("assignedTeacher") || searchParams.get("assignedTeacherId");

      if (assignedTeacherParam) {
        if (assignedTeacherParam === "owner" || assignedTeacherParam === "null") {
          const ownerStudents = await Student.find({
            centerId: trimmedCenterId,
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
            ],
            isActive: { $ne: false },
          }).select("_id");

          const ownerStudentIds = ownerStudents.map((s) => s._id);

          feeMatchCondition = {
            $or: [
              { assignedTeacherId: null },
              { assignedTeacherId: { $exists: false } },
              ...(ownerStudentIds.length > 0 ? [{ studentId: { $in: ownerStudentIds } }] : []),
            ],
          };
        } else if (mongoose.Types.ObjectId.isValid(assignedTeacherParam)) {
          const targetTeacherId = new mongoose.Types.ObjectId(assignedTeacherParam);

          const teacherStudents = await Student.find({
            centerId: trimmedCenterId,
            assignedTeacherId: targetTeacherId,
            isActive: { $ne: false },
          }).select("_id");

          const scopedStudentIds = teacherStudents.map((s) => s._id);

          feeMatchCondition = {
            $or: [
              { assignedTeacherId: targetTeacherId },
              ...(scopedStudentIds.length > 0 ? [{ studentId: { $in: scopedStudentIds } }] : []),
            ],
          };
        } else {
          return NextResponse.json(
            { success: false, error: "Invalid assignedTeacher query parameter" },
            { status: 400, headers: corsHeaders }
          );
        }
      }
    }

    // 3. Concurrent aggregation queries for baseline financial metrics
    const [pendingAgg, overdueCount, collectedAgg] = await Promise.all([
      Fee.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            centerId: trimmedCenterId,
            status: { $in: ["Pending", "Partial Paid"] },
            amountDue: { $gt: 0 },
            ...feeMatchCondition,
          },
        },
        { $group: { _id: null, total: { $sum: "$amountDue" } } },
      ]),

      Fee.countDocuments({
        centerId: trimmedCenterId,
        status: { $in: ["Pending", "Partial Paid"] },
        amountDue: { $gt: 0 },
        ...feeMatchCondition,
      }),

      Fee.aggregate<{ _id: null; total: number }>([
        {
          $match: {
            centerId: trimmedCenterId,
            status: { $in: ["Paid", "Partial Paid"] },
            ...feeMatchCondition,
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$paidAmount", "$amountDue"] } },
          },
        },
      ]),
    ]);

    const totalPendingAmount = pendingAgg[0]?.total || 0;
    const pendingStudentsCount = overdueCount;
    const collectedAmount = collectedAgg[0]?.total || 0;

    // 4. Detailed Overview Metrics & Activity Feed
    if (user.role === "owner") {
      // Optimized payment fee filter: Only load fees with recorded payments for metrics & custody
      const paymentFeeFilter: Record<string, unknown> = {
        centerId: trimmedCenterId,
        $or: [
          { "paymentHistory.0": { $exists: true } },
          { paidAmount: { $gt: 0 } },
          { status: { $in: ["Paid", "Partial Paid"] } },
        ],
      };

      const handoverFilter: Record<string, unknown> = {
        centerId: trimmedCenterId,
        $or: [
          { status: { $in: ["pending_approval", "pending_verification", "disputed"] } },
          { discrepancyStatus: { $in: ["disputed", "shortage_confirmed"] } },
        ],
      };

      const [feesRaw, teachersRaw, handoversRaw] = await Promise.all([
        Fee.find(paymentFeeFilter)
          .select(
            "_id studentId paymentHistory paidAmount status paymentMode paidDate createdAt receivedBy receivedByRole recordedBy recordedByRole assignedTeacherAtPayment batchAtPayment"
          )
          .lean(),
        Teacher.find({ centerId: trimmedCenterId }).select("_id name loginId").lean(),
        safeSelectLean<ICashHandoverDocument[]>(
          CashHandover.find(handoverFilter),
          "status discrepancyStatus discrepancyAmount submittedAmount incrementalSettlements.amountReceived"
        ),
      ]);

      const teacherMap = new Map<string, { name: string; loginId?: string }>();
      for (const t of ((teachersRaw || []) as Array<{ _id: unknown; name: string; loginId?: string }>)) {
        teacherMap.set(String(t._id), { name: t.name, loginId: t.loginId });
      }

      let totalParentCollections = 0;
      let verifiedCashReceived = 0;
      let teacherHeldCash = 0;
      let pendingVerificationCash = 0;
      const top10Recent: RecentCollectionItem[] = [];

      for (const rawFee of ((feesRaw || []) as unknown as IFeeDocument[])) {
        const entries = getFeePaymentEntries(rawFee);

        // Resolve student identification (preserving populated object names or resolving raw ObjectId)
        let studentIdStr = "";
        let studentNameDirect = "";
        const rawStudent = (rawFee as { studentId?: unknown }).studentId;
        if (rawStudent) {
          if (typeof rawStudent === "object" && rawStudent !== null) {
            if ("name" in rawStudent && typeof (rawStudent as { name: unknown }).name === "string") {
              studentNameDirect = (rawStudent as { name: string }).name;
            }
            if ("_id" in rawStudent) {
              studentIdStr = String((rawStudent as { _id: unknown })._id);
            } else {
              studentIdStr = String(rawStudent);
            }
          } else {
            studentIdStr = String(rawStudent);
          }
        }

        for (const entry of entries) {
          const amt = Number(entry.amount) || 0;
          totalParentCollections += amt;

          const rawEntry = entry as unknown as { isOwnerVerified?: boolean; recordedBy?: unknown };
          const isDirectOwnerOrDigital =
            entry.receivedByRole === "owner" ||
            entry.paymentMode === "upi" ||
            entry.paymentMode === "bank_transfer" ||
            (Boolean(rawEntry.isOwnerVerified) && (!entry.allocations || entry.allocations.length === 0));

          let ownerVer = 0;
          let tInHand = 0;
          let oPending = 0;

          if (isDirectOwnerOrDigital) {
            ownerVer = amt;
          } else {
            const custody = calculatePaymentCustody(entry);
            ownerVer = custody.ownerVerifiedAmount;
            tInHand = custody.teacherInHandAmount;
            oPending = custody.ownerPendingVerificationAmount;
          }

          verifiedCashReceived += ownerVer;
          teacherHeldCash += tInHand;
          pendingVerificationCash += oPending;

          let custodyLabel = "Recorded";
          if (isDirectOwnerOrDigital || (ownerVer > 0 && tInHand === 0 && oPending === 0)) {
            custodyLabel = "Verified by Owner";
          } else if (oPending > 0) {
            custodyLabel = "Pending Verification";
          } else if (tInHand > 0) {
            custodyLabel = "Teacher In-Hand";
          }

          const collectorId = entry.receivedBy
            ? String(entry.receivedBy)
            : rawEntry.recordedBy
            ? String(rawEntry.recordedBy)
            : "";

          const collectorName =
            entry.receivedByRole === "owner"
              ? "Institute Owner"
              : teacherMap.get(collectorId)?.name || "Teacher";

          const genuinePaymentDate = extractPaymentDate(entry, rawFee);

          const collectionItem: RecentCollectionItem = {
            feeId: String((rawFee as { _id: unknown })._id),
            paymentId: String(entry.paymentId || (entry as unknown as { _id?: unknown })._id || ""),
            amount: amt,
            paymentDate: genuinePaymentDate,
            receiptNumber: entry.receiptNumber || "",
            studentName: studentNameDirect || studentIdStr,
            collectorName,
            collectorRole: entry.receivedByRole || "teacher",
            custodyStatus: custodyLabel,
          };

          insertBoundedTop(
            top10Recent,
            collectionItem,
            (x) => (x.paymentDate ? new Date(x.paymentDate).getTime() : 0),
            10
          );
        }
      }

      // Hydrate student names for ONLY the top 10 recent collections that need hydration
      const top10StudentIds = Array.from(
        new Set(
          top10Recent
            .map((item) => item.studentName)
            .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
        )
      );

      if (top10StudentIds.length > 0) {
        const studentQuery = Student.find({ _id: { $in: top10StudentIds } });
        const students = await safeSelectLean<Array<{ _id: unknown; name?: string }>>(
          studentQuery,
          "_id name"
        );
        const studentNameMap = new Map<string, string>();
        for (const s of (students || [])) {
          studentNameMap.set(String(s._id), s.name || "Student");
        }
        for (const item of top10Recent) {
          if (studentNameMap.has(item.studentName)) {
            item.studentName = studentNameMap.get(item.studentName) || "Student";
          } else if (mongoose.Types.ObjectId.isValid(item.studentName)) {
            item.studentName = "Student";
          }
        }
      }

      let activeDiscrepancies = 0;
      let pendingHandoversCount = 0;
      let pendingHandoversAmount = 0;
      let disputesCount = 0;

      for (const h of ((handoversRaw || []) as ICashHandoverDocument[])) {
        const settlements = h.incrementalSettlements || [];
        const totalSettled = settlements.reduce(
          (sum, s) => sum + (Number(s.amountReceived) || 0),
          0
        );
        const remainingShortage = Math.max(0, (Number(h.discrepancyAmount) || 0) - totalSettled);

        if (
          h.discrepancyStatus === "disputed" ||
          h.discrepancyStatus === "shortage_confirmed" ||
          (h as unknown as { status: string }).status === "disputed"
        ) {
          activeDiscrepancies += remainingShortage;
          disputesCount += 1;
        }

        if (
          h.status === "pending_approval" ||
          (h as unknown as { status: string }).status === "pending_verification"
        ) {
          pendingHandoversCount += 1;
          pendingHandoversAmount += Number(h.submittedAmount) || 0;
        }
      }

      return NextResponse.json(
        {
          success: true,
          data: {
            totalPendingAmount,
            pendingStudentsCount,
            collectedAmount,
            role: "owner",
            kpis: {
              totalParentCollections,
              verifiedCashReceived,
              teacherHeldCash,
              pendingVerificationCash,
              outstandingFeeBalance: totalPendingAmount,
              activeDiscrepancies,
            },
            actionRequired: {
              pendingHandoversCount,
              pendingHandoversAmount,
              overdueCount: pendingStudentsCount,
              disputesCount,
            },
            recentCollections: top10Recent,
          },
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // Teacher Role Overview Metrics & Feed
    const teacherIdStr = String(user.teacherId);
    const teacherObjectId = mongoose.Types.ObjectId.isValid(teacherIdStr)
      ? new mongoose.Types.ObjectId(teacherIdStr)
      : null;

    const [teacherHandoversRaw, teacherStudentsFull] = await Promise.all([
      safeSelectLean<ICashHandoverDocument[]>(
        CashHandover.find({
          centerId: trimmedCenterId,
          $or: [
            ...(teacherObjectId ? [{ teacherId: teacherObjectId }] : []),
            { teacherId: user.userId },
          ],
        }),
        "_id status discrepancyStatus"
      ),
      teacherObjectId
        ? Student.find({
            centerId: trimmedCenterId,
            assignedTeacherId: teacherObjectId,
            isActive: { $ne: false },
          })
            .select("_id name batch monthlyFee")
            .lean()
        : Promise.resolve([]),
    ]);

    const assignedStudentIds = ((teacherStudentsFull || []) as Array<{ _id: unknown; name: string; batch: string }>).map((s) => s._id);
    const studentMetaMap = new Map<string, { name: string; batch: string }>();
    for (const s of ((teacherStudentsFull || []) as Array<{ _id: unknown; name: string; batch: string }>)) {
      studentMetaMap.set(String(s._id), { name: s.name, batch: s.batch });
    }

    // Scoped fee query for teacher
    const teacherFeeFilter: Record<string, unknown> = {
      centerId: trimmedCenterId,
      $or: [
        ...(assignedStudentIds.length > 0 ? [{ studentId: { $in: assignedStudentIds } }] : []),
        ...(teacherObjectId
          ? [
              { receivedBy: teacherObjectId },
              { recordedBy: teacherObjectId },
              { assignedTeacherId: teacherObjectId },
              { "paymentHistory.receivedBy": teacherObjectId },
              { "paymentHistory.recordedBy": teacherObjectId },
            ]
          : []),
        { receivedBy: user.userId },
        { recordedBy: user.userId },
        { "paymentHistory.receivedBy": user.userId },
        { "paymentHistory.recordedBy": user.userId },
      ],
    };

    const feesRaw = await Fee.find(teacherFeeFilter)
      .select(
        "_id studentId paymentHistory paidAmount status paymentMode paidDate createdAt receivedBy receivedByRole recordedBy recordedByRole amountDue originalAmountDue"
      )
      .lean();

    let ownCashCollected = 0;
    let ownCashInHand = 0;
    let ownSubmittedHandovers = 0;
    let ownVerifiedHandovers = 0;
    const top10TeacherRecent: RecentCollectionItem[] = [];

    for (const rawFee of ((feesRaw || []) as unknown as IFeeDocument[])) {
      const entries = getFeePaymentEntries(rawFee);

      for (const entry of entries) {
        const rawEntry = entry as unknown as { isOwnerVerified?: boolean; recordedBy?: unknown };
        const collectorId = entry.receivedBy
          ? String(entry.receivedBy)
          : rawEntry.recordedBy
          ? String(rawEntry.recordedBy)
          : "";

        if (collectorId !== teacherIdStr && collectorId !== String(user.userId)) {
          continue;
        }

        const amt = Number(entry.amount) || 0;
        ownCashCollected += amt;

        const custody = calculatePaymentCustody(entry);
        ownCashInHand += custody.teacherInHandAmount;
        ownSubmittedHandovers += custody.ownerPendingVerificationAmount;
        ownVerifiedHandovers += custody.ownerVerifiedAmount;

        let custodyLabel = "Teacher In-Hand";
        if (
          custody.ownerVerifiedAmount > 0 &&
          custody.teacherInHandAmount === 0 &&
          custody.ownerPendingVerificationAmount === 0
        ) {
          custodyLabel = "Verified by Owner";
        } else if (custody.ownerPendingVerificationAmount > 0) {
          custodyLabel = "Pending Verification";
        }

        const genuinePaymentDate = extractPaymentDate(entry, rawFee);

        const collectionItem: RecentCollectionItem = {
          feeId: String((rawFee as { _id: unknown })._id),
          paymentId: String(entry.paymentId || (entry as unknown as { _id?: unknown })._id || ""),
          amount: amt,
          paymentDate: genuinePaymentDate,
          receiptNumber: entry.receiptNumber || "",
          studentName: String((rawFee as { studentId?: unknown }).studentId || ""),
          collectorName: "You",
          collectorRole: "teacher",
          custodyStatus: custodyLabel,
        };

        insertBoundedTop(
          top10TeacherRecent,
          collectionItem,
          (x) => (x.paymentDate ? new Date(x.paymentDate).getTime() : 0),
          10
        );
      }
    }

    // Resolve student names for top 10 items
    const missingStudentIds: string[] = [];
    for (const item of top10TeacherRecent) {
      if (item.studentName && studentMetaMap.has(item.studentName)) {
        item.studentName = studentMetaMap.get(item.studentName)!.name;
      } else if (item.studentName && mongoose.Types.ObjectId.isValid(item.studentName)) {
        missingStudentIds.push(item.studentName);
      } else {
        item.studentName = "Student";
      }
    }

    if (missingStudentIds.length > 0) {
      const extraStudentsQuery = Student.find({ _id: { $in: missingStudentIds } });
      const extraStudents = await safeSelectLean<Array<{ _id: unknown; name?: string }>>(
        extraStudentsQuery,
        "_id name"
      );
      const extraMap = new Map<string, string>();
      for (const s of (extraStudents || [])) {
        extraMap.set(String(s._id), s.name || "Student");
      }
      for (const item of top10TeacherRecent) {
        if (extraMap.has(item.studentName)) {
          item.studentName = extraMap.get(item.studentName)!;
        }
      }
    }

    let pendingHandoverCount = 0;
    let rejectedHandoverCount = 0;
    let activeDisputesCount = 0;

    for (const h of ((teacherHandoversRaw || []) as ICashHandoverDocument[])) {
      if (
        h.status === "pending_approval" ||
        (h as unknown as { status: string }).status === "pending_verification"
      ) {
        pendingHandoverCount += 1;
      } else if (h.status === "rejected") {
        rejectedHandoverCount += 1;
      }

      if (
        h.discrepancyStatus === "disputed" ||
        (h as unknown as { status: string }).status === "disputed"
      ) {
        activeDisputesCount += 1;
      }
    }

    // SECTION B METRICS: Assigned Students Fee Status
    // Filter assigned students' fees from feesRaw
    const assignedFees = ((feesRaw || []) as IFeeDocument[]).filter((f) => {
      const sId = typeof f.studentId === "object" && f.studentId !== null && "_id" in f.studentId
        ? String((f.studentId as { _id: unknown })._id)
        : String(f.studentId);
      return studentMetaMap.has(sId);
    });

    const pendingAssignedFees = assignedFees.filter(
      (f) => f.status === "Pending" || f.status === "Partial Paid"
    );
    const assignedTotalOutstanding = pendingAssignedFees.reduce(
      (sum, f) => sum + (Number(f.amountDue) || 0),
      0
    );
    const studentsWithDuesSet = new Set(
      pendingAssignedFees.map((f) => {
        return typeof f.studentId === "object" && f.studentId !== null && "_id" in f.studentId
          ? String((f.studentId as { _id: unknown })._id)
          : String(f.studentId);
      })
    );
    const studentsWithDues = studentsWithDuesSet.size;
    const totalAssignedStudents = (teacherStudentsFull || []).length;
    const studentsFullyPaid = Math.max(0, totalAssignedStudents - studentsWithDues);

    // Recent activity on assigned students' fees (strictly zero contact phone numbers)
    const sortedAssignedFees: IFeeDocument[] = [];
    for (const f of assignedFees) {
      insertBoundedTop(
        sortedAssignedFees,
        f,
        (x) => new Date(x.updatedAt || x.createdAt || 0).getTime(),
        8
      );
    }

    const recentStudentActivity = sortedAssignedFees.map((f) => {
      const sId = typeof f.studentId === "object" && f.studentId !== null && "_id" in f.studentId
        ? String((f.studentId as { _id: unknown })._id)
        : String(f.studentId);
      const meta = studentMetaMap.get(sId);
      return {
        feeId: String(f._id),
        studentName: meta?.name || "Student",
        batchName: meta?.batch || "",
        month: f.month || "",
        title: f.title || f.month || "Tuition Fee",
        amountDue: Number(f.amountDue) || 0,
        paidAmount: Number(f.paidAmount) || 0,
        status: f.status,
        dueDate: f.dueDate,
        updatedAt: f.updatedAt || f.createdAt || new Date(),
      };
    });

    // Recent personal notifications for Teacher
    let teacherNotifications: unknown[] = [];
    if (mongoose.connection?.readyState === 1 || StaffNotification.find !== mongoose.Model.find) {
      try {
        teacherNotifications = await StaffNotification.find({
          centerId: trimmedCenterId,
          recipientRole: "teacher",
          $or: [
            { recipientId: teacherIdStr },
            { recipientId: String(user.userId) },
          ],
        })
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
      } catch {
        teacherNotifications = [];
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          totalPendingAmount: assignedTotalOutstanding,
          pendingStudentsCount: studentsWithDues,
          collectedAmount: ownCashCollected,
          role: "teacher",
          kpis: {
            ownCashCollected,
            ownCashInHand,
            ownSubmittedHandovers,
            ownVerifiedHandovers,
          },
          studentStatus: {
            totalAssignedStudents,
            studentsWithDues,
            studentsFullyPaid,
            totalOutstandingBalance: assignedTotalOutstanding,
            recentActivity: recentStudentActivity,
          },
          actionRequired: {
            eligibleForHandoverAmount: ownCashInHand,
            pendingHandoverCount,
            rejectedHandoverCount,
            activeDisputesCount,
          },
          recentCollections: top10TeacherRecent,
          notifications: teacherNotifications,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to load fees summary";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
