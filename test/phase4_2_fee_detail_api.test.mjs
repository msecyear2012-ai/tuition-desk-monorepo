process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const { GET: getFeeRoute, PUT: putFeeRoute } = await import(
  "../tution-desk-be/src/app/api/fees/[feeId]/route.ts"
);

function createMockRequest({
  method = "GET",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/fees/fee_123",
}) {
  const reqHeaders = new Headers(headers);
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: new URL(url),
    json: async () => body || {},
  };
}

test("Phase 4.2 Task 2: Individual Fee API Integration Suite (GET & PUT /api/fees/[feeId])", async (t) => {
  const centerId = "center_alpha";
  const centerBetaId = "center_beta";

  const ownerId = "507f191e810c19729de860f1";
  const teacherAId = "507f191e810c19729de860f2";
  const teacherBId = "507f191e810c19729de860f3";

  const studentAId = "507f191e810c19729de860ea";
  const studentBId = "507f191e810c19729de860eb";

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
    name: "Center Director Alpha",
  });

  const teacherAToken = await signToken({
    userId: teacherAId,
    teacherId: teacherAId,
    centerId,
    role: "teacher",
    name: "Teacher Sharma",
  });

  const teacherBToken = await signToken({
    userId: teacherBId,
    teacherId: teacherBId,
    centerId,
    role: "teacher",
    name: "Teacher Verma",
  });

  const ownerBetaToken = await signToken({
    userId: "507f191e810c19729de860f9",
    centerId: centerBetaId,
    role: "owner",
    name: "Center Director Beta",
  });

  const mockStudentA = {
    _id: studentAId,
    centerId,
    name: "Aarav Sharma",
    batch: "Class 10-A",
    assignedTeacherId: teacherAId,
    parentWhatsApp: "+919876543210",
    phone: "+919876543210",
    parentPhone: "+919876543210",
    monthlyFee: 2500,
    isActive: true,
  };

  const mockStudentB = {
    _id: studentBId,
    centerId,
    name: "Rohan Verma",
    batch: "Class 12-B",
    assignedTeacherId: teacherBId,
    parentWhatsApp: "+919123456789",
    phone: "+919123456789",
    monthlyFee: 3000,
    isActive: true,
  };

  // =========================================================================
  // 1. OWNER GET ACCESS
  // =========================================================================
  await t.test("1. Owner GET access returns enriched fee with unmasked contact info, payment history & custody", async () => {
    const feeId = "507f191e810c19729de86001";
    const sampleFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Paid",
      amountDue: 0,
      paidAmount: 2500,
      originalAmountDue: 2500,
      receiptNumber: "RCPT-OWNER01",
      feeType: "monthly_recurring",
      paymentHistory: [
        {
          _id: "pay_001",
          paymentId: "pay_001",
          amount: 2500,
          paymentDate: new Date("2026-11-05"),
          paymentMode: "Cash",
          receiptNumber: "RCPT-OWNER01",
          isProvisional: false,
          receivedBy: ownerId,
          receivedByRole: "owner",
          custodyStatus: "owner_custody",
          allocations: [
            {
              allocationId: "alloc_001",
              handoverId: "ho_001",
              allocatedAmount: 2500,
              status: "verified",
              verifiedAmount: 2500,
            },
          ],
        },
      ],
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = (query) => {
      assert.equal(query.centerId, centerId, "Must strictly scope query by authenticated centerId");
      assert.equal(query._id, feeId);
      return {
        ...sampleFee,
        populate: async () => sampleFee,
      };
    };

    const req = createMockRequest({
      method: "GET",
      token: ownerToken,
    });

    const res = await getFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.data._id, feeId);
    assert.equal(json.data.originalAmountDue, 2500);
    assert.equal(json.data.paymentHistory.length, 1);
    assert.equal(json.data.paymentHistory[0].amount, 2500);

    // Owner must see RAW unmasked parent phone
    assert.equal(json.data.studentId.parentWhatsApp, "+919876543210", "Owner must see raw unmasked phone");
    assert.equal(json.data.studentId.phone, "+919876543210");

    // Live custody breakdown must reflect verified owner custody
    assert.ok(json.data.custodyBreakdown, "Must include live custodyBreakdown");
    assert.equal(json.data.custodyBreakdown.ownerVerifiedAmount, 2500);
    assert.equal(json.data.custodyBreakdown.teacherInHandAmount, 0);
    assert.equal(json.data.custodyBreakdown.custodyLabel, "owner_verified");
  });

  // =========================================================================
  // 2. TEACHER GET ACCESS TO ASSIGNED STUDENTS
  // =========================================================================
  await t.test("2. Teacher GET access to assigned student succeeds with HTTP 200", async () => {
    const feeId = "507f191e810c19729de86002";
    const assignedFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA, // Assigned to Teacher Sharma (teacherAId)
      assignedTeacherId: teacherAId,
      billingMonth: "2026-11",
      month: "November 2026",
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      originalAmountDue: 2500,
      feeType: "monthly_recurring",
      paymentHistory: [],
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => ({
      ...assignedFee,
      populate: async () => assignedFee,
    });

    const req = createMockRequest({
      method: "GET",
      token: teacherAToken,
    });

    const res = await getFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.data._id, feeId);
    assert.equal(json.data.amountDue, 2500);
  });

  // =========================================================================
  // 3. CROSS-CENTER ACCESS REJECTION
  // =========================================================================
  await t.test("3. Cross-center access rejection: User from Center Alpha cannot access Center Beta fee", async () => {
    const betaFeeId = "507f191e810c19729de86003";

    // Query scoped to Center Alpha returns null
    FeeModel.findOne = () => null;

    // Cross-center check locates fee in Center Beta
    FeeModel.findById = () => ({
      select: () => ({
        lean: async () => ({ _id: betaFeeId, centerId: centerBetaId }),
      }),
    });

    // 3.1 GET cross-center
    const reqGet = createMockRequest({
      method: "GET",
      token: ownerToken, // Center Alpha
    });
    const resGet = await getFeeRoute(reqGet, { params: Promise.resolve({ feeId: betaFeeId }) });
    assert.equal(resGet.status, 403, "Cross-center GET must return HTTP 403 Forbidden");
    const jsonGet = await resGet.json();
    assert.ok(jsonGet.error.includes("Cross-center"));

    // 3.2 PUT cross-center
    const reqPut = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: { notes: "Malicious cross-center edit" },
    });
    const resPut = await putFeeRoute(reqPut, { params: Promise.resolve({ feeId: betaFeeId }) });
    assert.equal(resPut.status, 403, "Cross-center PUT must return HTTP 403 Forbidden");
    const jsonPut = await resPut.json();
    assert.ok(jsonPut.error.includes("Cross-center"));
  });

  // =========================================================================
  // 4. TEACHER ACCESS RESTRICTION (UNASSIGNED STUDENT)
  // =========================================================================
  await t.test("4. Teacher access restriction: Teacher A cannot access Teacher B's student fee", async () => {
    const feeId = "507f191e810c19729de86004";
    const teacherBFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentB, // Assigned to Teacher B
      assignedTeacherId: teacherBId, // Assigned to Teacher B
      status: "Pending",
      amountDue: 3000,
      paidAmount: 0,
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => ({
      ...teacherBFee,
      populate: async () => teacherBFee,
    });

    // Teacher Sharma (Teacher A) attempts to GET Teacher Verma's student fee
    const reqGet = createMockRequest({
      method: "GET",
      token: teacherAToken,
    });
    const resGet = await getFeeRoute(reqGet, { params: Promise.resolve({ feeId }) });
    assert.equal(resGet.status, 403);
    const jsonGet = await resGet.json();
    assert.ok(jsonGet.error.includes("not assigned to your account"));

    // Teacher Sharma attempts to PUT notes on Teacher Verma's student fee
    const reqPut = createMockRequest({
      method: "PUT",
      token: teacherAToken,
      body: { notes: "Unauthorized note" },
    });
    const resPut = await putFeeRoute(reqPut, { params: Promise.resolve({ feeId }) });
    assert.equal(resPut.status, 403);
    const jsonPut = await resPut.json();
    assert.ok(jsonPut.error.includes("not assigned to your account"));
  });

  // =========================================================================
  // 5. STRUCTURED PAYMENT HISTORY RESPONSE
  // =========================================================================
  await t.test("5. Payment history response exposes all structured IPaymentEntry fields and allocations", async () => {
    const feeId = "507f191e810c19729de86005";
    const payment1 = {
      _id: "pay_sharma_001",
      paymentId: "pay_sharma_001",
      amount: 1000,
      paymentDate: new Date("2026-11-01"),
      paymentMode: "Cash",
      receiptNumber: "RCPT-SHARMA1",
      isProvisional: true,
      receivedBy: teacherAId,
      receivedByRole: "teacher",
      recordedBy: teacherAId,
      recordedByRole: "teacher",
      custodyStatus: "teacher_custody",
      allocations: [],
      notes: "First installment",
    };

    const payment2 = {
      _id: "pay_verma_002",
      paymentId: "pay_verma_002",
      amount: 1500,
      paymentDate: new Date("2026-11-10"),
      paymentMode: "Cash",
      receiptNumber: "RCPT-VERMA2",
      isProvisional: true,
      receivedBy: teacherBId,
      receivedByRole: "teacher",
      recordedBy: teacherBId,
      recordedByRole: "teacher",
      custodyStatus: "teacher_custody",
      allocations: [],
      notes: "Second installment",
    };

    const multiPaymentFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      amountDue: 0,
      paidAmount: 2500,
      originalAmountDue: 2500,
      status: "Paid",
      paymentHistory: [payment1, payment2],
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => ({
      ...multiPaymentFee,
      populate: async () => multiPaymentFee,
    });

    const req = createMockRequest({
      method: "GET",
      token: ownerToken,
    });

    const res = await getFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.data.paymentHistory.length, 2);
    assert.equal(json.data.paymentHistory[0].receiptNumber, "RCPT-SHARMA1");
    assert.equal(json.data.paymentHistory[0].amount, 1000);
    assert.equal(json.data.paymentHistory[0].isProvisional, true);
    assert.equal(String(json.data.paymentHistory[0].receivedBy), teacherAId);

    assert.equal(json.data.paymentHistory[1].receiptNumber, "RCPT-VERMA2");
    assert.equal(json.data.paymentHistory[1].amount, 1500);
    assert.equal(String(json.data.paymentHistory[1].receivedBy), teacherBId);
  });

  // =========================================================================
  // 6. LEGACY FEE BACKWARD COMPATIBILITY
  // =========================================================================
  await t.test("6. Legacy Fee response synthesizes approved payment entries preserving historical payments", async () => {
    const feeId = "507f191e810c19729de86006";

    // Legacy record: has paidAmount: 2500, receiptNumber: "RCPT-LEGACY06", but NO paymentHistory array
    const legacyFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      amountDue: 0,
      paidAmount: 2500,
      month: "October 2026",
      status: "Paid",
      receiptNumber: "RCPT-LEGACY06",
      paymentMode: "Cash",
      paymentDate: new Date("2026-10-15"),
      // paymentHistory is undefined/empty
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => ({
      ...legacyFee,
      populate: async () => legacyFee,
    });

    const req = createMockRequest({
      method: "GET",
      token: ownerToken,
    });

    const res = await getFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.data.originalAmountDue, 2500, "originalAmountDue must be calculated as due (0) + paid (2500)");
    assert.ok(json.data.paymentHistory.length >= 1, "Must synthesize approved payment entry for legacy fee");
    assert.equal(json.data.paymentHistory[0].amount, 2500);
    assert.equal(json.data.paymentHistory[0].receiptNumber, "RCPT-LEGACY06");
    assert.equal(json.data.paymentHistory[0].isProvisional, false, "Synthesized legacy payment must not be provisional");
    assert.equal(json.data.paymentHistory[0].custodyStatus, "owner_custody");
  });

  // =========================================================================
  // 7. CUSTODY BREAKDOWN ACCURACY (SPLIT CUSTODY)
  // =========================================================================
  await t.test("7. Custody breakdown accurately calculates split verified and pending allocation amounts", async () => {
    const feeId = "507f191e810c19729de86007";

    // ₹1,000 payment with ₹700 verified and ₹300 pending owner verification
    const feeWithAllocations = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      amountDue: 0,
      paidAmount: 1000,
      originalAmountDue: 1000,
      status: "Paid",
      paymentHistory: [
        {
          _id: "pay_split_007",
          paymentId: "pay_split_007",
          amount: 1000,
          paymentDate: new Date(),
          paymentMode: "Cash",
          receiptNumber: "RCPT-SPLIT07",
          isProvisional: true,
          receivedBy: teacherAId,
          receivedByRole: "teacher",
          custodyStatus: "teacher_custody",
          allocations: [
            {
              allocationId: "alloc_verified",
              handoverId: "ho_001",
              allocatedAmount: 700,
              status: "verified",
              verifiedAmount: 700,
            },
            {
              allocationId: "alloc_pending",
              handoverId: "ho_002",
              allocatedAmount: 300,
              status: "pending_verification",
            },
          ],
        },
      ],
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => ({
      ...feeWithAllocations,
      populate: async () => feeWithAllocations,
    });

    const req = createMockRequest({
      method: "GET",
      token: ownerToken,
    });

    const res = await getFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    const custody = json.data.custodyBreakdown;
    assert.ok(custody);
    assert.equal(custody.totalAmount, 1000);
    assert.equal(custody.ownerVerifiedAmount, 700, "Verified allocation locks 700");
    assert.equal(custody.ownerPendingVerificationAmount, 300, "Pending allocation locks 300");
    assert.equal(custody.teacherInHandAmount, 0, "No cash left unallocated in teacher hand");
    assert.equal(custody.disputedDiscrepancyAmount, 0);
    assert.equal(custody.custodyLabel, "split_custody");
  });

  // =========================================================================
  // 8. PUT IMMUTABLE FIELD TAMPERING REJECTION
  // =========================================================================
  await t.test("8. PUT immutable field tampering rejection (paymentHistory, allocations, originalAmountDue, attribution)", async () => {
    const feeId = "507f191e810c19729de86008";

    // Test each forbidden field individually
    const forbiddenPayloads = [
      { paymentHistory: [] },
      { allocations: [] },
      { originalAmountDue: 100 },
      { recordedBy: ownerId },
      { recordedByRole: "owner" },
      { receivedBy: ownerId },
      { receivedByRole: "owner" },
      { custodyStatus: "owner_custody" },
      { isProvisional: false },
    ];

    for (const forbidden of forbiddenPayloads) {
      const req = createMockRequest({
        method: "PUT",
        token: ownerToken,
        body: forbidden,
      });

      const res = await putFeeRoute(req, { params: Promise.resolve({ feeId }) });
      assert.equal(res.status, 400, `Payload ${JSON.stringify(forbidden)} must return HTTP 400 Bad Request`);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.code, "IMMUTABLE_FIELD_TAMPERING");
      assert.ok(json.error.includes("strictly forbidden"));
    }
  });

  // =========================================================================
  // 9. LEGITIMATE PERMITTED FEE UPDATES
  // =========================================================================
  await t.test("9. Legitimate permitted Fee updates: Owner updating notes, title, or dueDate succeeds with HTTP 200", async () => {
    const feeId = "507f191e810c19729de86009";
    const existingFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      amountDue: 2500,
      paidAmount: 0,
      title: "Original Monthly Fee",
      notes: "Original note",
      dueDate: new Date("2026-11-10"),
      status: "Pending",
      save: async function () {
        return this;
      },
      populate: async function () {
        return this;
      },
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => existingFee;

    const newDueDate = "2026-11-25T00:00:00.000Z";
    const req = createMockRequest({
      method: "PUT",
      token: ownerToken,
      body: {
        title: "Updated Title for Examination Fee",
        notes: "Approved installment extension until 25th Nov",
        dueDate: newDueDate,
      },
    });

    const res = await putFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.data.title, "Updated Title for Examination Fee");
    assert.equal(json.data.notes, "Approved installment extension until 25th Nov");
    assert.equal(new Date(json.data.dueDate).toISOString(), new Date(newDueDate).toISOString());
  });

  // =========================================================================
  // 10. TEACHER AUTHORIZATION RESTRICTIONS ON PUT
  // =========================================================================
  await t.test("10. Teacher authorization restrictions: Teacher cannot mark fee as Paid or change assignedTeacherId via PUT", async () => {
    const feeId = "507f191e810c19729de86010";
    const pendingFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      assignedTeacherId: teacherAId, // Assigned to Teacher A
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      save: async function () {
        return this;
      },
    };

    FeeModel.findOne = () => pendingFee;

    // Attempt 1: Teacher attempting to mark status: "Paid" directly via PUT
    const reqMarkPaid = createMockRequest({
      method: "PUT",
      token: teacherAToken,
      body: { status: "Paid" },
    });
    const resMarkPaid = await putFeeRoute(reqMarkPaid, { params: Promise.resolve({ feeId }) });
    assert.equal(resMarkPaid.status, 403, "Teacher cannot mark Paid via PUT");
    const jsonMarkPaid = await resMarkPaid.json();
    assert.ok(jsonMarkPaid.error.includes("manual collection API"));

    // Attempt 2: Teacher attempting to change assignedTeacherId
    const reqChangeTeacher = createMockRequest({
      method: "PUT",
      token: teacherAToken,
      body: { assignedTeacherId: teacherBId },
    });
    const resChangeTeacher = await putFeeRoute(reqChangeTeacher, { params: Promise.resolve({ feeId }) });
    assert.equal(resChangeTeacher.status, 403);
    const jsonChangeTeacher = await resChangeTeacher.json();
    assert.ok(jsonChangeTeacher.error.includes("cannot change student assignment"));

    // Attempt 3: Teacher updating notes ONLY on assigned student (Permitted)
    pendingFee.populate = async function () {
      return this;
    };
    pendingFee.toObject = function () {
      return { ...this };
    };

    const reqTeacherNotes = createMockRequest({
      method: "PUT",
      token: teacherAToken,
      body: { notes: "Parent called: will pay offline on Friday" },
    });
    const resTeacherNotes = await putFeeRoute(reqTeacherNotes, { params: Promise.resolve({ feeId }) });
    assert.equal(resTeacherNotes.status, 200, "Teacher updating notes on assigned student must succeed");
    const jsonTeacherNotes = await resTeacherNotes.json();
    assert.equal(jsonTeacherNotes.data.notes, "Parent called: will pay offline on Friday");
  });

  // =========================================================================
  // 11. STUDENT PHONE NUMBER MASKING
  // =========================================================================
  await t.test("11. Student phone number masking: Teacher GET receives masked contact numbers while Owner receives raw numbers", async () => {
    const feeId = "507f191e810c19729de86011";
    const sampleFee = {
      _id: feeId,
      centerId,
      studentId: {
        _id: studentAId,
        name: "Aarav Sharma",
        batch: "Class 10-A",
        assignedTeacherId: teacherAId,
        parentWhatsApp: "+919876543210",
        phone: "+919876543210",
        parentPhone: "+919876543210",
      },
      assignedTeacherId: teacherAId,
      status: "Pending",
      amountDue: 2500,
      paidAmount: 0,
      toObject() {
        return {
          ...this,
          studentId: { ...this.studentId },
        };
      },
    };

    FeeModel.findOne = () => ({
      ...sampleFee,
      populate: async () => sampleFee,
    });

    // 1. Teacher Sharma calls GET -> phone numbers MUST be masked
    const reqTeacher = createMockRequest({
      method: "GET",
      token: teacherAToken,
    });
    const resTeacher = await getFeeRoute(reqTeacher, { params: Promise.resolve({ feeId }) });
    assert.equal(resTeacher.status, 200);
    const jsonTeacher = await resTeacher.json();

    const studentForTeacher = jsonTeacher.data.studentId;
    assert.notEqual(studentForTeacher.parentWhatsApp, "+919876543210", "Teacher must NOT see raw parent WhatsApp");
    assert.ok(studentForTeacher.parentWhatsApp.endsWith("3210"), "Masked phone should retain last 4 digits");
    assert.ok(studentForTeacher.parentWhatsApp.startsWith("****"), "Masked phone should hide prefix with asterisks");
    assert.ok(studentForTeacher.phone.startsWith("****"));

    // 2. Owner calls GET -> phone numbers MUST be unmasked
    const reqOwner = createMockRequest({
      method: "GET",
      token: ownerToken,
    });
    const resOwner = await getFeeRoute(reqOwner, { params: Promise.resolve({ feeId }) });
    assert.equal(resOwner.status, 200);
    const jsonOwner = await resOwner.json();

    const studentForOwner = jsonOwner.data.studentId;
    assert.equal(studentForOwner.parentWhatsApp, "+919876543210", "Owner must see raw unmasked phone");
    assert.equal(studentForOwner.phone, "+919876543210");
  });

  // =========================================================================
  // 12. REGRESSION COMPATIBILITY
  // =========================================================================
  await t.test("12. Regression compatibility: GET response preserves exact contract expected by FeesPage and FeeActionCard", async () => {
    const feeId = "507f191e810c19729de86012";
    const sampleFee = {
      _id: feeId,
      centerId,
      studentId: mockStudentA,
      status: "Paid",
      amountDue: 0,
      paidAmount: 2500,
      upiTransactionId: "UPI-TXN-12345",
      paymentMode: "UPI",
      receiptNumber: "RCPT-REGRESS12",
      paidAt: new Date("2026-11-05"),
      paidDate: new Date("2026-11-05"),
      toObject() {
        return { ...this };
      },
    };

    FeeModel.findOne = () => ({
      ...sampleFee,
      populate: async () => sampleFee,
    });

    const req = createMockRequest({
      method: "GET",
      token: ownerToken,
    });

    const res = await getFeeRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const json = await res.json();

    // Verify properties polled by FeeActionCard.tsx:215: if (json?.data?.status === "Paid")
    assert.equal(json.data.status, "Paid");
    assert.equal(json.data.amountDue, 0);
    assert.equal(json.data.paidAmount, 2500);
    assert.equal(json.data.receiptNumber, "RCPT-REGRESS12");
    assert.equal(json.data.paymentMode, "UPI");
    assert.equal(json.data.upiTransactionId, "UPI-TXN-12345");
  });
});
