process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.TOKEN_ENCRYPTION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

// Import models & services
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const ParentAccessModel = (await import("../tution-desk-be/src/models/ParentAccess.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const {
  getOrCreateParentAccess,
  getPhoneVariants,
  sanitizePhoneNumber,
} = await import("../tution-desk-be/src/lib/parentAccessService.ts");

// Import fee-summary route
const { GET: getFeeSummaryRoute } = await import(
  "../tution-desk-be/src/app/api/students/[id]/fee-summary/route.ts"
);

function createMockRequest({
  method = "GET",
  token,
  url = "http://localhost:3000/api/students/507f191e810c19729de86011/fee-summary",
}) {
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  const parsedUrl = new URL(url);

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: parsedUrl,
    json: async () => ({}),
  };
}

test("Sibling Auto-Link & Calendar Dues Sync Test Suite", async (t) => {
  const centerA = "center_a";
  const centerB = "center_b";

  const student1Id = new mongoose.Types.ObjectId("507f191e810c19729de86011"); // Sumedha
  const student2Id = new mongoose.Types.ObjectId("507f191e810c19729de86012"); // Drishti (Sibling in center A)
  const student3Id = new mongoose.Types.ObjectId("507f191e810c19729de86013"); // Student in center B with same phone

  const parentPhoneRaw = "9876543210";
  const parentPhoneE164 = "919876543210";

  // Standalone unit test mock mode: disable Atlas replica set network wait
  mongoose.startSession = null;

  // 1. Phone Normalization Variants Helper
  await t.test("1. getPhoneVariants extracts normalized 10-digit and international forms", () => {
    const variants = getPhoneVariants("+91-98765-43210");
    assert.ok(variants.includes("9876543210"));
    assert.ok(variants.includes("919876543210"));
    assert.ok(variants.includes("+919876543210"));
  });

  // 2. Single Student Auto-Linking by Parent Phone without rotating token
  await t.test(
    "2. Creating a 2nd student with same normalized parentPhone auto-links to existing ParentAccess without changing token",
    async () => {
      const existingPortalId = new mongoose.Types.ObjectId("507f191e810c19729de86099");
      const existingTokenHash = "pre_existing_token_hash_abc123";
      const existingTokenPrefix = "pt_12345";

      let updatedQuery = null;
      let updatedPayload = null;

      const mockStudent1 = {
        _id: student1Id,
        centerId: centerA,
        name: "Sumedha",
        parentWhatsApp: parentPhoneRaw,
      };

      const mockStudent2 = {
        _id: student2Id,
        centerId: centerA,
        name: "Drishti",
        parentWhatsApp: parentPhoneE164,
      };

      const existingParentAccess = {
        _id: existingPortalId,
        centerId: centerA,
        parentPhone: parentPhoneRaw,
        linkedStudentIds: [student1Id],
        tokenHash: existingTokenHash,
        tokenPrefix: existingTokenPrefix,
        status: "active",
      };

      const originalStudentFindOne = StudentModel.findOne;
      const originalParentAccessFindOne = ParentAccessModel.findOne;
      const originalParentAccessUpdateOne = ParentAccessModel.updateOne;

      StudentModel.findOne = async (q) => {
        if (String(q._id) === String(student2Id) && q.centerId === centerA) {
          return mockStudent2;
        }
        return null;
      };

      ParentAccessModel.findOne = async (q) => {
        // First check: by linkedStudentIds -> Drishti not yet linked
        if (q.linkedStudentIds && String(q.linkedStudentIds) === String(student2Id)) {
          return null;
        }
        // Second check: by parentPhone variants in centerA
        if (q.centerId === centerA && q.parentPhone && q.parentPhone.$in) {
          return existingParentAccess;
        }
        return null;
      };

      ParentAccessModel.updateOne = async (query, update) => {
        updatedQuery = query;
        updatedPayload = update;
        return { acknowledged: true, modifiedCount: 1 };
      };

      try {
        const result = await getOrCreateParentAccess(centerA, student2Id, {
          parentPhone: parentPhoneE164,
          parentName: "Parent Sharma",
        });

        assert.equal(result.created, false, "Should not create a duplicate portal");
        assert.equal(result.rawToken, null, "Should not return a new raw token for existing portal");
        assert.equal(result.parentAccess._id, existingPortalId);
        assert.equal(result.parentAccess.tokenHash, existingTokenHash, "Token hash must remain unchanged");
        assert.equal(result.parentAccess.tokenPrefix, existingTokenPrefix, "Token prefix must remain unchanged");

        // Verify Drishti was appended to linkedStudentIds via $addToSet
        assert.equal(String(updatedQuery._id), String(existingPortalId));
        assert.equal(String(updatedPayload.$addToSet.linkedStudentIds), String(student2Id));
      } finally {
        StudentModel.findOne = originalStudentFindOne;
        ParentAccessModel.findOne = originalParentAccessFindOne;
        ParentAccessModel.updateOne = originalParentAccessUpdateOne;
      }
    }
  );

  // 3. Cross-center students with same phone are NEVER linked
  await t.test(
    "3. Cross-center student with same phone number is NEVER linked to another center's portal",
    async () => {
      const portalCenterA = {
        _id: new mongoose.Types.ObjectId("507f191e810c19729de86099"),
        centerId: centerA,
        parentPhone: parentPhoneRaw,
        linkedStudentIds: [student1Id],
        status: "active",
      };

      const mockStudent3 = {
        _id: student3Id,
        centerId: centerB,
        name: "Foreign Student",
        parentWhatsApp: parentPhoneRaw,
      };

      let createdForCenterB = null;

      const originalStudentFindOne = StudentModel.findOne;
      const originalStudentFind = StudentModel.find;
      const originalParentAccessFindOne = ParentAccessModel.findOne;
      const originalParentAccessCreate = ParentAccessModel.create;

      StudentModel.findOne = async (q) => {
        if (String(q._id) === String(student3Id) && q.centerId === centerB) {
          return mockStudent3;
        }
        return null;
      };

      StudentModel.find = () => ({
        select: async () => [{ _id: student3Id }],
      });

      ParentAccessModel.findOne = async (q) => {
        // Portal only exists in center A; querying in center B must return null
        if (q.centerId === centerA) return portalCenterA;
        return null;
      };

      ParentAccessModel.create = async (doc) => {
        createdForCenterB = doc;
        return {
          ...doc,
          _id: new mongoose.Types.ObjectId("507f191e810c19729de86077"),
        };
      };

      const mockParentAccessLock = {
        hasUniqueLockIndex: async () => true,
        create: async () => ({}),
        findOneAndUpdate: async () => ({}),
        findOne: async () => null,
        updateOne: async () => ({ acknowledged: true }),
        deleteOne: async () => ({ acknowledged: true }),
      };

      try {
        const result = await getOrCreateParentAccess(centerB, student3Id, {
          parentPhone: parentPhoneRaw,
          parentName: "Foreign Student",
          models: {
            ParentAccessLock: mockParentAccessLock,
          },
        });

        assert.equal(result.created, true, "Must create fresh portal for center B");
        assert.ok(result.rawToken, "Must return initial raw token for center B");
        assert.equal(createdForCenterB.centerId, centerB, "Must be strictly scoped to center B");
        assert.deepEqual(
          createdForCenterB.linkedStudentIds.map(String),
          [String(student3Id)],
          "Must only link student 3, never center A students"
        );
      } finally {
        StudentModel.findOne = originalStudentFindOne;
        StudentModel.find = originalStudentFind;
        ParentAccessModel.findOne = originalParentAccessFindOne;
        ParentAccessModel.create = originalParentAccessCreate;
      }
    }
  );

  // 4. fee-summary totalDue sync with calendar month dues
  await t.test(
    "4. GET /api/students/[id]/fee-summary strictly synchronizes totalDue with calendar month due amounts",
    async () => {
      const ownerToken = await signToken({
        userId: "owner_1",
        centerId: centerA,
        role: "owner",
        name: "Owner Sharma",
      });

      const mockStudent = {
        _id: student1Id,
        centerId: centerA,
        name: "Sumedha",
        monthlyFee: 250,
        billingCycleDate: 5,
        joiningDate: new Date("2026-08-01"),
        createdAt: new Date("2026-08-01"),
        advanceBalance: 0,
      };

      // Mock database has NO fee records yet (cron hasn't run), so allFees is empty
      const originalStudentFindOne = StudentModel.findOne;
      const originalFeeFind = FeeModel.find;

      StudentModel.findOne = async () => mockStudent;
      FeeModel.find = async () => []; // 0 stored fees

      try {
        const req = createMockRequest({
          token: ownerToken,
          url: `http://localhost:3000/api/students/${student1Id}/fee-summary?year=2026`,
        });

        const res = await getFeeSummaryRoute(req, {
          params: Promise.resolve({ id: String(student1Id) }),
        });
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.equal(body.success, true);

        const summary = body.data.summary;
        const months = body.data.months;

        // In 2026, months after Aug (e.g. Aug, Sep, Oct, Nov) are post-admission and due
        const dueMonths = months.filter((m) => m.status === "due" || m.status === "partial");
        const expectedDues = dueMonths.reduce((sum, m) => sum + m.amountDue, 0);

        assert.ok(dueMonths.length > 0, "There should be due months calculated for enrolled student");
        assert.equal(
          summary.totalDue,
          expectedDues,
          "summary.totalDue must strictly equal the sum of dues across calendar months"
        );
        assert.ok(
          summary.totalDue > 0,
          "summary.totalDue must NOT be 0 when calendar month cells indicate dues"
        );
      } finally {
        StudentModel.findOne = originalStudentFindOne;
        FeeModel.find = originalFeeFind;
      }
    }
  );
});
