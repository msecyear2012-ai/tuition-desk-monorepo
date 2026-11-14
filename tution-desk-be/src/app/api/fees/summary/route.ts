import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import Fee, {
  type IFeeDocument,
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
  paymentDate: Date | string;
  receiptNumber: string;
  studentName: string;
  collectorName: string;
  collectorRole: string;
  custodyStatus: string;
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
            ...feeMatchCondition,
          },
        },
        { $group: { _id: null, total: { $sum: "$amountDue" } } },
      ]),

      Fee.countDocuments({
        centerId: trimmedCenterId,
        status: { $in: ["Pending", "Partial Paid"] },
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
      const [feesRaw, teachersRaw, handoversRaw] = await Promise.all([
        (typeof Fee.find === "function"
          ? (Fee.find({ centerId: trimmedCenterId }) as unknown as { populate: (path: string, fields: string) => Promise<unknown[]> }).populate?.("studentId", "name batch") || Fee.find({ centerId: trimmedCenterId })
          : []) as Promise<unknown[]>,
        Teacher.find({ centerId: trimmedCenterId }).select("_id name loginId"),
        CashHandover.find({ centerId: trimmedCenterId }),
      ]);

      const teacherMap = new Map<string, { name: string; loginId?: string }>();
      for (const t of ((teachersRaw || []) as Array<{ _id: unknown; name: string; loginId?: string }>)) {
        teacherMap.set(String(t._id), { name: t.name, loginId: t.loginId });
      }

      let totalParentCollections = 0;
      let verifiedCashReceived = 0;
      let teacherHeldCash = 0;
      let pendingVerificationCash = 0;
      const recentCollections: RecentCollectionItem[] = [];

      for (const rawFee of ((feesRaw || []) as IFeeDocument[])) {
        const entries = getFeePaymentEntries(rawFee);
        const sObj = rawFee.studentId as { name?: string } | null;
        const studentName = sObj?.name || "Student";

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

          recentCollections.push({
            feeId: String(rawFee._id),
            paymentId: String(entry.paymentId || (entry as unknown as { _id?: unknown })._id || ""),
            amount: amt,
            paymentDate: entry.paymentDate || entry.createdAt || new Date(),
            receiptNumber: entry.receiptNumber || "",
            studentName,
            collectorName,
            collectorRole: entry.receivedByRole || "teacher",
            custodyStatus: custodyLabel,
          });
        }
      }

      recentCollections.sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime());
      const top10Recent = recentCollections.slice(0, 10);

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

    const [feesRaw, teacherHandoversRaw, teacherStudentsFull] = await Promise.all([
      (typeof Fee.find === "function"
        ? (Fee.find({ centerId: trimmedCenterId }) as unknown as { populate: (path: string, fields: string) => Promise<unknown[]> }).populate?.("studentId", "name batch") || Fee.find({ centerId: trimmedCenterId })
        : []) as Promise<unknown[]>,
      CashHandover.find({
        centerId: trimmedCenterId,
        $or: [
          ...(teacherObjectId ? [{ teacherId: teacherObjectId }] : []),
          { teacherId: user.userId },
        ],
      }),
      teacherObjectId
        ? Student.find({
            centerId: trimmedCenterId,
            assignedTeacherId: teacherObjectId,
            isActive: { $ne: false },
          }).select("_id name batch monthlyFee")
        : Promise.resolve([]),
    ]);

    let ownCashCollected = 0;
    let ownCashInHand = 0;
    let ownSubmittedHandovers = 0;
    let ownVerifiedHandovers = 0;
    const teacherRecentCollections: RecentCollectionItem[] = [];

    for (const rawFee of ((feesRaw || []) as IFeeDocument[])) {
      const entries = getFeePaymentEntries(rawFee);
      const sObj = rawFee.studentId as { name?: string } | null;
      const studentName = sObj?.name || "Student";

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

        teacherRecentCollections.push({
          feeId: String(rawFee._id),
          paymentId: String(entry.paymentId || (entry as unknown as { _id?: unknown })._id || ""),
          amount: amt,
          paymentDate: entry.paymentDate || entry.createdAt || new Date(),
          receiptNumber: entry.receiptNumber || "",
          studentName,
          collectorName: "You",
          collectorRole: "teacher",
          custodyStatus: custodyLabel,
        });
      }
    }

    teacherRecentCollections.sort(
      (a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime()
    );
    const top10TeacherRecent = teacherRecentCollections.slice(0, 10);

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
    const assignedStudentIds = ((teacherStudentsFull || []) as Array<{ _id: unknown; name: string; batch: string }>).map((s) => s._id);
    const studentMetaMap = new Map<string, { name: string; batch: string }>();
    for (const s of ((teacherStudentsFull || []) as Array<{ _id: unknown; name: string; batch: string }>)) {
      studentMetaMap.set(String(s._id), { name: s.name, batch: s.batch });
    }

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
    const sortedAssignedFees = [...assignedFees].sort((a, b) => {
      const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    const recentStudentActivity = sortedAssignedFees.slice(0, 8).map((f) => {
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
