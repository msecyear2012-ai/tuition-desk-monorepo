import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";
import { connectDB } from "file:///D:/Client-Projects/MSEC/tution-desk-be/src/lib/db.ts";

export const EXPECTED_CENTER = "msce-8267";

/**
 * Phase 1: Complete Read-Only Preflight Verification
 * Validates ownership, center isolation, and strict linkage across all candidates.
 * Returns the exact verified manifest. Throws on ANY ambiguity or missing proof.
 */
export async function verifyPreflight(db, { studentId, feeId, tag, centerId = EXPECTED_CENTER }) {
  if (!studentId || !mongoose.Types.ObjectId.isValid(String(studentId))) {
    throw new Error("ABORT: Valid --student-id=<ObjectId> parameter is required.");
  }
  if (!feeId || !mongoose.Types.ObjectId.isValid(String(feeId))) {
    throw new Error("ABORT: Valid --fee-id=<ObjectId> parameter is required.");
  }
  if (!tag || String(tag).trim().length < 6) {
    throw new Error("ABORT: Valid --tag=<EXPECTED_QA_TAG> parameter is required (minimum 6 characters).");
  }

  const stuObjId = new mongoose.Types.ObjectId(String(studentId));
  const feeObjId = new mongoose.Types.ObjectId(String(feeId));
  const cleanTag = String(tag).trim();

  const manifest = {
    centerId,
    qaTag: cleanTag,
    student: null,
    fee: null,
    parentAccessesToDelete: [],
    admissionWelcomeJobsToDelete: [],
  };

  // ---------------------------------------------------------------------------
  // Check 1: Verify Student Ownership & Tag
  // ---------------------------------------------------------------------------
  const student = await db.collection("students").findOne({ _id: stuObjId, centerId });
  if (!student) {
    throw new Error(`ABORT: Target student [${studentId}] not found in center [${centerId}]. Rollback halted.`);
  }
  if (!String(student.name || "").includes(cleanTag)) {
    throw new Error(
      `ABORT: Student [${studentId}] name "${student.name}" does NOT contain expected QA tag "${cleanTag}". Genuine data protection triggered! Rollback halted.`
    );
  }
  manifest.student = {
    _id: student._id,
    name: student.name,
    batch: student.batch || "",
    centerId: student.centerId,
  };

  // ---------------------------------------------------------------------------
  // Check 2: Verify Fee Linkage & Independent Fee Ownership Proof
  // ---------------------------------------------------------------------------
  const fee = await db.collection("fees").findOne({ _id: feeObjId, centerId });
  if (!fee) {
    throw new Error(`ABORT: Target fee [${feeId}] not found in center [${centerId}]. Rollback halted.`);
  }
  if (String(fee.studentId) !== String(stuObjId)) {
    throw new Error(
      `ABORT: Fee [${feeId}] studentId (${fee.studentId}) does not match target student (${stuObjId}). Cross-link violation! Rollback halted.`
    );
  }

  // Independent Fee Ownership Guard: Must NOT rely on student.name.
  // The fee record itself must carry the QA tag in notes, title, or utrNumber.
  const hasIndependentFeeTag =
    String(fee.notes || "").includes(cleanTag) ||
    String(fee.title || "").includes(cleanTag) ||
    String(fee.utrNumber || "").includes(cleanTag);

  if (!hasIndependentFeeTag) {
    throw new Error(
      `ABORT: Fee [${feeId}] does NOT carry independent QA tag "${cleanTag}" in 'notes', 'title', or 'utrNumber'. ` +
      `Independent fee ownership cannot be proven. Fallback to student.name is strictly forbidden. Rollback halted.`
    );
  }

  manifest.fee = {
    _id: fee._id,
    title: fee.title || fee.month || "",
    status: fee.status || "Pending",
    amountDue: fee.amountDue || 0,
    paidAmount: fee.paidAmount || 0,
    receiptNumber: fee.receiptNumber || "(None)",
    paymentMode: fee.paymentMode || "(None)",
    hasIndependentTagProof: true,
    centerId: fee.centerId,
  };

  // ---------------------------------------------------------------------------
  // Check 3: Inspect ALL ParentAccess Records Linked to Target Student
  // ---------------------------------------------------------------------------
  const candidateParentAccesses = await db.collection("parentaccesses").find({
    linkedStudentIds: stuObjId,
    centerId,
  }).toArray();

  for (const pa of candidateParentAccesses) {
    if (!Array.isArray(pa.linkedStudentIds) || pa.linkedStudentIds.length === 0) {
      throw new Error(`ABORT: ParentAccess [${pa._id}] has malformed or empty linkedStudentIds. Rollback halted.`);
    }

    // Check for sibling / foreign student linkage:
    // If any linked ID is NOT the target student, abort immediately to prevent sibling access loss.
    const hasOtherStudents = pa.linkedStudentIds.some((id) => String(id) !== String(stuObjId));
    if (hasOtherStudents) {
      throw new Error(
        `ABORT: ParentAccess [${pa._id}] links other student(s) in addition to target student [${stuObjId}] ` +
        `(Total linked: ${pa.linkedStudentIds.length}). Sibling linkage detected. Deletion aborted to prevent sibling data loss.`
      );
    }

    // Exactly links only this student
    manifest.parentAccessesToDelete.push({
      _id: pa._id,
      parentPhone: pa.parentPhone || "",
      linkedStudentCount: pa.linkedStudentIds.length,
      centerId: pa.centerId,
    });
  }

  // ---------------------------------------------------------------------------
  // Check 4: Inspect ALL AdmissionWelcomeJobs Linked to Target Student
  // ---------------------------------------------------------------------------
  const candidateJobs = await db.collection("admissionwelcomejobs").find({
    studentId: stuObjId,
    centerId,
  }).toArray();

  for (const job of candidateJobs) {
    if (String(job.studentId) !== String(stuObjId) || job.centerId !== centerId) {
      throw new Error(`ABORT: AdmissionWelcomeJob [${job._id}] failed ownership cross-check.`);
    }
    manifest.admissionWelcomeJobsToDelete.push({
      _id: job._id,
      status: job.status,
      studentName: job.studentName,
      centerId: job.centerId,
    });
  }

  return manifest;
}

/**
 * Phase 2: Atomic MongoDB Transaction Execution
 * Revalidates every document inside the transaction before executing targeted deleteOne.
 * Reverts automatically if any check fails or deletedCount !== 1.
 */
export async function executeRollbackTransaction(client, db, manifest, { centerId = EXPECTED_CENTER }) {
  const session = client.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const stuObjId = manifest.student._id;
      const feeObjId = manifest.fee._id;
      const tag = manifest.qaTag;

      // -----------------------------------------------------------------------
      // In-Transaction Revalidation: Guard against concurrent mutations
      // -----------------------------------------------------------------------

      // 1. Revalidate Student
      const currentStudent = await db.collection("students").findOne(
        { _id: stuObjId, centerId },
        { session }
      );
      if (!currentStudent || !String(currentStudent.name || "").includes(tag)) {
        throw new Error(`Transaction Abort: Student [${stuObjId}] state changed or tag missing since preflight.`);
      }

      // 2. Revalidate Fee
      const currentFee = await db.collection("fees").findOne(
        { _id: feeObjId, centerId },
        { session }
      );
      if (!currentFee || String(currentFee.studentId) !== String(stuObjId)) {
        throw new Error(`Transaction Abort: Fee [${feeObjId}] state or student linkage changed since preflight.`);
      }
      const hasIndependentTag =
        String(currentFee.notes || "").includes(tag) ||
        String(currentFee.title || "").includes(tag) ||
        String(currentFee.utrNumber || "").includes(tag);
      if (!hasIndependentTag) {
        throw new Error(`Transaction Abort: Fee [${feeObjId}] independent QA tag missing in transaction revalidation.`);
      }

      // 3. Revalidate Every ParentAccess
      for (const paInfo of manifest.parentAccessesToDelete) {
        const currentPa = await db.collection("parentaccesses").findOne(
          { _id: paInfo._id, centerId },
          { session }
        );
        if (!currentPa || !Array.isArray(currentPa.linkedStudentIds) || currentPa.linkedStudentIds.length !== 1 || String(currentPa.linkedStudentIds[0]) !== String(stuObjId)) {
          throw new Error(`Transaction Abort: ParentAccess [${paInfo._id}] state or linkage changed since preflight.`);
        }
      }

      // 4. Revalidate Every AdmissionWelcomeJob
      for (const jobInfo of manifest.admissionWelcomeJobsToDelete) {
        const currentJob = await db.collection("admissionwelcomejobs").findOne(
          { _id: jobInfo._id, centerId },
          { session }
        );
        if (!currentJob || String(currentJob.studentId) !== String(stuObjId)) {
          throw new Error(`Transaction Abort: AdmissionWelcomeJob [${jobInfo._id}] state changed since preflight.`);
        }
      }

      // -----------------------------------------------------------------------
      // In-Transaction Exact ID Deletions
      // -----------------------------------------------------------------------

      // Delete Fee
      const delFeeRes = await db.collection("fees").deleteOne(
        { _id: feeObjId, centerId },
        { session }
      );
      if (delFeeRes.deletedCount !== 1) {
        throw new Error(`Transaction Abort: Expected to delete 1 fee [${feeObjId}], deleted ${delFeeRes.deletedCount}.`);
      }

      // Delete ParentAccess records
      let paDeletedCount = 0;
      for (const paInfo of manifest.parentAccessesToDelete) {
        const delPaRes = await db.collection("parentaccesses").deleteOne(
          { _id: paInfo._id, centerId },
          { session }
        );
        if (delPaRes.deletedCount !== 1) {
          throw new Error(`Transaction Abort: Expected to delete 1 ParentAccess [${paInfo._id}], deleted ${delPaRes.deletedCount}.`);
        }
        paDeletedCount++;
      }

      // Delete AdmissionWelcomeJobs
      let jobsDeletedCount = 0;
      for (const jobInfo of manifest.admissionWelcomeJobsToDelete) {
        const delJobRes = await db.collection("admissionwelcomejobs").deleteOne(
          { _id: jobInfo._id, centerId },
          { session }
        );
        if (delJobRes.deletedCount !== 1) {
          throw new Error(`Transaction Abort: Expected to delete 1 job [${jobInfo._id}], deleted ${delJobRes.deletedCount}.`);
        }
        jobsDeletedCount++;
      }

      // Delete Student
      const delStuRes = await db.collection("students").deleteOne(
        { _id: stuObjId, centerId },
        { session }
      );
      if (delStuRes.deletedCount !== 1) {
        throw new Error(`Transaction Abort: Expected to delete 1 student [${stuObjId}], deleted ${delStuRes.deletedCount}.`);
      }

      result = {
        feesDeleted: delFeeRes.deletedCount,
        parentAccessesDeleted: paDeletedCount,
        jobsDeleted: jobsDeletedCount,
        studentsDeleted: delStuRes.deletedCount,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Main CLI Entry Point
 */
export async function runRollbackCli(cliArgs = process.argv.slice(2)) {
  const studentId = cliArgs.find((a) => a.startsWith("--student-id="))?.split("=")[1];
  const feeId     = cliArgs.find((a) => a.startsWith("--fee-id="))?.split("=")[1];
  const tag       = cliArgs.find((a) => a.startsWith("--tag="))?.split("=")[1];
  const isConfirmed = cliArgs.includes("--confirm-delete=true");

  console.log("================================================================================");
  console.log("🛡️ MSEC Scoped Manual Rollback & Exact ID Ownership Verifier");
  console.log("================================================================================");
  console.log(`• Target Center:       ${EXPECTED_CENTER}`);
  console.log(`• Target Student ID:   ${studentId || "(MISSING)"}`);
  console.log(`• Target Fee ID:       ${feeId || "(MISSING)"}`);
  console.log(`• Expected QA Tag:     ${tag || "(MISSING)"}`);
  console.log(`• Execution Mode:      ${isConfirmed ? "🚨 LIVE TRANSACTIONAL DELETION" : "🔍 DRY-RUN PREVIEW ONLY (Default)"}`);
  console.log("================================================================================\n");

  await connectDB();
  const db = mongoose.connection.db;
  const client = mongoose.connection.getClient();

  try {
    console.log("⏳ Phase 1: Running Complete Preflight Ownership & Linkage Verification...\n");
    const manifest = await verifyPreflight(db, { studentId, feeId, tag, centerId: EXPECTED_CENTER });

    console.log(`✔ [VERIFIED] Student: "${manifest.student.name}" (ID: ${manifest.student._id})`);
    console.log(`✔ [VERIFIED] Fee: "${manifest.fee.title}" Status: ${manifest.fee.status} Receipt: ${manifest.fee.receiptNumber} (ID: ${manifest.fee._id})`);
    console.log(`✔ [VERIFIED] ParentAccess: ${manifest.parentAccessesToDelete.length} verified record(s) linked strictly to target student`);
    console.log(`✔ [VERIFIED] AdmissionWelcomeJobs: ${manifest.admissionWelcomeJobsToDelete.length} verified record(s)`);

    console.log("\n--------------------------------------------------------------------------------");
    console.log("📋 EXACT ROLLBACK MANIFEST (Preflight Passed — Verified for Deletion)");
    console.log("--------------------------------------------------------------------------------");
    console.log(JSON.stringify(manifest, null, 2));
    console.log("--------------------------------------------------------------------------------\n");

    if (!isConfirmed) {
      console.log("🛑 DRY-RUN PREVIEW COMPLETE: Zero database mutations were performed.");
      console.log("• All preflight ownership and linkage checks passed.");
      console.log("• To execute this exact rollback under an atomic MongoDB transaction, re-run with:");
      console.log(`  node --env-file=\"tution-desk-be/.env\" scripts/safe-manual-rollback.mjs --student-id=${studentId} --fee-id=${feeId} --tag=${tag} --confirm-delete=true`);
      console.log("================================================================================\n");
      return { status: "DRY_RUN", manifest };
    }

    console.log("🚨 CONFIRMED EXECUTION: Commencing atomic MongoDB session transaction...\n");
    const result = await executeRollbackTransaction(client, db, manifest, { centerId: EXPECTED_CENTER });

    console.log("✔ [TX] Execution summary:", JSON.stringify(result));
    console.log("\n================================================================================");
    console.log("🏁 ATOMIC ROLLBACK COMMITTED: All target records deleted without genuine data loss.");
    console.log("================================================================================\n");
    return { status: "COMMITTED", result, manifest };

  } finally {
    await mongoose.disconnect();
  }
}

// Direct CLI invocation guard
const isDirectCli = process.argv[1] && (
  process.argv[1].endsWith("safe-manual-rollback.mjs") ||
  process.argv[1].endsWith("safe-manual-rollback.js")
);

if (isDirectCli) {
  runRollbackCli().catch((err) => {
    console.error("\n❌ FATAL ROLLBACK HALT:", err.message);
    process.exit(1);
  });
}
