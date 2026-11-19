process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

// Import models & auth
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;

// Import route handler
const { GET: getFeeSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/students/[id]/fee-summary/route.ts"
);

function createMockRequest({
  method = "GET",
  token,
  url = "http://localhost:3000/api/students/507f191e810c19729de86011/fee-summary",
}) {
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  reqHeaders.set("content-type", "application/json");

  const parsedUrl = new URL(url);

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: parsedUrl,
  };
}

test("Student 12-Month Fee Calendar Summary API Suite", async (t) => {
  const centerId = "center_msec";
  const foreignCenterId = "center_foreign";

  const ownerId = "507f191e810c19729de86001";
  const teacher1Id = "507f191e810c19729de86002";
  const teacher2Id = "507f191e810c19729de86003";
  const studentId = "507f191e810c19729de86011";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Sharma",
  });

  const assignedTeacherToken = await signToken({
    userId: teacher1Id,
    centerId,
    role: "teacher",
    teacherId: teacher1Id,
    name: "Teacher Assigned",
  });

  const unassignedTeacherToken = await signToken({
    userId: teacher2Id,
    centerId,
    role: "teacher",
    teacherId: teacher2Id,
    name: "Teacher Unassigned",
  });

  const foreignOwnerToken = await signToken({
    userId: "507f191e810c19729de86099",
    centerId: foreignCenterId,
    role: "owner",
    name: "Foreign Owner",
  });

  // Student admitted in April 2026, due on the 10th of every month, fee 2000
  const sampleStudent = {
    _id: new mongoose.Types.ObjectId(studentId),
    centerId,
    name: "Aarav Sharma",
    batch: "10th Grade Science",
    monthlyFee: 2000,
    billingCycleDate: 10,
    advanceBalance: 500,
    joiningDate: new Date("2026-04-01T00:00:00.000Z"),
    assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
    isActive: true,
    toObject() {
      return { ...this };
    },
  };

  // 1. Unauthenticated request returns HTTP 401
  await t.test("1. Unauthenticated request returns HTTP 401", async () => {
    const req = createMockRequest({
      url: `http://localhost:3000/api/students/${studentId}/fee-summary`,
    });

    const res = await getFeeSummaryRoute(req, {
      params: Promise.resolve({ id: studentId }),
    });
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  // 2. Multi-tenant isolation: Foreign owner cannot view student from another center (HTTP 404)
  await t.test("2. Multi-tenant isolation: Foreign owner receives HTTP 404", async () => {
    const originalFindOne = StudentModel.findOne;
    StudentModel.findOne = async (q) => {
      if (q.centerId === centerId && q._id.toString() === studentId) {
        return sampleStudent;
      }
      return null;
    };

    try {
      const req = createMockRequest({
        token: foreignOwnerToken,
        url: `http://localhost:3000/api/students/${studentId}/fee-summary`,
      });

      const res = await getFeeSummaryRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 404);
      assert.equal(body.success, false);
      assert.match(body.error, /Student not found/i);
    } finally {
      StudentModel.findOne = originalFindOne;
    }
  });

  // 3. Teacher Scoping: Unassigned teacher cannot access student (HTTP 403)
  await t.test("3. Teacher scoping: Unassigned teacher receives HTTP 403", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalTeacherFind = TeacherModel.findOne;

    StudentModel.findOne = async () => sampleStudent;
    TeacherModel.findOne = () => ({
      select: async () => ({ assignedBatches: ["12th Commerce"] }), // Does not include student's batch
    });

    try {
      const req = createMockRequest({
        token: unassignedTeacherToken,
        url: `http://localhost:3000/api/students/${studentId}/fee-summary`,
      });

      const res = await getFeeSummaryRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 403);
      assert.equal(body.success, false);
      assert.match(body.error, /Access denied/i);
    } finally {
      StudentModel.findOne = originalFindOne;
      TeacherModel.findOne = originalTeacherFind;
    }
  });

  // 4. Assigned Teacher can access student (HTTP 200)
  await t.test("4. Teacher scoping: Assigned teacher receives HTTP 200", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFeeFind = FeeModel.find;

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => [];

    try {
      const req = createMockRequest({
        token: assignedTeacherToken,
        url: `http://localhost:3000/api/students/${studentId}/fee-summary`,
      });

      const res = await getFeeSummaryRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.studentId, studentId);
    } finally {
      StudentModel.findOne = originalFindOne;
      FeeModel.find = originalFeeFind;
    }
  });

  // 5. 12-Month Fee Calendar Status Calculation & Summary Metrics
  await t.test("5. Computes summary metrics and 12-month calendar statuses accurately", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFeeFind = FeeModel.find;

    // Fees setup:
    // - April 2026: Paid in full (₹2,000 via Cash on 2026-04-10)
    // - May 2026: Partial paid (₹1,000 paid, ₹1,000 due)
    // - June 2026: Pending due (₹2,000 due)
    // - December 2026: Future advance paid (₹2,000 via UPI on 2026-04-12)
    const mockFees = [
      {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86051"),
        centerId,
        studentId: sampleStudent._id,
        billingMonth: "2026-04",
        amountDue: 0,
        paidAmount: 2000,
        originalAmountDue: 2000,
        status: "Paid",
        paidDate: new Date("2026-04-10T10:00:00.000Z"),
        paymentMode: "Cash",
      },
      {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86052"),
        centerId,
        studentId: sampleStudent._id,
        billingMonth: "2026-05",
        amountDue: 1000,
        paidAmount: 1000,
        originalAmountDue: 2000,
        status: "Partial Paid",
        paidDate: new Date("2026-05-10T10:00:00.000Z"),
        paymentMode: "UPI",
      },
      {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86053"),
        centerId,
        studentId: sampleStudent._id,
        billingMonth: "2026-06",
        amountDue: 2000,
        paidAmount: 0,
        originalAmountDue: 2000,
        status: "Pending",
      },
      {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86054"),
        centerId,
        studentId: sampleStudent._id,
        billingMonth: "2026-12",
        amountDue: 0,
        paidAmount: 2000,
        originalAmountDue: 2000,
        status: "Paid",
        isAdvance: true,
        paidDate: new Date("2026-04-12T10:00:00.000Z"),
        paymentMode: "UPI",
      },
    ];

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => mockFees;

    try {
      const req = createMockRequest({
        token: ownerToken,
        url: `http://localhost:3000/api/students/${studentId}/fee-summary?year=2026`,
      });

      const res = await getFeeSummaryRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.year, 2026);

      // Verify Summary Block
      const summary = body.data.summary;
      assert.equal(summary.monthlyFee, 2000);
      assert.equal(summary.dueDay, 10);
      assert.equal(summary.advanceBalance, 500);
      assert.equal(summary.totalDue, 3000); // 1000 (May) + 2000 (June)
      assert.ok(summary.nextBillingDate, "nextBillingDate must be present");
      assert.ok(summary.admissionDate.startsWith("2026-04"), "admissionDate must reflect April 2026");

      // Verify 12 Months Array
      const months = body.data.months;
      assert.equal(months.length, 12, "Must return exactly 12 calendar months");

      // Months 1-3 (Jan, Feb, Mar): Strictly before admission in April 2026 -> "pre_admission"
      for (let m = 0; m < 3; m++) {
        assert.equal(months[m].status, "pre_admission", `Month ${m + 1} must be pre_admission`);
        assert.equal(months[m].amountInvoiced, 0);
        assert.equal(months[m].amountPaid, 0);
        assert.equal(months[m].amountDue, 0);
        assert.equal(months[m].feeId, null);
      }

      // Month 4 (April): Paid
      assert.equal(months[3].month, 4);
      assert.equal(months[3].label, "Apr");
      assert.equal(months[3].status, "paid");
      assert.equal(months[3].amountInvoiced, 2000);
      assert.equal(months[3].amountPaid, 2000);
      assert.equal(months[3].amountDue, 0);
      assert.equal(months[3].paymentMode, "Cash");
      assert.equal(months[3].feeId, "507f191e810c19729de86051");

      // Month 5 (May): Partial
      assert.equal(months[4].month, 5);
      assert.equal(months[4].label, "May");
      assert.equal(months[4].status, "partial");
      assert.equal(months[4].amountInvoiced, 2000);
      assert.equal(months[4].amountPaid, 1000);
      assert.equal(months[4].amountDue, 1000);
      assert.equal(months[4].paymentMode, "UPI");
      assert.equal(months[4].feeId, "507f191e810c19729de86052");

      // Month 6 (June): Due
      assert.equal(months[5].month, 6);
      assert.equal(months[5].label, "Jun");
      assert.equal(months[5].status, "due");
      assert.equal(months[5].amountInvoiced, 2000);
      assert.equal(months[5].amountPaid, 0);
      assert.equal(months[5].amountDue, 2000);
      assert.equal(months[5].feeId, "507f191e810c19729de86053");

      // Month 12 (December): Future with Advance -> "advance"
      assert.equal(months[11].month, 12);
      assert.equal(months[11].label, "Dec");
      assert.equal(months[11].status, "advance");
      assert.equal(months[11].amountPaid, 2000);
      assert.equal(months[11].amountDue, 0);
      assert.equal(months[11].feeId, "507f191e810c19729de86054");

      // Month labels check
      const expectedLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      months.forEach((m, idx) => {
        assert.equal(m.label, expectedLabels[idx]);
        assert.equal(m.month, idx + 1);
        assert.ok(m.billingDate.includes("-10T"), `Billing date for month ${idx + 1} must use dueDay 10`);
      });
    } finally {
      StudentModel.findOne = originalFindOne;
      FeeModel.find = originalFeeFind;
    }
  });

  // 6. Year defaulting: Defaults to current year when omitted
  await t.test("6. Defaults to current year when ?year is omitted", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFeeFind = FeeModel.find;

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => [];

    try {
      const req = createMockRequest({
        token: ownerToken,
        url: `http://localhost:3000/api/students/${studentId}/fee-summary`,
      });

      const res = await getFeeSummaryRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.data.year, new Date().getFullYear());
      assert.equal(body.data.months.length, 12);
    } finally {
      StudentModel.findOne = originalFindOne;
      FeeModel.find = originalFeeFind;
    }
  });
});
