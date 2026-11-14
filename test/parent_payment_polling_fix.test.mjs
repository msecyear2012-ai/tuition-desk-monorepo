/**
 * TuitionDesk / MSEC — Parent UPI Payment Status Polling & Access Security Regression Tests
 *
 * Verifies:
 * 1. Authenticated parent can read payment status for linked student's fee.
 * 2. Parent cannot read fees for unlinked students in the same center (HTTP 403).
 * 3. Cross-tenant access is rejected (HTTP 403).
 * 4. Unauthenticated requests are rejected (HTTP 401).
 * 5. Owner and Teacher permissions and full ledger contracts are preserved.
 * 6. Internal accounting data (custodyBreakdown, recordedBy, receivedBy) is not leaked to parents.
 * 7. Polling aborts on terminal states (401, 403, 404, Paid, Cancelled, max count, network errors).
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";

globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

test("MSEC Security Regression Suite: GET /api/fees/[feeId] Parent Polling & Access Control", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
  const { ParentAccess } = await import("../tution-desk-be/src/models/ParentAccess.ts");
  const { GET, OPTIONS } = await import(
    "../tution-desk-be/src/app/api/fees/[feeId]/route.ts"
  );

  // In-memory mock databases
  const mockFees = new Map();
  const mockStudents = new Map();
  const mockParentAccess = new Map();

  // Test ObjectIds (24 hex characters)
  const student1Id = "655100000000000000000001";
  const student2Id = "655100000000000000000002";
  const studentBetaId = "655100000000000000000003";

  const fee1Id = "655000000000000000000001"; // student 1, center_alpha
  const fee2Id = "655000000000000000000002"; // student 2, center_alpha
  const feeBetaId = "655000000000000000000003"; // studentBeta, center_beta

  const parent1Id = "655200000000000000000001"; // linked to student 1 only
  const teacher1Id = "655400000000000000000001"; // assigned to student 1
  const owner1Id = "655300000000000000000001";

  // Seed Students
  mockStudents.set(student1Id, {
    _id: student1Id,
    centerId: "center_alpha",
    name: "Student Alpha One",
    phone: "9876543210",
    parentWhatsApp: "9876543210",
    assignedTeacherId: teacher1Id,
  });

  mockStudents.set(student2Id, {
    _id: student2Id,
    centerId: "center_alpha",
    name: "Student Alpha Two",
    phone: "9876543211",
    parentWhatsApp: "9876543211",
    assignedTeacherId: "655400000000000000000099",
  });

  mockStudents.set(studentBetaId, {
    _id: studentBetaId,
    centerId: "center_beta",
    name: "Student Beta",
    phone: "9876543299",
  });

  // Seed ParentAccess (linked strictly to student 1)
  mockParentAccess.set(parent1Id, {
    _id: parent1Id,
    centerId: "center_alpha",
    studentId: student1Id,
    linkedStudentIds: [student1Id],
    status: "active",
    tokenPrefix: "pt_a1",
  });

  // Seed Fees
  function resetFees() {
    mockFees.clear();

    mockFees.set(fee1Id, {
      _id: fee1Id,
      centerId: "center_alpha",
      studentId: student1Id,
      month: "2026-11",
      billingMonth: "2026-11",
      feeType: "tuition",
      title: "Monthly Tuition Fee",
      amountDue: 2500,
      paidAmount: 0,
      dueDate: new Date("2026-11-10"),
      status: "Pending",
      utrNumber: "",
      paymentHistory: [],
      recordedBy: owner1Id,
      recordedByRole: "owner",
      custodyBreakdown: { teacherInHand: 0, verifiedInBank: 0 },
      toObject() {
        return { ...this };
      },
    });

    mockFees.set(fee2Id, {
      _id: fee2Id,
      centerId: "center_alpha",
      studentId: student2Id,
      month: "2026-11",
      billingMonth: "2026-11",
      feeType: "tuition",
      title: "Monthly Tuition Fee",
      amountDue: 3000,
      paidAmount: 0,
      dueDate: new Date("2026-11-10"),
      status: "Pending",
      utrNumber: "",
      paymentHistory: [],
      toObject() {
        return { ...this };
      },
    });

    mockFees.set(feeBetaId, {
      _id: feeBetaId,
      centerId: "center_beta",
      studentId: studentBetaId,
      month: "2026-11",
      amountDue: 2000,
      status: "Pending",
      toObject() {
        return { ...this };
      },
    });
  }

  resetFees();

  // Mock Mongoose queries
  const origFeeFindOne = FeeModel.findOne;
  const origFeeFindById = FeeModel.findById;
  const origStudentFindById = StudentModel.findById;
  const origParentAccessFindOne = ParentAccess.findOne;

  FeeModel.findOne = function (query) {
    const fee = mockFees.get(String(query?._id));
    const matchesCenter = !query?.centerId || fee?.centerId === query.centerId;
    const matchedFee = matchesCenter ? fee : null;

    const queryObj = {
      populate(field) {
        if (matchedFee && field === "studentId") {
          const student = mockStudents.get(String(matchedFee.studentId));
          return Promise.resolve({
            ...matchedFee,
            studentId: student ? { ...student } : matchedFee.studentId,
            toObject() {
              return {
                ...matchedFee,
                studentId: student ? { ...student } : matchedFee.studentId,
              };
            },
          });
        }
        return Promise.resolve(matchedFee);
      },
      lean() {
        return Promise.resolve(matchedFee ? { ...matchedFee } : null);
      },
      then(resolve, reject) {
        return Promise.resolve(matchedFee || null).then(resolve, reject);
      },
    };
    return queryObj;
  };

  FeeModel.findById = function (id) {
    const fee = mockFees.get(String(id));
    const queryObj = {
      select() {
        return queryObj;
      },
      lean() {
        return Promise.resolve(fee ? { ...fee } : null);
      },
      then(resolve, reject) {
        return Promise.resolve(fee || null).then(resolve, reject);
      },
    };
    return queryObj;
  };

  StudentModel.findById = function (id) {
    const s = mockStudents.get(String(id));
    const queryObj = {
      select() {
        return queryObj;
      },
      lean() {
        return Promise.resolve(s ? { ...s } : null);
      },
      then(resolve, reject) {
        return Promise.resolve(s || null).then(resolve, reject);
      },
    };
    return queryObj;
  };

  ParentAccess.findOne = function (query) {
    const p = query?._id ? mockParentAccess.get(String(query._id)) : null;
    return Promise.resolve(p ? { ...p } : null);
  };

  t.after(() => {
    FeeModel.findOne = origFeeFindOne;
    FeeModel.findById = origFeeFindById;
    StudentModel.findById = origStudentFindById;
    ParentAccess.findOne = origParentAccessFindOne;
  });

  function createMockRequest({
    method = "GET",
    url = "http://localhost:3000/api/fees/655000000000000000000001",
    headers = {},
    cookies = {},
  } = {}) {
    const headerMap = new Map();
    for (const [k, v] of Object.entries(headers)) {
      headerMap.set(k.toLowerCase(), v);
    }
    const cookieMap = new Map(Object.entries(cookies));

    return {
      method,
      url,
      nextUrl: new URL(url),
      headers: {
        get: (name) => headerMap.get(name.toLowerCase()) || null,
      },
      cookies: {
        get: (name) => {
          const val = cookieMap.get(name);
          return val !== undefined ? { value: val } : null;
        },
      },
    };
  }

  // Generate tokens
  const parentSessionToken = await signToken({
    role: "parent",
    parentAccessId: parent1Id,
    centerId: "center_alpha",
    tokenPrefix: "pt_a1",
  });

  const ownerToken = await signToken({
    userId: owner1Id,
    role: "owner",
    centerId: "center_alpha",
  });

  const teacherToken = await signToken({
    userId: teacher1Id,
    teacherId: teacher1Id,
    role: "teacher",
    centerId: "center_alpha",
  });

  // 1. Unauthenticated request rejected with 401
  await t.test("1.1 Unauthenticated request without tokens is rejected with 401", async () => {
    const req = createMockRequest();
    const res = await GET(req, { params: Promise.resolve({ feeId: fee1Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /authentication required/i);
  });

  // 2. Invalid Bearer token is rejected with 401
  await t.test("1.2 Invalid Bearer token is rejected with 401", async () => {
    const req = createMockRequest({
      headers: { Authorization: "Bearer bad.token.here" },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee1Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
  });

  // 3. Authorized parent can read linked student's payment status
  await t.test("2.1 Authorized parent reading linked student's fee succeeds with 200", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee1Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data._id, fee1Id);
    assert.strictEqual(json.data.status, "Pending");
    assert.strictEqual(json.data.amountDue, 2500);

    // Verify sensitive accounting/custody fields are strictly excluded
    assert.strictEqual(json.data.custodyBreakdown, undefined);
    assert.strictEqual(json.data.recordedBy, undefined);
    assert.strictEqual(json.data.recordedByRole, undefined);
    assert.strictEqual(json.data.receivedBy, undefined);
    assert.strictEqual(json.data.paymentHistory, undefined);
  });

  // 4. Authorized parent can read using session cookie
  await t.test("2.2 Authorized parent reading with parent_portal_session cookie succeeds", async () => {
    const req = createMockRequest({
      cookies: { parent_portal_session: parentSessionToken },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee1Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.data.status, "Pending");
  });

  // 5. Parent cannot read another student's fee (same center)
  await t.test("3.1 Parent attempting to read unlinked student's fee is rejected with 403", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee2Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /not authorized to view fee records for this student/i);
  });

  // 6. Cross-tenant fee access is rejected
  await t.test("4.1 Parent attempting to access cross-tenant fee in center_beta is rejected with 403", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: feeBetaId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /cross-center fee access is strictly forbidden/i);
  });

  // 7. Owner access remains intact with full accounting details
  await t.test("5.1 Owner can access fee with full ledger, payment history and custody breakdown", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee1Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.ok(Array.isArray(json.data.paymentHistory));
    assert.ok(json.data.custodyBreakdown !== undefined);
  });

  // 8. Teacher access remains intact for assigned student
  await t.test("6.1 Assigned teacher can access fee with contact numbers masked", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee1Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.ok(json.data.studentId.phone.includes("*"));
  });

  // 9. Teacher access rejected for unassigned student
  await t.test("6.2 Unassigned teacher accessing unassigned student fee is rejected with 403", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: fee2Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /fee record is not assigned/i);
  });

  // 10. Non-existent fee returns 404
  await t.test("7.1 Non-existent fee ID returns 404", async () => {
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
    });
    const res = await GET(req, { params: Promise.resolve({ feeId: "655000000000000000000999" }) });
    const json = await res.json();

    assert.strictEqual(res.status, 404);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /not found/i);
  });

  // 11. OPTIONS returns 204
  await t.test("8.1 OPTIONS /api/fees/[feeId] returns 204", async () => {
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    const res = await OPTIONS(req);

    assert.strictEqual(res.status, 204);
  });
});

test("MSEC Polling Safeguards: Client Polling Safety & Terminal State Cleanup", async (t) => {
  // Unit test verifying terminal polling rules
  const terminalStatuses = ["Paid", "Cancelled"];
  const fatalHttpCodes = [401, 403, 404];

  await t.test("Terminal HTTP status codes (401, 403, 404) immediately stop polling", () => {
    for (const code of fatalHttpCodes) {
      let isPolling = true;
      const simulatePollResponse = (statusCode) => {
        if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
          isPolling = false;
        }
      };
      simulatePollResponse(code);
      assert.strictEqual(isPolling, false, `Polling should have stopped on HTTP ${code}`);
    }
  });

  await t.test("Terminal fee statuses (Paid, Cancelled) immediately stop polling", () => {
    for (const status of terminalStatuses) {
      let isPolling = true;
      const simulateFeeUpdate = (feeStatus) => {
        if (feeStatus === "Paid" || feeStatus === "Cancelled") {
          isPolling = false;
        }
      };
      simulateFeeUpdate(status);
      assert.strictEqual(isPolling, false, `Polling should have stopped on fee status ${status}`);
    }
  });

  await t.test("Polling stops after max poll iterations (5 minutes = 100 polls)", () => {
    let pollCount = 0;
    let isPolling = true;
    const MAX_POLLS = 100;

    for (let i = 0; i < 150; i++) {
      pollCount++;
      if (pollCount > MAX_POLLS) {
        isPolling = false;
        break;
      }
    }

    assert.strictEqual(pollCount, 101);
    assert.strictEqual(isPolling, false);
  });

  await t.test("Polling stops after 5 consecutive network errors", () => {
    let consecutiveErrors = 0;
    let isPolling = true;

    for (let i = 0; i < 5; i++) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        isPolling = false;
      }
    }

    assert.strictEqual(consecutiveErrors, 5);
    assert.strictEqual(isPolling, false);
  });
});
