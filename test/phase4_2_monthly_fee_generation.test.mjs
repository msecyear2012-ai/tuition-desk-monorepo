process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { generateOrGetMonthlyFee } = await import(
  "../tution-desk-be/src/lib/feeService.ts"
);
const { getFeePaymentEntries } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { POST: postFeeRoute, GET: getFeesRoute } = await import(
  "../tution-desk-be/src/app/api/fees/route.ts"
);
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;

function createMockRequest({
  method = "GET",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/fees",
}) {
  const reqHeaders = new Headers(headers);
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: new URL(url),
    json: async () => body || {},
  };
}

test("Phase 4.2 Task 3: Monthly Fee Generation Integration Suite", async (t) => {
  const centerId = "center_alpha";
  const studentAId = "507f191e810c19729de860ea";
  const studentBId = "507f191e810c19729de860eb";
  const teacherId = "507f191e810c19729de860f2";
  const ownerId = "507f191e810c19729de860f1";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director Alpha",
  });

  function createMockEnv(initialData = {}) {
    const feeDocs = new Map(initialData.fees || []);
    const studentDocs = new Map(
      initialData.students || [
        [
          studentAId,
          {
            _id: studentAId,
            centerId,
            name: "Student Alpha",
            monthlyFee: 3000,
            isActive: true,
            billingCycleDate: 5,
            joiningDate: new Date("2024-01-01T00:00:00Z"),
            assignedTeacherId: teacherId,
            batch: "Batch A - Morning",
          },
        ],
        [
          studentBId,
          {
            _id: studentBId,
            centerId,
            name: "Student Beta",
            monthlyFee: 4000,
            isActive: true,
            billingCycleDate: 10,
            joiningDate: new Date("2024-01-01T00:00:00Z"),
            assignedTeacherId: null,
            batch: "Batch B - Evening",
          },
        ],
      ]
    );

    const centerDocs = new Map(
      initialData.centers || [
        [
          centerId,
          {
            centerId,
            name: "Center Alpha Institute",
            ownerName: "Alpha Director",
            dueDateOffsetDays: 7,
          },
        ],
      ]
    );

    const lockDocs = new Map();

    const mockModels = {
      Student: {
        findById: async (id) => studentDocs.get(String(id)) || null,
        find: async () => Array.from(studentDocs.values()),
        findOne: async (q) => {
          for (const s of studentDocs.values()) {
            if (q.centerId && s.centerId !== q.centerId) continue;
            if (q._id && String(s._id) !== String(q._id)) continue;
            return s;
          }
          return null;
        },
      },
      Center: {
        findOne: async (q) => centerDocs.get(q.centerId) || null,
        find: async () => Array.from(centerDocs.values()),
      },
      Fee: {
        findOne: async (q) => {
          for (const doc of feeDocs.values()) {
            if (q.centerId && doc.centerId !== q.centerId) continue;
            if (q.studentId && String(doc.studentId) !== String(q.studentId)) continue;
            if (q.billingMonth && doc.billingMonth !== q.billingMonth) continue;
            if (q.feeType && doc.feeType !== q.feeType) continue;
            return doc;
          }
          return null;
        },
        find: async (q = {}) => {
          const results = [];
          for (const doc of feeDocs.values()) {
            if (q.centerId && doc.centerId !== q.centerId) continue;
            if (q.studentId && String(doc.studentId) !== String(q.studentId)) continue;
            if (q.month && q.month.$in && !q.month.$in.includes(doc.month)) continue;
            if (q.isAdvance && q.isAdvance.$ne && doc.isAdvance === true) continue;
            if (q.feeType && q.feeType.$ne && doc.feeType === q.feeType.$ne) continue;
            results.push(doc);
          }
          return results;
        },
        create: async (payload) => {
          const id = payload._id || `fee_${feeDocs.size + 1}`;
          const newDoc = {
            _id: id,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...payload,
            toObject() {
              return { ...this };
            },
          };
          feeDocs.set(String(id), newDoc);
          return newDoc;
        },
      },
      FeeCreationLock: {
        hasUniqueLockIndex: async () => true,
        collection: {
          indexes: async () => [{ key: { _id: 1 } }, { key: { lockKey: 1 }, unique: true }],
        },
        create: async (lockPayload) => {
          const key = lockPayload.lockKey;
          if (lockDocs.has(key)) {
            const err = new Error(`E11000 duplicate key error on ${key}`);
            err.code = 11000;
            throw err;
          }
          const lockDoc = { ...lockPayload, _id: `lock_${lockDocs.size + 1}` };
          lockDocs.set(key, lockDoc);
          return lockDoc;
        },
        findOne: async (q) => lockDocs.get(q.lockKey) || null,
        findOneAndUpdate: async (filter, update) => {
          const existing = lockDocs.get(filter.lockKey);
          if (!existing) return null;
          if (update.$set) Object.assign(existing, update.$set);
          return existing;
        },
        deleteOne: async (q) => {
          lockDocs.delete(q.lockKey);
          return { deletedCount: 1 };
        },
      },
    };

    return { mockModels, feeDocs, studentDocs, centerDocs };
  }

  // 1. New monthly invoice initializes originalAmountDue
  await t.test("1. New monthly invoice initializes originalAmountDue to the full invoiced rate", async () => {
    const env = createMockEnv();
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    assert.equal(result.success, true);
    assert.equal(result.wasCreated, true);
    assert.equal(result.status, "created");
    assert.equal(result.fee.originalAmountDue, 3000);
    assert.equal(result.fee.amountDue, 3000);
    assert.equal(result.fee.paidAmount, 0);
    assert.equal(result.fee.status, "Pending");
    assert.equal(result.fee.billingMonth, "2026-11");
    assert.equal(result.fee.feeType, "monthly_recurring");
  });

  // 2. New invoice initializes paymentHistory correctly
  await t.test("2. New invoice initializes paymentHistory as a valid empty array without fake entries", async () => {
    const env = createMockEnv();
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.fee.paymentHistory), "paymentHistory must be an array");
    assert.equal(result.fee.paymentHistory.length, 0, "paymentHistory must be empty for new invoice");

    // Helper getFeePaymentEntries should return empty array for unpaid invoice
    const entries = getFeePaymentEntries(result.fee);
    assert.equal(entries.length, 0, "No synthetic payment entries should be generated for unpaid fee");
  });

  // 3. Existing invoice is not overwritten
  await t.test("3. Existing invoice is not overwritten on subsequent generation attempts", async () => {
    const existingFeeId = "fee_existing_01";
    const existingFee = {
      _id: existingFeeId,
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      month: "Nov 2026",
      title: "Special Academic Rate November",
      notes: "Scholarship concession applied",
      originalAmountDue: 2500,
      amountDue: 2500,
      paidAmount: 0,
      paymentHistory: [],
      status: "Pending",
      feeType: "monthly_recurring",
    };

    const env = createMockEnv({ fees: [[existingFeeId, existingFee]] });
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    assert.equal(result.success, true);
    assert.equal(result.wasCreated, false);
    assert.equal(result.status, "reused");
    assert.equal(result.fee._id, existingFeeId);
    assert.equal(result.fee.title, "Special Academic Rate November");
    assert.equal(result.fee.notes, "Scholarship concession applied");
    assert.equal(result.fee.originalAmountDue, 2500);
    assert.equal(result.fee.amountDue, 2500);
    assert.equal(env.feeDocs.size, 1, "Zero new documents created");
  });

  // 4. Existing paidAmount is preserved
  await t.test("4. Existing paidAmount and settled status are preserved without balance resets", async () => {
    const existingFeeId = "fee_paid_01";
    const existingFee = {
      _id: existingFeeId,
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      month: "Nov 2026",
      title: "Nov 2026 Tuition Fee",
      originalAmountDue: 3000,
      amountDue: 0,
      paidAmount: 3000,
      status: "Paid",
      feeType: "monthly_recurring",
      receiptNumber: "RCPT-2026-001",
      paymentDate: new Date("2026-11-02T10:00:00Z"),
      paymentHistory: [
        {
          paymentId: "pay_1",
          amount: 3000,
          paymentMode: "Cash",
          receiptNumber: "RCPT-2026-001",
          isProvisional: false,
          custodyStatus: "owner_custody",
        },
      ],
    };

    const env = createMockEnv({ fees: [[existingFeeId, existingFee]] });
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    assert.equal(result.success, true);
    assert.equal(result.wasCreated, false);
    assert.equal(result.status, "reused");
    assert.equal(result.fee.paidAmount, 3000);
    assert.equal(result.fee.amountDue, 0);
    assert.equal(result.fee.status, "Paid");
    assert.equal(result.fee.originalAmountDue, 3000);
    assert.equal(result.fee.receiptNumber, "RCPT-2026-001");
  });

  // 5. Partial payment compatibility
  await t.test("5. Partial payment balance and line items remain fully intact on generation", async () => {
    const existingFeeId = "fee_partial_01";
    const existingFee = {
      _id: existingFeeId,
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      month: "Nov 2026",
      title: "Nov 2026 Tuition Fee",
      originalAmountDue: 3000,
      amountDue: 1800,
      paidAmount: 1200,
      status: "Partial Paid",
      feeType: "monthly_recurring",
      paymentHistory: [
        {
          paymentId: "pay_partial_1",
          amount: 1200,
          paymentMode: "Cash",
          receiptNumber: "RCPT-PART-01",
          isProvisional: true,
          custodyStatus: "teacher_custody",
        },
      ],
    };

    const env = createMockEnv({ fees: [[existingFeeId, existingFee]] });
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    assert.equal(result.success, true);
    assert.equal(result.wasCreated, false);
    assert.equal(result.status, "reused");
    assert.equal(result.fee.originalAmountDue, 3000);
    assert.equal(result.fee.paidAmount, 1200);
    assert.equal(result.fee.amountDue, 1800);
    assert.equal(result.fee.status, "Partial Paid");
    assert.equal(result.fee.paymentHistory.length, 1);
  });

  // 6. Duplicate monthly invoice prevention
  await t.test("6. Duplicate monthly invoice prevention: exactly 1 invoice is created across calls", async () => {
    const env = createMockEnv();

    const call1 = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    const call2 = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    assert.equal(call1.wasCreated, true);
    assert.equal(call1.status, "created");
    assert.equal(call2.wasCreated, false);
    assert.equal(call2.status, "reused");
    assert.equal(call2.fee._id, call1.fee._id);
    assert.equal(env.feeDocs.size, 1, "Exactly one fee document exists in map");
  });

  // 7. Legacy Fee compatibility
  await t.test("7. Legacy fee compatibility: legacy candidate is reused and synthesizes approved entry", async () => {
    const legacyFeeId = "fee_legacy_01";
    const legacyFee = {
      _id: legacyFeeId,
      centerId,
      studentId: studentAId,
      month: "Nov 2026",
      title: "Nov 2026 Tuition Fee",
      // Notice: No billingMonth, no originalAmountDue, no paymentHistory
      amountDue: 0,
      paidAmount: 2500,
      status: "Paid",
      paymentDate: new Date("2026-11-03T11:00:00Z"),
      paymentMode: "Cash",
      receiptNumber: "LEGACY-RCPT-88",
    };

    const env = createMockEnv({ fees: [[legacyFeeId, legacyFee]] });
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-05T12:00:00+05:30"),
      models: env.mockModels,
    });

    assert.equal(result.success, true);
    assert.equal(result.wasCreated, false);
    assert.equal(result.status, "reused_legacy");
    assert.equal(result.fee._id, legacyFeeId);
    assert.equal(env.feeDocs.size, 1);

    // Verify legacy payment entry synthesis
    const entries = getFeePaymentEntries(result.fee);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].amount, 2500);
    assert.equal(entries[0].isProvisional, false);
    assert.equal(entries[0].custodyStatus, "owner_custody");
    assert.equal(entries[0].allocations[0].status, "verified");
  });

  // 8. Multiple students and billing months remain isolated
  await t.test("8. Multiple students and billing months remain completely isolated", async () => {
    const env = createMockEnv();

    // Student A, November
    const resA_Nov = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-05T12:00:00+05:30"),
      models: env.mockModels,
    });

    // Student A, December
    const resA_Dec = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-12",
      referenceDate: new Date("2026-12-05T12:00:00+05:30"),
      models: env.mockModels,
    });

    // Student B, November
    const resB_Nov = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentBId,
      billingMonth: "2026-11",
      referenceDate: new Date("2026-11-05T12:00:00+05:30"),
      models: env.mockModels,
    });

    assert.equal(resA_Nov.wasCreated, true);
    assert.equal(resA_Dec.wasCreated, true);
    assert.equal(resB_Nov.wasCreated, true);

    assert.equal(resA_Nov.fee.originalAmountDue, 3000);
    assert.equal(resA_Dec.fee.originalAmountDue, 3000);
    assert.equal(resB_Nov.fee.originalAmountDue, 4000);

    assert.notEqual(resA_Nov.fee._id, resA_Dec.fee._id);
    assert.notEqual(resA_Nov.fee._id, resB_Nov.fee._id);
    assert.equal(env.feeDocs.size, 3);
  });

  // 9. Repeated generation does not reset financial values
  await t.test("9. Repeated generation does not reset financial values over multiple cycles", async () => {
    const env = createMockEnv();

    // Initial creation
    const initial = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });

    // Simulate collection of ₹1,000 against this fee
    const feeInDb = env.feeDocs.get(String(initial.fee._id));
    feeInDb.paidAmount = 1000;
    feeInDb.amountDue = 2000;
    feeInDb.status = "Partial Paid";
    feeInDb.paymentHistory = [
      {
        paymentId: "p1",
        amount: 1000,
        paymentMode: "Cash",
        isProvisional: true,
      },
    ];

    // Repeated generation passes (e.g. 5 cron runs)
    for (let i = 0; i < 5; i++) {
      const subsequent = await generateOrGetMonthlyFee({
        centerId,
        studentId: studentAId,
        billingMonth: "2026-11",
        models: env.mockModels,
      });

      assert.equal(subsequent.wasCreated, false);
      assert.equal(subsequent.status, "reused");
      assert.equal(subsequent.fee.paidAmount, 1000, `Run ${i + 1}: paidAmount must remain 1000`);
      assert.equal(subsequent.fee.amountDue, 2000, `Run ${i + 1}: amountDue must remain 2000`);
      assert.equal(subsequent.fee.originalAmountDue, 3000, `Run ${i + 1}: originalAmountDue must remain 3000`);
      assert.equal(subsequent.fee.status, "Partial Paid", `Run ${i + 1}: status must remain Partial Paid`);
      assert.equal(subsequent.fee.paymentHistory.length, 1);
    }
  });

  // 10. Existing fee-generation behavior remains compatible
  await t.test("10. Existing fee-generation behavior remains compatible (dueDate offsets, teacher mapping, batch, API routes)", async () => {
    const env = createMockEnv();

    // Verification of assignedTeacherId, batchAtPayment, and dueDate calculation
    const refDate = new Date("2026-11-01T10:00:00+05:30");
    const result = await generateOrGetMonthlyFee({
      centerId,
      studentId: studentAId,
      billingMonth: "2026-11",
      referenceDate: refDate,
      models: env.mockModels,
    });

    assert.equal(result.fee.assignedTeacherId, teacherId, "Teacher must be mapped from student");
    assert.equal(result.fee.batchAtPayment, "Batch A - Morning", "Student batch must be snapshot");
    assert.ok(result.fee.dueDate, "Due date must be calculated");

    // Inactive student is skipped in automated generation
    const inactiveStudent = {
      _id: "inactive_01",
      centerId,
      name: "Inactive Student",
      monthlyFee: 2000,
      isActive: false,
      billingCycleDate: 5,
    };
    env.studentDocs.set("inactive_01", inactiveStudent);

    const inactiveResult = await generateOrGetMonthlyFee({
      centerId,
      studentId: "inactive_01",
      billingMonth: "2026-11",
      isManual: false,
      models: env.mockModels,
    });
    assert.equal(inactiveResult.success, false);
    assert.equal(inactiveResult.status, "skipped_ineligible");

    // Zero fee rate is skipped
    const zeroFeeStudent = {
      _id: "zero_01",
      centerId,
      name: "Free Student",
      monthlyFee: 0,
      isActive: true,
      billingCycleDate: 5,
    };
    env.studentDocs.set("zero_01", zeroFeeStudent);

    const zeroResult = await generateOrGetMonthlyFee({
      centerId,
      studentId: "zero_01",
      billingMonth: "2026-11",
      models: env.mockModels,
    });
    assert.equal(zeroResult.success, false);
    assert.equal(zeroResult.status, "skipped_ineligible");

    // Cross-center mismatch rejected
    const crossCenterResult = await generateOrGetMonthlyFee({
      centerId: "other_center",
      studentId: studentAId,
      billingMonth: "2026-11",
      models: env.mockModels,
    });
    assert.equal(crossCenterResult.success, false);
    assert.equal(crossCenterResult.status, "skipped_ineligible");

    // API Route test: POST /api/fees non-recurring fee initializes originalAmountDue & empty paymentHistory
    const mockCreatedFees = [];
    const origFeeCreate = FeeModel.create;
    const origStudentFindById = StudentModel.findById;
    const origCenterFindOne = CenterModel.findOne;
    const origFeeFind = FeeModel.find;
    const origTeacherFind = TeacherModel.find;

    FeeModel.create = async (doc) => {
      const created = {
        _id: "fee_adhoc_100",
        ...doc,
        toObject() {
          return { ...this };
        },
      };
      mockCreatedFees.push(created);
      return created;
    };

    StudentModel.findById = async () => ({
      _id: studentAId,
      centerId,
      batch: "Batch A - Morning",
    });

    CenterModel.findOne = () => ({
      select: async () => ({
        _id: "center_alpha_id",
        centerId,
        name: "Center Alpha",
        ownerName: "Alpha Director",
      }),
    });

    TeacherModel.find = () => ({
      select: async () => [
        {
          _id: teacherId,
          name: "Teacher Sharma",
          phone: "+919876543210",
          loginId: "teacher_sharma",
          role: "teacher",
        },
      ],
    });

    FeeModel.find = (q) => {
      const mockQuery = {
        populate: () => mockQuery,
        sort: () => [
          {
            _id: "fee_1",
            centerId,
            studentId: { _id: studentAId, name: "Student Alpha", batch: "Batch A" },
            month: "Nov 2026",
            amountDue: 2500,
            originalAmountDue: 2500,
            paidAmount: 0,
            status: "Pending",
            paymentHistory: [],
            toObject() {
              return { ...this };
            },
          },
        ],
      };
      return mockQuery;
    };

    try {
      // POST /api/fees with adhoc fee
      const postReq = createMockRequest({
        method: "POST",
        token: ownerToken,
        body: {
          studentId: studentAId,
          feeType: "adhoc",
          amountDue: 1500,
          title: "Lab Material Fee",
          month: "Nov 2026",
          dueDate: "2026-11-20",
          paymentHistory: [{ fake: true }], // Client attempt to inject fake history
          originalAmountDue: 99999, // Client attempt to forge originalAmountDue
        },
      });

      const postRes = await postFeeRoute(postReq);
      assert.equal(postRes.status, 201);
      const postJson = await postRes.json();
      assert.equal(postJson.success, true);
      assert.equal(postJson.data.originalAmountDue, 1500, "originalAmountDue must be initialized from amountDue, ignoring forged input");
      assert.equal(postJson.data.amountDue, 1500);
      assert.equal(postJson.data.paidAmount, 0);
      assert.deepEqual(postJson.data.paymentHistory, [], "paymentHistory must be empty array, ignoring forged input");

      // GET /api/fees exposes enriched originalAmountDue and paymentHistory
      const getReq = createMockRequest({
        method: "GET",
        token: ownerToken,
      });

      const getRes = await getFeesRoute(getReq);
      assert.equal(getRes.status, 200);
      const getJson = await getRes.json();
      assert.equal(getJson.success, true);
      assert.ok(getJson.data.length > 0);
      assert.equal(getJson.data[0].originalAmountDue, 2500);
      assert.ok(Array.isArray(getJson.data[0].paymentHistory));
    } finally {
      FeeModel.create = origFeeCreate;
      StudentModel.findById = origStudentFindById;
      CenterModel.findOne = origCenterFindOne;
      FeeModel.find = origFeeFind;
      TeacherModel.find = origTeacherFind;
    }
  });
});
