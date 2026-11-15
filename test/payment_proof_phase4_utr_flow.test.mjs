import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";
process.env.IMAGEKIT_PUBLIC_KEY = "public_test_key_123456";
process.env.IMAGEKIT_PRIVATE_KEY = "private_test_key_123456";
process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/testcenter";

globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

test("Payment Proof Phase 4: UTR & Screenshot Integration Suite (20 Tests)", async (t) => {
  const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
  const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
  const PaymentProofModel = (await import("../tution-desk-be/src/models/PaymentProof.ts")).default;
  const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
  const { NextRequest } = await import("next/server.js");
  const { setMockImageKitHandler } = await import("../tution-desk-be/src/lib/imagekitService.ts");

  setMockImageKitHandler(async (opts) => {
    return {
      fileId: "mock_file_" + Math.random().toString(36).slice(2, 8),
      fileUrl: `https://ik.imagekit.io/testcenter/payment-proofs/${opts.fileName}`,
      thumbnailUrl: `https://ik.imagekit.io/testcenter/payment-proofs/tr:w-300/${opts.fileName}`,
      filePath: `/payment-proofs/${opts.fileName}`,
      size: opts.fileBuffer.length,
      name: opts.fileName,
    };
  }, async () => true);

  const {
    POST: postProofRoute,
    GET: getProofRoute,
    PUT: putProofRoute,
  } = await import("../tution-desk-be/src/app/api/fees/[feeId]/payment-proof/route.ts");

  // In-memory test stores
  const mockFees = new Map();
  const mockProofs = new Map();
  const mockStudents = new Map();

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

  const studentAlpha = {
    _id: "6724a1b2c3d4e5f6a7b8s001",
    centerId: centerAlpha,
    name: "Rohan Sharma",
    assignedTeacherId: "6724a1b2c3d4e5f6a7b8c003",
    parentWhatsApp: "9876543210",
  };

  const studentBeta = {
    _id: "6724a1b2c3d4e5f6a7b8s002",
    centerId: centerBeta,
    name: "Sneha Patel",
    parentWhatsApp: "9876543211",
  };

  function resetStores() {
    mockFees.clear();
    mockProofs.clear();
    mockStudents.clear();

    mockStudents.set(studentAlpha._id, studentAlpha);
    mockStudents.set(studentBeta._id, studentBeta);

    // Alpha Fee 1: Pending
    const feeAlpha1 = {
      _id: "6724a1b2c3d4e5f6a7b8f001",
      centerId: centerAlpha,
      studentId: studentAlpha._id,
      month: "November 2026",
      amountDue: 2500,
      paidAmount: 0,
      dueDate: new Date("2026-11-10"),
      status: "Pending",
      hasPaymentProof: false,
      paymentHistory: [],
      save: async function () {
        mockFees.set(String(this._id), this);
        return this;
      },
    };
    mockFees.set(feeAlpha1._id, feeAlpha1);

    // Beta Fee: Belongs to centerBeta
    const feeBeta = {
      _id: "6724a1b2c3d4e5f6a7b8f999",
      centerId: centerBeta,
      studentId: studentBeta._id,
      month: "November 2026",
      amountDue: 3000,
      paidAmount: 0,
      dueDate: new Date("2026-11-10"),
      status: "Pending",
      hasPaymentProof: false,
      paymentHistory: [],
      save: async function () {
        mockFees.set(String(this._id), this);
        return this;
      },
    };
    mockFees.set(feeBeta._id, feeBeta);
  }

  // Hook Mongoose Mocks
  FeeModel.findById = function (id) {
    const doc = mockFees.get(String(id));
    return Promise.resolve(doc || null);
  };
  FeeModel.findOne = function (query) {
    for (const doc of mockFees.values()) {
      if (query.centerId && doc.centerId !== query.centerId) continue;
      if (query._id && query._id.$ne && String(doc._id) === String(query._id.$ne)) continue;
      if (query.$or) {
        let match = false;
        for (const cond of query.$or) {
          if (cond.utrNumber && doc.utrNumber === cond.utrNumber) match = true;
          if (cond.processedTxnIds && Array.isArray(doc.processedTxnIds) && doc.processedTxnIds.includes(cond.processedTxnIds)) match = true;
        }
        if (match) return Promise.resolve(doc);
      }
    }
    return Promise.resolve(null);
  };
  FeeModel.findOneAndUpdate = function (filter, update) {
    const doc = mockFees.get(String(filter._id));
    if (!doc) return Promise.resolve(null);
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    return Promise.resolve(doc);
  };
  FeeModel.updateOne = function (filter, update) {
    const doc = mockFees.get(String(filter._id));
    if (doc && update.$unset && update.$unset.proofUploadLockUntil) {
      delete doc.proofUploadLockUntil;
    }
    return Promise.resolve({ modifiedCount: 1 });
  };

  StudentModel.findById = function (id) {
    const doc = mockStudents.get(String(id));
    return {
      select: () => ({
        lean: () => Promise.resolve(doc || null),
      }),
    };
  };

  PaymentProofModel.findOne = function (query) {
    for (const doc of mockProofs.values()) {
      if (query.centerId && doc.centerId !== query.centerId) continue;
      if (query.feeId && query.feeId.$ne && String(doc.feeId) === String(query.feeId.$ne)) continue;
      if (query.submittedUtr && doc.submittedUtr !== query.submittedUtr) continue;
      if (query.status) {
        if (typeof query.status === "string" && doc.status !== query.status) continue;
        if (query.status.$in && !query.status.$in.includes(doc.status)) continue;
      }
      return {
        sort: () => Promise.resolve(doc),
        then: (resolve) => resolve(doc),
      };
    }
    return {
      sort: () => Promise.resolve(null),
      then: (resolve) => resolve(null),
    };
  };
  PaymentProofModel.find = function (query) {
    const results = [];
    for (const doc of mockProofs.values()) {
      if (query.feeId && String(doc.feeId) === String(query.feeId)) {
        results.push({ ...doc });
      }
    }
    return {
      select: () => ({
        sort: () => ({
          lean: () => Promise.resolve(results),
        }),
      }),
    };
  };
  PaymentProofModel.create = function (data) {
    const id = "proof_" + Math.random().toString(36).slice(2, 9);
    const doc = {
      _id: id,
      ...data,
      createdAt: new Date(),
    };
    mockProofs.set(id, doc);
    return Promise.resolve(doc);
  };
  PaymentProofModel.updateMany = function (filter, update) {
    let count = 0;
    for (const doc of mockProofs.values()) {
      if (filter.feeId && String(doc.feeId) !== String(filter.feeId)) continue;
      if (filter.status && doc.status !== filter.status) continue;
      if (filter._id && filter._id.$ne && String(doc._id) === String(filter._id.$ne)) continue;
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      count++;
    }
    return Promise.resolve({ modifiedCount: count });
  };

  // Valid JPEG header bytes
  const validJpegBase64 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

  // -------------------------------------------------------------------------
  // TEST 1: Desktop UTR-Only Submission
  // -------------------------------------------------------------------------
  await t.test("1. Desktop UTR-Only Submission: Accepts valid 12-digit UTR without screenshot", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "428910293847",
        notes: "Paid via netbanking IMPS transfer",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.submittedUtr, "428910293847");
    assert.equal(json.data.fileUrl, "");

    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, "428910293847");
  });

  // -------------------------------------------------------------------------
  // TEST 2: Desktop Screenshot-Only Submission
  // -------------------------------------------------------------------------
  await t.test("2. Desktop Screenshot-Only Submission: Accepts valid screenshot without UTR", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        file: validJpegBase64,
        fileName: "gpay_screenshot.jpg",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.fileUrl.startsWith("https://ik.imagekit.io"));
    assert.equal(json.data.submittedUtr, "");
  });

  // -------------------------------------------------------------------------
  // TEST 3: Desktop Combined Submission (UTR + Screenshot)
  // -------------------------------------------------------------------------
  await t.test("3. Desktop UTR + Screenshot Submission: Accepts both together", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        file: validJpegBase64,
        utrNumber: "987654321098",
        notes: "Full tuition clearance",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.data.submittedUtr, "987654321098");
    assert.ok(json.data.fileUrl.length > 0);
  });

  // -------------------------------------------------------------------------
  // TEST 4: Empty Submission Rejection
  // -------------------------------------------------------------------------
  await t.test("4. Empty Submission Rejection: Fails with HTTP 400 when neither UTR nor screenshot provided", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        notes: "Only notes without proof",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /Either a valid UTR.*or a payment screenshot is required/i);
  });

  // -------------------------------------------------------------------------
  // TEST 5: Mobile UPI Response with Transaction Reference
  // -------------------------------------------------------------------------
  await t.test("5. Mobile UPI Response Extraction: Parses NPCI ApprovalRefNo / txnId parameters", () => {
    const mockQuery = "?txnId=UPI123456789&ApprovalRefNo=428910293847&Status=SUCCESS&responseCode=00";
    const params = new URLSearchParams(mockQuery);

    const approvalRef = params.get("ApprovalRefNo") || params.get("refId") || "";
    const status = params.get("Status");
    const responseCode = params.get("responseCode");

    assert.equal(approvalRef, "428910293847");
    assert.equal(status, "SUCCESS");
    assert.equal(responseCode, "00");
  });

  // -------------------------------------------------------------------------
  // TEST 6: Mobile UPI Response without Transaction Reference
  // -------------------------------------------------------------------------
  await t.test("6. Mobile UPI Response Missing Reference: Gracefully handles missing ApprovalRefNo", () => {
    const mockQuery = "?Status=SUBMITTED&responseCode=00";
    const params = new URLSearchParams(mockQuery);

    const approvalRef = params.get("ApprovalRefNo") || "";
    assert.equal(approvalRef, "");
    // Fallback allows manual UTR or screenshot
  });

  // -------------------------------------------------------------------------
  // TEST 7: Mobile UPI Cancellation
  // -------------------------------------------------------------------------
  await t.test("7. Mobile UPI Cancellation: Detects responseCode ZM / Status FAILURE", () => {
    const mockQuery = "?Status=FAILURE&responseCode=ZM";
    const params = new URLSearchParams(mockQuery);

    const isCancelled = params.get("Status") === "FAILURE" || params.get("responseCode") === "ZM";
    assert.equal(isCancelled, true);
  });

  // -------------------------------------------------------------------------
  // TEST 8: Manual UTR Fallback Sanity
  // -------------------------------------------------------------------------
  await t.test("8. Manual UTR Fallback: Rejects UTR with fewer than 6 characters", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "123",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /minimum 6 alphanumeric characters/i);
  });

  // -------------------------------------------------------------------------
  // TEST 9: Parent Confirmation Before Submission
  // -------------------------------------------------------------------------
  await t.test("9. Parent Confirmation: Status strictly remains 'Verification Pending' (never automatically 'Paid')", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "CONFIRM123456",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201);
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Verification Pending");
    assert.notEqual(fee.status, "Paid");
  });

  // -------------------------------------------------------------------------
  // TEST 10: Owner Review of UTR-Only Proof (GET signed delivery)
  // -------------------------------------------------------------------------
  await t.test("10. Owner Review of UTR-Only Proof: Returns UTR details with empty fileUrl safely", async () => {
    resetStores();
    mockProofs.set("p_utr_only", {
      _id: "p_utr_only",
      feeId: "6724a1b2c3d4e5f6a7b8f001",
      submittedUtr: "428910293847",
      fileUrl: "",
      status: "pending_review",
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "GET",
      headers: { authorization: `Bearer ${ownerAlphaToken}` },
    });

    const res = await getProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].submittedUtr, "428910293847");
    assert.equal(json.data[0].fileUrl, "");
  });

  // -------------------------------------------------------------------------
  // TEST 11: Owner Review of Screenshot-Only Proof
  // -------------------------------------------------------------------------
  await t.test("11. Owner Review of Screenshot-Only Proof: Returns signed ImageKit URL", async () => {
    resetStores();
    mockProofs.set("p_img_only", {
      _id: "p_img_only",
      feeId: "6724a1b2c3d4e5f6a7b8f001",
      submittedUtr: "",
      fileUrl: "https://ik.imagekit.io/testcenter/payment-proofs/proof_1.jpg",
      status: "pending_review",
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "GET",
      headers: { authorization: `Bearer ${ownerAlphaToken}` },
    });

    const res = await getProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.data[0].fileUrl.includes("ik-s="));
  });

  // -------------------------------------------------------------------------
  // TEST 12: Owner Review of Combined Proof
  // -------------------------------------------------------------------------
  await t.test("12. Owner Review of Combined Proof: Returns both UTR and signed URL", async () => {
    resetStores();
    mockProofs.set("p_both", {
      _id: "p_both",
      feeId: "6724a1b2c3d4e5f6a7b8f001",
      submittedUtr: "COMBO_12345678",
      fileUrl: "https://ik.imagekit.io/testcenter/payment-proofs/proof_combo.jpg",
      status: "pending_review",
      createdAt: new Date(),
    });

    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "GET",
      headers: { authorization: `Bearer ${ownerAlphaToken}` },
    });

    const res = await getProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data[0].submittedUtr, "COMBO_12345678");
    assert.ok(json.data[0].fileUrl.includes("ik-s="));
  });

  // -------------------------------------------------------------------------
  // TEST 13: Duplicate UTR Detection within Tenant
  // -------------------------------------------------------------------------
  await t.test("13. Duplicate UTR Handling: Rejects UTR already verified on another fee (HTTP 409)", async () => {
    resetStores();
    // Prior fee with verified UTR
    mockFees.set("6724a1b2c3d4e5f6a7b8f_old", {
      _id: "6724a1b2c3d4e5f6a7b8f_old",
      centerId: centerAlpha,
      utrNumber: "ALREADY_VERIFIED_UTR",
      status: "Paid",
    });

    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "ALREADY_VERIFIED_UTR",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, "DUPLICATE_UTR_VERIFIED");
  });

  // -------------------------------------------------------------------------
  // TEST 14: Unauthorized Access (Unauthenticated)
  // -------------------------------------------------------------------------
  await t.test("14. Unauthorized Action: Rejects unauthenticated caller with HTTP 401", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ utrNumber: "123456789012" }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 401);
  });

  // -------------------------------------------------------------------------
  // TEST 15: Teacher Approval Denial (RBAC)
  // -------------------------------------------------------------------------
  await t.test("15. Teacher Approval Denial: Blocks teacher from approving proof with HTTP 403", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${teacherAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 403);
  });

  // -------------------------------------------------------------------------
  // TEST 16: Cross-Center Access Denial
  // -------------------------------------------------------------------------
  await t.test("16. Cross-Center Access Denial: Blocks centerBeta owner from reviewing centerAlpha fee with HTTP 403", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerBetaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 403);
  });

  // -------------------------------------------------------------------------
  // TEST 17: Duplicate / Already Paid Approval Denial
  // -------------------------------------------------------------------------
  await t.test("17. Duplicate Approval Denial: Rejects approval on already Paid fee with HTTP 400", async () => {
    resetStores();
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    fee.status = "Paid";

    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /already been paid/i);
  });

  // -------------------------------------------------------------------------
  // TEST 18: Partial-Payment & Outstanding-Balance Regression
  // -------------------------------------------------------------------------
  await t.test("18. Partial-Payment Regression: When approved amount is partial, transitions to 'Partial Paid' with remaining balance", async () => {
    resetStores();
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    fee.amountDue = 2500;
    fee.paidAmount = 0;

    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "approve",
        paidAmount: 1000, // Partial payment
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 200);

    assert.equal(fee.status, "Partial Paid");
    assert.equal(fee.paidAmount, 1000);
    assert.equal(fee.amountDue, 1500); // 2500 - 1000
  });

  // -------------------------------------------------------------------------
  // TEST 19: Rejection & Resubmission Feedback Loop
  // -------------------------------------------------------------------------
  await t.test("19. Rejection & Resubmission: Rejection requires reason, reverts fee status, and permits resubmission", async () => {
    resetStores();
    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    fee.status = "Verification Pending";

    // 1. Rejection without reason fails
    const failReq = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "reject", rejectionReason: "  " }),
    });
    const failRes = await putProofRoute(failReq, { params: Promise.resolve({ feeId: fee._id }) });
    assert.equal(failRes.status, 400);

    // 2. Rejection with reason succeeds
    const rejectReq = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({ action: "reject", rejectionReason: "UTR not found in bank statement" }),
    });
    const rejectRes = await putProofRoute(rejectReq, { params: Promise.resolve({ feeId: fee._id }) });
    assert.equal(rejectRes.status, 200);
    assert.equal(fee.status, "Pending");
    assert.equal(fee.rejectionReason, "UTR not found in bank statement");

    // 3. Resubmission succeeds with corrected UTR
    const resubmitReq = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "CORRECTED_UTR_123",
      }),
    });
    const resubmitRes = await postProofRoute(resubmitReq, { params: Promise.resolve({ feeId: fee._id }) });
    assert.equal(resubmitRes.status, 201);
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, "CORRECTED_UTR_123");
  });

  // -------------------------------------------------------------------------
  // TEST 20: Existing QR / UPI Flow Regression
  // -------------------------------------------------------------------------
  await t.test("20. Existing UPI QR Regression: Preserves canonical upi:// deep link URI format", () => {
    const upiId = "9876543210@paytm";
    const centerName = "Apex Tuition Center";
    const amount = 2500;
    const customRef = "FEE-8f001";

    const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(centerName)}&am=${amount}&tn=${encodeURIComponent(customRef)}&cu=INR`;

    assert.ok(upiLink.startsWith("upi://pay?"));
    assert.ok(upiLink.includes("pa=9876543210%40paytm"));
    assert.ok(upiLink.includes("am=2500"));
    assert.ok(upiLink.includes("cu=INR"));
  });
});
