import { signToken } from "file:///D:/Client-Projects/MSEC/tution-desk-be/src/lib/auth.ts";
import { QA_CONFIG } from "./config.mjs";

export async function createAuthTokens() {
  const ownerToken = await signToken({
    userId: QA_CONFIG.ownerId,
    centerId: QA_CONFIG.centerId,
    role: "owner",
    name: "MSEC Institute Owner",
  });

  const teacher1Token = await signToken({
    userId: QA_CONFIG.teacher1Id,
    centerId: QA_CONFIG.centerId,
    role: "teacher",
    teacherId: QA_CONFIG.teacher1Id,
    name: "Jitender Kumar",
  });

  const teacher2Token = await signToken({
    userId: QA_CONFIG.teacher2Id,
    centerId: QA_CONFIG.centerId,
    role: "teacher",
    teacherId: QA_CONFIG.teacher2Id,
    name: "TEST_E2E_Teacher_Sharma",
  });

  return {
    ownerToken,
    teacher1Token,
    teacher2Token,
  };
}

export async function createParentPortalToken(parentAccessId, linkedStudentIds, phone, tokenPrefix) {
  return await signToken({
    parentAccessId,
    centerId: QA_CONFIG.centerId,
    role: "parent",
    linkedStudentIds,
    parentPhone: phone,
    tokenPrefix,
  });
}
