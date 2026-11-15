process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { GET: getStudentsRoute } = await import(
  "../tution-desk-be/src/app/api/students/route.ts"
);
const { GET: getFeesRoute } = await import(
  "../tution-desk-be/src/app/api/fees/route.ts"
);
const { GET: getFinancialSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/reports/financial-summary/route.ts"
);
const { GET: getOwnerDashboardRoute } = await import(
  "../tution-desk-be/src/app/api/dashboard/owner/route.ts"
);
const { GET: getFeesSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/fees/summary/route.ts"
);

const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const CashHandoverModel = (await import("../tution-desk-be/src/models/CashHandover.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
const BatchModel = (await import("../tution-desk-be/src/models/Batch.ts")).default;
const AttendanceModel = (await import("../tution-desk-be/src/models/Attendance.ts")).default;
const TestModel = (await import("../tution-desk-be/src/models/Test.ts")).default;
const mongoose = (await import("../tution-desk-be/node_modules/mongoose/index.js")).default;

function createMockRequest({
  token,
  url = "http://localhost:3000/api/test",
  params = {},
}) {
  const reqUrl = new URL(url);
  for (const [key, val] of Object.entries(params)) {
    reqUrl.searchParams.set(key, String(val));
  }

  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }

  return {
    method: "GET",
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: reqUrl,
  };
}

function mockQuery(result) {
  const queryObj = {
    sort: () => queryObj,
    populate: () => queryObj,
    select: () => queryObj,
    skip: () => queryObj,
    limit: () => queryObj,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return queryObj;
}

test("MSEC — P0 Performance Optimization Regression Suite", async (t) => {
  const centerId = "center_perf_alpha";
  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Alpha",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    teacherId,
    centerId,
    role: "teacher",
    name: "Faculty Member Beta",
  });

  CenterModel.findOne = () => ({
    select: () => Promise.resolve({ _id: ownerId, name: "Alpha Academy", ownerName: "Owner Alpha" }),
  });
  TeacherModel.find = () => ({
    select: () => Promise.resolve([{ _id: teacherId, name: "Faculty Beta", loginId: "beta" }]),
  });

  // =========================================================================
  // SECTION 1: STUDENTS SERVER-SIDE PAGINATION & BACKWARD COMPATIBILITY
  // =========================================================================
  await t.test("1.1. Students route returns 50 items by default with complete pagination metadata", async () => {
    let capturedSkip = null;
    let capturedLimit = null;

    const dummyStudents = Array.from({ length: 50 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      centerId,
      name: `Student ${i + 1}`,
      rollNumber: `R-${100 + i}`,
      batch: "Batch A",
      parentWhatsApp: "9876543210",
      monthlyFee: 1500,
      isActive: true,
      toObject() { return { ...this }; },
    }));

    StudentModel.find = () => ({
      select: () => ({
        sort: () => ({
          skip: (s) => ({
            limit: (l) => {
              capturedSkip = s;
              capturedLimit = l;
              return Promise.resolve(dummyStudents);
            },
          }),
        }),
      }),
    });
    StudentModel.countDocuments = async () => 135;

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/students",
      params: { page: "1" },
    });

    const res = await getStudentsRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal(body.data.length, 50);
    assert.equal(capturedSkip, 0);
    assert.equal(capturedLimit, 50);

    // Verify pagination metadata
    assert.ok(body.pagination, "Pagination metadata must be present");
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 50);
    assert.equal(body.pagination.total, 135);
    assert.equal(body.pagination.totalPages, 3);
    assert.equal(body.pagination.hasNextPage, true);
    assert.equal(body.pagination.hasPreviousPage, false);
  });

  await t.test("1.2. Students route calculates correct skip offset on page 2", async () => {
    let capturedSkip = null;
    let capturedLimit = null;

    StudentModel.find = () => ({
      select: () => ({
        sort: () => ({
          skip: (s) => ({
            limit: (l) => {
              capturedSkip = s;
              capturedLimit = l;
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    });
    StudentModel.countDocuments = async () => 135;

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/students",
      params: { page: "2", limit: "50" },
    });

    const res = await getStudentsRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(capturedSkip, 50);
    assert.equal(capturedLimit, 50);
    assert.equal(body.pagination.page, 2);
    assert.equal(body.pagination.hasNextPage, true);
    assert.equal(body.pagination.hasPreviousPage, true);
  });

  await t.test("1.3. Students route clamps limit safely to maximum 100", async () => {
    let capturedLimit = null;

    StudentModel.find = () => ({
      select: () => ({
        sort: () => ({
          skip: () => ({
            limit: (l) => {
              capturedLimit = l;
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    });
    StudentModel.countDocuments = async () => 200;

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/students",
      params: { limit: "999" }, // Attacker or misconfigured client requests 999
    });

    const res = await getStudentsRoute(req);
    assert.equal(res.status, 200);
    assert.equal(capturedLimit, 100, "Limit must be clamped to max 100");
  });

  // =========================================================================
  // SECTION 2: FEES SERVER-SIDE PAGINATION & METADATA
  // =========================================================================
  await t.test("2.1. Fees route applies pagination and returns complete pagination contract", async () => {
    let capturedSkip = null;
    let capturedLimit = null;

    const mockFees = Array.from({ length: 25 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      centerId,
      amountDue: 2000,
      paidAmount: 0,
      status: "Pending",
      studentId: {
        _id: new mongoose.Types.ObjectId(),
        name: `Student ${i}`,
        batch: "Batch A",
        parentWhatsApp: "9876543210",
      },
      toObject() { return { ...this }; },
    }));

    FeeModel.find = () => ({
      populate: () => ({
        sort: () => ({
          skip: (s) => ({
            limit: (l) => {
              capturedSkip = s;
              capturedLimit = l;
              return Promise.resolve(mockFees);
            },
          }),
        }),
      }),
    });
    FeeModel.countDocuments = async () => 180;

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/fees",
      params: { status: "Pending", page: "2", limit: "25" },
    });

    const res = await getFeesRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal(body.data.length, 25);
    assert.equal(capturedSkip, 25);
    assert.equal(capturedLimit, 25);

    assert.ok(body.pagination, "Fees pagination metadata must be present");
    assert.equal(body.pagination.page, 2);
    assert.equal(body.pagination.limit, 25);
    assert.equal(body.pagination.total, 180);
    assert.equal(body.pagination.totalPages, 8);
    assert.equal(body.pagination.hasNextPage, true);
    assert.equal(body.pagination.hasPreviousPage, true);
  });

  await t.test("2.2. Fees route with all=true bypasses limit and skip, returning full dataset", async () => {
    let wasSkipCalled = false;
    let wasLimitCalled = false;
    const mockFees = Array.from({ length: 65 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      centerId,
      amountDue: 1000,
      paidAmount: 1000,
      status: "Paid",
      month: `2026-${String((i % 12) + 1).padStart(2, "0")}`,
      studentId: { _id: new mongoose.Types.ObjectId(), name: `Student ${i}`, batch: "Batch A" },
      toObject: function () { return this; },
    }));

    FeeModel.find = () => {
      const q = {
        populate: () => q,
        sort: () => q,
        skip: () => { wasSkipCalled = true; return q; },
        limit: () => { wasLimitCalled = true; return q; },
        then: (resolve) => Promise.resolve(mockFees).then(resolve),
      };
      return q;
    };
    FeeModel.countDocuments = async () => 65;

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/fees",
      params: { status: "Paid,Partial Paid", all: "true" },
    });

    const res = await getFeesRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal(body.data.length, 65);
    assert.equal(wasSkipCalled, false, "skip() must not be called when all=true");
    assert.equal(wasLimitCalled, false, "limit() must not be called when all=true");
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.totalPages, 1);
    assert.equal(body.pagination.hasNextPage, false);
  });

  await t.test("2.3. Fees route with studentId but without explicit pagination defaults safely to limit 500", async () => {
    let capturedLimit = null;
    const mockFees = [{ _id: new mongoose.Types.ObjectId(), amountDue: 500, toObject: function () { return this; } }];

    FeeModel.find = () => ({
      populate: () => ({
        sort: () => ({
          skip: () => ({
            limit: (l) => {
              capturedLimit = l;
              return Promise.resolve(mockFees);
            },
          }),
        }),
      }),
    });
    FeeModel.countDocuments = async () => 1;

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/fees",
      params: { studentId: "507f191e810c19729de86999" },
    });

    const res = await getFeesRoute(req);
    assert.equal(res.status, 200);
    assert.equal(capturedLimit, 500, "Single student fee history must default to limit 500 to prevent silent truncation");
  });

  await t.test("2.4. Fees route enforces tenant and teacher role scoping even when all=true is passed", async () => {
    let capturedFilter = null;
    StudentModel.find = () => ({
      distinct: () => Promise.resolve([new mongoose.Types.ObjectId()]),
    });
    FeeModel.find = (f) => {
      capturedFilter = f;
      return {
        populate: () => ({
          sort: () => Promise.resolve([]),
        }),
      };
    };
    FeeModel.countDocuments = async () => 0;

    const req = createMockRequest({
      token: teacherToken,
      url: "http://localhost:3000/api/fees",
      params: { all: "true" },
    });

    const res = await getFeesRoute(req);
    assert.equal(res.status, 200);
    assert.equal(capturedFilter.centerId, centerId, "Tenant isolation must be enforced with all=true");
    assert.ok(capturedFilter.$or, "Teacher role scoping must be enforced with all=true");
  });

  // =========================================================================
  // SECTION 3: FINANCIAL REPORTS PUSH-DOWN & TIMEZONE INTEGRITY
  // =========================================================================
  await t.test("3.1. Reports route pushes handover status and fee status down to MongoDB queries", async () => {
    let capturedHandoverFilter = null;
    let capturedFeeFilter = null;

    TeacherModel.find = () => mockQuery([{ _id: teacherId, name: "Faculty Beta", loginId: "beta" }]);
    StudentModel.find = () => mockQuery([]);
    CashHandoverModel.find = (filter) => {
      capturedHandoverFilter = filter;
      return mockQuery([]);
    };
    FeeModel.find = (filter) => {
      capturedFeeFilter = filter;
      return mockQuery([]);
    };

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/reports/financial-summary",
      params: {
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        status: "Paid",
        handoverStatus: "verified",
      },
    });

    const res = await getFinancialSummaryRoute(req);
    const body = await res.json();
    if (res.status !== 200) {
      console.log("TEST 3.1 ERROR:", body);
    }
    assert.equal(res.status, 200);

    // Verify filter pushdown
    assert.equal(capturedFeeFilter.centerId, centerId);
    assert.equal(capturedFeeFilter.status, "Paid");

    assert.equal(capturedHandoverFilter.centerId, centerId);
    assert.equal(capturedHandoverFilter.status, "verified");
    assert.ok(capturedHandoverFilter.submittedAt, "Date range filter must be applied to submittedAt");
    assert.equal(capturedHandoverFilter.submittedAt.$gte.toISOString(), new Date("2026-11-01T00:00:00.000+05:30").toISOString());
  });

  await t.test("3.2. Financial Summary excludes undated payment entries from date-bounded calculations without assigning Date.now()", async () => {
    const student1Id = new mongoose.Types.ObjectId();
    StudentModel.find = () => mockQuery([{ _id: student1Id, name: "Aarav", batch: "Batch A" }]);
    TeacherModel.find = () => mockQuery([{ _id: teacherId, name: "Faculty Beta", loginId: "beta" }]);
    CashHandoverModel.find = () => mockQuery([]);

    // Fee with paidAmount 3000 but NO paymentDate, NO paidDate, NO paidAt, NO recordedAt
    const undatedFee = {
      _id: new mongoose.Types.ObjectId(),
      centerId,
      studentId: { _id: student1Id, name: "Aarav", batch: "Batch A" },
      batchAtPayment: "Batch A",
      amountDue: 0,
      paidAmount: 3000,
      status: "Paid",
      month: "2026-11",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId(),
          amount: 3000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
        },
      ],
      createdAt: new Date("2026-05-01T10:00:00.000Z"),
    };

    FeeModel.find = () => mockQuery([undatedFee]);

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/reports/financial-summary",
      params: {
        startDate: "2026-11-01",
        endDate: "2026-11-30",
      },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.totalParentCollections, 0, "Undated payments must NOT be assigned Date.now() and included in date range");
    assert.equal(body.kpis.undatedCollectionsCount, 1, "Must track undatedCollectionsCount");
    assert.equal(body.kpis.undatedCollectionsAmount, 3000, "Must track undatedCollectionsAmount");
  });

  await t.test("3.3. Financial Summary includes undated payments in all-time totals and reports undatedCollections metrics", async () => {
    const student1Id = new mongoose.Types.ObjectId();
    StudentModel.find = () => mockQuery([{ _id: student1Id, name: "Aarav", batch: "Batch A" }]);
    TeacherModel.find = () => mockQuery([{ _id: teacherId, name: "Faculty Beta", loginId: "beta" }]);
    CashHandoverModel.find = () => mockQuery([]);

    const undatedFee = {
      _id: new mongoose.Types.ObjectId(),
      centerId,
      studentId: { _id: student1Id, name: "Aarav", batch: "Batch A" },
      batchAtPayment: "Batch A",
      amountDue: 0,
      paidAmount: 3000,
      status: "Paid",
      month: "2026-11",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId(),
          amount: 3000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
        },
      ],
      createdAt: new Date("2026-05-01T10:00:00.000Z"),
    };

    FeeModel.find = () => mockQuery([undatedFee]);

    // All-time query without startDate / endDate
    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/reports/financial-summary",
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.totalParentCollections, 3000, "All-time report must include undated payments in totalParentCollections");
    assert.equal(body.kpis.undatedCollectionsCount, 1, "Must report undatedCollectionsCount");
    assert.equal(body.kpis.undatedCollectionsAmount, 3000, "Must report undatedCollectionsAmount");
  });

  await t.test("3.4. Financial Summary partial payments retain correct date-based line-item aggregation", async () => {
    const student1Id = new mongoose.Types.ObjectId();
    StudentModel.find = () => mockQuery([{ _id: student1Id, name: "Diya", batch: "Batch Science" }]);
    TeacherModel.find = () => mockQuery([{ _id: teacherId, name: "Faculty Beta", loginId: "beta" }]);
    CashHandoverModel.find = () => mockQuery([]);

    const partialFee = {
      _id: new mongoose.Types.ObjectId(),
      centerId,
      studentId: { _id: student1Id, name: "Diya", batch: "Batch Science" },
      batchAtPayment: "Batch Science",
      amountDue: 2000,
      paidAmount: 4000,
      status: "Partial Paid",
      month: "2026-11",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId(),
          amount: 1500,
          paymentDate: new Date("2026-10-15T10:00:00.000Z"), // October payment
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
        },
        {
          paymentId: new mongoose.Types.ObjectId(),
          amount: 2500,
          paymentDate: new Date("2026-11-15T10:00:00.000Z"), // November payment
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
        },
      ],
    };

    FeeModel.find = () => mockQuery([partialFee]);

    // Query strictly for November 2026
    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/reports/financial-summary",
      params: {
        startDate: "2026-11-01",
        endDate: "2026-11-30",
      },
    });

    const res = await getFinancialSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.kpis.totalParentCollections, 2500, "Only the November partial payment must be counted in November range");
    assert.equal(body.kpis.outstandingFeeBalance, 2000, "Outstanding balance on partial fee must be accurately retained");
  });

  // =========================================================================
  // SECTION 4: OWNER DASHBOARD COLLECTION CURRENT-MONTH BOUNDARY
  // =========================================================================
  await t.test("4.1. Owner Dashboard applies current IST month boundary to collectedFeesThisMonth", async () => {
    let capturedFeeAggregatePipeline = null;

    StudentModel.countDocuments = async () => 45;
    BatchModel.countDocuments = async () => 3;
    AttendanceModel.countDocuments = async () => 30;
    TestModel.countDocuments = async () => 5;
    BatchModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);
    StudentModel.aggregate = async () => [];

    FeeModel.countDocuments = async () => 10;
    FeeModel.aggregate = async (pipeline) => {
      // Differentiate pending sum from collected sum
      if (pipeline[0]?.$match?.status === "Pending") {
        return [{ total: 15000 }];
      }
      capturedFeeAggregatePipeline = pipeline;
      return [{ total: 42000 }];
    };
    FeeModel.find = () => mockQuery([]);

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/dashboard/owner",
    });

    const res = await getOwnerDashboardRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal(body.data.collectedFeesThisMonth, 42000);

    // Verify aggregation pipeline structure
    assert.ok(capturedFeeAggregatePipeline, "Must run aggregation for collected fees");
    const matchStage = capturedFeeAggregatePipeline.find((s) => s.$match && s.$match.centerId);
    assert.ok(matchStage, "Must include centerId in $match stage");
    assert.deepEqual(matchStage.$match.status, { $in: ["Paid", "Partial Paid"] });

    // Verify unwind & date-filter stages are present for IST month containment
    const unwindStage = capturedFeeAggregatePipeline.find((s) => s.$unwind === "$payments");
    assert.ok(unwindStage, "Must unwind payments for individual payment-history line items");

    const dateFilterStage = capturedFeeAggregatePipeline.find(
      (s) => s.$match && s.$match["payments.paymentDate"]
    );
    assert.ok(dateFilterStage, "Must filter payments within current month date boundary");
    assert.ok(dateFilterStage.$match["payments.paymentDate"].$gte, "Must have $gte start of month");
    assert.ok(dateFilterStage.$match["payments.paymentDate"].$lte, "Must have $lte end of month");
  });

  await t.test("4.2. Owner Dashboard aggregation pipeline strictly removes updatedAt from paymentDate fallback", async () => {
    let capturedPipeline = null;

    StudentModel.countDocuments = async () => 10;
    BatchModel.countDocuments = async () => 1;
    AttendanceModel.countDocuments = async () => 5;
    TestModel.countDocuments = async () => 1;
    BatchModel.find = () => mockQuery([]);
    StudentModel.find = () => mockQuery([]);
    StudentModel.aggregate = async () => [];

    FeeModel.countDocuments = async () => 2;
    FeeModel.aggregate = async (pipeline) => {
      if (pipeline[0]?.$match?.status === "Pending") {
        return [{ total: 5000 }];
      }
      capturedPipeline = pipeline;
      return [{ total: 10000 }];
    };
    FeeModel.find = () => mockQuery([]);

    const req = createMockRequest({
      token: ownerToken,
      url: "http://localhost:3000/api/dashboard/owner",
    });

    const res = await getOwnerDashboardRoute(req);
    assert.equal(res.status, 200);

    assert.ok(capturedPipeline, "Must capture aggregation pipeline");
    const projectStage = capturedPipeline.find((s) => s.$project && s.$project.payments);
    assert.ok(projectStage, "Must have $project payments stage");

    const projectStr = JSON.stringify(projectStage);
    assert.equal(projectStr.includes("$updatedAt"), false, "Pipeline must NOT use $updatedAt as payment fallback");
    assert.equal(projectStr.includes("$createdAt"), false, "Pipeline must NOT use $createdAt as confirmed payment date");
  });

  // =========================================================================
  // SECTION 5: FEES SUMMARY RECENT COLLECTIONS UNDATED DATE INTEGRITY
  // =========================================================================
  await t.test("5.1. Fees summary preserves undated paymentDate as null and does NOT fallback to createdAt or Date.now()", async () => {
    const student1Id = new mongoose.Types.ObjectId();
    StudentModel.find = () => mockQuery([{ _id: student1Id, name: "Tanvi", batch: "Batch A" }]);
    TeacherModel.find = () => mockQuery([{ _id: teacherId, name: "Faculty Beta", loginId: "beta" }]);
    CashHandoverModel.find = () => mockQuery([]);

    // Undated legacy paid fee where teacher collected cash
    const undatedLegacyFee = {
      _id: new mongoose.Types.ObjectId(),
      centerId,
      studentId: student1Id,
      amountDue: 0,
      paidAmount: 2000,
      status: "Paid",
      feeType: "adhoc",
      month: "2026-11",
      receivedBy: new mongoose.Types.ObjectId(teacherId),
      receivedByRole: "teacher",
      paymentHistory: [
        {
          paymentId: new mongoose.Types.ObjectId(),
          amount: 2000,
          paymentMode: "Cash",
          receivedBy: new mongoose.Types.ObjectId(teacherId),
          receivedByRole: "teacher",
          // explicitly omitting paymentDate and recordedAt
        },
      ],
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
    };

    FeeModel.find = () => mockQuery([undatedLegacyFee]);

    const req = createMockRequest({
      token: teacherToken,
      url: "http://localhost:3000/api/fees/summary",
    });

    const res = await getFeesSummaryRoute(req);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.recentCollections), "recentCollections must be an array");
    assert.equal(body.data.recentCollections.length, 1);

    const recentItem = body.data.recentCollections[0];
    assert.equal(recentItem.amount, 2000);
    assert.equal(recentItem.paymentDate, null, "paymentDate must be null for undated payments, NOT createdAt or Date.now()");
    assert.equal(body.data.kpis.ownCashCollected, 2000);
    assert.equal(body.data.kpis.ownCashInHand, 2000);
  });
});
