process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

// Import models & auth
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const AdmissionWelcomeJobModel = (await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts")).default;
const FeeReminderLogModel = (await import("../tution-desk-be/src/models/FeeReminderLog.ts")).default;
const FeeCreationLockModel = (await import("../tution-desk-be/src/models/FeeCreationLock.ts")).default;
const ParentAccessLockModel = (await import("../tution-desk-be/src/models/ParentAccessLock.ts")).default;
const ParentAccessModel = (await import("../tution-desk-be/src/models/ParentAccess.ts")).default;
const MessageCampaignModel = (await import("../tution-desk-be/src/models/MessageCampaign.ts")).default;
const PaymentProofModel = (await import("../tution-desk-be/src/models/PaymentProof.ts")).default;
const StudentBatchRequestModel = (await import("../tution-desk-be/src/models/StudentBatchRequest.ts")).default;

// Import route handlers
const { GET: getStudentRoute, DELETE: deleteStudentRoute } = await import(
  "../tution-desk-be/src/app/api/students/[id]/route.ts"
);

function createMockRequest({
  method = "GET",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/students/507f191e810c19729de86011",
}) {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body || {});
  const reqHeaders = new Headers(headers);
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  if (!reqHeaders.has("content-type")) {
    reqHeaders.set("content-type", "application/json");
  }
  reqHeaders.set("content-length", String(Buffer.byteLength(bodyString)));

  const parsedUrl = new URL(url);

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: parsedUrl,
    json: async () => (body ? (typeof body === "string" ? JSON.parse(body) : body) : {}),
    text: async () => bodyString,
    arrayBuffer: async () => Buffer.from(bodyString),
  };
}

test("Student Deletion & Fee Settlement Suite", async (t) => {
  const centerId = "center_msec";
  const foreignCenterId = "center_foreign";

  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";
  const studentId = "507f191e810c19729de86011";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Owner Sharma",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    centerId,
    role: "teacher",
    teacherId,
    name: "Teacher Verma",
  });

  const sampleStudent = {
    _id: new mongoose.Types.ObjectId(studentId),
    centerId,
    name: "Rahul Kumar",
    batch: "10th Grade Math",
    phone: "9876543210",
    isActive: true,
    toObject() {
      return { ...this };
    },
  };

  const originalStartSession = mongoose.startSession;
  mongoose.startSession = null; // Mock standalone mode for fast deterministic unit tests

  // 1. Unauthenticated DELETE returns 401
  await t.test("1. Unauthenticated DELETE returns HTTP 401", async () => {
    const req = createMockRequest({
      method: "DELETE",
      url: `http://localhost:3000/api/students/${studentId}`,
    });

    const res = await deleteStudentRoute(req, {
      params: Promise.resolve({ id: studentId }),
    });
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  // 2. Teacher role DELETE returns 403
  await t.test("2. Teacher role cannot delete student (HTTP 403 Forbidden)", async () => {
    const req = createMockRequest({
      method: "DELETE",
      token: teacherToken,
      url: `http://localhost:3000/api/students/${studentId}`,
    });

    const res = await deleteStudentRoute(req, {
      params: Promise.resolve({ id: studentId }),
    });
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.success, false);
    assert.match(body.error, /Only Owners can delete students/i);
  });

  // 3. Pre-delete check via GET ?checkDues=true
  await t.test("3. Pre-delete check via GET ?checkDues=true calculates unpaid dues", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFeeFind = FeeModel.find;

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => [
      {
        _id: new mongoose.Types.ObjectId(),
        amountDue: 600,
        status: "Pending",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        amountDue: 400,
        status: "Partial Paid",
      },
    ];

    try {
      const req = createMockRequest({
        method: "GET",
        token: ownerToken,
        url: `http://localhost:3000/api/students/${studentId}?checkDues=true`,
      });

      const res = await getStudentRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.unpaidAmount, 1000);
      assert.equal(body.data.pendingFeesCount, 2);
    } finally {
      StudentModel.findOne = originalFindOne;
      FeeModel.find = originalFeeFind;
    }
  });

  // 4. Case 1: Student with ₹0 unpaid dues deletes cleanly and cleans up locks/jobs
  await t.test("4. Case 1: Student with ₹0 unpaid dues deletes cleanly", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFindOneAndDelete = StudentModel.findOneAndDelete;
    const originalFeeFind = FeeModel.find;
    const originalJobDelete = AdmissionWelcomeJobModel.deleteMany;
    const originalLockDelete = FeeCreationLockModel.deleteMany;
    const originalReminderDelete = FeeReminderLogModel.deleteMany;
    const originalParentLockDelete = ParentAccessLockModel.deleteMany;
    const originalParentUpdate = ParentAccessModel.updateMany;
    const originalParentDelete = ParentAccessModel.deleteMany;
    const originalCampaignUpdate = MessageCampaignModel.updateMany;
    const originalProofDelete = PaymentProofModel.deleteMany;
    const originalBatchReqDelete = StudentBatchRequestModel.deleteMany;

    let deletedStudentId = null;
    let jobCleaned = false;
    let locksCleaned = false;

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => []; // ₹0 pending fees
    StudentModel.findOneAndDelete = async (q) => {
      deletedStudentId = q._id.toString();
      return sampleStudent;
    };
    AdmissionWelcomeJobModel.deleteMany = async () => {
      jobCleaned = true;
      return { deletedCount: 1 };
    };
    FeeCreationLockModel.deleteMany = async () => {
      locksCleaned = true;
      return { deletedCount: 1 };
    };
    FeeReminderLogModel.deleteMany = async () => ({ deletedCount: 1 });
    ParentAccessLockModel.deleteMany = async () => ({ deletedCount: 1 });
    ParentAccessModel.updateMany = async () => ({ modifiedCount: 1 });
    ParentAccessModel.deleteMany = async () => ({ deletedCount: 0 });
    MessageCampaignModel.updateMany = async () => ({ modifiedCount: 0 });
    PaymentProofModel.deleteMany = async () => ({ deletedCount: 0 });
    StudentBatchRequestModel.deleteMany = async () => ({ deletedCount: 0 });

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        url: `http://localhost:3000/api/students/${studentId}`,
      });

      const res = await deleteStudentRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.action, "deleted");
      assert.equal(deletedStudentId, studentId);
      assert.equal(jobCleaned, true);
      assert.equal(locksCleaned, true);
    } finally {
      StudentModel.findOne = originalFindOne;
      StudentModel.findOneAndDelete = originalFindOneAndDelete;
      FeeModel.find = originalFeeFind;
      AdmissionWelcomeJobModel.deleteMany = originalJobDelete;
      FeeCreationLockModel.deleteMany = originalLockDelete;
      FeeReminderLogModel.deleteMany = originalReminderDelete;
      ParentAccessLockModel.deleteMany = originalParentLockDelete;
      ParentAccessModel.updateMany = originalParentUpdate;
      ParentAccessModel.deleteMany = originalParentDelete;
      MessageCampaignModel.updateMany = originalCampaignUpdate;
      PaymentProofModel.deleteMany = originalProofDelete;
      StudentBatchRequestModel.deleteMany = originalBatchReqDelete;
    }
  });

  // 5. Case 2: Unpaid dues (> 0) without settlementAction returns 409 Conflict
  await t.test("5. Case 2: Unpaid dues (> 0) without settlement action returns HTTP 409 Conflict", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFeeFind = FeeModel.find;

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => [
      {
        _id: new mongoose.Types.ObjectId(),
        amountDue: 1200,
        status: "Pending",
      },
    ];

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        url: `http://localhost:3000/api/students/${studentId}`,
      });

      const res = await deleteStudentRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 409);
      assert.equal(body.success, false);
      assert.equal(body.code, "UNRESOLVED_FEES_EXIST");
      assert.equal(body.unpaidAmount, 1200);
      assert.equal(body.pendingFeesCount, 1);
    } finally {
      StudentModel.findOne = originalFindOne;
      FeeModel.find = originalFeeFind;
    }
  });

  // 6. Case 3: settlementAction: "mark_paid" records fee as Paid under Owner custody & deletes student
  await t.test("6. Case 3: settlementAction 'mark_paid' records payment under Owner custody & deletes student", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFindOneAndDelete = StudentModel.findOneAndDelete;
    const originalFeeFind = FeeModel.find;
    const originalJobDelete = AdmissionWelcomeJobModel.deleteMany;
    const originalLockDelete = FeeCreationLockModel.deleteMany;
    const originalReminderDelete = FeeReminderLogModel.deleteMany;
    const originalParentLockDelete = ParentAccessLockModel.deleteMany;
    const originalParentUpdate = ParentAccessModel.updateMany;
    const originalParentDelete = ParentAccessModel.deleteMany;
    const originalCampaignUpdate = MessageCampaignModel.updateMany;
    const originalProofDelete = PaymentProofModel.deleteMany;
    const originalBatchReqDelete = StudentBatchRequestModel.deleteMany;

    let feeSaved = false;
    let savedFeeDoc = null;
    let deletedStudent = false;

    const mockPendingFee = {
      _id: new mongoose.Types.ObjectId(),
      centerId,
      studentId: new mongoose.Types.ObjectId(studentId),
      amountDue: 1500,
      paidAmount: 0,
      status: "Pending",
      paymentHistory: [],
      async save() {
        feeSaved = true;
        savedFeeDoc = this;
        return this;
      },
    };

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => [mockPendingFee];
    StudentModel.findOneAndDelete = async () => {
      deletedStudent = true;
      return sampleStudent;
    };
    AdmissionWelcomeJobModel.deleteMany = async () => ({ deletedCount: 1 });
    FeeCreationLockModel.deleteMany = async () => ({ deletedCount: 1 });
    FeeReminderLogModel.deleteMany = async () => ({ deletedCount: 1 });
    ParentAccessLockModel.deleteMany = async () => ({ deletedCount: 1 });
    ParentAccessModel.updateMany = async () => ({ modifiedCount: 1 });
    ParentAccessModel.deleteMany = async () => ({ deletedCount: 0 });
    MessageCampaignModel.updateMany = async () => ({ modifiedCount: 0 });
    PaymentProofModel.deleteMany = async () => ({ deletedCount: 0 });
    StudentBatchRequestModel.deleteMany = async () => ({ deletedCount: 0 });

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        body: {
          settlementAction: "mark_paid",
          amountReceived: 1500,
          paymentMode: "UPI",
        },
        url: `http://localhost:3000/api/students/${studentId}`,
      });

      const res = await deleteStudentRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.action, "mark_paid");
      assert.equal(deletedStudent, true);
      assert.equal(feeSaved, true);

      // Verify Fee was settled as Paid with Owner custody
      assert.equal(savedFeeDoc.status, "Paid");
      assert.equal(savedFeeDoc.amountDue, 0);
      assert.equal(savedFeeDoc.paidAmount, 1500);
      assert.equal(savedFeeDoc.paymentMode, "UPI");
      assert.equal(savedFeeDoc.paymentHistory.length, 1);
      assert.equal(savedFeeDoc.paymentHistory[0].custodyStatus, "owner_custody");
      assert.equal(savedFeeDoc.paymentHistory[0].amount, 1500);
      assert.equal(savedFeeDoc.paymentHistory[0].paymentMode, "UPI");
      assert.equal(savedFeeDoc.receivedByRole, "owner");
    } finally {
      StudentModel.findOne = originalFindOne;
      StudentModel.findOneAndDelete = originalFindOneAndDelete;
      FeeModel.find = originalFeeFind;
      AdmissionWelcomeJobModel.deleteMany = originalJobDelete;
      FeeCreationLockModel.deleteMany = originalLockDelete;
      FeeReminderLogModel.deleteMany = originalReminderDelete;
      ParentAccessLockModel.deleteMany = originalParentLockDelete;
      ParentAccessModel.updateMany = originalParentUpdate;
      ParentAccessModel.deleteMany = originalParentDelete;
      MessageCampaignModel.updateMany = originalCampaignUpdate;
      PaymentProofModel.deleteMany = originalProofDelete;
      StudentBatchRequestModel.deleteMany = originalBatchReqDelete;
    }
  });

  // 7. Case 4: settlementAction: "waive_and_delete" clears pending fee records & deletes student
  await t.test("7. Case 4: settlementAction 'waive_and_delete' clears pending fee records & deletes student", async () => {
    const originalFindOne = StudentModel.findOne;
    const originalFindOneAndDelete = StudentModel.findOneAndDelete;
    const originalFeeFind = FeeModel.find;
    const originalFeeDeleteMany = FeeModel.deleteMany;
    const originalJobDelete = AdmissionWelcomeJobModel.deleteMany;
    const originalLockDelete = FeeCreationLockModel.deleteMany;
    const originalReminderDelete = FeeReminderLogModel.deleteMany;
    const originalParentLockDelete = ParentAccessLockModel.deleteMany;
    const originalParentUpdate = ParentAccessModel.updateMany;
    const originalParentDelete = ParentAccessModel.deleteMany;
    const originalCampaignUpdate = MessageCampaignModel.updateMany;
    const originalProofDelete = PaymentProofModel.deleteMany;
    const originalBatchReqDelete = StudentBatchRequestModel.deleteMany;

    let pendingFeesDeleted = false;
    let deletedStudent = false;

    StudentModel.findOne = async () => sampleStudent;
    FeeModel.find = async () => [
      {
        _id: new mongoose.Types.ObjectId(),
        amountDue: 800,
        status: "Pending",
      },
    ];
    FeeModel.deleteMany = async (q) => {
      if (q.status && q.status.$in) {
        pendingFeesDeleted = true;
      }
      return { deletedCount: 1 };
    };
    StudentModel.findOneAndDelete = async () => {
      deletedStudent = true;
      return sampleStudent;
    };
    AdmissionWelcomeJobModel.deleteMany = async () => ({ deletedCount: 1 });
    FeeCreationLockModel.deleteMany = async () => ({ deletedCount: 1 });
    FeeReminderLogModel.deleteMany = async () => ({ deletedCount: 1 });
    ParentAccessLockModel.deleteMany = async () => ({ deletedCount: 1 });
    ParentAccessModel.updateMany = async () => ({ modifiedCount: 1 });
    ParentAccessModel.deleteMany = async () => ({ deletedCount: 0 });
    MessageCampaignModel.updateMany = async () => ({ modifiedCount: 0 });
    PaymentProofModel.deleteMany = async () => ({ deletedCount: 0 });
    StudentBatchRequestModel.deleteMany = async () => ({ deletedCount: 0 });

    try {
      const req = createMockRequest({
        method: "DELETE",
        token: ownerToken,
        body: {
          settlementAction: "waive_and_delete",
        },
        url: `http://localhost:3000/api/students/${studentId}`,
      });

      const res = await deleteStudentRoute(req, {
        params: Promise.resolve({ id: studentId }),
      });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.action, "waive_and_delete");
      assert.equal(deletedStudent, true);
      assert.equal(pendingFeesDeleted, true);
    } finally {
      StudentModel.findOne = originalFindOne;
      StudentModel.findOneAndDelete = originalFindOneAndDelete;
      FeeModel.find = originalFeeFind;
      FeeModel.deleteMany = originalFeeDeleteMany;
      AdmissionWelcomeJobModel.deleteMany = originalJobDelete;
      FeeCreationLockModel.deleteMany = originalLockDelete;
      FeeReminderLogModel.deleteMany = originalReminderDelete;
      ParentAccessLockModel.deleteMany = originalParentLockDelete;
      ParentAccessModel.updateMany = originalParentUpdate;
      ParentAccessModel.deleteMany = originalParentDelete;
      MessageCampaignModel.updateMany = originalCampaignUpdate;
      PaymentProofModel.deleteMany = originalProofDelete;
      StudentBatchRequestModel.deleteMany = originalBatchReqDelete;
    }
  });

  // 8. Frontend Modal & Admissions Page Integration verification
  await t.test("8. Frontend StudentDeleteModal renders UI contract and is wired to Admissions page", () => {
    const modalPath = path.resolve(__dirname, "../src/components/modals/StudentDeleteModal.tsx");
    const admissionsPath = path.resolve(__dirname, "../src/app/admissions/page.tsx");

    assert.ok(fs.existsSync(modalPath), "StudentDeleteModal.tsx must exist");
    const modalCode = fs.readFileSync(modalPath, "utf-8");

    assert.ok(modalCode.includes("No pending dues. Delete student?"), "Modal must display zero dues confirmation");
    assert.ok(modalCode.includes("Unpaid Dues Detected"), "Modal must highlight unpaid dues banner");
    assert.ok(modalCode.includes("Amount Received (₹)"), "Modal must include amount received input");
    assert.ok(modalCode.includes("Payment Mode"), "Modal must include payment mode selector");
    assert.ok(modalCode.includes("Mark Payment Received &amp; Delete") || modalCode.includes("Mark Payment Received & Delete"), "Modal must have primary settlement button");
    assert.ok(modalCode.includes("Waive Dues &amp; Delete") || modalCode.includes("Waive Dues & Delete"), "Modal must have secondary waive button");

    const admissionsCode = fs.readFileSync(admissionsPath, "utf-8");
    assert.ok(admissionsCode.includes("StudentDeleteModal"), "Admissions page must import and render StudentDeleteModal");
    assert.ok(admissionsCode.includes("studentToDelete"), "Admissions page must track studentToDelete state");
    assert.ok(admissionsCode.includes("invalidateApiCache"), "Admissions page must invalidate cache on student deletion");
  });
});
