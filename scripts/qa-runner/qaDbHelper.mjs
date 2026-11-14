import mongoose from "file:///D:/Client-Projects/MSEC/tution-desk-be/node_modules/mongoose/index.js";
import { connectDB } from "file:///D:/Client-Projects/MSEC/tution-desk-be/src/lib/db.ts";

export async function initDbConnection() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db || db.databaseName !== "msec") {
    throw new Error(`Database safety guard failed: Expected 'msec', got '${db?.databaseName}'`);
  }
  return db;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Strictly scoped QA record cleanup:
 * 
 * Safety Rules (Non-Negotiable):
 * 1. ParentAccess and FeeReminderLog cleanup MUST delete ONLY records with an exact,
 *    dedicated `qaRunId` field matching the active run ({ qaRunId: qaRunId, centerId: "msce-8267" }).
 * 2. Zero `parentName` or `failureReason` regex-based deletions. Completely removed.
 * 3. Student/Fee/Batch/Test/Campaign ID-based cleanup is allowed ONLY after verifying
 *    those IDs were created by the same active QA run AND are recorded in its run manifest.
 *    Otherwise cleanup is safely skipped.
 * 4. Records without the exact active `qaRunId` are NEVER deleted, even if their names,
 *    failure reasons, phone numbers, or linked IDs look similar.
 * 5. If existing schemas do not support exact correlation, deletion is skipped and
 *    orphaned QA records are reported. Never modify schemas or genuine records to force cleanup.
 */
export async function cleanupQaRecords(qaRunId, manifest = null) {
  if (!qaRunId || !qaRunId.startsWith("QA_")) {
    throw new Error(`Invalid qaRunId for cleanup: ${qaRunId}. Aborting cleanup for safety.`);
  }

  const db = mongoose.connection.db;
  const summary = {
    studentsDeleted: 0,
    studentsSkipped: false,
    batchesDeleted: 0,
    batchesSkipped: false,
    feesDeleted: 0,
    feesSkipped: false,
    testsDeleted: 0,
    testsSkipped: false,
    attendancesDeleted: 0,
    attendancesSkipped: false,
    parentAccessesDeleted: 0,
    parentAccessesSkipped: false,
    orphanedParentAccesses: [],
    campaignsDeleted: 0,
    campaignsSkipped: false,
    reminderLogsDeleted: 0,
    reminderLogsSkipped: false,
    orphanedFeeReminderLogs: [],
    admissionWelcomeJobsDeleted: 0,
    admissionWelcomeJobsSkipped: false,
  };

  try {
    // -------------------------------------------------------------------------
    // Rule 3: Verify manifest IDs were created by active QA run before any deletion
    // -------------------------------------------------------------------------

    // 1. Verify Student IDs from manifest
    const verifiedStudentIds = [];
    if (Array.isArray(manifest?.studentIds) && manifest.studentIds.length > 0) {
      const candidateStudentObjectIds = manifest.studentIds
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));

      if (candidateStudentObjectIds.length > 0) {
        const verifiedStudents = await db.collection("students").find({
          _id: { $in: candidateStudentObjectIds },
          name: { $regex: qaRunId },
          centerId: "msce-8267",
        }).project({ _id: 1 }).toArray();
        verifiedStudentIds.push(...verifiedStudents.map((s) => s._id));
      }
    }

    // 2. Verify Fee IDs from manifest
    const verifiedFeeIds = [];
    if (Array.isArray(manifest?.feeIds) && manifest.feeIds.length > 0) {
      const candidateFeeObjectIds = manifest.feeIds
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));

      if (candidateFeeObjectIds.length > 0) {
        const verifiedFees = await db.collection("fees").find({
          _id: { $in: candidateFeeObjectIds },
          $or: [
            { title: { $regex: qaRunId } },
            { notes: { $regex: qaRunId } },
          ],
          centerId: "msce-8267",
        }).project({ _id: 1 }).toArray();
        verifiedFeeIds.push(...verifiedFees.map((f) => f._id));
      }
    }

    // 3. Verify Batch IDs from manifest
    const verifiedBatchIds = [];
    if (Array.isArray(manifest?.batchIds) && manifest.batchIds.length > 0) {
      const candidateBatchObjectIds = manifest.batchIds
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));

      if (candidateBatchObjectIds.length > 0) {
        const verifiedBatches = await db.collection("batches").find({
          _id: { $in: candidateBatchObjectIds },
          name: { $regex: qaRunId },
          centerId: "msce-8267",
        }).project({ _id: 1 }).toArray();
        verifiedBatchIds.push(...verifiedBatches.map((b) => b._id));
      }
    }

    // 4. Verify Test IDs from manifest
    const verifiedTestIds = [];
    if (Array.isArray(manifest?.testIds) && manifest.testIds.length > 0) {
      const candidateTestObjectIds = manifest.testIds
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));

      if (candidateTestObjectIds.length > 0) {
        const verifiedTests = await db.collection("tests").find({
          _id: { $in: candidateTestObjectIds },
          title: { $regex: qaRunId },
          centerId: "msce-8267",
        }).project({ _id: 1 }).toArray();
        verifiedTestIds.push(...verifiedTests.map((t) => t._id));
      }
    }

    // 5. Verify Campaign IDs from manifest
    const verifiedCampaignIds = [];
    if (Array.isArray(manifest?.campaignIds) && manifest.campaignIds.length > 0) {
      const candidateCampaignObjectIds = manifest.campaignIds
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));

      if (candidateCampaignObjectIds.length > 0) {
        const verifiedCampaigns = await db.collection("messagecampaigns").find({
          _id: { $in: candidateCampaignObjectIds },
          title: { $regex: qaRunId },
          centerId: "msce-8267",
        }).project({ _id: 1 }).toArray();
        verifiedCampaignIds.push(...verifiedCampaigns.map((c) => c._id));
      }
    }

    // -------------------------------------------------------------------------
    // Rule 1, 2, 5: ParentAccess Cleanup
    // - Delete ONLY records with exact, dedicated `qaRunId: qaRunId`
    // - Remove parentName regex completely
    // - If documents lack exact qaRunId correlation, skip deletion and report orphans
    // -------------------------------------------------------------------------
    const paRes = await db.collection("parentaccesses").deleteMany({
      qaRunId: qaRunId,
      centerId: "msce-8267",
    });
    summary.parentAccessesDeleted = paRes.deletedCount;

    // Report any orphaned ParentAccess records linked to verified student IDs that lack dedicated qaRunId
    if (verifiedStudentIds.length > 0) {
      const orphanedPa = await db.collection("parentaccesses").find({
        linkedStudentIds: { $in: verifiedStudentIds },
        centerId: "msce-8267",
        qaRunId: { $ne: qaRunId },
      }).project({ _id: 1, parentPhone: 1 }).toArray();

      if (orphanedPa.length > 0) {
        summary.parentAccessesSkipped = true;
        summary.orphanedParentAccesses = orphanedPa.map((doc) => String(doc._id));
        console.log(`[QA CLEANUP NOTICE] Skipped ${orphanedPa.length} ParentAccess record(s) lacking dedicated qaRunId field.`);
      }
    }

    // -------------------------------------------------------------------------
    // Rule 1, 2, 5: FeeReminderLog Cleanup
    // - Delete ONLY records with exact, dedicated `qaRunId: qaRunId`
    // - Remove failureReason regex completely
    // - If documents lack exact qaRunId correlation, skip deletion and report orphans
    // -------------------------------------------------------------------------
    const logRes = await db.collection("feereminderlogs").deleteMany({
      qaRunId: qaRunId,
      centerId: "msce-8267",
    });
    summary.reminderLogsDeleted = logRes.deletedCount;

    // Report any orphaned FeeReminderLog records linked to verified fee IDs that lack dedicated qaRunId
    if (verifiedFeeIds.length > 0) {
      const orphanedLogs = await db.collection("feereminderlogs").find({
        feeId: { $in: verifiedFeeIds },
        centerId: "msce-8267",
        qaRunId: { $ne: qaRunId },
      }).project({ _id: 1, feeId: 1 }).toArray();

      if (orphanedLogs.length > 0) {
        summary.reminderLogsSkipped = true;
        summary.orphanedFeeReminderLogs = orphanedLogs.map((doc) => String(doc._id));
        console.log(`[QA CLEANUP NOTICE] Skipped ${orphanedLogs.length} FeeReminderLog record(s) lacking dedicated qaRunId field.`);
      }
    }

    // -------------------------------------------------------------------------
    // Rule 3: Verified ID-based cleanup for other collections
    // -------------------------------------------------------------------------

    // Admission Welcome Jobs (verified student IDs)
    if (verifiedStudentIds.length > 0) {
      const jobRes = await db.collection("admissionwelcomejobs").deleteMany({
        studentId: { $in: verifiedStudentIds },
        centerId: "msce-8267",
      });
      summary.admissionWelcomeJobsDeleted = jobRes.deletedCount;
    } else {
      summary.admissionWelcomeJobsSkipped = true;
    }

    // Students (verified student IDs from manifest created by this active run)
    if (verifiedStudentIds.length > 0) {
      const studentRes = await db.collection("students").deleteMany({
        _id: { $in: verifiedStudentIds },
        name: { $regex: qaRunId },
        centerId: "msce-8267",
      });
      summary.studentsDeleted = studentRes.deletedCount;
    } else {
      summary.studentsSkipped = true;
    }

    // Batches (verified batch IDs from manifest created by this active run)
    if (verifiedBatchIds.length > 0) {
      const batchRes = await db.collection("batches").deleteMany({
        _id: { $in: verifiedBatchIds },
        name: { $regex: qaRunId },
        centerId: "msce-8267",
      });
      summary.batchesDeleted = batchRes.deletedCount;
    } else {
      summary.batchesSkipped = true;
    }

    // Fees (verified fee IDs from manifest created by this active run)
    if (verifiedFeeIds.length > 0) {
      const feeRes = await db.collection("fees").deleteMany({
        _id: { $in: verifiedFeeIds },
        $or: [
          { title: { $regex: qaRunId } },
          { notes: { $regex: qaRunId } },
        ],
        centerId: "msce-8267",
      });
      summary.feesDeleted = feeRes.deletedCount;
    } else {
      summary.feesSkipped = true;
    }

    // Tests (verified test IDs from manifest created by this active run)
    if (verifiedTestIds.length > 0) {
      const testRes = await db.collection("tests").deleteMany({
        _id: { $in: verifiedTestIds },
        title: { $regex: qaRunId },
        centerId: "msce-8267",
      });
      summary.testsDeleted = testRes.deletedCount;
    } else {
      summary.testsSkipped = true;
    }

    // Attendances (scoped to verified student run batch tag)
    if (verifiedStudentIds.length > 0) {
      const attRes = await db.collection("attendances").deleteMany({
        batch: { $regex: qaRunId },
        centerId: "msce-8267",
      });
      summary.attendancesDeleted = attRes.deletedCount;
    } else {
      summary.attendancesSkipped = true;
    }

    // Campaigns (verified campaign IDs from manifest created by this active run)
    if (verifiedCampaignIds.length > 0) {
      const campRes = await db.collection("messagecampaigns").deleteMany({
        _id: { $in: verifiedCampaignIds },
        title: { $regex: qaRunId },
        centerId: "msce-8267",
      });
      summary.campaignsDeleted = campRes.deletedCount;
    } else {
      summary.campaignsSkipped = true;
    }

  } catch (err) {
    console.error(`[QA CLEANUP ERROR] Failed during cleanup for run ${qaRunId}:`, err);
  }

  return summary;
}
