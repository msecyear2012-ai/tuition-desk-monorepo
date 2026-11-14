import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";
import { initDbConnection, disconnectDb, cleanupQaRecords } from "../scripts/qa-runner/qaDbHelper.mjs";

test("QA Cleanup Exact Correlation Safety Suite", async (t) => {
  let db;

  t.before(async () => {
    db = await initDbConnection();
    assert.equal(db.databaseName, "msec", "Safety guard: Must run against msec database");
  });

  t.after(async () => {
    await disconnectDb();
  });

  await t.test("1. ParentAccess without exact dedicated qaRunId is NEVER deleted, even with similar name/phone/linkedId", async () => {
    const activeQaRunId = `QA_TEST_RUN_${Date.now()}_1`;
    const dummyStudentId = new mongoose.Types.ObjectId();

    // Create fixture that looks like a QA record but lacks exact `qaRunId` field
    const fixture = {
      centerId: "msce-8267",
      parentPhone: "919999900011",
      parentName: `QA_STUDENT_${activeQaRunId}`, // looks identical to QA student name
      linkedStudentIds: [dummyStudentId],
      tokenHash: `test_hash_${Date.now()}_1`,
      tokenPrefix: "pt_tst1",
      status: "active",
      isPasswordProtected: false,
      failedPasswordAttempts: 0,
      // NOTE: NO `qaRunId` field present on this document
    };

    const insertResult = await db.collection("parentaccesses").insertOne(fixture);
    const fixtureId = insertResult.insertedId;

    try {
      // Execute cleanup for the active run
      const summary = await cleanupQaRecords(activeQaRunId, {
        qaRunId: activeQaRunId,
        studentIds: [dummyStudentId],
      });

      // Verification: Document must NOT be deleted
      const checkDoc = await db.collection("parentaccesses").findOne({ _id: fixtureId });
      assert.ok(checkDoc, "Record without dedicated qaRunId MUST NOT be deleted even if parentName matches active run");
      assert.equal(summary.parentAccessesDeleted, 0, "parentAccessesDeleted must be 0");
    } finally {
      // Clean up specific test fixture
      await db.collection("parentaccesses").deleteOne({ _id: fixtureId });
    }
  });

  await t.test("2. FeeReminderLog without exact dedicated qaRunId is NEVER deleted, even with similar failureReason/phone/feeId", async () => {
    const activeQaRunId = `QA_TEST_RUN_${Date.now()}_2`;
    const dummyFeeId = new mongoose.Types.ObjectId();
    const dummyStudentId = new mongoose.Types.ObjectId();

    // Create fixture that looks like a QA log but lacks exact `qaRunId` field
    const fixture = {
      centerId: "msce-8267",
      feeId: dummyFeeId,
      studentId: dummyStudentId,
      recipientPhone: "919999900011",
      amountDue: 2500,
      dueDate: new Date("2026-11-15"),
      triggerType: "manual_owner_single",
      status: "attempted",
      simulated: true,
      failureReason: `Simulation mode active for ${activeQaRunId}`, // contains qaRunId text!
      attemptedAt: new Date(),
      // NOTE: NO `qaRunId` field present on this document
    };

    const insertResult = await db.collection("feereminderlogs").insertOne(fixture);
    const fixtureId = insertResult.insertedId;

    try {
      // Execute cleanup for active run
      const summary = await cleanupQaRecords(activeQaRunId, {
        qaRunId: activeQaRunId,
        feeIds: [dummyFeeId],
        studentIds: [dummyStudentId],
      });

      // Verification: Document must NOT be deleted
      const checkDoc = await db.collection("feereminderlogs").findOne({ _id: fixtureId });
      assert.ok(checkDoc, "FeeReminderLog without dedicated qaRunId MUST NOT be deleted even if failureReason contains qaRunId");
      assert.equal(summary.reminderLogsDeleted, 0, "reminderLogsDeleted must be 0");
    } finally {
      // Clean up specific test fixture
      await db.collection("feereminderlogs").deleteOne({ _id: fixtureId });
    }
  });

  await t.test("3. Records tagged with a DIFFERENT qaRunId are NEVER deleted by active run", async () => {
    const activeQaRunId = `QA_ACTIVE_RUN_${Date.now()}_A`;
    const otherQaRunId = `QA_OTHER_RUN_${Date.now()}_B`;

    const fixture = {
      centerId: "msce-8267",
      parentPhone: "919999900011",
      parentName: "Test Other Parent",
      linkedStudentIds: [new mongoose.Types.ObjectId()],
      tokenHash: `test_hash_${Date.now()}_diff`,
      tokenPrefix: "pt_diff",
      status: "active",
      isPasswordProtected: false,
      failedPasswordAttempts: 0,
      qaRunId: otherQaRunId, // explicitly tagged with DIFFERENT run ID
    };

    const insertResult = await db.collection("parentaccesses").insertOne(fixture);
    const fixtureId = insertResult.insertedId;

    try {
      // Run cleanup for activeQaRunId (different from otherQaRunId)
      const summary = await cleanupQaRecords(activeQaRunId, { qaRunId: activeQaRunId });

      // Verification: Document with different qaRunId must survive
      const checkDoc = await db.collection("parentaccesses").findOne({ _id: fixtureId });
      assert.ok(checkDoc, "Record with different qaRunId MUST survive active run cleanup");
      assert.equal(summary.parentAccessesDeleted, 0);
    } finally {
      await db.collection("parentaccesses").deleteOne({ _id: fixtureId });
    }
  });

  await t.test("4. Records WITH exact matching dedicated qaRunId ARE safely deleted", async () => {
    const targetQaRunId = `QA_TARGET_RUN_${Date.now()}_C`;

    const fixture = {
      centerId: "msce-8267",
      parentPhone: "919999900011",
      parentName: "Target Parent",
      linkedStudentIds: [new mongoose.Types.ObjectId()],
      tokenHash: `test_hash_${Date.now()}_target`,
      tokenPrefix: "pt_targ",
      status: "active",
      isPasswordProtected: false,
      failedPasswordAttempts: 0,
      qaRunId: targetQaRunId, // exact dedicated correlation field
    };

    const insertResult = await db.collection("parentaccesses").insertOne(fixture);
    const fixtureId = insertResult.insertedId;

    try {
      const summary = await cleanupQaRecords(targetQaRunId, { qaRunId: targetQaRunId });
      assert.equal(summary.parentAccessesDeleted, 1, "Record with exact dedicated qaRunId must be deleted");

      const checkDoc = await db.collection("parentaccesses").findOne({ _id: fixtureId });
      assert.equal(checkDoc, null, "Record must be pruned from database");
    } finally {
      await db.collection("parentaccesses").deleteOne({ _id: fixtureId });
    }
  });

  await t.test("5. ID-based cleanup strictly skips IDs not verified against active QA run", async () => {
    const activeQaRunId = `QA_VERIFY_RUN_${Date.now()}_D`;
    const unverifiedStudentId = new mongoose.Types.ObjectId();

    // Create a student whose name does NOT match the active qaRunId
    const unverifiedStudent = {
      _id: unverifiedStudentId,
      name: "Genuine Student Sharma", // does NOT match activeQaRunId
      batch: "Batch A",
      parentWhatsApp: "919876543210",
      centerId: "msce-8267",
      isActive: true,
      monthlyFee: 3000,
      billingCycleDate: 5,
    };

    await db.collection("students").insertOne(unverifiedStudent);

    try {
      // Manifest maliciously or mistakenly contains unverifiedStudentId
      const summary = await cleanupQaRecords(activeQaRunId, {
        qaRunId: activeQaRunId,
        studentIds: [unverifiedStudentId],
      });

      // Verification: Must NOT delete unverified student
      const checkStudent = await db.collection("students").findOne({ _id: unverifiedStudentId });
      assert.ok(checkStudent, "Unverified student ID must NOT be deleted even if passed in manifest");
      assert.equal(summary.studentsDeleted, 0, "studentsDeleted must be 0");
      assert.equal(summary.studentsSkipped, true, "studentsSkipped must be true");
    } finally {
      await db.collection("students").deleteOne({ _id: unverifiedStudentId });
    }
  });

  await t.test("6. Genuine center records are completely untouched", async () => {
    const initialStudentCount = await db.collection("students").countDocuments({ centerId: "msce-8267" });
    const initialFeeCount = await db.collection("fees").countDocuments({ centerId: "msce-8267" });

    // Run cleanup for a non-existent QA run
    const dummyQaRunId = `QA_NONEXISTENT_${Date.now()}`;
    await cleanupQaRecords(dummyQaRunId, { qaRunId: dummyQaRunId });

    const postStudentCount = await db.collection("students").countDocuments({ centerId: "msce-8267" });
    const postFeeCount = await db.collection("fees").countDocuments({ centerId: "msce-8267" });

    assert.equal(postStudentCount, initialStudentCount, "Genuine student count must be 100% preserved");
    assert.equal(postFeeCount, initialFeeCount, "Genuine fee count must be 100% preserved");
  });
});
