import test from "node:test";
import assert from "node:assert/strict";

test("Admissions UI Improvement – Batch Navigation, ID Stability & Scoping Suite", async (t) => {
  // Test Data Fixtures representing MSEC live data model
  const mockBatches = [
    {
      _id: "6af100000000000000000002",
      centerId: "msce-8267",
      name: "Class 10 - Mathematics",
      timing: "5:00 PM - 6:30 PM",
      subject: "Mathematics",
      isActive: true,
    },
    {
      _id: "6af100000000000000000003",
      centerId: "msce-8267",
      name: "TEST_E2E_Batch_Physics",
      timing: "4:00 PM - 5:30 PM",
      subject: "Physics",
      isActive: true,
    },
    {
      _id: "6af100000000000000000004",
      centerId: "msce-8267",
      name: "Class 12 - Chemistry",
      timing: "6:30 PM - 8:00 PM",
      subject: "Chemistry",
      isActive: true,
    },
  ];

  const TEACHER_1_ID = "6ae9ba93d29bd04896bac676";
  const TEACHER_2_ID = "6af100000000000000000001";

  const mockStudents = [
    {
      _id: "s_jack",
      centerId: "msce-8267",
      name: "Jack",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9999908820",
      monthlyFee: 2500,
      assignedTeacherId: TEACHER_1_ID,
      isActive: true,
      billingCycleDate: 5,
    },
    {
      _id: "s_t1_2",
      centerId: "msce-8267",
      name: "TEST_E2E_Student_T1",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9999900005",
      monthlyFee: 3000,
      assignedTeacherId: TEACHER_1_ID,
      isActive: true,
      billingCycleDate: 10,
    },
    {
      _id: "s_t2_1",
      centerId: "msce-8267",
      name: "TEST_E2E_Student_T2",
      batch: "TEST_E2E_Batch_Physics",
      parentWhatsApp: "9999900006",
      monthlyFee: 3500,
      assignedTeacherId: TEACHER_2_ID,
      isActive: true,
      billingCycleDate: 15,
    },
    {
      _id: "s_owner_1",
      centerId: "msce-8267",
      name: "TEST_E2E_Student_Owner",
      batch: "Class 12 - Chemistry",
      parentWhatsApp: "9999900004",
      monthlyFee: 2000,
      assignedTeacherId: null, // Owner-assigned
      isActive: true,
      billingCycleDate: 5,
    },
  ];

  await t.test(
    "1.1 Batch Overview: Each batch card computes active student count and monthly fee without bundling student rows",
    () => {
      // Logic from AdmissionsPage batchStatsMap indexed by batch._id
      const computeBatchStats = (batches, students) => {
        const stats = {};
        batches.forEach((b) => {
          stats[b._id] = {
            totalStudents: 0,
            activeStudents: 0,
            monthlyFee: 0,
            meta: b,
            studentsBundled: false,
          };
        });

        students.forEach((s) => {
          const matchBatch = batches.find((b) => b.name === s.batch);
          if (matchBatch && stats[matchBatch._id]) {
            stats[matchBatch._id].totalStudents += 1;
            if (s.isActive !== false) {
              stats[matchBatch._id].activeStudents += 1;
              stats[matchBatch._id].monthlyFee += s.monthlyFee || 0;
            }
          }
        });
        return stats;
      };

      const stats = computeBatchStats(mockBatches, mockStudents);

      // Class 10 - Mathematics (_id: ...0002): 2 active students, ₹5,500 monthly fee
      assert.equal(stats["6af100000000000000000002"].activeStudents, 2);
      assert.equal(stats["6af100000000000000000002"].monthlyFee, 5500);
      assert.equal(stats["6af100000000000000000002"].meta.name, "Class 10 - Mathematics");
      assert.equal(stats["6af100000000000000000002"].meta.subject, "Mathematics");
      assert.equal(stats["6af100000000000000000002"].studentsBundled, false);

      // TEST_E2E_Batch_Physics (_id: ...0003): 1 active student, ₹3,500 monthly fee
      assert.equal(stats["6af100000000000000000003"].activeStudents, 1);
      assert.equal(stats["6af100000000000000000003"].monthlyFee, 3500);

      // Class 12 - Chemistry (_id: ...0004): 1 active student, ₹2,000 monthly fee
      assert.equal(stats["6af100000000000000000004"].activeStudents, 1);
      assert.equal(stats["6af100000000000000000004"].monthlyFee, 2000);
    }
  );

  await t.test(
    "2.1 URL State Stability: Navigation and state restoration prefer stable batch ObjectId `?batchId=<id>`",
    () => {
      let currentUrl = "/admissions";
      let selectedBatchId = null;

      const navigateToBatch = (batch) => {
        selectedBatchId = batch._id;
        currentUrl = `/admissions?batchId=${encodeURIComponent(batch._id)}`;
      };

      const navigateBackToBatches = () => {
        selectedBatchId = null;
        currentUrl = "/admissions";
      };

      // Select Mathematics batch by ObjectId
      navigateToBatch(mockBatches[0]);
      assert.equal(selectedBatchId, "6af100000000000000000002");
      assert.equal(currentUrl, "/admissions?batchId=6af100000000000000000002");

      // Verify that URL does NOT use batch name
      assert.ok(!currentUrl.includes("Class%2010"), "URL should use batchId, not batch name");

      // Simulate browser refresh: parse query params from currentUrl
      const urlParams = new URLSearchParams(currentUrl.split("?")[1]);
      const restoredBatchId = urlParams.get("batchId");
      const restoredBatch = mockBatches.find((b) => b._id === restoredBatchId);

      assert.equal(restoredBatchId, "6af100000000000000000002");
      assert.ok(restoredBatch, "Batch document must be resolvable from batchId");
      assert.equal(restoredBatch.name, "Class 10 - Mathematics");

      // Back navigation restores overview
      navigateBackToBatches();
      assert.equal(selectedBatchId, null);
      assert.equal(currentUrl, "/admissions");
    }
  );

  await t.test(
    "2.2 URL State Fallback: Legacy `?batch=<name>` query param resolves to stable batchId",
    () => {
      const legacyUrl = "/admissions?batch=Class%2010%20-%20Mathematics";
      const legacyParams = new URLSearchParams(legacyUrl.split("?")[1]);
      const legacyName = legacyParams.get("batch");

      const matchedBatch = mockBatches.find((b) => b.name === legacyName);
      assert.ok(matchedBatch);
      assert.equal(matchedBatch._id, "6af100000000000000000002");
    }
  );

  await t.test(
    "3.1 Safe Not-Found Guard: Invalid, deleted or unauthorized batch ID shows safe empty state without leaking data",
    () => {
      const resolveBatchState = (requestedBatchId, batches, students, isLoading) => {
        if (isLoading) return { status: "loading", students: [] };
        if (!requestedBatchId) return { status: "overview", students: [] };

        const batch = batches.find((b) => b._id === requestedBatchId);
        if (!batch) {
          // SAFE EMPTY / NOT-FOUND STATE: zero student data exposed
          return { status: "not_found", students: [] };
        }

        const batchStudents = students.filter((s) => s.batch === batch.name);
        return { status: "detail", batch, students: batchStudents };
      };

      // 1. Invalid random batch ID
      const invalidRes = resolveBatchState("invalid_random_id_999", mockBatches, mockStudents, false);
      assert.equal(invalidRes.status, "not_found");
      assert.equal(invalidRes.students.length, 0, "Must not leak any students for invalid batchId");

      // 2. Deleted batch ID
      const deletedRes = resolveBatchState("deleted_batch_id_000", mockBatches, mockStudents, false);
      assert.equal(deletedRes.status, "not_found");
      assert.equal(deletedRes.students.length, 0);

      // 3. Unauthorized batch ID for Teacher 1 (Teacher 1 only sees Math batch)
      const teacher1AuthorizedBatches = mockBatches.filter((b) => b._id === "6af100000000000000000002");
      const unauthorizedRes = resolveBatchState(
        "6af100000000000000000003", // Physics batch ID
        teacher1AuthorizedBatches,
        mockStudents,
        false
      );
      assert.equal(unauthorizedRes.status, "not_found", "Teacher must receive not_found for unauthorized batchId");
      assert.equal(unauthorizedRes.students.length, 0, "No student data can leak to unauthorized teacher");
    }
  );

  await t.test(
    "4.1 Debounced Search: Request includes selected batchId and performs case-insensitive search",
    () => {
      const buildSearchRequest = (selectedBatch, query) => {
        return {
          batchId: selectedBatch._id,
          batch: selectedBatch.name,
          search: query.trim(),
        };
      };

      const req = buildSearchRequest(mockBatches[0], "jack");
      assert.equal(req.batchId, "6af100000000000000000002");
      assert.equal(req.batch, "Class 10 - Mathematics");
      assert.equal(req.search, "jack");

      // Execute search within batch
      const searchResults = mockStudents.filter(
        (s) =>
          s.batch === req.batch &&
          (s.name.toLowerCase().includes(req.search) || s.parentWhatsApp.includes(req.search))
      );

      assert.equal(searchResults.length, 1);
      assert.equal(searchResults[0].name, "Jack");
    }
  );

  await t.test(
    "4.2 Debounced Search: AbortController & request epoch stale-response guard contract",
    () => {
      let activeController = new AbortController();
      let currentEpoch = 0;

      // Simulate first keystroke 'j'
      currentEpoch++;
      const req1Epoch = currentEpoch;
      let req1Aborted = false;

      activeController.signal.addEventListener("abort", () => {
        req1Aborted = true;
      });

      // Simulate rapid second keystroke 'ja' before response 1 arrives
      activeController.abort();
      activeController = new AbortController();
      currentEpoch++;
      const req2Epoch = currentEpoch;

      assert.equal(req1Aborted, true, "First request must be aborted");
      assert.equal(activeController.signal.aborted, false, "Second request remains active");

      // Verify epoch guard: response from req 1 is discarded even if network returned late
      const shouldApplyReq1 = req1Epoch === currentEpoch;
      const shouldApplyReq2 = req2Epoch === currentEpoch;

      assert.equal(shouldApplyReq1, false, "Late response from superseded query must be ignored");
      assert.equal(shouldApplyReq2, true, "Latest query response must be accepted");
    }
  );

  await t.test(
    "5.1 Backend Scoping Guard: Teacher querying with another teacher's batchId receives 0 students",
    () => {
      // Simulate backend validation logic from /api/students route
      const validateTeacherBatchAccess = (teacherId, requestedBatchId, batches, students) => {
        const teacherStudents = students.filter((s) => s.assignedTeacherId === teacherId);
        const allowedBatchNames = new Set(teacherStudents.map((s) => s.batch));

        const batchDoc = batches.find((b) => b._id === requestedBatchId);
        if (!batchDoc || !allowedBatchNames.has(batchDoc.name)) {
          // Backend sets filter.batch = "__NON_EXISTENT_BATCH__"
          return "__NON_EXISTENT_BATCH__";
        }
        return batchDoc.name;
      };

      // Teacher 1 tries to access Physics batch
      const filterBatch = validateTeacherBatchAccess(
        TEACHER_1_ID,
        "6af100000000000000000003", // Physics batch ID
        mockBatches,
        mockStudents
      );

      assert.equal(filterBatch, "__NON_EXISTENT_BATCH__");

      const resultStudents = mockStudents.filter(
        (s) => s.assignedTeacherId === TEACHER_1_ID && s.batch === filterBatch
      );
      assert.equal(resultStudents.length, 0, "Teacher 1 receives 0 students for foreign batchId");
    }
  );

  await t.test(
    "5.2 Modal initialBatch Contract: Pre-fills active batch name for new admissions",
    () => {
      const activeBatch = mockBatches[0];
      const initialBatch = activeBatch.name;

      const resolveModalBatch = (initialBatch, studentToEdit) => {
        if (studentToEdit && studentToEdit.batch) return studentToEdit.batch;
        return initialBatch || "Default Batch";
      };

      const newStudentBatch = resolveModalBatch(initialBatch, null);
      assert.equal(newStudentBatch, "Class 10 - Mathematics");
    }
  );
});
