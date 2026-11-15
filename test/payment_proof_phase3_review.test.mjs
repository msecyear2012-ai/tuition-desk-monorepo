import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";
process.env.IMAGEKIT_PUBLIC_KEY = "public_test_key_123456";
process.env.IMAGEKIT_PRIVATE_KEY = "private_test_key_123456";
process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/testcenter";

globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

test("Payment Proof Phase 3: Owner Review, Security & Ledger Integration Suite", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
  const PaymentProofModel = (await import("../tution-desk-be/src/models/PaymentProof.ts")).default;
  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
  const { NextRequest } = await import("next/server.js");

  const {
    GET: getProofRoute,
    PUT: putProofRoute,
  } = await import("../tution-desk-be/src/app/api/fees/[feeId]/payment-proof/route.ts");

  const {
    PUT: putFeeRoute,
  } = await import("../tution-desk-be/src/app/api/fees/[feeId]/route.ts");

  // In-memory test stores
  const mockFees = new Map();
  const mockProofs = new Map();
  const mockStudents = new Map();

  // Test Entities
  const centerAlpha = "center_alpha_001";
  const centerBeta = "center_beta_002";

  const ownerAlphaUser = {
    userId: "6724a1b2c3d4e5f6a7b8c001",
    centerId: centerAlpha,
    role: "owner",
    phone: "9876543210",
  };
  const ownerAlphaToken = await signToken(ownerAlphaUser);

  const ownerBetaUser = {
    userId: "6724a1b2c3d4e5f6a7b8c002",
    centerId: centerBeta,
    role: "owner",
    phone: "9876543211",
  };
  const ownerBetaToken = await signToken(ownerBetaUser);

  const teacherAlphaUser = {
    userId: "6724a1b2c3d4e5f6a7b8c003",
    teacherId: "6724a1b2c3d4e5f6a7b8c003",
    centerId: centerAlpha,
    role: "teacher",
    phone: "9876543212",
  };
  const teacherAlphaToken = await signToken(teacherAlphaUser);

  function resetStores() {
    mockFees.clear();
    mockProofs.clear();
    mockStudents.clear();

    const studentAlpha = {
      _id: "6724a1b2c3d4e5f6a7b8s001",
      centerId: centerAlpha,
      name: "Rohan Sharma",
      assignedTeacherId: "6724a1b2c3d4e5f6a7b8c003",
      parentWhatsApp: "9876543210",
    };
    mockStudents.set(studentAlpha._id, studentAlpha);

    // Alpha Fee 1: Verification Pending with active PaymentProof
    const feeAlpha1 = {
      _id: "6724a1b2c3d4e5f6a7b8f001",
      centerId: centerAlpha,
      studentId: studentAlpha._id,
      assignedTeacherId: "6724a1b2c3d4e5f6a7b8c003",
      month: "2026-11",
      title: "November Tuition Fee",
      amountDue: 2500,
      paidAmount: 0,
      status: "Verification Pending",
      paymentMode: "Online/UPI",
      utrNumber: "428910293847",
      hasPaymentProof: true,
      latestPaymentProofId: "6724a1b2c3d4e5f6a7b8p001",
      rejectionReason: null,
      paymentHistory: [],
      async save() {
        mockFees.set(this._id, this);
        return this;
      },
      populate() {
        return Promise.resolve({
          ...this,
          studentId: studentAlpha,
        });
      },
    };
    mockFees.set(feeAlpha1._id, feeAlpha1);

    // Alpha Proof 1: Pending Review
    const proofAlpha1 = {
      _id: "6724a1b2c3d4e5f6a7b8p001",
      centerId: centerAlpha,
      feeId: feeAlpha1._id,
      studentId: studentAlpha._id,
      fileId: "ik_file_alpha_001",
      fileUrl: "https://ik.imagekit.io/testcenter/payment-proofs/receipt1.jpg",
      thumbnailUrl: "https://ik.imagekit.io/testcenter/payment-proofs/receipt1_thumb.jpg",
      fileSizeBytes: 840000,
      mimeType: "image/jpeg",
      originalFileName: "gpay_nov_receipt.jpg",
      submittedUtr: "428910293847",
      submittedAmount: 2500,
      notes: "Paid via GPay to center scanner",
      status: "pending_review",
      rejectionReason: "",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date("2026-11-14T10:00:00Z"),
    };
    mockProofs.set(proofAlpha1._id, proofAlpha1);

    // Beta Fee 1: Owned by Center Beta
    const feeBeta1 = {
      _id: "6724a1b2c3d4e5f6a7b8f002",
      centerId: centerBeta,
      studentId: "6724a1b2c3d4e5f6a7b8s002",
      month: "2026-11",
      amountDue: 3000,
      paidAmount: 0,
      status: "Verification Pending",
      hasPaymentProof: true,
      latestPaymentProofId: "6724a1b2c3d4e5f6a7b8p002",
      paymentHistory: [],
      async save() {
        mockFees.set(this._id, this);
        return this;
      },
      populate() {
        return Promise.resolve(this);
      },
    };
    mockFees.set(feeBeta1._id, feeBeta1);

    const proofBeta1 = {
      _id: "6724a1b2c3d4e5f6a7b8p002",
      centerId: centerBeta,
      feeId: feeBeta1._id,
      studentId: "6724a1b2c3d4e5f6a7b8s002",
      fileId: "ik_file_beta_002",
      fileUrl: "https://ik.imagekit.io/testcenter/payment-proofs/receipt_beta.png",
      status: "pending_review",
    };
    mockProofs.set(proofBeta1._id, proofBeta1);
  }

  // Monkey-patch Mongoose find queries for unit isolation
  FeeModel.findById = function (id) {
    const fee = mockFees.get(String(id));
    return Promise.resolve(fee || null);
  };
  FeeModel.findOne = function (query) {
    for (const fee of mockFees.values()) {
      let match = true;
      if (query._id && String(fee._id) !== String(query._id)) match = false;
      if (query.centerId && String(fee.centerId) !== String(query.centerId)) match = false;
      if (match) return Promise.resolve(fee);
    }
    return Promise.resolve(null);
  };
  PaymentProofModel.find = function (query) {
    const results = [];
    for (const p of mockProofs.values()) {
      let match = true;
      if (query.feeId && String(p.feeId) !== String(query.feeId)) match = false;
      if (query.status && p.status !== query.status) match = false;
      if (match) results.push({ ...p });
    }
    return {
      select: () => ({
        sort: () => ({
          lean: () => Promise.resolve(results),
        }),
      }),
    };
  };
  PaymentProofModel.updateMany = function (conditions, update) {
    let count = 0;
    for (const p of mockProofs.values()) {
      let match = true;
      if (conditions.feeId && String(p.feeId) !== String(conditions.feeId)) match = false;
      if (conditions.status && p.status !== conditions.status) match = false;
      if (conditions._id && String(p._id) !== String(conditions._id)) match = false;
      if (match) {
        if (update.$set) {
          Object.assign(p, update.$set);
        }
        count++;
      }
    }
    return Promise.resolve({ modifiedCount: count });
  };
  StudentModel.findById = function (id) {
    const student = mockStudents.get(String(id));
    return {
      select: () => ({
        lean: () => Promise.resolve(student || null),
      }),
    };
  };

  // =========================================================================
  // TEST SUITE 1: OWNER SCREENSHOT ACCESS & SIGNED URLS
  // =========================================================================
  await t.test("1. Owner Screenshot Access: Generates fresh signed URLs without leaking private key", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
    });

    const res = await getProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(Array.isArray(json.data), true);
    assert.equal(json.data.length, 1);

    const proof = json.data[0];
    assert.equal(proof.fileId, "ik_file_alpha_001");
    // Verify signed URL generation
    assert.match(proof.fileUrl, /ik-t=/);
    assert.match(proof.fileUrl, /ik-s=/);
    assert.ok(proof.urlExpiresAt, "urlExpiresAt must be populated");
    // Ensure raw credentials are never leaked
    assert.equal(JSON.stringify(json).includes(process.env.IMAGEKIT_PRIVATE_KEY), false);
  });

  // =========================================================================
  // TEST SUITE 2: CROSS-CENTER ACCESS REJECTION (TENANT ISOLATION)
  // =========================================================================
  await t.test("2. Tenant Isolation: Rejects cross-center screenshot access with HTTP 403", async () => {
    resetStores();

    // Owner Beta attempts to access Center Alpha's fee proof
    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ownerBetaToken}`,
      },
    });

    const res = await getProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 403);
    assert.equal(json.success, false);
    assert.match(json.error, /Cross-tenant fee access is strictly forbidden/i);
  });

  await t.test("2. Tenant Isolation: Rejects cross-center proof review / approval with HTTP 403", async () => {
    resetStores();

    // Owner Beta attempts to approve Center Alpha's fee proof
    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerBetaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 403);
    assert.equal(json.success, false);
    assert.match(json.error, /Cross-tenant fee review is strictly forbidden/i);
  });

  // =========================================================================
  // TEST SUITE 3: TEACHER RBAC RESTRICTION
  // =========================================================================
  await t.test("3. RBAC Restriction: Teachers cannot approve payment proofs via PUT /api/fees/[feeId]/payment-proof (HTTP 403)", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${teacherAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 403);
    assert.equal(json.success, false);
    assert.match(json.error, /Only center owners are authorized/i);
  });

  await t.test("3. RBAC Restriction: Teachers cannot reject payment proofs via PUT /api/fees/[feeId]/payment-proof (HTTP 403)", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${teacherAlphaToken}`,
      },
      body: JSON.stringify({ action: "reject", rejectionReason: "Invalid" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 403);
    assert.equal(json.success, false);
    assert.match(json.error, /Only center owners are authorized/i);
  });

  await t.test("3. RBAC Restriction: Teachers cannot mark fee as Paid via PUT /api/fees/[feeId] (HTTP 403)", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${teacherAlphaToken}`,
      },
      body: JSON.stringify({ status: "Paid" }),
    });

    const res = await putFeeRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 403);
    assert.equal(json.success, false);
    assert.match(json.error, /Teachers cannot record payments or alter financial balances/i);
  });

  // =========================================================================
  // TEST SUITE 4: APPROVAL WORKFLOW & LEDGER CONSISTENCY
  // =========================================================================
  await t.test("4. Approval Workflow: Marks fee Paid, generates receipt, appends paymentHistory, and verifies proof", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve", paymentMode: "Online/UPI" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.match(json.message, /Payment proof verified and fee marked as Paid/i);

    // Verify Fee document updates
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Paid");
    assert.equal(fee.amountDue, 0);
    assert.equal(fee.paidAmount, 2500);
    assert.match(fee.receiptNumber, /^RCPT-/);
    assert.equal(fee.paymentHistory.length, 1);
    assert.equal(fee.paymentHistory[0].custodyStatus, "owner_custody");
    assert.equal(fee.paymentHistory[0].receivedByRole, "owner");

    // Verify PaymentProof document status
    const proof = mockProofs.get("6724a1b2c3d4e5f6a7b8p001");
    assert.equal(proof.status, "verified");
    assert.ok(proof.reviewedBy, "reviewedBy must be set");
    assert.ok(proof.reviewedAt, "reviewedAt must be set");
  });

  await t.test("4. Approval Workflow: Generic PUT /api/fees/[feeId] with status=Paid also verifies PaymentProof", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ status: "Paid", paymentMode: "Online/UPI" }),
    });

    const res = await putFeeRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);

    const proof = mockProofs.get("6724a1b2c3d4e5f6a7b8p001");
    assert.equal(proof.status, "verified");
  });

  // =========================================================================
  // TEST SUITE 5: DUPLICATE APPROVAL REJECTION
  // =========================================================================
  await t.test("5. Invariant Guard: Rejects duplicate approval on already Paid fee with HTTP 400", async () => {
    resetStores();
    // Mark fee as already Paid
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    fee.status = "Paid";
    fee.amountDue = 0;
    fee.paidAmount = 2500;

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /already been paid and verified.*Duplicate approval is rejected/i);
  });

  // =========================================================================
  // TEST SUITE 6: REJECTION WORKFLOW & MANDATORY REASON
  // =========================================================================
  await t.test("6. Rejection Workflow: Fails when rejection reason is missing or empty (HTTP 400)", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "reject", rejectionReason: "   " }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /Rejection reason is required/i);
  });

  await t.test("6. Rejection Workflow: Successfully rejects proof, preserves ledger, and returns fee to Pending", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "UTR 428910293847 was not found in center bank statement.",
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.match(json.message, /Payment proof rejected and fee returned to Pending/i);

    // Verify Fee ledger preservation
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Pending", "Fee status must revert to Pending");
    assert.equal(fee.amountDue, 2500, "Outstanding balance must remain unchanged");
    assert.equal(fee.paidAmount, 0, "paidAmount must remain 0");
    assert.equal(fee.paymentHistory.length, 0, "No payment entry should be added upon rejection");
    assert.equal(fee.rejectionReason, "UTR 428910293847 was not found in center bank statement.");

    // Verify PaymentProof record
    const proof = mockProofs.get("6724a1b2c3d4e5f6a7b8p001");
    assert.equal(proof.status, "rejected");
    assert.equal(proof.rejectionReason, "UTR 428910293847 was not found in center bank statement.");
    assert.ok(proof.reviewedBy);
    assert.ok(proof.reviewedAt);
    // Ensure screenshot file reference was preserved for audit and not deleted
    assert.equal(proof.fileId, "ik_file_alpha_001");
  });

  await t.test("6. Rejection Workflow: Rejection via PUT /api/fees/[feeId] also requires reason and updates proof", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        status: "Pending",
        rejectionReason: "Screenshot blurred and unreadable",
      }),
    });

    const res = await putFeeRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);

    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Pending");
    assert.equal(fee.rejectionReason, "Screenshot blurred and unreadable");

    const proof = mockProofs.get("6724a1b2c3d4e5f6a7b8p001");
    assert.equal(proof.status, "rejected");
    assert.equal(proof.rejectionReason, "Screenshot blurred and unreadable");
  });

  // =========================================================================
  // TEST SUITE 7: PARTIAL PAYMENT & OUTSTANDING BALANCE GUARD
  // =========================================================================
  await t.test("7. Financial Guard: Rejects approval when approved amount exceeds outstanding fee balance", async () => {
    resetStores();

    const req = new NextRequest("http://localhost:3001/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve", paidAmount: 5000 }), // AmountDue is 2500
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.equal(json.success, false);
    assert.match(json.error, /cannot exceed the outstanding balance/i);
  });
});
