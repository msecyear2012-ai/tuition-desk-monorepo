import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";
import { verifyPreflight, executeRollbackTransaction, EXPECTED_CENTER } from "../scripts/safe-manual-rollback.mjs";

function createMockDb(initialData = {}) {
  const store = {
    students: initialData.students || [],
    fees: initialData.fees || [],
    parentaccesses: initialData.parentaccesses || [],
    admissionwelcomejobs: initialData.admissionwelcomejobs || [],
  };

  const collections = {};

  return {
    collection(name) {
      if (collections[name]) return collections[name];
      const colData = store[name] || [];
      collections[name] = {
        async findOne(query) {
          return colData.find((doc) => {
            for (const [k, v] of Object.entries(query)) {
              if (k === "_id" && String(doc._id) !== String(v)) return false;
              if (k === "centerId" && doc.centerId !== v) return false;
              if (k === "linkedStudentIds" && !doc.linkedStudentIds?.some((id) => String(id) === String(v))) return false;
            }
            return true;
          }) || null;
        },
        find(query) {
          const matched = colData.filter((doc) => {
            for (const [k, v] of Object.entries(query)) {
              if (k === "centerId" && doc.centerId !== v) return false;
              if (k === "studentId" && String(doc.studentId) !== String(v)) return false;
              if (k === "linkedStudentIds" && !doc.linkedStudentIds?.some((id) => String(id) === String(v))) return false;
            }
            return true;
          });
          return {
            async toArray() {
              return matched;
            },
          };
        },
        async deleteOne(query) {
          const idx = colData.findIndex((doc) => {
            for (const [k, v] of Object.entries(query)) {
              if (k === "_id" && String(doc._id) !== String(v)) return false;
              if (k === "centerId" && doc.centerId !== v) return false;
            }
            return true;
          });
          if (idx !== -1) {
            colData.splice(idx, 1);
            return { acknowledged: true, deletedCount: 1 };
          }
          return { acknowledged: true, deletedCount: 0 };
        },
      };
      return collections[name];
    },
  };
}

function createMockClient() {
  let inTx = false;
  let aborted = false;
  let committed = false;

  return {
    startSession() {
      return {
        async withTransaction(fn) {
          inTx = true;
          try {
            await fn();
            committed = true;
          } catch (err) {
            aborted = true;
            throw err;
          } finally {
            inTx = false;
          }
        },
        async endSession() {},
        get inTx() { return inTx; },
        get aborted() { return aborted; },
        get committed() { return committed; },
      };
    },
  };
}

test("Safety Guard 1: Missing fee QA tag causes preflight ABORT (no student.name fallback)", async () => {
  const stuId = new mongoose.Types.ObjectId();
  const feeId = new mongoose.Types.ObjectId();
  const tag = "QA_TEST_TAG_999";

  const mockDb = createMockDb({
    students: [
      { _id: stuId, name: `QA_STU_${tag}`, centerId: EXPECTED_CENTER },
    ],
    fees: [
      {
        _id: feeId,
        studentId: stuId,
        centerId: EXPECTED_CENTER,
        title: "Nov 2026 Tuition Fee", // Lacks QA tag!
        notes: "",                     // Lacks QA tag!
        utrNumber: "",                 // Lacks QA tag!
      },
    ],
  });

  await assert.rejects(
    async () => {
      await verifyPreflight(mockDb, {
        studentId: stuId.toString(),
        feeId: feeId.toString(),
        tag,
        centerId: EXPECTED_CENTER,
      });
    },
    (err) => {
      assert.match(err.message, /independent QA tag/i);
      assert.match(err.message, /Fallback to student\.name is strictly forbidden/i);
      return true;
    }
  );
});

test("Safety Guard 2A: ParentAccess linking multiple students (sibling linkage) causes preflight ABORT", async () => {
  const stuId = new mongoose.Types.ObjectId();
  const siblingId = new mongoose.Types.ObjectId();
  const feeId = new mongoose.Types.ObjectId();
  const tag = "QA_TEST_TAG_999";

  const mockDb = createMockDb({
    students: [
      { _id: stuId, name: `QA_STU_${tag}`, centerId: EXPECTED_CENTER },
    ],
    fees: [
      {
        _id: feeId,
        studentId: stuId,
        centerId: EXPECTED_CENTER,
        notes: `Cash collected - ${tag}_PAYMENT`,
      },
    ],
    parentaccesses: [
      {
        _id: new mongoose.Types.ObjectId(),
        linkedStudentIds: [stuId, siblingId], // Ambiguous sibling linkage!
        centerId: EXPECTED_CENTER,
      },
    ],
  });

  await assert.rejects(
    async () => {
      await verifyPreflight(mockDb, {
        studentId: stuId.toString(),
        feeId: feeId.toString(),
        tag,
        centerId: EXPECTED_CENTER,
      });
    },
    (err) => {
      assert.match(err.message, /links other student\(s\)/i);
      assert.match(err.message, /Sibling linkage detected/i);
      return true;
    }
  );
});

test("Safety Guard 2B: Multiple ParentAccess records linking strictly to target student are all included", async () => {
  const stuId = new mongoose.Types.ObjectId();
  const feeId = new mongoose.Types.ObjectId();
  const paId1 = new mongoose.Types.ObjectId();
  const paId2 = new mongoose.Types.ObjectId();
  const tag = "QA_TEST_TAG_999";

  const mockDb = createMockDb({
    students: [
      { _id: stuId, name: `QA_STU_${tag}`, centerId: EXPECTED_CENTER },
    ],
    fees: [
      {
        _id: feeId,
        studentId: stuId,
        centerId: EXPECTED_CENTER,
        notes: `Payment note - ${tag}`,
      },
    ],
    parentaccesses: [
      { _id: paId1, linkedStudentIds: [stuId], centerId: EXPECTED_CENTER },
      { _id: paId2, linkedStudentIds: [stuId], centerId: EXPECTED_CENTER },
    ],
  });

  const manifest = await verifyPreflight(mockDb, {
    studentId: stuId.toString(),
    feeId: feeId.toString(),
    tag,
    centerId: EXPECTED_CENTER,
  });

  assert.equal(manifest.parentAccessesToDelete.length, 2);
  assert.equal(String(manifest.parentAccessesToDelete[0]._id), String(paId1));
  assert.equal(String(manifest.parentAccessesToDelete[1]._id), String(paId2));
});

test("Safety Guard 3: Mutated record between preflight and transaction causes transaction ABORT", async () => {
  const stuId = new mongoose.Types.ObjectId();
  const feeId = new mongoose.Types.ObjectId();
  const tag = "QA_TEST_TAG_999";

  const mockDb = createMockDb({
    students: [
      { _id: stuId, name: `QA_STU_${tag}`, centerId: EXPECTED_CENTER },
    ],
    fees: [
      {
        _id: feeId,
        studentId: stuId,
        centerId: EXPECTED_CENTER,
        notes: `Payment note - ${tag}`,
      },
    ],
  });

  // Step 1: Preflight succeeds
  const manifest = await verifyPreflight(mockDb, {
    studentId: stuId.toString(),
    feeId: feeId.toString(),
    tag,
    centerId: EXPECTED_CENTER,
  });

  // Step 2: Before transaction runs, student record is mutated (unlinked or tag stripped)
  const stuDoc = mockDb.collection("students");
  // Alter student name in mock DB to simulate concurrent mutation
  const found = await stuDoc.findOne({ _id: stuId, centerId: EXPECTED_CENTER });
  found.name = "GENUINE_STUDENT_WITHOUT_TAG";

  const mockClient = createMockClient();

  // Step 3: Transaction execution must catch discrepancy and ABORT
  await assert.rejects(
    async () => {
      await executeRollbackTransaction(mockClient, mockDb, manifest, { centerId: EXPECTED_CENTER });
    },
    (err) => {
      assert.match(err.message, /Student \[.*\] state changed or tag missing since preflight/i);
      return true;
    }
  );
});

test("Safety Guard 4: Deletion failure inside transaction triggers automatic transaction rollback", async () => {
  const stuId = new mongoose.Types.ObjectId();
  const feeId = new mongoose.Types.ObjectId();
  const tag = "QA_TEST_TAG_999";

  const mockDb = createMockDb({
    students: [
      { _id: stuId, name: `QA_STU_${tag}`, centerId: EXPECTED_CENTER },
    ],
    fees: [
      {
        _id: feeId,
        studentId: stuId,
        centerId: EXPECTED_CENTER,
        notes: `Payment note - ${tag}`,
      },
    ],
  });

  const manifest = await verifyPreflight(mockDb, {
    studentId: stuId.toString(),
    feeId: feeId.toString(),
    tag,
    centerId: EXPECTED_CENTER,
  });

  // Override deleteOne on fees to simulate an unexpected database driver failure
  const feeCol = mockDb.collection("fees");
  feeCol.deleteOne = async () => {
    throw new Error("Simulated transient MongoDB cluster network glitch");
  };

  const mockClient = createMockClient();

  await assert.rejects(
    async () => {
      await executeRollbackTransaction(mockClient, mockDb, manifest, { centerId: EXPECTED_CENTER });
    },
    (err) => {
      assert.match(err.message, /Simulated transient MongoDB cluster network glitch/i);
      return true;
    }
  );

  // Verify student was NOT deleted
  const studentStillExists = await mockDb.collection("students").findOne({ _id: stuId, centerId: EXPECTED_CENTER });
  assert.ok(studentStillExists, "Student record must remain 100% intact after aborted transaction");
});
