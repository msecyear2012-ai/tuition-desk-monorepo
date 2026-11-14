import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";

globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

test("MSEC Security Regression Suite: PUT /api/fees/[feeId]/submit-utr Authentication & Tenant Isolation", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
  const { ParentAccess } = await import("../tution-desk-be/src/models/ParentAccess.ts");
  const { PUT, OPTIONS } = await import(
    "../tution-desk-be/src/app/api/fees/[feeId]/submit-utr/route.ts"
  );

  // In-memory mock databases
  const mockFees = new Map();
  const mockStudents = new Map();
  const mockParentAccess = new Map();

  // Seed Students
  const student1 = {
    _id: "student_doc_001",
    centerId: "center_alpha",
    name: "Student Alpha One",
    assignedTeacherId: "teacher_alpha_01",
  };
  const student2 = {
    _id: "student_doc_002",
    centerId: "center_alpha",
    name: "Student Alpha Two",
    assignedTeacherId: "teacher_alpha_02",
  };
  const studentBeta = {
    _id: "student_doc_beta_001",
    centerId: "center_beta",
    name: "Student Beta One",
  };

  mockStudents.set("student_doc_001", student1);
  mockStudents.set("student_doc_002", student2);
  mockStudents.set("student_doc_beta_001", studentBeta);

  // Seed ParentAccess
  // Parent 1 is only linked to student 1
  const parent1 = {
    _id: "parent_access_001",
    centerId: "center_alpha",
    studentId: "student_doc_001",
    linkedStudentIds: ["student_doc_001"],
    status: "active",
    tokenPrefix: "pt_a1",
  };
  mockParentAccess.set("parent_access_001", parent1);

  // Seed Fees
  function resetFees() {
    mockFees.clear();
    mockFees.set("fee_alpha_001", {
      _id: "fee_alpha_001",
      centerId: "center_alpha",
      studentId: "student_doc_001",
      month: "2026-11",
      amountDue: 2500,
      status: "Pending",
      utrNumber: "",
      async save() {
        mockFees.set(this._id, this);
        return this;
      },
    });

    mockFees.set("fee_alpha_002", {
      _id: "fee_alpha_002",
      centerId: "center_alpha",
      studentId: "student_doc_002",
      month: "2026-11",
      amountDue: 3000,
      status: "Pending",
      utrNumber: "",
      async save() {
        mockFees.set(this._id, this);
        return this;
      },
    });

    mockFees.set("fee_beta_001", {
      _id: "fee_beta_001",
      centerId: "center_beta",
      studentId: "student_doc_beta_001",
      month: "2026-11",
      amountDue: 2000,
      status: "Pending",
      utrNumber: "",
      async save() {
        mockFees.set(this._id, this);
        return this;
      },
    });

    mockFees.set("fee_paid_001", {
      _id: "fee_paid_001",
      centerId: "center_alpha",
      studentId: "student_doc_001",
      month: "2026-10",
      amountDue: 2500,
      status: "Paid",
      utrNumber: "ALREADYPAID123",
      async save() {
        mockFees.set(this._id, this);
        return this;
      },
    });
  }

  resetFees();

  // Mock Mongoose queries
  const origFeeFindById = FeeModel.findById;
  FeeModel.findById = function (id) {
    const fee = mockFees.get(String(id));
    const queryObj = {
      populate(field) {
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

  const origStudentFindById = StudentModel.findById;
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

  const origParentAccessFindOne = ParentAccess.findOne;
  ParentAccess.findOne = function (query) {
    const p = query?._id ? mockParentAccess.get(String(query._id)) : null;
    return Promise.resolve(p ? { ...p } : null);
  };

  t.after(() => {
    FeeModel.findById = origFeeFindById;
    StudentModel.findById = origStudentFindById;
    ParentAccess.findOne = origParentAccessFindOne;
  });

  function createMockRequest({
    method = "PUT",
    url = "http://localhost:3000/api/fees/fee_alpha_001/submit-utr",
    headers = {},
    cookies = {},
    body = null,
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
      json: async () => (body ? JSON.parse(JSON.stringify(body)) : {}),
    };
  }

  // 1. Unauthenticated request rejected
  await t.test("1.1 Unauthenticated request without tokens is rejected with 401", async () => {
    resetFees();
    const req = createMockRequest({ body: { utrNumber: "UTR123456789" } });
    const res = await PUT(req, { params: Promise.resolve({ feeId: "655000000000000000000001" }) });
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /authentication required/i);
  });

  // 2. Invalid token rejected
  await t.test("1.2 Invalid Bearer token is rejected with 401", async () => {
    resetFees();
    const req = createMockRequest({
      headers: { Authorization: "Bearer invalid.malformed.token" },
      body: { utrNumber: "UTR123456789" },
    });
    const res = await PUT(req, { params: Promise.resolve({ feeId: "655000000000000000000001" }) });
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /authentication required/i);
  });

  // 3. Cross-tenant fee submission rejected
  await t.test("2.1 Parent from center_alpha submitting for fee in center_beta is rejected with 403", async () => {
    resetFees();
    // Valid parent session for center_alpha
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001",
      tokenPrefix: "pt_a1",
    });

    const feeBetaId = "655000000000000000000099";
    mockFees.set(feeBetaId, {
      _id: feeBetaId,
      centerId: "center_beta",
      studentId: "student_doc_beta_001",
      amountDue: 2000,
      status: "Pending",
      async save() { return this; },
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
      body: { utrNumber: "UTR123456789" },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId: feeBetaId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /cross-tenant fee submission is strictly forbidden/i);
  });

  // 4. Unauthorized student/parent rejected
  await t.test("3.1 Parent in center_alpha attempting to submit UTR for an unlinked student is rejected with 403", async () => {
    resetFees();
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001", // only linked to student_doc_001
      tokenPrefix: "pt_a1",
    });

    const feeStudent2Id = "655000000000000000000002";
    mockFees.set(feeStudent2Id, {
      _id: feeStudent2Id,
      centerId: "center_alpha",
      studentId: "student_doc_002", // student 2, NOT student 1
      amountDue: 3000,
      status: "Pending",
      async save() { return this; },
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
      body: { utrNumber: "UTR123456789" },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId: feeStudent2Id }) });
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /not authorized to submit payments for this student/i);
  });

  // 5. Valid authorized parent submission succeeds
  await t.test("4.1 Authorized parent submitting valid UTR succeeds and transitions fee to Verification Pending", async () => {
    resetFees();
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001",
      tokenPrefix: "pt_a1",
    });

    const feeId = "655000000000000000000001";
    const feeObj = {
      _id: feeId,
      centerId: "center_alpha",
      studentId: "student_doc_001",
      amountDue: 2500,
      status: "Pending",
      utrNumber: "",
      paymentDate: null,
      paidDate: null,
      paymentMode: "",
      async save() {
        mockFees.set(feeId, this);
        return this;
      },
    };
    mockFees.set(feeId, feeObj);

    const req = createMockRequest({
      cookies: { parent_portal_session: parentSessionToken },
      body: { utrNumber: "UPI123456789012" },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.match(json.message, /verification pending/i);

    // Verify stored fee record
    const updated = mockFees.get(feeId);
    assert.strictEqual(updated.status, "Verification Pending");
    assert.strictEqual(updated.utrNumber, "UPI123456789012");
    assert.strictEqual(updated.paymentMode, "Online/UPI");
    assert.ok(updated.paymentDate instanceof Date);
  });

  // 6. Authorized Owner submission succeeds
  await t.test("5.1 Authorized Owner can submit UTR for any student in their center", async () => {
    resetFees();
    const ownerToken = await signToken({
      role: "owner",
      centerId: "center_alpha",
      userId: "owner_001",
    });

    const feeId = "655000000000000000000001";
    mockFees.set(feeId, {
      _id: feeId,
      centerId: "center_alpha",
      studentId: "student_doc_001",
      status: "Pending",
      async save() { return this; },
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { utrNumber: "OWNER_ENTERED_UTR_123" },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
  });

  // 7. Prevent re-submission for Paid fee
  await t.test("6.1 Submitting UTR for an already Paid fee is rejected with 400", async () => {
    resetFees();
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001",
      tokenPrefix: "pt_a1",
    });

    const feeId = "655000000000000000000001";
    mockFees.set(feeId, {
      _id: feeId,
      centerId: "center_alpha",
      studentId: "student_doc_001",
      status: "Paid",
      async save() { return this; },
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
      body: { utrNumber: "NEWUTR123456" },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /already marked as paid/i);
  });

  // 8. Invalid UTR rejected
  await t.test("7.1 UTR shorter than 6 characters is rejected with 400", async () => {
    resetFees();
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001",
      tokenPrefix: "pt_a1",
    });

    const feeId = "655000000000000000000001";
    mockFees.set(feeId, {
      _id: feeId,
      centerId: "center_alpha",
      studentId: "student_doc_001",
      status: "Pending",
      async save() { return this; },
    });

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
      body: { utrNumber: "123" }, // too short
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /minimum 6 alphanumeric/i);
  });

  await t.test("7.2 Fallback claim generates delayed reference and succeeds", async () => {
    resetFees();
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001",
      tokenPrefix: "pt_a1",
    });

    const feeId = "655000000000000000000001";
    const feeObj = {
      _id: feeId,
      centerId: "center_alpha",
      studentId: "student_doc_001",
      status: "Pending",
      utrNumber: "",
      async save() {
        mockFees.set(feeId, this);
        return this;
      },
    };
    mockFees.set(feeId, feeObj);

    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
      body: { fallbackClaim: true },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
    assert.ok(mockFees.get(feeId).utrNumber.startsWith("CLAIM_DELAYED_"));
  });

  // 9. Fee Not Found
  await t.test("8.1 Non-existent fee ID returns HTTP 404", async () => {
    resetFees();
    const parentSessionToken = await signToken({
      role: "parent",
      centerId: "center_alpha",
      parentAccessId: "parent_access_001",
      tokenPrefix: "pt_a1",
    });

    const nonExistentFeeId = "655000000000000000000999";
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${parentSessionToken}` },
      body: { utrNumber: "VALIDUTR123456" },
    });

    const res = await PUT(req, { params: Promise.resolve({ feeId: nonExistentFeeId }) });
    const json = await res.json();

    assert.strictEqual(res.status, 404);
    assert.strictEqual(json.success, false);
    assert.match(json.error, /fee record not found/i);
  });

  // 10. CORS Preflight
  await t.test("9.1 OPTIONS returns HTTP 204 with approved methods", async () => {
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { Origin: "https://tution-desk-one.vercel.app" },
    });
    const res = await OPTIONS(req);
    assert.strictEqual(res.status, 204);
  });
});
