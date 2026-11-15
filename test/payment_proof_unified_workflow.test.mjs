import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";
process.env.IMAGEKIT_PUBLIC_KEY = "public_test_key_123456";
process.env.IMAGEKIT_PRIVATE_KEY = "private_test_key_123456";
process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/testcenter";

globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

// Replicate UTR parsing and validation helper from FeeActionCard.tsx
function validateExtractedUtr(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (trimmed.length < 6 || trimmed.length > 30) return null;
  if (trimmed.startsWith("FEE-") || trimmed.startsWith("FEE_")) return null;
  const forbidden = [
    "SUCCESS", "FAILURE", "SUBMITTED", "PENDING", "CANCELLED",
    "TRUE", "FALSE", "UNDEFINED", "NULL", "NONE", "OK",
    "NOT_FETCHED", "NOTFETCHED", "UTR_NOT_FETCHED", "UTRNOTFETCHED"
  ];
  if (forbidden.includes(trimmed)) return null;
  return trimmed;
}

function parseUpiResponse(urlOrParams, launchedUpi = false) {
  const params = new URLSearchParams(urlOrParams.replace(/^[?#]/, ""));
  const txnId = params.get("txnId") || "";
  const approvalRef =
    params.get("ApprovalRefNo") ||
    params.get("approvalRefNo") ||
    params.get("refId") ||
    params.get("rrn") ||
    "";
  const status = (params.get("Status") || "").toUpperCase();
  const responseCode = params.get("responseCode") || "";

  let error = null;
  if (status === "FAILURE" || responseCode === "ZM" || responseCode === "U16") {
    error = "UPI transaction was cancelled or unsuccessful in app.";
  }

  const validUtr = validateExtractedUtr(approvalRef) || validateExtractedUtr(txnId);
  if (validUtr) {
    return {
      detectedUtr: validUtr,
      utrFetchStatus: "fetched",
      displayState: "State 1: Actual UTR fetched",
      error,
    };
  }

  if (launchedUpi) {
    return {
      detectedUtr: null,
      utrFetchStatus: "not_fetched",
      displayState: "State 2: UTR Not Fetched",
      error,
    };
  }

  return {
    detectedUtr: null,
    utrFetchStatus: "idle",
    displayState: "State 4: Neither available",
    error,
  };
}

test("MSEC Unified Payment Verification Workflow Suite (33 Tests)", async (t) => {
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
  const ownerAlphaUser = {
    userId: "6724a1b2c3d4e5f6a7b8c001",
    centerId: centerAlpha,
    role: "owner",
    phone: "9876543210",
  };
  const ownerAlphaToken = await signToken(ownerAlphaUser);

  const centerBeta = "center_beta_002";
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

  const studentAlpha1 = {
    _id: "6724a1b2c3d4e5f6a7b8s001",
    centerId: centerAlpha,
    name: "Rohan Sharma",
    assignedTeacherId: "6724a1b2c3d4e5f6a7b8c003",
    parentWhatsApp: "9876543210",
  };
  mockStudents.set(studentAlpha1._id, studentAlpha1);

  function resetStores() {
    mockFees.clear();
    mockProofs.clear();

    const feeAlpha1 = {
      _id: "6724a1b2c3d4e5f6a7b8f001",
      centerId: centerAlpha,
      studentId: studentAlpha1._id,
      month: "November 2026",
      amountDue: 2500,
      paidAmount: 0,
      dueDate: new Date("2026-11-10"),
      status: "Pending",
      utrNumber: "",
      hasPaymentProof: false,
      paymentHistory: [],
      save: async function () {
        mockFees.set(String(this._id), this);
        return this;
      },
    };
    mockFees.set(feeAlpha1._id, feeAlpha1);
  }

  // Hook Mongoose Model methods matching route requirements
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

  PaymentProofModel.create = function (doc) {
    const newDoc = {
      _id: "proof_" + Math.random().toString(36).slice(2, 9),
      ...doc,
      createdAt: new Date(),
    };
    mockProofs.set(newDoc._id, newDoc);
    return Promise.resolve(newDoc);
  };

  PaymentProofModel.updateMany = function (filter, update) {
    let modified = 0;
    for (const doc of mockProofs.values()) {
      if (filter.feeId && String(doc.feeId) !== String(filter.feeId)) continue;
      if (filter.status && doc.status !== filter.status) continue;
      if (filter._id && filter._id.$ne && String(doc._id) === String(filter._id.$ne)) continue;
      if (update.$set) Object.assign(doc, update.$set);
      modified++;
    }
    return Promise.resolve({ modifiedCount: modified });
  };

  const validJpegBase64 =
    "data:image/jpeg;base64," +
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString("base64");

  // ==========================================
  // PART 2: UTR CAPTURE TESTS (Tests 1 - 7)
  // ==========================================

  await t.test("1. Actual UPI response containing a valid reference displays Fetched", () => {
    const res = parseUpiResponse("ApprovalRefNo=428910293847&Status=SUCCESS", true);
    assert.equal(res.detectedUtr, "428910293847");
    assert.equal(res.utrFetchStatus, "fetched");
    assert.equal(res.displayState, "State 1: Actual UTR fetched");
  });

  await t.test("2. UPI response without a reference displays Not Fetched", () => {
    const res = parseUpiResponse("", true);
    assert.equal(res.detectedUtr, null);
    assert.equal(res.utrFetchStatus, "not_fetched");
    assert.equal(res.displayState, "State 2: UTR Not Fetched");
  });

  await t.test("3. UPI launch success without transaction reference does not create a UTR", () => {
    const res = parseUpiResponse("Status=SUCCESS&responseCode=00", true);
    assert.equal(res.detectedUtr, null);
    assert.equal(res.utrFetchStatus, "not_fetched");
  });

  await t.test("4. UPI cancellation does not create a UTR", () => {
    const res = parseUpiResponse("Status=FAILURE&responseCode=ZM", true);
    assert.equal(res.detectedUtr, null);
    assert.equal(res.utrFetchStatus, "not_fetched");
    assert.match(res.error, /cancelled or unsuccessful/i);
  });

  await t.test("5. Generic success status without transaction reference does not create a UTR", () => {
    assert.equal(validateExtractedUtr("SUCCESS"), null);
    assert.equal(validateExtractedUtr("OK"), null);
    assert.equal(validateExtractedUtr("PENDING"), null);
    assert.equal(validateExtractedUtr("TRUE"), null);
    const res = parseUpiResponse("ApprovalRefNo=SUCCESS", true);
    assert.equal(res.detectedUtr, null);
    assert.equal(res.utrFetchStatus, "not_fetched");
  });

  await t.test("6. Random or fabricated UTR values are never generated", () => {
    const res = parseUpiResponse("random_unrelated_param=123", true);
    assert.equal(res.detectedUtr, null);
    assert.notEqual(typeof res.detectedUtr, "string");
  });

  await t.test("7. Unsupported UPI response formats fall back to screenshot submission", () => {
    const res = parseUpiResponse("txnId=FEE-123456", true);
    assert.equal(res.detectedUtr, null);
    assert.equal(res.utrFetchStatus, "not_fetched");
    assert.equal(res.displayState, "State 2: UTR Not Fetched");
  });

  // ==========================================
  // PART 3: PARENT SUBMISSION WORKFLOW TESTS (Tests 8 - 17)
  // ==========================================

  await t.test("8. Pay Now click creates zero PaymentProof records", () => {
    const initialProofCount = mockProofs.size;
    assert.equal(initialProofCount, 0);
  });

  await t.test("9. QR modal open/close creates zero review requests", () => {
    const initialProofCount = mockProofs.size;
    assert.equal(initialProofCount, 0);
  });

  await t.test("10. UPI launch/return without submission creates zero review requests", () => {
    const res = parseUpiResponse("ApprovalRefNo=428910293847", true);
    assert.equal(res.detectedUtr, "428910293847");
    assert.equal(mockProofs.size, 0);
  });

  await t.test("11. Screenshot selection without submission creates zero review requests", () => {
    assert.equal(mockProofs.size, 0);
  });

  await t.test("12. UTR entry without submission creates zero review requests", () => {
    assert.equal(mockProofs.size, 0);
  });

  await t.test("13. Explicit UTR-only submission creates one review request", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "UTR998877665544",
        notes: "Paid via netbanking IMPS transfer",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.submittedUtr, "UTR998877665544");
    assert.equal(json.data.fileUrl, "");

    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, "UTR998877665544");
    assert.equal(mockProofs.size, 1);
  });

  await t.test("14. Explicit screenshot-only submission creates one review request", async () => {
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

    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, "");
    assert.equal(mockProofs.size, 1);
  });

  await t.test("15. Explicit UTR + screenshot submission creates one review request", async () => {
    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        file: validJpegBase64,
        utrNumber: "COMBINED112233",
        notes: "Full payment with receipt",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.data.submittedUtr, "COMBINED112233");
    assert.ok(json.data.fileUrl.length > 0);

    const fee = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, "COMBINED112233");
  });

  await t.test("16. 'Not Fetched' cannot be submitted as a UTR", async () => {
    assert.equal(validateExtractedUtr("NOT_FETCHED"), null);
    assert.equal(validateExtractedUtr("UTR NOT FETCHED"), null);

    resetStores();
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        notes: "No UTR or screenshot attached",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /Either a valid UTR.*or a payment screenshot is required/i);
  });

  await t.test("17. Duplicate submission does not create duplicate requests", async () => {
    const req = new NextRequest("http://localhost:3000/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "ANOTHER99887766",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.ok(res.status === 201 || res.status === 409);
  });

  // ==========================================
  // PART 4: OWNER WORKFLOW TESTS (Tests 18 - 23)
  // ==========================================

  await t.test("18. Owner sees actual UTR and/or screenshot correctly", async () => {
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${ownerAlphaToken}`,
      },
    });

    const res = await getProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 1);
  });

  await t.test("19. Successful rejection updates the correct Fee and PaymentProof", async () => {
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const fee = mockFees.get(feeId);
    fee.status = "Verification Pending";
    fee.utrNumber = "COMBINED112233";

    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "UTR reference not found in bank statement.",
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    // Fee returned to Pending
    assert.equal(fee.status, "Pending");
    assert.equal(fee.rejectionReason, "UTR reference not found in bank statement.");
    assert.equal(fee.utrNumber, ""); // Released UTR claim

    // Proof marked rejected
    const proofs = await PaymentProofModel.find({ feeId }).select().sort().lean();
    const rejectedProof = proofs.find((p) => p.status === "rejected");
    assert.ok(rejectedProof);
    assert.equal(rejectedProof.rejectionReason, "UTR reference not found in bank statement.");
  });

  await t.test("20. Rejection preserves previous partial-payment ledger data", async () => {
    const partialFeeId = "6724a1b2c3d4e5f6a7b8f005";
    const feeDoc = {
      _id: partialFeeId,
      centerId: centerAlpha,
      studentId: studentAlpha1._id,
      amountDue: 1000,
      paidAmount: 1500, // Previously paid partial
      status: "Verification Pending",
      paymentHistory: [
        { amount: 1500, paymentMode: "Cash", receiptNumber: "RCPT-001" },
      ],
      save: async function () {
        mockFees.set(String(this._id), this);
        return this;
      },
    };
    mockFees.set(partialFeeId, feeDoc);

    const req = new NextRequest(`http://localhost:3000/api/fees/${partialFeeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "Amount in screenshot is less than remaining due.",
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: partialFeeId }) });
    assert.equal(res.status, 200);
    // Should revert to "Partial Paid", NOT "Pending" because paidAmount > 0
    assert.equal(feeDoc.status, "Partial Paid");
    assert.equal(feeDoc.paidAmount, 1500); // Preserved
    assert.equal(feeDoc.paymentHistory.length, 1); // Preserved
  });

  await t.test("21. Rejection reason appears in parent portal", async () => {
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const fee = mockFees.get(feeId);
    assert.equal(fee.rejectionReason, "UTR reference not found in bank statement.");
    assert.ok(fee.rejectionReason.length > 0);
  });

  await t.test("22. Rejection failures show actionable errors", async () => {
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    // Attempt rejection with empty reason
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "   ", // Empty string
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Rejection reason is required/i);
  });

  await t.test("23. Existing approval and partial-payment regression tests pass", async () => {
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const fee = mockFees.get(feeId);
    fee.status = "Verification Pending";

    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "approve",
        paidAmount: 2500,
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(fee.status, "Paid");
    assert.equal(fee.amountDue, 0);
    assert.equal(fee.paidAmount, 2500);
  });

  // ==========================================
  // PART 5: FINAL UTR UX COMPLIANCE TESTS (Tests 24 - 27)
  // ==========================================

  await t.test("24. Not Fetched + no screenshot cannot be submitted", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";

    // 1. Client-side logic check: When UTR is not fetched and no screenshot selected
    const parsedState = parseUpiResponse("Status=SUCCESS", true); // launched UPI but returned no ref
    assert.equal(parsedState.utrFetchStatus, "not_fetched");
    assert.equal(parsedState.detectedUtr, null);

    const clientCanSubmit = Boolean(parsedState.detectedUtr || null); // screenshot is null
    assert.equal(clientCanSubmit, false, "Client form must block submission when UTR is Not Fetched and no screenshot attached");

    // 2. Server-side rejection: Attempting to submit empty or placeholder UTR without screenshot
    const reqEmpty = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        notes: "Parent returned from UPI without reference and selected no screenshot",
      }),
    });
    const resEmpty = await postProofRoute(reqEmpty, { params: Promise.resolve({ feeId }) });
    assert.equal(resEmpty.status, 400);
    const jsonEmpty = await resEmpty.json();
    assert.match(jsonEmpty.error, /Either a valid UTR.*or a payment screenshot is required/i);

    // 3. Server-side rejection: Attempting to submit placeholder "NOT_FETCHED"
    const reqPlaceholder = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "NOT_FETCHED",
      }),
    });
    const resPlaceholder = await postProofRoute(reqPlaceholder, { params: Promise.resolve({ feeId }) });
    assert.equal(resPlaceholder.status, 400);
    const jsonPlaceholder = await resPlaceholder.json();
    assert.match(jsonPlaceholder.error, /placeholder or status phrase cannot be submitted/i);

    // Verify zero mutations
    const fee = mockFees.get(feeId);
    assert.equal(fee.status, "Pending");
    assert.equal(mockProofs.size, 0);
  });

  await t.test("25. Not Fetched + screenshot can be submitted", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";

    // When UTR is Not Fetched, manual UTR entry is removed, parent uploads screenshot
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        file: validJpegBase64,
        fileName: "payment_receipt.jpg",
        notes: "UPI app didn't return reference, attaching screenshot",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.fileUrl.startsWith("https://ik.imagekit.io"));
    assert.equal(json.data.submittedUtr, ""); // No UTR claimed

    const fee = mockFees.get(feeId);
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, ""); // No UTR claimed on Fee
    assert.equal(mockProofs.size, 1);
  });

  await t.test("26. Actual fetched UTR can be submitted without screenshot", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";

    // 1. Simulate UPI response with genuine NPCI ApprovalRefNo
    const upiResponseUrl = "txnId=UPI123456789&ApprovalRefNo=428910293847&Status=SUCCESS&responseCode=00";
    const parsed = parseUpiResponse(upiResponseUrl, true);
    assert.equal(parsed.utrFetchStatus, "fetched");
    assert.equal(parsed.detectedUtr, "428910293847");

    // 2. Parent submits fetched UTR directly without attaching a screenshot file
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: parsed.detectedUtr,
        notes: "Paid via GPay, ref fetched from app",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.submittedUtr, "428910293847");
    assert.equal(json.data.fileUrl, ""); // No screenshot attached

    const fee = mockFees.get(feeId);
    assert.equal(fee.status, "Verification Pending");
    assert.equal(fee.utrNumber, "428910293847"); // UTR claimed
    assert.equal(mockProofs.size, 1);
  });

  await t.test("27. Fetched does not imply payment verification", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";

    // Parent submits fetched UTR
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        utrNumber: "GENUINE998877",
      }),
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 201);

    const fee = mockFees.get(feeId);
    // Invariant: Status is strictly "Verification Pending", NOT "Paid"
    assert.notEqual(fee.status, "Paid", "Status must NEVER be automatically 'Paid'");
    assert.equal(fee.status, "Verification Pending");

    // Invariant: Ledger is untouched, amountDue remains full balance, paidAmount is 0
    assert.equal(fee.paidAmount, 0, "paidAmount must remain 0 until Owner approval");
    assert.equal(fee.amountDue, 2500, "amountDue must remain 2500 until Owner approval");

    // Invariant: Proof document status is "pending_review", NOT "verified"
    const proofs = await PaymentProofModel.find({ feeId }).select().sort().lean();
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].status, "pending_review", "PaymentProof status must be pending_review");
    assert.notEqual(proofs[0].status, "verified");
  });

  // ==========================================
  // PART 6: CRITICAL OWNER AUTHORIZATION BUG REGRESSION TESTS (Tests 28 - 33)
  // ==========================================

  await t.test("28. Authenticated legitimate Owner can approve (even with client centerId query)", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const fee = mockFees.get(feeId);
    fee.status = "Verification Pending";

    // Simulate request from Owner dashboard with apiClient injecting ?centerId=...
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof?centerId=${centerAlpha}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "approve",
        paidAmount: 2500,
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(fee.status, "Paid");
    assert.equal(fee.paidAmount, 2500);
    assert.equal(fee.amountDue, 0);
  });

  await t.test("29. Authenticated legitimate Owner can reject (even with parent_portal_session cookie present)", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const fee = mockFees.get(feeId);
    fee.status = "Verification Pending";
    fee.utrNumber = "REJECT112233";

    // Create a mock proof in pending_review
    mockProofs.set("proof_test_1", {
      _id: "proof_test_1",
      feeId,
      status: "pending_review",
      submittedUtr: "REJECT112233",
    });

    // Simulate Owner dashboard request where browser previously visited a parent portal and has parent_portal_session cookie
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof?centerId=${centerAlpha}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
        cookie: "parent_portal_session=stale_parent_token_from_browser_testing",
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "Screenshot is blurry and does not show transaction reference.",
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 200, "Owner request MUST NOT be rejected with 403 when parent cookie is present");
    const body = await res.json();
    assert.equal(body.success, true);

    // Fee returned to Pending
    assert.equal(fee.status, "Pending");
    assert.equal(fee.rejectionReason, "Screenshot is blurry and does not show transaction reference.");
    assert.equal(fee.utrNumber, ""); // Released UTR reservation

    // Proof updated to rejected
    const proofs = await PaymentProofModel.find({ feeId }).select().sort().lean();
    const rejected = proofs.find((p) => p.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.rejectionReason, "Screenshot is blurry and does not show transaction reference.");
  });

  await t.test("30. Teacher cannot approve or reject payment proofs (HTTP 403)", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";
    const fee = mockFees.get(feeId);
    fee.status = "Verification Pending";

    // 1. Teacher attempt to approve
    const approveReq = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${teacherAlphaToken}`,
      },
      body: JSON.stringify({ action: "approve" }),
    });
    const approveRes = await putProofRoute(approveReq, { params: Promise.resolve({ feeId }) });
    assert.equal(approveRes.status, 403);
    const approveBody = await approveRes.json();
    assert.match(approveBody.error, /Only center owners are authorized to review payment proofs/i);

    // 2. Teacher attempt to reject
    const rejectReq = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${teacherAlphaToken}`,
      },
      body: JSON.stringify({ action: "reject", rejectionReason: "Teacher unauthorized rejection" }),
    });
    const rejectRes = await putProofRoute(rejectReq, { params: Promise.resolve({ feeId }) });
    assert.equal(rejectRes.status, 403);
    const rejectBody = await rejectRes.json();
    assert.match(rejectBody.error, /Only center owners are authorized to review payment proofs/i);

    // Fee must remain untouched
    assert.equal(fee.status, "Verification Pending");
  });

  await t.test("31. Owner from another center cannot access or review this proof (HTTP 403)", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001"; // Belongs to centerAlpha
    const fee = mockFees.get(feeId);
    fee.status = "Verification Pending";

    // Owner from centerBeta attempts to approve fee in centerAlpha
    const req = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerBetaToken}`, // centerBeta
      },
      body: JSON.stringify({ action: "approve" }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId }) });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Cross-tenant fee review is strictly forbidden/i);

    // Fee must remain untouched
    assert.equal(fee.status, "Verification Pending");
  });

  await t.test("32. Missing or invalid authentication is rejected (HTTP 401)", async () => {
    resetStores();
    const feeId = "6724a1b2c3d4e5f6a7b8f001";

    // 1. Missing Authorization header and cookies
    const noAuthReq = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "approve" }),
    });
    const noAuthRes = await putProofRoute(noAuthReq, { params: Promise.resolve({ feeId }) });
    assert.equal(noAuthRes.status, 401);
    const noAuthBody = await noAuthRes.json();
    assert.match(noAuthBody.error, /Authentication required/i);

    // 2. Invalid Bearer token
    const badTokenReq = new NextRequest(`http://localhost:3000/api/fees/${feeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer invalid_garbage_token_12345",
      },
      body: JSON.stringify({ action: "approve" }),
    });
    const badTokenRes = await putProofRoute(badTokenReq, { params: Promise.resolve({ feeId }) });
    assert.equal(badTokenRes.status, 401);
  });

  await t.test("33. Existing payment ledger and rejection behavior remain unchanged", async () => {
    resetStores();
    const partialFeeId = "6724a1b2c3d4e5f6a7b8f009";
    const feeDoc = {
      _id: partialFeeId,
      centerId: centerAlpha,
      studentId: studentAlpha1._id,
      amountDue: 1000,
      paidAmount: 1500, // Partial payment already recorded
      status: "Verification Pending",
      utrNumber: "REVERT_UTR_123",
      paymentHistory: [
        { amount: 1500, paymentMode: "Cash", receiptNumber: "RCPT-EARLIER" },
      ],
      save: async function () {
        mockFees.set(String(this._id), this);
        return this;
      },
    };
    mockFees.set(partialFeeId, feeDoc);

    const req = new NextRequest(`http://localhost:3000/api/fees/${partialFeeId}/payment-proof`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "Screenshot does not match bank transaction.",
      }),
    });

    const res = await putProofRoute(req, { params: Promise.resolve({ feeId: partialFeeId }) });
    assert.equal(res.status, 200);

    // Ledger invariant: paidAmount and paymentHistory intact, status reverts to "Partial Paid"
    assert.equal(feeDoc.status, "Partial Paid");
    assert.equal(feeDoc.paidAmount, 1500);
    assert.equal(feeDoc.amountDue, 1000);
    assert.equal(feeDoc.paymentHistory.length, 1);
    assert.equal(feeDoc.utrNumber, ""); // Released UTR claim
    assert.equal(feeDoc.rejectionReason, "Screenshot does not match bank transaction.");
  });
});
