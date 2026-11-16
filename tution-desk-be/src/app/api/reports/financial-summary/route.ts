import { NextRequest, NextResponse } from "next/server.js";
import mongoose from "mongoose";
import connectDB from "../../../../lib/db.ts";
import Fee, {
  type IFeeDocument,
  calculatePaymentCustody,
  getFeePaymentEntries,
} from "../../../../models/Fee.ts";
import CashHandover, { type ICashHandoverDocument } from "../../../../models/CashHandover.ts";
import Teacher from "../../../../models/Teacher.ts";
import Student from "../../../../models/Student.ts";
import { getAuthenticatedUser } from "../../../../lib/auth.ts";
import { getCorsHeaders, handleCorsPreflight } from "../../../../lib/cors.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "GET, OPTIONS");
}

interface TeacherReportRow {
  teacherId: string;
  teacherName: string;
  teacherLoginId?: string;
  totalCollected: number;
  teacherInHandAmount: number;
  ownerPendingAmount: number;
  ownerVerifiedAmount: number;
  cashInHand: number;
  cashSubmitted: number;
  cashVerified: number;
  activeDiscrepancies: number;
  transactionCount: number;
}

interface BatchReportRow {
  batchName: string;
  studentCount: number;
  totalInvoiced: number;
  totalCollected: number;
  outstandingBalance: number;
  partialPaymentCount: number;
  collectionRate: number;
  collectionRatePercent: number;
}

interface StudentLedgerRow {
  feeId: string;
  studentId: string;
  studentName: string;
  parentName?: string;
  parentPhone?: string;
  batch: string;
  batchName?: string;
  feeMonth: string;
  month?: string;
  feeTitle: string;
  amountDue: number;
  paidAmount: number;
  outstandingBalance?: number;
  originalAmountDue: number;
  status: string;
  feeStatus?: string;
  payments: Array<{
    paymentId: string;
    amount: number;
    paymentDate: Date | string;
    paymentMode: string;
    receiptNumber: string;
    receivedByName: string;
    receivedByRole: string;
    custodyStatus: string;
    custodyLabel?: string;
    isOwnerVerified?: boolean;
    status?: string;
  }>;
}

interface HandoverReportRow {
  handoverId: string;
  handoverNumber: string;
  teacherId: string;
  teacherName: string;
  submittedAt: Date | string;
  submittedAmount: number;
  approvedAmount: number;
  discrepancyAmount: number;
  remainingDiscrepancy: number;
  status: string;
  discrepancyStatus: string;
  itemCount: number;
  resolutionsCount: number;
  settlementsCount: number;
}

/**
 * GET /api/reports/financial-summary
 * Comprehensive Owner Financial Reports & Analytics Endpoint
 * Strictly restricted to authenticated Institute Owners (role === "owner").
 */
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request);

  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (user.role !== "owner") {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied: Financial reports are restricted strictly to institute owners",
          code: "UNAUTHORIZED_ROLE",
        },
        { status: 403, headers: corsHeaders }
      );
    }

    await connectDB();

    const centerId = user.centerId;
    const { searchParams } = request.nextUrl;

    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");
    const teacherIdParam = searchParams.get("teacherId");
    const batchParam = searchParams.get("batch");
    const studentQueryParam = searchParams.get("student") || searchParams.get("search");
    const statusParam = searchParams.get("status");
    const handoverStatusParam = searchParams.get("handoverStatus");

    // Parse date boundaries if provided
    let dateRangeStart: Date | null = null;
    let dateRangeEnd: Date | null = null;

    if (startDateParam && /^\d{4}-\d{2}-\d{2}$/.test(startDateParam)) {
      dateRangeStart = new Date(`${startDateParam}T00:00:00.000+05:30`);
    }
    if (endDateParam && /^\d{4}-\d{2}-\d{2}$/.test(endDateParam)) {
      dateRangeEnd = new Date(`${endDateParam}T23:59:59.999+05:30`);
    }

    // Push applicable filters down to MongoDB
    const handoverFilter: Record<string, unknown> = { centerId };
    if (handoverStatusParam && handoverStatusParam !== "all") {
      handoverFilter.status = handoverStatusParam;
    }
    if (teacherIdParam && teacherIdParam !== "all" && mongoose.Types.ObjectId.isValid(teacherIdParam)) {
      handoverFilter.teacherId = new mongoose.Types.ObjectId(teacherIdParam);
    }
    if (dateRangeStart || dateRangeEnd) {
      const dateSubFilter: Record<string, unknown> = {};
      if (dateRangeStart) dateSubFilter.$gte = dateRangeStart;
      if (dateRangeEnd) dateSubFilter.$lte = dateRangeEnd;
      handoverFilter.submittedAt = dateSubFilter;
    }

    const feeFilter: Record<string, unknown> = { centerId };
    if (statusParam && statusParam !== "all") {
      feeFilter.status = statusParam;
    }
    if (studentQueryParam && studentQueryParam.trim() && mongoose.Types.ObjectId.isValid(studentQueryParam.trim())) {
      feeFilter.studentId = new mongoose.Types.ObjectId(studentQueryParam.trim());
    }

    let teacherQuery: any = Teacher.find({ centerId, isActive: { $ne: false } });
    if (teacherQuery && typeof teacherQuery.select === "function") {
      teacherQuery = teacherQuery.select("_id name loginId role");
    }
    if (teacherQuery && typeof teacherQuery.lean === "function") {
      teacherQuery = teacherQuery.lean();
    }

    // Load active and inactive students for this center to resolve historical fees without duplicate populate queries
    let studentQuery: any = Student.find({ centerId });
    if (studentQuery && typeof studentQuery.select === "function") {
      studentQuery = studentQuery.select("_id name batch parentName parentWhatsApp phone");
    }
    if (studentQuery && typeof studentQuery.lean === "function") {
      studentQuery = studentQuery.lean();
    }

    let handoverQuery: any = CashHandover.find(handoverFilter);
    if (handoverQuery && typeof handoverQuery.select === "function") {
      handoverQuery = handoverQuery.select(
        "centerId handoverNumber teacherId submittedAt submittedAmount approvedAmount discrepancyAmount status discrepancyStatus items resolutions incrementalSettlements createdAt"
      );
    }
    if (handoverQuery && typeof handoverQuery.sort === "function") {
      handoverQuery = handoverQuery.sort({ submittedAt: -1 });
    }
    if (handoverQuery && typeof handoverQuery.lean === "function") {
      handoverQuery = handoverQuery.lean();
    }

    let feeQuery: any = Fee.find(feeFilter);
    if (feeQuery && typeof feeQuery.select === "function") {
      feeQuery = feeQuery.select(
        "centerId studentId batchAtPayment originalAmountDue amountDue paidAmount status month title paymentHistory paymentDate paidDate paidAt createdAt"
      );
    }
    if (feeQuery && typeof feeQuery.sort === "function") {
      feeQuery = feeQuery.sort({ createdAt: -1 });
    }
    if (feeQuery && typeof feeQuery.lean === "function") {
      feeQuery = feeQuery.lean();
    }

    // Load reference datasets in parallel with field projections and database filters
    const [teachers, students, handoversRaw, feesRaw] = await Promise.all([
      teacherQuery,
      studentQuery,
      handoverQuery,
      feeQuery,
    ]);

    // Build lookup maps
    const teacherMap = new Map<string, { name: string; loginId?: string }>();
    (Array.isArray(teachers) ? teachers : []).forEach((t: any) => {
      teacherMap.set(String(t._id), { name: t.name, loginId: t.loginId });
    });

    const studentMap = new Map<
      string,
      { name: string; batch: string; parentName?: string; parentPhone?: string }
    >();
    (Array.isArray(students) ? students : []).forEach((s: any) => {
      const pDoc = s as unknown as {
        parentName?: string;
        parentWhatsApp?: string;
        phone?: string;
      };
      studentMap.set(String(s._id), {
        name: s.name,
        batch: s.batch || "General",
        parentName: pDoc.parentName || "Parent",
        parentPhone: pDoc.parentWhatsApp || pDoc.phone || "",
      });
    });

    // --- 1. Process & Filter Fees ---
    let totalParentCollections = 0;
    let verifiedCashReceived = 0;
    let teacherHeldCash = 0;
    let pendingVerificationCash = 0;
    let outstandingFeeBalance = 0;
    let undatedCollectionsCount = 0;
    let undatedCollectionsAmount = 0;

    const teacherAggMap = new Map<
      string,
      {
        totalCollected: number;
        cashInHand: number;
        cashSubmitted: number;
        cashVerified: number;
        txCount: number;
      }
    >();

    const batchAggMap = new Map<
      string,
      {
        invoiced: number;
        collected: number;
        outstanding: number;
        partialCount: number;
        studentSet: Set<string>;
      }
    >();

    const studentLedgerRows: StudentLedgerRow[] = [];

    for (const rawFee of feesRaw) {
      const fee = rawFee as unknown as IFeeDocument;
      const studentObj =
        typeof fee.studentId === "object" && fee.studentId !== null
          ? (fee.studentId as { _id?: unknown; name?: string; batch?: string })
          : null;
      const sId = studentObj?._id ? String(studentObj._id) : String(fee.studentId || "");
      const sName = studentObj?.name || studentMap.get(sId)?.name || "Unknown Student";
      const sBatch =
        studentObj?.batch || fee.batchAtPayment || studentMap.get(sId)?.batch || "General";

      // Filter: Batch
      if (batchParam && batchParam !== "all" && sBatch.toLowerCase() !== batchParam.toLowerCase()) {
        continue;
      }

      // Filter: Student Query (search by name or id)
      if (studentQueryParam && studentQueryParam.trim()) {
        const q = studentQueryParam.trim().toLowerCase();
        const matches = sName.toLowerCase().includes(q) || sId.toLowerCase().includes(q);
        if (!matches) continue;
      }

      // Filter: Fee Status
      if (statusParam && statusParam !== "all") {
        if (fee.status !== statusParam) continue;
      }

      const entries = getFeePaymentEntries(fee);

      // Track Batch-wise Invoicing & Outstanding
      if (!batchAggMap.has(sBatch)) {
        batchAggMap.set(sBatch, {
          invoiced: 0,
          collected: 0,
          outstanding: 0,
          partialCount: 0,
          studentSet: new Set<string>(),
        });
      }
      const bRow = batchAggMap.get(sBatch)!;
      bRow.studentSet.add(sId);

      const feeInvoiced =
        (Number(fee.originalAmountDue) > 0 ? Number(fee.originalAmountDue) : 0) ||
        ((Number(fee.amountDue) || 0) + (Number(fee.paidAmount) || 0));
      bRow.invoiced += feeInvoiced;

      if (fee.status === "Pending" || fee.status === "Partial Paid") {
        const due = Number(fee.amountDue) || 0;
        outstandingFeeBalance += due;
        bRow.outstanding += due;
      }
      if (fee.status === "Partial Paid") {
        bRow.partialCount += 1;
      }

      // Process payment entries for line-item custody and attribution
      const paymentLineItems: StudentLedgerRow["payments"] = [];
      let feeCollectedInWindow = 0;

      for (const entry of entries) {
        // Resolve reliable historical collection date strictly from payment timestamps
        let payDate: Date | null = null;
        if (entry.paymentDate && !isNaN(new Date(entry.paymentDate).getTime())) {
          payDate = new Date(entry.paymentDate);
        } else if (entry.recordedAt && !isNaN(new Date(entry.recordedAt).getTime())) {
          payDate = new Date(entry.recordedAt);
        } else if (fee.paymentDate && !isNaN(new Date(fee.paymentDate).getTime())) {
          payDate = new Date(fee.paymentDate);
        } else if (fee.paidDate && !isNaN(new Date(fee.paidDate).getTime())) {
          payDate = new Date(fee.paidDate);
        } else if (fee.paidAt && !isNaN(new Date(fee.paidAt).getTime())) {
          payDate = new Date(fee.paidAt);
        }

        const amt = Number(entry.amount) || 0;

        // Date Range Filter logic: do NOT assign Date.now() or guess invoice creation dates
        const hasDateRangeFilter = Boolean(dateRangeStart || dateRangeEnd);
        if (hasDateRangeFilter) {
          if (!payDate) {
            // Undated payment cannot be verified to fall within the requested date window
            undatedCollectionsCount += 1;
            undatedCollectionsAmount += amt;
            continue;
          }
          if (dateRangeStart && payDate < dateRangeStart) continue;
          if (dateRangeEnd && payDate > dateRangeEnd) continue;
        } else if (!payDate) {
          // All-time report: track undated metrics but retain in all-time parent collections
          undatedCollectionsCount += 1;
          undatedCollectionsAmount += amt;
        }

        const rawEntry = entry as unknown as {
          isOwnerVerified?: boolean;
          receivedByName?: string;
          recordedBy?: unknown;
          status?: string;
        };

        // Teacher Filter (Attribution by Collector: receivedBy with recordedBy fallback)
        const collectorId = entry.receivedBy
          ? String(entry.receivedBy)
          : rawEntry.recordedBy
          ? String(rawEntry.recordedBy)
          : "";
        if (teacherIdParam && teacherIdParam !== "all" && collectorId !== teacherIdParam) {
          continue;
        }

        feeCollectedInWindow += amt;
        totalParentCollections += amt;

        const isDirectOwnerOrDigital =
          entry.receivedByRole === "owner" ||
          entry.paymentMode === "upi" ||
          entry.paymentMode === "bank_transfer" ||
          (Boolean(rawEntry.isOwnerVerified) && (!entry.allocations || entry.allocations.length === 0));

        let ownerVerifiedAmount = 0;
        let teacherInHandAmount = 0;
        let ownerPendingAmount = 0;

        if (isDirectOwnerOrDigital) {
          ownerVerifiedAmount = amt;
        } else {
          const custody = calculatePaymentCustody(entry);
          ownerVerifiedAmount = custody.ownerVerifiedAmount;
          teacherInHandAmount = custody.teacherInHandAmount;
          ownerPendingAmount = custody.ownerPendingVerificationAmount;
        }

        verifiedCashReceived += ownerVerifiedAmount;
        teacherHeldCash += teacherInHandAmount;
        pendingVerificationCash += ownerPendingAmount;

        // Teacher Attribution Accumulation
        if (collectorId) {
          if (!teacherAggMap.has(collectorId)) {
            teacherAggMap.set(collectorId, {
              totalCollected: 0,
              cashInHand: 0,
              cashSubmitted: 0,
              cashVerified: 0,
              txCount: 0,
            });
          }
          const tRow = teacherAggMap.get(collectorId)!;
          tRow.totalCollected += amt;
          tRow.cashInHand += teacherInHandAmount;
          tRow.cashSubmitted += ownerPendingAmount;
          tRow.cashVerified += ownerVerifiedAmount;
          tRow.txCount += 1;
        }

        const collectorInfo = teacherMap.get(collectorId);
        const collectorName =
          rawEntry.receivedByName ||
          (entry.receivedByRole === "owner"
            ? "Institute Owner"
            : collectorInfo?.name || "Faculty Member");

        const custodyDisplayLabel = isDirectOwnerOrDigital
          ? "Owner Safe Custody"
          : ownerVerifiedAmount === amt
          ? "Owner Safe Custody"
          : ownerPendingAmount === amt
          ? "Pending Verification"
          : teacherInHandAmount === amt
          ? "Faculty In-Hand"
          : "Split Custody";

        paymentLineItems.push({
          paymentId: String(entry.paymentId || entry._id || ""),
          amount: Number(amt) || 0,
          paymentDate: payDate || "undated",
          paymentMode: entry.paymentMode || "Cash",
          receiptNumber: entry.receiptNumber || "N/A",
          receivedByName: collectorName,
          receivedByRole: entry.receivedByRole || "teacher",
          custodyStatus: custodyDisplayLabel,
          custodyLabel: custodyDisplayLabel,
          isOwnerVerified: Boolean(rawEntry.isOwnerVerified),
          status: rawEntry.status || "approved",
        });
      }

      bRow.collected += feeCollectedInWindow;

      const sInfo = studentMap.get(sId);
      const studentDoc = studentObj as unknown as {
        parentName?: string;
        parentWhatsApp?: string;
        phone?: string;
      } | null;
      const sParentName = studentDoc?.parentName || sInfo?.parentName || "Parent";
      const sParentPhone =
        studentDoc?.parentWhatsApp || studentDoc?.phone || sInfo?.parentPhone || "";

      studentLedgerRows.push({
        feeId: String(fee._id),
        studentId: sId,
        studentName: sName,
        parentName: sParentName,
        parentPhone: sParentPhone,
        batch: sBatch,
        batchName: sBatch,
        feeMonth: fee.month || "",
        month: fee.month || "",
        feeTitle: fee.title || `${fee.month || ""} Tuition`,
        amountDue: Number(fee.amountDue) || 0,
        paidAmount: Number(fee.paidAmount) || 0,
        outstandingBalance: Number(fee.amountDue) || 0,
        originalAmountDue: feeInvoiced,
        status: fee.status || "Pending",
        feeStatus: fee.status || "Pending",
        payments: paymentLineItems,
      });
    }

    // --- 2. Process & Filter Handovers ---
    let activeDiscrepanciesTotal = 0;
    const handoverReports: HandoverReportRow[] = [];
    const teacherDiscrepancyMap = new Map<string, number>();

    for (const h of handoversRaw) {
      const doc = h as unknown as ICashHandoverDocument;
      const hDate = new Date(doc.submittedAt || doc.createdAt || Date.now());

      // Filter: Date
      if (dateRangeStart && hDate < dateRangeStart) continue;
      if (dateRangeEnd && hDate > dateRangeEnd) continue;

      // Filter: Teacher
      const hTeacherId = String(doc.teacherId || "");
      if (teacherIdParam && teacherIdParam !== "all" && hTeacherId !== teacherIdParam) {
        continue;
      }

      // Filter: Handover Status
      if (handoverStatusParam && handoverStatusParam !== "all") {
        if (doc.status !== handoverStatusParam) continue;
      }

      // Cumulative settlements
      const settlements = doc.incrementalSettlements || [];
      const totalSettled = settlements.reduce(
        (sum, s) => sum + (Number(s.amountReceived) || 0),
        0
      );
      const remainingShortage = Math.max(0, (Number(doc.discrepancyAmount) || 0) - totalSettled);

      if (doc.discrepancyStatus === "disputed" || doc.discrepancyStatus === "shortage_confirmed") {
        activeDiscrepanciesTotal += remainingShortage;
        if (hTeacherId) {
          teacherDiscrepancyMap.set(
            hTeacherId,
            (teacherDiscrepancyMap.get(hTeacherId) || 0) + remainingShortage
          );
        }
      }

      const tName = teacherMap.get(hTeacherId)?.name || "Faculty";

      handoverReports.push({
        handoverId: String(doc._id),
        handoverNumber: doc.handoverNumber || "N/A",
        teacherId: hTeacherId,
        teacherName: tName,
        submittedAt: hDate,
        submittedAmount: Number(doc.submittedAmount) || 0,
        approvedAmount: Number(doc.approvedAmount) || 0,
        discrepancyAmount: Number(doc.discrepancyAmount) || 0,
        remainingDiscrepancy: Number(remainingShortage) || 0,
        status: doc.status || "pending_verification",
        discrepancyStatus: doc.discrepancyStatus || "none",
        itemCount: Number(doc.items?.length) || 0,
        resolutionsCount: Number(doc.resolutions?.length) || 0,
        settlementsCount: Number(settlements.length) || 0,
      });
    }

    // --- 3. Format Teacher Reports Output ---
    const teacherReports: TeacherReportRow[] = [];
    (Array.isArray(teachers) ? teachers : []).forEach((t: any) => {
      const tId = String(t._id);
      if (teacherIdParam && teacherIdParam !== "all" && tId !== teacherIdParam) {
        return;
      }
      const agg = teacherAggMap.get(tId) || {
        totalCollected: 0,
        cashInHand: 0,
        cashSubmitted: 0,
        cashVerified: 0,
        txCount: 0,
      };
      teacherReports.push({
        teacherId: tId,
        teacherName: t.name,
        teacherLoginId: t.loginId,
        totalCollected: Number(agg.totalCollected) || 0,
        teacherInHandAmount: Number(agg.cashInHand) || 0,
        ownerPendingAmount: Number(agg.cashSubmitted) || 0,
        ownerVerifiedAmount: Number(agg.cashVerified) || 0,
        cashInHand: Number(agg.cashInHand) || 0,
        cashSubmitted: Number(agg.cashSubmitted) || 0,
        cashVerified: Number(agg.cashVerified) || 0,
        activeDiscrepancies: Number(teacherDiscrepancyMap.get(tId)) || 0,
        transactionCount: Number(agg.txCount) || 0,
      });
    });

    // Also include Owner if Owner collected payments directly
    const ownerAgg = teacherAggMap.get(String(user.userId));
    if (ownerAgg && (!teacherIdParam || teacherIdParam === "all" || teacherIdParam === String(user.userId))) {
      teacherReports.unshift({
        teacherId: String(user.userId),
        teacherName: "Institute Owner (Direct)",
        teacherLoginId: "owner",
        totalCollected: Number(ownerAgg.totalCollected) || 0,
        teacherInHandAmount: 0,
        ownerPendingAmount: 0,
        ownerVerifiedAmount: Number(ownerAgg.cashVerified) || 0,
        cashInHand: 0,
        cashSubmitted: 0,
        cashVerified: Number(ownerAgg.cashVerified) || 0,
        activeDiscrepancies: 0,
        transactionCount: Number(ownerAgg.txCount) || 0,
      });
    }

    // --- 4. Format Batch Reports Output ---
    const batchReports: BatchReportRow[] = [];
    batchAggMap.forEach((val, bName) => {
      const rate = val.invoiced > 0 ? Math.round((val.collected / val.invoiced) * 100) : 0;
      batchReports.push({
        batchName: bName,
        studentCount: Number(val.studentSet.size) || 0,
        totalInvoiced: Number(val.invoiced) || 0,
        totalCollected: Number(val.collected) || 0,
        outstandingBalance: Number(val.outstanding) || 0,
        partialPaymentCount: Number(val.partialCount) || 0,
        collectionRate: rate,
        collectionRatePercent: rate,
      });
    });
    batchReports.sort((a, b) => a.batchName.localeCompare(b.batchName));

    const summaryKPIs = {
      totalParentCollections,
      verifiedCashReceived,
      teacherHeldCash,
      pendingVerificationCash,
      outstandingFeeBalance,
      activeDiscrepancies: activeDiscrepanciesTotal,
      undatedCollectionsCount,
      undatedCollectionsAmount,
    };

    return NextResponse.json(
      {
        success: true,
        kpis: summaryKPIs,
        teacherReports,
        batchReports,
        studentLedger: studentLedgerRows,
        handoverReports,
        data: {
          summary: summaryKPIs,
          teacherReports,
          batchReports,
          handoverReports,
          metadata: {
            centerId,
            filterCount: {
              teachers: teacherReports.length,
              batches: batchReports.length,
              students: studentLedgerRows.length,
              handovers: handoverReports.length,
            },
          },
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Failed to generate financial summary report";
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500, headers: corsHeaders }
    );
  }
}
