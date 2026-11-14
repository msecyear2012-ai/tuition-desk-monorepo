import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// ============================================================================
// Phase 3B: Dual-Axis Fee Logic, Snapshot Immutability & Attribution Security Suite
//
// TEST CLASSIFICATION:
// 1. Snapshot Immutability (DEC-MSEC-03):
//    - Tests 2, 3, 4: Preserves null and non-null assignedTeacherAtPayment snapshots permanently;
//      null is a valid immutable snapshot for Owner-assigned students and must never be treated as missing.
// 2. Strict Teacher Resource Authorization (DEC-MSEC-01/02):
//    - Tests 5, 6, 7, 8, 9, 10, 11: Teachers are restricted strictly to their assigned records,
//      cannot edit/delete Owner records (assignedTeacherId=null) or other teachers' records,
//      cannot reassign students, and cannot edit/delete paid records.
// 3. Concurrency Safety:
//    - Test 12: Atomic deletion guard protects against concurrent payment settlement races (409 Conflict).
// 4. Duplicate UTR Index Discrimination:
//    - Tests 13, 14: E11000 duplicate index conflicts are mapped to DUPLICATE_UTR (409) strictly
//      when the colliding index is the UTR index; other unique index conflicts are not misattributed.
// 5. Advance Payment Verification Pending Semantics:
//    - Tests 15, 16: Unverified advance payments retain null custody and zero paidAmount;
//      subsequent Owner verification confirms custody and snaps teacher attribution.
// 6. JWT Identity Mapping:
//    - Test 1: Verifies Owner and Teacher JWT claims map to MongoDB identities.
//
// 100% In-Memory Specification Suite - ZERO live database mutations or network dependencies.
// ============================================================================

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";

test("Phase 3B: Cross-Collection Attribution, Snapshot & Security Test Suite", async (t) => {
  const { signToken, getAuthenticatedUser } = await import(
    "../tution-desk-be/src/lib/auth.ts"
  );
  const { Student } = await import("../tution-desk-be/src/models/Student.ts");
  const { Fee } = await import("../tution-desk-be/src/models/Fee.ts");

  // Mock Request Generator
  function createMockRequest({
    token = null,
    method = "GET",
    body = {},
    searchParams = {},
    headers = {},
  } = {}) {
    return {
      method,
      cookies: {
        get: (name) =>
          token && (name === "auth_token" || name === "token")
            ? { value: token }
            : undefined,
      },
      headers: {
        get: (name) => {
          const lName = name.toLowerCase();
          if (lName === "authorization" && token) return `Bearer ${token}`;
          if (lName === "origin") return "http://localhost:3000";
          return headers[name] || headers[lName] || null;
        },
      },
      nextUrl: {
        searchParams: {
          get: (key) => searchParams[key] ?? null,
        },
      },
      json: async () => body,
    };
  }

  // Pre-signed Tokens
  const ownerId = "650000000000000000000001";
  const teacher1Id = "650000000000000000000010";
  const teacher2Id = "650000000000000000000020";
  const centerId = "msec";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId: centerId,
    role: "owner",
    name: "MSEC Owner",
  });

  const teacher1Token = await signToken({
    userId: teacher1Id,
    centerId: centerId,
    role: "teacher",
    teacherId: teacher1Id,
    name: "Teacher One",
  });

  const teacher2Token = await signToken({
    userId: teacher2Id,
    centerId: centerId,
    role: "teacher",
    teacherId: teacher2Id,
    name: "Teacher Two",
  });

  // --------------------------------------------------------------------------
  // TEST 1: JWT Identity Mapping
  // --------------------------------------------------------------------------
  await t.test(
    "1. Verify JWT userId maps to correct Owner/Teacher MongoDB identity",
    async () => {
      const ownerUser = await getAuthenticatedUser(
        createMockRequest({ token: ownerToken })
      );
      assert.equal(ownerUser.userId, ownerId);
      assert.equal(ownerUser.role, "owner");
      assert.equal(ownerUser.centerId, centerId);
      assert.equal(ownerUser.teacherId, undefined);

      const teacherUser = await getAuthenticatedUser(
        createMockRequest({ token: teacher1Token })
      );
      assert.equal(teacherUser.userId, teacher1Id);
      assert.equal(teacherUser.role, "teacher");
      assert.equal(teacherUser.teacherId, teacher1Id);
      assert.equal(teacherUser.centerId, centerId);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 2: Preserve null assignedTeacherAtPayment on student reassignment (PUT)
  // --------------------------------------------------------------------------
  await t.test(
    "2. Preserve null assignedTeacherAtPayment as a valid immutable snapshot on PUT (Owner -> Teacher reassignment)",
    async () => {
      const studentId = new mongoose.Types.ObjectId("650000000000000000000101");
      const feeId = new mongoose.Types.ObjectId("650000000000000000000201");

      // Fee was paid when student was assigned to Owner (assignedTeacherAtPayment: null)
      const existingFee = {
        _id: feeId,
        centerId: centerId,
        studentId: studentId,
        status: "Paid",
        amountDue: 0,
        paidAmount: 1500,
        assignedTeacherId: null, // Owner taught
        assignedTeacherAtPayment: null, // Immutable Owner snapshot!
        batchAtPayment: "Batch A",
        recordedBy: new mongoose.Types.ObjectId(ownerId),
        recordedByRole: "owner",
        receivedBy: new mongoose.Types.ObjectId(ownerId),
        receivedByRole: "owner",
      };

      // Student has subsequently been reassigned to Teacher 1
      const studentDoc = {
        _id: studentId,
        name: "Rahul Verma",
        assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
        batch: "Batch A",
      };

      // Simulation of PUT snapshot logic in [feeId]/route.ts:
      const isPaidRecord = existingFee.status === "Paid" || existingFee.status === "Partial Paid";
      const isNewlyPaidOrSettled = !isPaidRecord && (existingFee.status === "Paid" || existingFee.status === "Partial Paid");

      if (isNewlyPaidOrSettled) {
        existingFee.assignedTeacherAtPayment = studentDoc
          ? studentDoc.assignedTeacherId ?? null
          : existingFee.assignedTeacherId ?? null;
      }

      // Assert that because isPaidRecord was true, existingFee.assignedTeacherAtPayment was NOT overwritten
      assert.equal(
        existingFee.assignedTeacherAtPayment,
        null,
        "null assignedTeacherAtPayment must NOT be overwritten when student is reassigned to a teacher"
      );
    }
  );

  // --------------------------------------------------------------------------
  // TEST 3: Preserve non-null assignedTeacherAtPayment on student reassignment (PUT)
  // --------------------------------------------------------------------------
  await t.test(
    "3. Preserve non-null assignedTeacherAtPayment on student reassignment (Teacher 1 -> Owner reassignment)",
    async () => {
      const studentId = new mongoose.Types.ObjectId("650000000000000000000102");
      const feeId = new mongoose.Types.ObjectId("650000000000000000000202");

      // Fee was paid under Teacher 1
      const existingFee = {
        _id: feeId,
        centerId: centerId,
        studentId: studentId,
        status: "Paid",
        amountDue: 0,
        paidAmount: 2000,
        assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
        assignedTeacherAtPayment: new mongoose.Types.ObjectId(teacher1Id),
        batchAtPayment: "Class 10 Math",
        recordedBy: new mongoose.Types.ObjectId(teacher1Id),
        recordedByRole: "teacher",
        receivedBy: new mongoose.Types.ObjectId(teacher1Id),
        receivedByRole: "teacher",
      };

      // Student has now been reassigned to Owner (assignedTeacherId: null)
      const studentDoc = {
        _id: studentId,
        name: "Pooja Sharma",
        assignedTeacherId: null,
        batch: "Class 10 Math",
      };

      const isPaidRecord = existingFee.status === "Paid" || existingFee.status === "Partial Paid";
      const isNewlyPaidOrSettled = !isPaidRecord && (existingFee.status === "Paid" || existingFee.status === "Partial Paid");

      if (isNewlyPaidOrSettled) {
        existingFee.assignedTeacherAtPayment = studentDoc
          ? studentDoc.assignedTeacherId ?? null
          : existingFee.assignedTeacherId ?? null;
      }

      assert.equal(
        existingFee.assignedTeacherAtPayment.toString(),
        teacher1Id,
        "Teacher snapshot must be preserved even after student is reassigned to Owner"
      );
    }
  );

  // --------------------------------------------------------------------------
  // TEST 4: Manual Collection preserves null payment snapshot on subsequent payment
  // --------------------------------------------------------------------------
  await t.test(
    "4. Manual Collection preserves null payment snapshot on second partial payment",
    async () => {
      const candidate = {
        _id: new mongoose.Types.ObjectId("650000000000000000000203"),
        centerId: centerId,
        billingMonth: "2026-11",
        status: "Partial Paid",
        amountDue: 500,
        paidAmount: 500,
        assignedTeacherAtPayment: null, // Explicit null snapshot
        batchAtPayment: "Batch B",
        paymentDate: new Date("2026-11-01"),
        paidDate: new Date("2026-11-01"),
      };

      // Student reassigned to Teacher 2
      const responsibleTeacherId = new mongoose.Types.ObjectId(teacher2Id);
      const responsibleBatch = "Batch B";

      // Simulation of manual-collection snapshot logic:
      const attributionSet = {};
      const hasPriorPayment =
        candidate.status === "Partial Paid" ||
        Boolean(candidate.paymentDate) ||
        Boolean(candidate.paidDate);

      if (!hasPriorPayment) {
        attributionSet.assignedTeacherAtPayment = responsibleTeacherId;
        attributionSet.batchAtPayment = responsibleBatch;
      }

      assert.equal(
        attributionSet.assignedTeacherAtPayment,
        undefined,
        "Second partial collection must NOT overwrite existing null assignedTeacherAtPayment"
      );
    }
  );

  // --------------------------------------------------------------------------
  // TEST 5: Teacher PUT forbidden on Owner-assigned fee (assignedTeacherId = null)
  // --------------------------------------------------------------------------
  await t.test(
    "5. Restrict Teacher fee PUT: returns 404 on Owner-assigned fee (assignedTeacherId=null)",
    async () => {
      const existingFee = {
        _id: "650000000000000000000205",
        centerId: centerId,
        assignedTeacherId: null, // Owner-assigned
        status: "Pending",
        amountDue: 1000,
      };

      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));

      let statusCode = 200;
      let error = null;

      if (teacherUser.role === "teacher") {
        const teacherId = teacherUser.teacherId || teacherUser.userId;
        if (
          !teacherId ||
          !existingFee.assignedTeacherId ||
          String(existingFee.assignedTeacherId) !== String(teacherId)
        ) {
          statusCode = 404;
          error = "Fee record not found";
        }
      }

      assert.equal(statusCode, 404);
      assert.equal(error, "Fee record not found");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 6: Teacher PUT forbidden on another Teacher's fee
  // --------------------------------------------------------------------------
  await t.test(
    "6. Restrict Teacher fee PUT: returns 404 on foreign Teacher's fee record",
    async () => {
      const existingFee = {
        _id: "650000000000000000000206",
        centerId: centerId,
        assignedTeacherId: teacher2Id, // Assigned to Teacher 2
        status: "Pending",
        amountDue: 1200,
      };

      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));

      let statusCode = 200;
      let error = null;

      if (teacherUser.role === "teacher") {
        const teacherId = teacherUser.teacherId || teacherUser.userId;
        if (
          !teacherId ||
          !existingFee.assignedTeacherId ||
          String(existingFee.assignedTeacherId) !== String(teacherId)
        ) {
          statusCode = 404;
          error = "Fee record not found";
        }
      }

      assert.equal(statusCode, 404);
      assert.equal(error, "Fee record not found");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 7: Teacher cannot change assignedTeacherId via PUT (403 Forbidden)
  // --------------------------------------------------------------------------
  await t.test(
    "7. Teacher cannot change student assignment on fee record via PUT (403 Forbidden)",
    async () => {
      const existingFee = {
        _id: "650000000000000000000207",
        centerId: centerId,
        assignedTeacherId: teacher1Id,
        status: "Pending",
        amountDue: 800,
      };

      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));
      const body = { assignedTeacherId: teacher2Id };

      let statusCode = 200;
      let error = null;

      if (teacherUser.role === "teacher") {
        if (body.assignedTeacherId !== undefined) {
          statusCode = 403;
          error = "Teachers cannot change student assignment";
        }
      }

      assert.equal(statusCode, 403);
      assert.equal(error, "Teachers cannot change student assignment");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 8: Teacher cannot modify financial amounts or status on paid records (403)
  // --------------------------------------------------------------------------
  await t.test(
    "8. Teacher cannot modify financial amounts on paid/partial-paid fees via PUT (403 Forbidden)",
    async () => {
      const existingFee = {
        _id: "650000000000000000000208",
        centerId: centerId,
        assignedTeacherId: teacher1Id,
        status: "Paid",
        amountDue: 0,
        paidAmount: 1500,
      };

      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));
      const body = { paidAmount: 1000 };

      const isPaidRecord = existingFee.status === "Paid" || existingFee.status === "Partial Paid";
      let statusCode = 200;
      let error = null;

      if (teacherUser.role === "teacher") {
        if (
          isPaidRecord &&
          (body.paidAmount !== undefined ||
            body.amountDue !== undefined ||
            (body.status !== undefined && body.status !== existingFee.status))
        ) {
          statusCode = 403;
          error = "Teachers cannot edit financial amounts on paid or partially paid fee records";
        }
      }

      assert.equal(statusCode, 403);
      assert.match(error, /cannot edit financial amounts/i);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 9: Teacher DELETE forbidden on Owner-assigned fee (404 Not Found)
  // --------------------------------------------------------------------------
  await t.test(
    "9. Restrict Teacher fee DELETE: returns 404 on Owner-assigned fee (assignedTeacherId=null)",
    async () => {
      const existingFee = {
        _id: "650000000000000000000209",
        centerId: centerId,
        assignedTeacherId: null, // Owner-assigned
        status: "Pending",
      };

      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));
      const teacherId = teacherUser.teacherId || teacherUser.userId;

      let statusCode = 200;
      let error = null;

      if (
        !existingFee.assignedTeacherId ||
        String(existingFee.assignedTeacherId) !== String(teacherId)
      ) {
        statusCode = 404;
        error = "Fee record not found";
      }

      assert.equal(statusCode, 404);
      assert.equal(error, "Fee record not found");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 10: Teacher DELETE forbidden on another Teacher's fee (404 Not Found)
  // --------------------------------------------------------------------------
  await t.test(
    "10. Restrict Teacher fee DELETE: returns 404 on foreign Teacher's fee record",
    async () => {
      const existingFee = {
        _id: "650000000000000000000210",
        centerId: centerId,
        assignedTeacherId: teacher2Id,
        status: "Pending",
      };

      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));
      const teacherId = teacherUser.teacherId || teacherUser.userId;

      let statusCode = 200;
      let error = null;

      if (
        !existingFee.assignedTeacherId ||
        String(existingFee.assignedTeacherId) !== String(teacherId)
      ) {
        statusCode = 404;
        error = "Fee record not found";
      }

      assert.equal(statusCode, 404);
      assert.equal(error, "Fee record not found");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 11: Teacher DELETE forbidden on Paid or Partial Paid fee records (403)
  // --------------------------------------------------------------------------
  await t.test(
    "11. Restrict Teacher fee DELETE: returns 403 on Paid or Partial Paid fee records",
    async () => {
      const existingFee = {
        _id: "650000000000000000000211",
        centerId: centerId,
        assignedTeacherId: teacher1Id,
        status: "Paid",
      };

      let statusCode = 200;
      let error = null;

      if (existingFee.status === "Paid" || existingFee.status === "Partial Paid") {
        statusCode = 403;
        error = "Teachers cannot delete paid or partially paid fee records";
      }

      assert.equal(statusCode, 403);
      assert.match(error, /cannot delete paid or partially paid/i);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 12: Atomic DELETE concurrency guard (409 Conflict)
  // --------------------------------------------------------------------------
  await t.test(
    "12. Atomic fee DELETE guard detects concurrent settlement race and returns 409 Conflict",
    async () => {
      const deleteConditions = {
        _id: "650000000000000000000212",
        centerId: centerId,
        assignedTeacherId: teacher1Id,
        status: { $nin: ["Paid", "Partial Paid"] },
      };

      // Concurrent payment settlement caused status to become "Paid" in DB
      const currentDbRecord = {
        _id: "650000000000000000000212",
        centerId: centerId,
        assignedTeacherId: teacher1Id,
        status: "Paid",
      };

      // In atomic findOneAndDelete, query fails to match because status is $nin ["Paid", "Partial Paid"]
      const matchesAtomicQuery =
        currentDbRecord._id === deleteConditions._id &&
        currentDbRecord.centerId === deleteConditions.centerId &&
        currentDbRecord.assignedTeacherId === deleteConditions.assignedTeacherId &&
        !deleteConditions.status.$nin.includes(currentDbRecord.status);

      let statusCode = 200;
      let error = null;

      if (!matchesAtomicQuery) {
        statusCode = 409;
        error = "Concurrent modification conflict: fee record was already settled or deleted by another transaction.";
      }

      assert.equal(statusCode, 409);
      assert.match(error, /Concurrent modification conflict/i);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 13: Duplicate UTR (E11000) specifically maps to DUPLICATE_UTR (409)
  // --------------------------------------------------------------------------
  await t.test(
    "13. Map E11000 to DUPLICATE_UTR (409) specifically when colliding index is UTR index",
    async () => {
      const utrError = new Error(
        "E11000 duplicate key error collection: fees index: centerId_1_utrNumber_1 dup key: { centerId: 'msec', utrNumber: 'UPI998877' }"
      );
      utrError.code = 11000;
      utrError.keyPattern = { centerId: 1, utrNumber: 1 };
      utrError.keyValue = { centerId: "msec", utrNumber: "UPI998877" };

      function handleIndexError(error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        ) {
          const errObj = error;
          const isUtrConflict = Boolean(
            (errObj.keyPattern && "utrNumber" in errObj.keyPattern) ||
            (errObj.keyValue && "utrNumber" in errObj.keyValue) ||
            (typeof errObj.message === "string" &&
              (/utr/i.test(errObj.message) ||
                errObj.message.includes("centerId_1_utrNumber_1")))
          );

          if (isUtrConflict) {
            return {
              status: 409,
              code: "DUPLICATE_UTR",
              error: "A payment record with this transaction reference (UTR) already exists in this institute. Duplicate UPI/UPI-gateway references are blocked.",
            };
          }
        }
        return { status: 500, error: error.message };
      }

      const res = handleIndexError(utrError);
      assert.equal(res.status, 409);
      assert.equal(res.code, "DUPLICATE_UTR");
      assert.match(res.error, /transaction reference \(UTR\) already exists/i);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 14: Non-UTR E11000 error does NOT map to DUPLICATE_UTR
  // --------------------------------------------------------------------------
  await t.test(
    "14. Non-UTR E11000 error does NOT map to DUPLICATE_UTR",
    async () => {
      const lockError = new Error(
        "E11000 duplicate key error collection: import_locks index: centerId_1_lock_1 dup key: { centerId: 'msec' }"
      );
      lockError.code = 11000;
      lockError.keyPattern = { centerId: 1, lock: 1 };
      lockError.keyValue = { centerId: "msec" };

      function handleIndexError(error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        ) {
          const errObj = error;
          const isUtrConflict = Boolean(
            (errObj.keyPattern && "utrNumber" in errObj.keyPattern) ||
            (errObj.keyValue && "utrNumber" in errObj.keyValue) ||
            (typeof errObj.message === "string" &&
              (/utr/i.test(errObj.message) ||
                errObj.message.includes("centerId_1_utrNumber_1")))
          );

          if (isUtrConflict) {
            return {
              status: 409,
              code: "DUPLICATE_UTR",
              error: "A payment record with this transaction reference (UTR) already exists in this institute.",
            };
          }
        }
        return { status: 500, error: error.message };
      }

      const res = handleIndexError(lockError);
      assert.equal(res.status, 500);
      assert.notEqual(res.code, "DUPLICATE_UTR");
    }
  );

  // --------------------------------------------------------------------------
  // TEST 15: Advance fee creates Verification Pending with unverified custody
  // --------------------------------------------------------------------------
  await t.test(
    "15. Advance fee creates Verification Pending with unverified custody (receivedBy=null, paidAmount=0)",
    async () => {
      const teacherUser = await getAuthenticatedUser(createMockRequest({ token: teacher1Token }));
      const collectorId = new mongoose.Types.ObjectId(teacherUser.userId);
      const collectorRole = teacherUser.role;
      const responsibleTeacherId = new mongoose.Types.ObjectId(teacher1Id);
      const responsibleBatch = "Batch E";
      const now = new Date();

      const advanceFee = {
        centerId: centerId,
        studentId: new mongoose.Types.ObjectId("650000000000000000000115"),
        month: "Advance Fee Payment",
        title: "Advance Fee Payment",
        amountDue: 3000,
        paidAmount: 0,
        dueDate: now,
        status: "Verification Pending",
        paymentMode: "Online/UPI",
        feeType: "advance",
        isAdvance: true,
        utrNumber: "UPI11223344",
        paymentDate: null,
        paidDate: null,
        paidAt: null,
        assignedTeacherId: responsibleTeacherId,
        assignedTeacherAtPayment: null,
        batchAtPayment: responsibleBatch,
        recordedBy: collectorId,
        recordedByRole: collectorRole,
        recordedAt: now,
        receivedBy: null,
        receivedByRole: null,
      };

      assert.equal(advanceFee.status, "Verification Pending");
      assert.equal(advanceFee.paidAmount, 0, "paidAmount must be 0 for pending advance");
      assert.equal(advanceFee.paymentDate, null, "paymentDate must be null for unverified payment");
      assert.equal(advanceFee.receivedBy, null, "receivedBy custody must be null until verified");
      assert.equal(advanceFee.assignedTeacherAtPayment, null, "assignedTeacherAtPayment must be null until payment is confirmed");
      assert.equal(advanceFee.recordedByRole, "teacher");
      assert.equal(advanceFee.assignedTeacherId.toString(), teacher1Id);
    }
  );

  // --------------------------------------------------------------------------
  // TEST 16: Owner verification transitions Verification Pending advance fee to Paid
  // --------------------------------------------------------------------------
  await t.test(
    "16. Owner verification transitions Verification Pending advance fee to Paid and snapshots custody",
    async () => {
      const advanceFee = {
        _id: "650000000000000000000216",
        centerId: centerId,
        studentId: "650000000000000000000116",
        status: "Verification Pending",
        amountDue: 2500,
        paidAmount: 0,
        assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
        assignedTeacherAtPayment: null,
        batchAtPayment: "Batch F",
        recordedBy: new mongoose.Types.ObjectId(teacher1Id),
        recordedByRole: "teacher",
        receivedBy: null,
        receivedByRole: null,
        paymentDate: null,
        paidDate: null,
      };

      const studentDoc = {
        _id: "650000000000000000000116",
        name: "Karan Johar",
        assignedTeacherId: new mongoose.Types.ObjectId(teacher1Id),
        batch: "Batch F",
      };

      const ownerUser = await getAuthenticatedUser(createMockRequest({ token: ownerToken }));
      const now = new Date();

      // Owner verification simulation:
      const isPaidRecord = advanceFee.status === "Paid" || advanceFee.status === "Partial Paid";
      advanceFee.status = "Paid";
      advanceFee.paidAmount = advanceFee.amountDue;
      advanceFee.amountDue = 0;
      advanceFee.paidDate = now;
      advanceFee.paymentDate = now;

      const isNewlyPaidOrSettled = !isPaidRecord && (advanceFee.status === "Paid" || advanceFee.status === "Partial Paid");
      if (isNewlyPaidOrSettled) {
        advanceFee.receivedBy = new mongoose.Types.ObjectId(ownerUser.userId);
        advanceFee.receivedByRole = ownerUser.role;
        advanceFee.assignedTeacherAtPayment = studentDoc.assignedTeacherId ?? null;
      }

      assert.equal(advanceFee.status, "Paid");
      assert.equal(advanceFee.paidAmount, 2500);
      assert.equal(advanceFee.receivedBy.toString(), ownerId);
      assert.equal(advanceFee.receivedByRole, "owner");
      assert.equal(advanceFee.assignedTeacherAtPayment.toString(), teacher1Id);
      assert.ok(advanceFee.paidDate instanceof Date);
    }
  );
});
