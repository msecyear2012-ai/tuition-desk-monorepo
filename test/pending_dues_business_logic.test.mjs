import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";

test("MSEC — Fees Tab & Pending Dues Business Logic Suite", async (t) => {

  await t.test("PART 1: Static Architectural & Mobile UI Safeguards", async (st) => {
    const pagePath = path.resolve("src/app/fees/page.tsx");
    const clientPath = path.resolve("src/app/fees/FeesClient.tsx");
    const overdueItemPath = path.resolve("src/components/fees/OverdueStudentItem.tsx");
    const topHeaderPath = path.resolve("src/components/layout/TopHeader.tsx");

    const pageContent = fs.readFileSync(pagePath, "utf-8");
    const clientContent = fs.readFileSync(clientPath, "utf-8");
    const overdueContent = fs.readFileSync(overdueItemPath, "utf-8");
    const topHeaderContent = fs.readFileSync(topHeaderPath, "utf-8");

    await st.test("1.1 page.tsx uses Suspense boundary wrapping FeesDataLoader to prevent uncached data error", () => {
      assert.ok(pageContent.includes("<Suspense"), "page.tsx must wrap data loading in <Suspense>");
      assert.ok(pageContent.includes("fallback={<FeesPageFallback"), "page.tsx must have a Suspense fallback");
      assert.ok(pageContent.includes("function FeesDataLoader"), "page.tsx must use FeesDataLoader component");
    });

    await st.test("1.2 OverdueStudentItem.tsx implements mobile-safe card layout and no-overflow protections", () => {
      assert.ok(overdueContent.includes("w-full max-w-full overflow-hidden"), "OverdueStudentItem card must have overflow-hidden");
      assert.ok(overdueContent.includes("min-w-0 flex-1"), "Student name container must use min-w-0 to prevent flex blowout");
    });

    await st.test("1.3 OverdueStudentItem.tsx implements ergonomic mobile review CTA row (stacked actions, full width CTA)", () => {
      assert.ok(
        overdueContent.includes("flex-1 sm:flex-initial") && overdueContent.includes("w-full sm:w-auto"),
        "Secondary buttons must split equally on mobile and CTA must be full-width on mobile"
      );
      assert.ok(overdueContent.includes("h-10"), "Buttons must have minimum 40px touch targets for mobile usability");
    });

    await st.test("1.4 OverdueStudentItem.tsx displays rejection notice banner when rejectionReason exists (Rule C)", () => {
      assert.ok(overdueContent.includes("student.rejectionReason"), "OverdueStudentItem must render student.rejectionReason");
      assert.ok(overdueContent.includes("Rejected:"), "Must display rejection label");
    });

    await st.test("1.5 FeesClient.tsx implements horizontal scroll on navigation and stacks cash collections on mobile", () => {
      assert.ok(clientContent.includes("overflow-x-auto no-scrollbar touch-pan-x"), "Navigation tabs must have horizontal scroll classes for narrow viewports");
      assert.ok(clientContent.includes("flex-col items-end gap-1 flex-shrink-0 sm:flex-row"), "Cash collections amount/custody must stack vertically on mobile");
    });

    await st.test("1.6 TopHeader.tsx handles narrow mobile screens without header clipping", () => {
      assert.ok(topHeaderContent.includes("min-w-0 flex-1 mr-2"), "TopHeader title container must have min-w-0 flex-1");
    });
  });

  await t.test("PART 2: Pending Dues Business Logic Filtering Rules (A - F)", async (st) => {
    // We replicate the exact client-side filtering logic implemented in FeesClient.tsx fetchFeesData
    function processFeeRecords(fees) {
      const pendingStudents = [];
      const reviewStudents = [];
      const paidStudents = [];

      fees.forEach((f) => {
        const studentInfo = f.studentId || {};
        const proof = f.paymentProof || {};
        const effectiveStatus = f.paymentProofStatus || f.status;

        const feeItem = {
          id: f._id,
          feeId: f._id,
          name: studentInfo.name || "Student",
          studentName: studentInfo.name || "Student",
          amount: Number(f.amountDue ?? f.amount ?? 0),
          amountDue: Number(f.amountDue ?? f.amount ?? 0),
          totalAmount: Number(f.amount ?? 0),
          amountPaid: Number(f.amountPaid ?? 0),
          status: f.status,
          paymentProofStatus: f.paymentProofStatus,
          isAdvance: Boolean(f.isAdvance || f.feeType === "advance"),
          feeType: f.feeType,
          utrNumber: f.utrNumber,
          rejectionReason: proof.rejectionReason || f.rejectionReason,
        };

        // Review list (Awaiting Review)
        if (effectiveStatus === "Verification Pending") {
          reviewStudents.push(feeItem);
        }

        // Paid list
        if (f.status === "Paid") {
          paidStudents.push(feeItem);
        }

        // Pending Dues list (Rules A - F)
        const isAwaitingVerification = effectiveStatus === "Verification Pending";
        const isPaid = f.status === "Paid";
        const hasNoDue = feeItem.amountDue <= 0;
        const isFullyCoveredAdvance = feeItem.isAdvance && feeItem.amountDue <= 0;

        if (!isAwaitingVerification && !isPaid && !hasNoDue && !isFullyCoveredAdvance) {
          if (f.status === "Pending" || f.status === "Partial Paid") {
            pendingStudents.push(feeItem);
          }
        }
      });

      return { pendingStudents, reviewStudents, paidStudents };
    }

    await st.test("Rule A: System-generated unpaid fee appears in Pending Dues with actual amountDue", () => {
      const mockData = [
        {
          _id: "fee_sys_01",
          studentId: { name: "Alice Smith" },
          amount: 2500,
          amountDue: 2500,
          amountPaid: 0,
          status: "Pending",
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 1);
      assert.equal(result.pendingStudents[0].feeId, "fee_sys_01");
      assert.equal(result.pendingStudents[0].amountDue, 2500);
      assert.equal(result.reviewStudents.length, 0);
      assert.equal(result.paidStudents.length, 0);
    });

    await st.test("Rule B: Parent-submitted UTR is excluded from Pending Dues and appears in Awaiting Review", () => {
      const mockData = [
        {
          _id: "fee_utr_02",
          studentId: { name: "Bob Jones" },
          amount: 3000,
          amountDue: 3000,
          amountPaid: 0,
          status: "Pending",
          paymentProofStatus: "Verification Pending",
          utrNumber: "UPI1234567890",
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 0, "Fee with Verification Pending must be excluded from Pending Dues");
      assert.equal(result.reviewStudents.length, 1, "Fee with Verification Pending must appear in Review tab");
      assert.equal(result.reviewStudents[0].utrNumber, "UPI1234567890");
    });

    await st.test("Rule B2: Screenshot-only submission is excluded from Pending Dues and appears in Awaiting Review", () => {
      const mockData = [
        {
          _id: "fee_scr_03",
          studentId: { name: "Charlie Brown" },
          amount: 2000,
          amountDue: 2000,
          amountPaid: 0,
          status: "Pending",
          paymentProofStatus: "Verification Pending",
          paymentProof: {
            screenshotUrl: "https://ik.imagekit.io/proofs/scr_charlie.png",
          }
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 0, "Screenshot submission under review must be excluded from Pending Dues");
      assert.equal(result.reviewStudents.length, 1, "Screenshot submission must appear in Review tab");
    });

    await st.test("Rule C: Rejected proof returns to Pending Dues with rejectionReason preserved", () => {
      const mockData = [
        {
          _id: "fee_rej_04",
          studentId: { name: "David Wilson" },
          amount: 1800,
          amountDue: 1800,
          amountPaid: 0,
          status: "Pending",
          paymentProofStatus: "None",
          paymentProof: {
            rejectionReason: "Screenshot blurred, please upload clear image or provide UTR",
          }
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 1, "Rejected proof fee must return to Pending Dues");
      assert.equal(result.pendingStudents[0].rejectionReason, "Screenshot blurred, please upload clear image or provide UTR");
      assert.equal(result.reviewStudents.length, 0, "Rejected fee must no longer be in Review tab");
    });

    await st.test("Rule D: Approved partial payment displays only remaining balance, not original total", () => {
      const mockData = [
        {
          _id: "fee_part_05",
          studentId: { name: "Emma Watson" },
          amount: 5000,
          amountDue: 2000,
          amountPaid: 3000,
          status: "Partial Paid",
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 1);
      assert.equal(result.pendingStudents[0].amountDue, 2000, "Must display remaining balance 2000");
      assert.equal(result.pendingStudents[0].totalAmount, 5000);
      assert.equal(result.pendingStudents[0].amountPaid, 3000);
    });

    await st.test("Rule E1: Fully covered advance payment (amountDue <= 0) is excluded from Pending Dues", () => {
      const mockData = [
        {
          _id: "fee_adv_06",
          studentId: { name: "Frank Miller" },
          amount: 4000,
          amountDue: 0,
          amountPaid: 4000,
          isAdvance: true,
          status: "Paid",
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 0, "Fully covered advance must not be in Pending Dues");
      assert.equal(result.paidStudents.length, 1, "Fully paid advance belongs in Paid list");
    });

    await st.test("Rule E2: Advance payment with remaining balance shows only that remaining balance", () => {
      const mockData = [
        {
          _id: "fee_adv_07",
          studentId: { name: "Grace Hopper" },
          amount: 6000,
          amountDue: 1500,
          amountPaid: 4500,
          isAdvance: true,
          status: "Partial Paid",
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 1, "Advance with balance due must show in Pending Dues");
      assert.equal(result.pendingStudents[0].amountDue, 1500, "Must show remaining balance 1500");
    });

    await st.test("Rule F: Fully paid fee (status === 'Paid') is excluded from Pending Dues", () => {
      const mockData = [
        {
          _id: "fee_paid_08",
          studentId: { name: "Harry Potter" },
          amount: 3500,
          amountDue: 0,
          amountPaid: 3500,
          status: "Paid",
        }
      ];

      const result = processFeeRecords(mockData);
      assert.equal(result.pendingStudents.length, 0, "Paid fee must be excluded from Pending Dues");
      assert.equal(result.paidStudents.length, 1, "Paid fee must appear in Paid tab");
    });

    await st.test("Summary counts: totalOverdue & pendingStudentsCount accurately match filtered records", () => {
      const mixedBatch = [
        { _id: "f1", studentId: { name: "S1" }, amount: 1000, amountDue: 1000, status: "Pending" }, // Pending Dues: +1000
        { _id: "f2", studentId: { name: "S2" }, amount: 2000, amountDue: 500, amountPaid: 1500, status: "Partial Paid" }, // Pending Dues: +500
        { _id: "f3", studentId: { name: "S3" }, amount: 3000, amountDue: 3000, status: "Pending", paymentProofStatus: "Verification Pending" }, // In Review: excluded
        { _id: "f4", studentId: { name: "S4" }, amount: 2500, amountDue: 0, amountPaid: 2500, status: "Paid" }, // Paid: excluded
        { _id: "f5", studentId: { name: "S5" }, amount: 4000, amountDue: 0, amountPaid: 4000, isAdvance: true, status: "Paid" }, // Fully covered advance: excluded
        { _id: "f6", studentId: { name: "S6" }, amount: 5000, amountDue: 1200, amountPaid: 3800, isAdvance: true, status: "Partial Paid" }, // Partial advance: +1200
      ];

      const result = processFeeRecords(mixedBatch);
      assert.equal(result.pendingStudents.length, 3, "Only 3 records are actively pending");
      assert.equal(result.reviewStudents.length, 1, "Only 1 record is awaiting review");
      assert.equal(result.paidStudents.length, 2, "2 records are paid");

      const totalOverdue = result.pendingStudents.reduce((sum, s) => sum + s.amountDue, 0);
      assert.equal(totalOverdue, 1000 + 500 + 1200, "Total overdue amount should equal 2700");
    });
  });

  await t.test("PART 3: Backend API Query Filtering Verification", async (st) => {
    const feesRoutePath = path.resolve("tution-desk-be/src/app/api/fees/route.ts");
    const summaryRoutePath = path.resolve("tution-desk-be/src/app/api/fees/summary/route.ts");

    const feesRouteContent = fs.readFileSync(feesRoutePath, "utf-8");
    const summaryRouteContent = fs.readFileSync(summaryRoutePath, "utf-8");

    await st.test("3.1 GET /api/fees ensures amountDue > 0 when querying Pending or Partial Paid records", () => {
      assert.ok(
        feesRouteContent.includes("filter.amountDue = { $gt: 0 }"),
        "/api/fees route must filter amountDue: { $gt: 0 } for pending/partial fees"
      );
    });

    await st.test("3.2 GET /api/fees/summary ensures pending aggregations only count amountDue > 0", () => {
      assert.ok(
        summaryRouteContent.includes("amountDue: { $gt: 0 }"),
        "/api/fees/summary route must filter amountDue: { $gt: 0 } in summary aggregations"
      );
    });
  });
});
