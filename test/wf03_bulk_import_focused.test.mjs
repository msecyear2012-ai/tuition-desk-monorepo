import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";
import { initDbConnection, disconnectDb } from "../scripts/qa-runner/qaDbHelper.mjs";
import { createAuthTokens } from "../scripts/qa-runner/authHelper.mjs";
import { QA_CONFIG } from "../scripts/qa-runner/config.mjs";
import { verifyImportLockIndexIntegrity, ImportBatchLock } from "../tution-desk-be/src/models/ImportBatchLock.ts";

test("WF-03: Bulk Student Import & Distributed Lock Verification Suite", async (t) => {
  let db;
  let tokens;
  const testRunTag = `WF03_TEST_${Date.now()}`;
  const createdStudentIds = [];
  const createdLockPreviewIds = [];

  t.before(async () => {
    db = await initDbConnection();
    assert.equal(db.databaseName, "msec", "Safety guard: Must run against 'msec' database");
    tokens = await createAuthTokens();
  });

  t.after(async () => {
    // Scoped cleanup of test records created during this test suite
    if (createdStudentIds.length > 0) {
      await db.collection("students").deleteMany({
        _id: { $in: createdStudentIds },
        centerId: QA_CONFIG.centerId,
      });
      await db.collection("parentaccesses").deleteMany({
        linkedStudentIds: { $in: createdStudentIds },
        centerId: QA_CONFIG.centerId,
      });
      await db.collection("admissionwelcomejobs").deleteMany({
        studentId: { $in: createdStudentIds },
        centerId: QA_CONFIG.centerId,
      });
    }
    if (createdLockPreviewIds.length > 0) {
      await db.collection("importbatchlocks").deleteMany({
        previewId: { $in: createdLockPreviewIds },
        centerId: QA_CONFIG.centerId,
      });
    }
    // Clean up any remaining test students/locks/parentaccesses tagged with WF03_TEST
    await db.collection("students").deleteMany({
      name: { $regex: "WF03_TEST" },
      centerId: QA_CONFIG.centerId,
    });
    await db.collection("parentaccesses").deleteMany({
      parentName: { $regex: "WF03_TEST" },
      centerId: QA_CONFIG.centerId,
    });
    await disconnectDb();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Index definition and uniqueness verification
  // ---------------------------------------------------------------------------
  await t.test("1. Unique index 'centerId_1_previewId_1' is verified on 'msec.importbatchlocks'", async () => {
    const collection = db.collection("importbatchlocks");
    const indexes = await collection.indexes();

    const targetIndex = indexes.find((idx) => idx.name === "centerId_1_previewId_1");
    assert.ok(targetIndex, "Index 'centerId_1_previewId_1' must exist in collection.indexes()");
    assert.equal(targetIndex.unique, true, "Index 'centerId_1_previewId_1' must have unique: true");
    assert.equal(targetIndex.key.centerId, 1, "Index key.centerId must be 1");
    assert.equal(targetIndex.key.previewId, 1, "Index key.previewId must be 1");

    // Application-layer helper preflight
    const integrityResult = await verifyImportLockIndexIntegrity(ImportBatchLock);
    assert.equal(integrityResult, true, "verifyImportLockIndexIntegrity(ImportBatchLock) must return true");
  });

  // ---------------------------------------------------------------------------
  // Test 2: Two-step bulk import execution under distributed lock
  // ---------------------------------------------------------------------------
  let sharedPreviewToken = null;
  let sharedPreviewId = null;
  let sharedRows = null;

  await t.test("2. Two-step bulk import (Preview -> Confirm) succeeds under lock coordination", async () => {
    const student1 = {
      name: `QA_STU1_${testRunTag}`,
      batch: "Class 10 - Science",
      parentWhatsApp: "919999900081",
      monthlyFee: 3500,
      billingCycleDate: 10,
    };
    const student2 = {
      name: `QA_STU2_${testRunTag}`,
      batch: "Class 10 - Science",
      parentWhatsApp: "919999900082",
      monthlyFee: 3500,
      billingCycleDate: 10,
    };

    // Step 2A: POST /api/students/bulk-import/preview
    const previewRes = await fetch(`${QA_CONFIG.backendBaseUrl}/api/students/bulk-import/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.ownerToken}`,
      },
      body: JSON.stringify({ rows: [student1, student2] }),
    });

    const previewData = await previewRes.json();
    assert.equal(previewRes.status, 200, `Preview failed: ${JSON.stringify(previewData)}`);
    assert.equal(previewData.success, true);
    assert.ok(previewData.previewToken, "Preview must return previewToken");
    assert.ok(previewData.previewId, "Preview must return previewId");
    assert.equal(previewData.validCount, 2, "Preview must validate 2 rows");

    sharedPreviewToken = previewData.previewToken;
    sharedPreviewId = previewData.previewId;
    sharedRows = previewData.rows;
    createdLockPreviewIds.push(sharedPreviewId);

    // Step 2B: POST /api/students/bulk-import (Execute confirmation)
    const importRes = await fetch(`${QA_CONFIG.backendBaseUrl}/api/students/bulk-import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.ownerToken}`,
      },
      body: JSON.stringify({
        previewToken: sharedPreviewToken,
        rows: sharedRows,
        targetTeacherId: QA_CONFIG.teacher1Id,
      }),
    });

    const importData = await importRes.json();
    assert.ok(
      importRes.status === 200 || importRes.status === 201,
      `Import confirmation failed: HTTP ${importRes.status}: ${JSON.stringify(importData)}`
    );
    assert.equal(importData.success, true);
    assert.equal(importData.importedCount, 2);

    // Verify lock status in database
    const lockDoc = await db.collection("importbatchlocks").findOne({
      centerId: QA_CONFIG.centerId,
      previewId: sharedPreviewId,
    });
    assert.ok(lockDoc, "ImportBatchLock record must be persisted in MongoDB");
    assert.equal(lockDoc.status, "COMPLETED", "ImportBatchLock status must transition to COMPLETED");
    assert.equal(lockDoc.importedCount, 2);

    // Verify imported students exist in database
    const importedStudents = await db.collection("students").find({
      centerId: QA_CONFIG.centerId,
      name: { $regex: testRunTag },
    }).toArray();
    assert.equal(importedStudents.length, 2, "2 students must be created in MongoDB");
    for (const s of importedStudents) {
      createdStudentIds.push(s._id);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: Duplicate-preview lock protection (Re-attempt prevention)
  // ---------------------------------------------------------------------------
  await t.test("3. Duplicate-preview lock protection rejects re-attempt with HTTP 409 Conflict", async () => {
    assert.ok(sharedPreviewToken, "Prerequisite previewToken must exist from Test 2");

    // Second execution attempt with the same preview token / previewId
    const duplicateRes = await fetch(`${QA_CONFIG.backendBaseUrl}/api/students/bulk-import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.ownerToken}`,
      },
      body: JSON.stringify({
        previewToken: sharedPreviewToken,
        rows: sharedRows,
        targetTeacherId: QA_CONFIG.teacher1Id,
      }),
    });

    const duplicateData = await duplicateRes.json();
    assert.equal(
      duplicateRes.status,
      409,
      `Expected HTTP 409 Conflict on duplicate preview execution, got ${duplicateRes.status}: ${JSON.stringify(duplicateData)}`
    );
    assert.equal(duplicateData.success, false);
    assert.match(
      duplicateData.error,
      /already been processed|active lease/i,
      "Error must identify duplicate batch processing"
    );

    // Verify student count did not increase (idempotency preserved)
    const currentStudentCount = await db.collection("students").countDocuments({
      centerId: QA_CONFIG.centerId,
      name: { $regex: testRunTag },
    });
    assert.equal(currentStudentCount, 2, "No duplicate students should be created on re-attempt");
  });

  // ---------------------------------------------------------------------------
  // Test 4: Concurrent import protection (Database unique index enforcement)
  // ---------------------------------------------------------------------------
  await t.test("4. Concurrent import collision is rejected by unique index centerId_1_previewId_1", async () => {
    const testCollisionPreviewId = `prev_collision_${Date.now()}`;
    createdLockPreviewIds.push(testCollisionPreviewId);

    // Attempt 1: Insert initial lock
    await db.collection("importbatchlocks").insertOne({
      centerId: QA_CONFIG.centerId,
      previewId: testCollisionPreviewId,
      holderId: "holder_alpha",
      lockVersion: 1,
      status: "IN_PROGRESS",
      assignedRole: "owner",
      userId: QA_CONFIG.ownerId,
      lockedAt: new Date(),
      heartbeatAt: new Date(),
    });

    // Attempt 2: Concurrent runner tries to insert lock for the SAME centerId and previewId
    let duplicateKeyErrorCaught = false;
    try {
      await db.collection("importbatchlocks").insertOne({
        centerId: QA_CONFIG.centerId,
        previewId: testCollisionPreviewId,
        holderId: "holder_beta",
        lockVersion: 1,
        status: "IN_PROGRESS",
        assignedRole: "owner",
        userId: QA_CONFIG.ownerId,
        lockedAt: new Date(),
        heartbeatAt: new Date(),
      });
    } catch (err) {
      duplicateKeyErrorCaught = true;
      assert.equal(err.code, 11000, "MongoDB error code must be 11000 (duplicate key error)");
      assert.match(
        err.message,
        /centerId_1_previewId_1/,
        "Error message must reference unique index centerId_1_previewId_1"
      );
    }

    assert.equal(
      duplicateKeyErrorCaught,
      true,
      "Unique index must reject concurrent lock acquisition with E11000"
    );
  });

  // ---------------------------------------------------------------------------
  // Test 5: Teacher self-assignment security rule (DEC-MSEC-05)
  // ---------------------------------------------------------------------------
  await t.test("5. Teacher bulk import strictly enforces self-assignment and ignores client targetTeacherId", async () => {
    const teacherStudent = {
      name: `QA_TEACHER_IMPORT_${testRunTag}`,
      batch: "Class 10 - Science",
      parentWhatsApp: "919999900083",
      monthlyFee: 3000,
      billingCycleDate: 5,
    };

    // Teacher 1 previews
    const previewRes = await fetch(`${QA_CONFIG.backendBaseUrl}/api/students/bulk-import/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.teacher1Token}`,
      },
      body: JSON.stringify({ rows: [teacherStudent] }),
    });

    const previewData = await previewRes.json();
    assert.equal(previewRes.status, 200);
    assert.ok(previewData.previewToken);
    createdLockPreviewIds.push(previewData.previewId);

    // Teacher 1 attempts to confirm with targetTeacherId set to Teacher 2 or Owner
    // Per MSEC DEC-MSEC-05, this MUST be overridden to Teacher 1 (self-assignment)
    const importRes = await fetch(`${QA_CONFIG.backendBaseUrl}/api/students/bulk-import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.teacher1Token}`,
      },
      body: JSON.stringify({
        previewToken: previewData.previewToken,
        rows: previewData.rows,
        targetTeacherId: QA_CONFIG.teacher2Id, // Client attempts assignment to Teacher 2
      }),
    });

    const importData = await importRes.json();
    assert.ok(importRes.status === 200 || importRes.status === 201);
    assert.equal(importData.success, true);
    assert.equal(importData.assignedTo.role, "teacher");
    assert.equal(
      String(importData.assignedTo.id),
      String(QA_CONFIG.teacher1Id),
      "assignedTo.id must be authenticated Teacher 1"
    );

    // Verify in database: Student must be assigned to Teacher 1, NOT Teacher 2
    const dbStudent = await db.collection("students").findOne({
      centerId: QA_CONFIG.centerId,
      name: `QA_TEACHER_IMPORT_${testRunTag}`,
    });
    assert.ok(dbStudent, "Imported student must exist in MongoDB");
    createdStudentIds.push(dbStudent._id);

    assert.equal(
      String(dbStudent.assignedTeacherId),
      String(QA_CONFIG.teacher1Id),
      "MSEC Rule DEC-MSEC-05: imported student assignedTeacherId MUST be authenticated Teacher 1"
    );
    assert.notEqual(
      String(dbStudent.assignedTeacherId),
      String(QA_CONFIG.teacher2Id),
      "Client-supplied targetTeacherId must be strictly ignored for teacher role"
    );

    // Verify lock record assignedTeacherId
    const lockDoc = await db.collection("importbatchlocks").findOne({
      centerId: QA_CONFIG.centerId,
      previewId: previewData.previewId,
    });
    assert.ok(lockDoc);
    assert.equal(
      String(lockDoc.assignedTeacherId),
      String(QA_CONFIG.teacher1Id),
      "ImportBatchLock assignedTeacherId must record authenticated Teacher 1"
    );
  });
});
