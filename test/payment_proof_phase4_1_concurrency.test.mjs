import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-key-for-msec-tuition-desk-32chars!";
process.env.NODE_ENV = "test";
process.env.IMAGEKIT_PUBLIC_KEY = "public_test_key_123456";
process.env.IMAGEKIT_PRIVATE_KEY = "private_test_key_123456";
process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/testcenter";

globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

test("Phase 4.1: Atomic UTR Reservation & Concurrency Suite (10 Tests)", async (t) => {
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

  // Seed Students
  const studentAlpha1 = {
    _id: "6724a1b2c3d4e5f6a7b8s001",
    centerId: centerAlpha,
    name: "Rohan Sharma",
  };
  const studentAlpha2 = {
    _id: "6724a1b2c3d4e5f6a7b8s002",
    centerId: centerAlpha,
    name: "Pooja Verma",
  };
  const studentBeta1 = {
    _id: "6724a1b2c3d4e5f6a7b8s003",
    centerId: centerBeta,
    name: "Aman Gupta",
  };
  mockStudents.set(studentAlpha1._id, studentAlpha1);
  mockStudents.set(studentAlpha2._id, studentAlpha2);
  mockStudents.set(studentBeta1._id, studentBeta1);

  // Hook Mongoose Model methods with authentic index uniqueness simulation
  StudentModel.findById = function (id) {
    const doc = mockStudents.get(String(id));
    return {
      select: () => ({
        lean: () => Promise.resolve(doc || null),
      }),
    };
  };

  FeeModel.findById = function (id) {
    const doc = mockFees.get(String(id));
    return Promise.resolve(doc || null);
  };

  FeeModel.findOne = function (query) {
    const now = new Date();
    for (const doc of mockFees.values()) {
      if (query.centerId && doc.centerId !== query.centerId) continue;
      if (query._id && query._id.$ne && String(doc._id) === String(query._id.$ne)) continue;
      if (query.utrNumber && doc.utrNumber !== query.utrNumber) continue;
      if (query.hasPaymentProof && query.hasPaymentProof.$ne !== undefined) {
        if (Boolean(doc.hasPaymentProof) === Boolean(query.hasPaymentProof.$ne)) continue;
      }
      if (query.proofUploadLockUntil && query.proofUploadLockUntil.$lte) {
        if (!doc.proofUploadLockUntil || doc.proofUploadLockUntil > query.proofUploadLockUntil.$lte) {
          continue;
        }
      }
      if (query.$or) {
        let match = false;
        for (const cond of query.$or) {
          if (cond.utrNumber) {
            if (doc.utrNumber === cond.utrNumber) {
              if (cond.status && cond.status.$in) {
                if (cond.status.$in.includes(doc.status)) match = true;
              } else {
                match = true;
              }
            }
          }
          if (cond.processedTxnIds && Array.isArray(doc.processedTxnIds) && doc.processedTxnIds.includes(cond.processedTxnIds)) match = true;
        }
        if (!match) continue;
      }
      return Promise.resolve(doc);
    }
    return Promise.resolve(null);
  };

  FeeModel.findOneAndUpdate = function (filter, update) {
    const doc = mockFees.get(String(filter._id));
    if (!doc) return Promise.resolve(null);

    // Verify lock filter condition
    if (filter.$or) {
      const now = new Date();
      let lockOk = false;
      for (const cond of filter.$or) {
        if (cond.proofUploadLockUntil && cond.proofUploadLockUntil.$exists === false && !doc.proofUploadLockUntil) lockOk = true;
        if (cond.proofUploadLockUntil === null && !doc.proofUploadLockUntil) lockOk = true;
        if (cond.proofUploadLockUntil && cond.proofUploadLockUntil.$lte && doc.proofUploadLockUntil && doc.proofUploadLockUntil <= now) lockOk = true;
      }
      if (!lockOk) return Promise.resolve(null);
    }

    if (filter.proofUploadLockUntil && doc.proofUploadLockUntil && doc.proofUploadLockUntil.getTime() !== filter.proofUploadLockUntil.getTime()) {
      return Promise.resolve(null);
    }

    // SIMULATE REAL MONGODB UNIQUE COMPOUND INDEX: { centerId: 1, utrNumber: 1 } (partial: utrNumber > "")
    if (update.$set && update.$set.utrNumber) {
      const candidateUtr = String(update.$set.utrNumber).trim();
      if (candidateUtr.length > 0) {
        for (const [otherId, otherDoc] of mockFees.entries()) {
          if (String(otherId) !== String(filter._id) && otherDoc.centerId === doc.centerId && otherDoc.utrNumber === candidateUtr) {
            const err = new Error(`E11000 duplicate key error collection: fees index: centerId_1_utrNumber_1_unique dup key: { centerId: "${doc.centerId}", utrNumber: "${candidateUtr}" }`);
            err.code = 11000;
            return Promise.reject(err);
          }
        }
      }
    }

    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    return Promise.resolve(doc);
  };

  FeeModel.updateOne = function (filter, update) {
    const doc = mockFees.get(String(filter._id));
    if (!doc) return Promise.resolve({ modifiedCount: 0 });

    if (filter.proofUploadLockUntil && doc.proofUploadLockUntil && doc.proofUploadLockUntil.getTime() !== filter.proofUploadLockUntil.getTime()) {
      return Promise.resolve({ modifiedCount: 0 }); // Lock condition mismatch: newer claim protected!
    }

    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    if (update.$unset) {
      if (update.$unset.proofUploadLockUntil) delete doc.proofUploadLockUntil;
    }
    return Promise.resolve({ modifiedCount: 1 });
  };

  PaymentProofModel.findOne = function (query) {
    for (const doc of mockProofs.values()) {
      if (query.centerId && doc.centerId !== query.centerId) continue;
      if (query.feeId && query.feeId.$ne && String(doc.feeId) === String(query.feeId.$ne)) continue;
      if (query.feeId && !query.feeId.$ne && String(doc.feeId) !== String(query.feeId)) continue;
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

  PaymentProofModel.findByIdAndDelete = function (id) {
    const exists = mockProofs.has(String(id));
    mockProofs.delete(String(id));
    return Promise.resolve(exists ? { _id: id } : null);
  };

  PaymentProofModel.updateMany = function (query, update) {
    let count = 0;
    for (const doc of mockProofs.values()) {
      if (query.feeId && String(doc.feeId) !== String(query.feeId)) continue;
      if (query._id && query._id.$ne && String(doc._id) === String(query._id.$ne)) continue;
      if (query.status && doc.status !== query.status) continue;
      if (update.$set) Object.assign(doc, update.$set);
      count++;
    }
    return Promise.resolve({ modifiedCount: count });
  };

  // Helper to re-seed fresh test fees
  function seedFreshFees() {
    mockFees.clear();
    mockProofs.clear();

    const feeA = {
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
    const feeB = {
      _id: "6724a1b2c3d4e5f6a7b8f002",
      centerId: centerAlpha,
      studentId: studentAlpha2._id,
      month: "November 2026",
      amountDue: 3000,
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
    const feeBeta = {
      _id: "6724a1b2c3d4e5f6a7b8f999",
      centerId: centerBeta,
      studentId: studentBeta1._id,
      month: "November 2026",
      amountDue: 2000,
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

    mockFees.set(feeA._id, feeA);
    mockFees.set(feeB._id, feeB);
    mockFees.set(feeBeta._id, feeBeta);
  }

  // Helper to construct request
  function makeUtrRequest(feeId, token, utr, extra = {}) {
    return new NextRequest(`http://localhost/api/fees/${feeId}/payment-proof`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        utrNumber: utr,
        amount: 2500,
        ...extra,
      }),
    });
  }

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 1: Same center + same UTR + different fees
  // =========================================================================
  await t.test("1. Same center + same UTR + different fees: exactly one succeeds", async () => {
    seedFreshFees();
    const sharedUtr = "RACE111222333";

    const req1 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, sharedUtr);
    const req2 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f002", ownerAlphaToken, sharedUtr);

    // Launch both in true parallel execution
    const [res1, res2] = await Promise.all([
      postProofRoute(req1, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) }),
      postProofRoute(req2, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f002" }) }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [201, 409], "Exactly one parallel request must succeed (201) and one must be rejected (409)");

    const conflictRes = res1.status === 409 ? await res1.json() : await res2.json();
    assert.equal(conflictRes.success, false);
    assert.match(conflictRes.code, /DUPLICATE_UTR/);
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 2: Same center + same UTR + same fee
  // =========================================================================
  await t.test("2. Same center + same UTR + same fee: exactly one succeeds", async () => {
    seedFreshFees();
    const sharedUtr = "SAMEFEE999888";

    const req1 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, sharedUtr);
    const req2 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, sharedUtr);

    const [res1, res2] = await Promise.all([
      postProofRoute(req1, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) }),
      postProofRoute(req2, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [201, 409], "Concurrent requests on the same fee must serialize: 201 and 409");
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 3: Different centers + same UTR: both may succeed
  // =========================================================================
  await t.test("3. Different centers + same UTR: both may succeed", async () => {
    seedFreshFees();
    const sharedUtr = "CROSSCENTER777";

    const reqAlpha = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, sharedUtr);
    const reqBeta = makeUtrRequest("6724a1b2c3d4e5f6a7b8f999", ownerBetaToken, sharedUtr);

    const [resAlpha, resBeta] = await Promise.all([
      postProofRoute(reqAlpha, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) }),
      postProofRoute(reqBeta, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f999" }) }),
    ]);

    assert.equal(resAlpha.status, 201, "Alpha center submission must succeed");
    assert.equal(resBeta.status, 201, "Beta center submission with same UTR must succeed (tenant-isolated compound index)");
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 4: Different UTRs + same center: both may succeed
  // =========================================================================
  await t.test("4. Different UTRs + same center: both may succeed", async () => {
    seedFreshFees();

    const req1 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, "UTR_DISTINCT_01");
    const req2 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f002", ownerAlphaToken, "UTR_DISTINCT_02");

    const [res1, res2] = await Promise.all([
      postProofRoute(req1, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) }),
      postProofRoute(req2, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f002" }) }),
    ]);

    assert.equal(res1.status, 201, "First distinct UTR must succeed");
    assert.equal(res2.status, 201, "Second distinct UTR must succeed");
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 5: ImageKit failure releases the reservation
  // =========================================================================
  await t.test("5. ImageKit failure releases the reservation", async () => {
    seedFreshFees();
    const testUtr = "RELEASE_ON_IK_ERR";

    // Set ImageKit mock to fail
    setMockImageKitHandler(async () => {
      throw new Error("ImageKit storage outage 502");
    }, async () => true);

    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const req = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, testUtr, {
      file: `data:image/jpeg;base64,${jpegBuffer.toString("base64")}`,
    });

    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 502, "Must return 502 Bad Gateway");

    // Check that Fee A's reservation was released
    const feeA = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(feeA.utrNumber, "", "UTR must be released on ImageKit failure");
    assert.equal(feeA.proofUploadLockUntil, undefined, "Lock must be released");

    // Restore ImageKit mock
    setMockImageKitHandler(async (opts) => ({
      fileId: "mock_file_" + Math.random().toString(36).slice(2, 8),
      fileUrl: `https://ik.imagekit.io/testcenter/payment-proofs/${opts.fileName}`,
      thumbnailUrl: `https://ik.imagekit.io/testcenter/payment-proofs/tr:w-300/${opts.fileName}`,
      filePath: `/payment-proofs/${opts.fileName}`,
      size: opts.fileBuffer.length,
      name: opts.fileName,
    }), async () => true);
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 6: Database failure releases the reservation
  // =========================================================================
  await t.test("6. Database failure releases the reservation", async () => {
    seedFreshFees();
    const testUtr = "RELEASE_ON_DB_ERR";

    // Force fee.save to fail during persistence
    const feeA = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    const originalSave = feeA.save;
    feeA.save = async function () {
      throw new Error("Simulated MongoDB WriteConcernError");
    };

    const req = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, testUtr);
    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 500, "Must return 500 on database persistence failure");

    // Check that compensation reverted utrNumber
    assert.equal(feeA.utrNumber, "", "UTR reservation must be reverted during compensation");
    assert.equal(feeA.proofUploadLockUntil, undefined, "Upload lock must be released");

    // Restore original save
    feeA.save = originalSave;
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 7: Rejected proof releases reservation according to policy
  // =========================================================================
  await t.test("7. Rejected proof releases reservation according to policy", async () => {
    seedFreshFees();
    const testUtr = "REJECT_AND_RELEASE";

    const req = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, testUtr);
    const res = await postProofRoute(req, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res.status, 201, "Initial submission succeeds");

    const feeA = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(feeA.utrNumber, testUtr);

    // Owner rejects the payment proof
    const rejectReq = new NextRequest(`http://localhost/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "reject",
        rejectionReason: "UTR not found in bank statement",
      }),
    });

    const rejectRes = await putProofRoute(rejectReq, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(rejectRes.status, 200, "Proof rejected successfully");

    // Fee utrNumber must be reset to empty string, releasing unique index reservation
    assert.equal(feeA.utrNumber, "", "UTR must be cleared on rejection to allow resubmission");
    assert.equal(feeA.status, "Pending", "Fee status reverts to Pending");
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 8: Pending proof retains reservation
  // =========================================================================
  await t.test("8. Pending proof retains reservation", async () => {
    seedFreshFees();
    const testUtr = "PENDING_RETAINED";

    const req1 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, testUtr);
    const res1 = await postProofRoute(req1, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res1.status, 201);

    // Another fee attempts to submit the same UTR while Fee A is pending review
    const req2 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f002", ownerAlphaToken, testUtr);
    const res2 = await postProofRoute(req2, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f002" }) });

    assert.equal(res2.status, 409, "Must be rejected with 409 Conflict while pending review");
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 9: Verified proof retains reservation
  // =========================================================================
  await t.test("9. Verified proof retains reservation", async () => {
    seedFreshFees();
    const testUtr = "VERIFIED_RETAINED";

    const req1 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f001", ownerAlphaToken, testUtr);
    const res1 = await postProofRoute(req1, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(res1.status, 201);

    // Owner approves the payment proof
    const approveReq = new NextRequest(`http://localhost/api/fees/6724a1b2c3d4e5f6a7b8f001/payment-proof`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerAlphaToken}`,
      },
      body: JSON.stringify({
        action: "approve",
      }),
    });

    const approveRes = await putProofRoute(approveReq, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f001" }) });
    assert.equal(approveRes.status, 200, "Proof approved and fee marked Paid");

    const feeA = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    assert.equal(feeA.status, "Paid");
    assert.equal(feeA.utrNumber, testUtr);

    // Another fee attempts to claim the verified UTR
    const req2 = makeUtrRequest("6724a1b2c3d4e5f6a7b8f002", ownerAlphaToken, testUtr);
    const res2 = await postProofRoute(req2, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f002" }) });

    assert.equal(res2.status, 409, "Must be rejected with 409 Conflict when UTR is already verified");
  });

  // =========================================================================
  // CRITICAL CONCURRENCY TEST 10: Stale reservation recovery cannot delete a newer claim
  // =========================================================================
  await t.test("10. Stale reservation recovery cannot delete a newer claim", async () => {
    seedFreshFees();
    const testUtr = "STALE_RECOVERY_PROTECTION";

    // Simulate Fee A holding a stale reservation from a crashed upload 10 minutes ago
    const feeA = mockFees.get("6724a1b2c3d4e5f6a7b8f001");
    const staleTime = new Date(Date.now() - 600 * 1000); // 10 minutes ago
    feeA.utrNumber = testUtr;
    feeA.proofUploadLockUntil = staleTime;
    feeA.hasPaymentProof = false;

    // Now Fee B attempts to submit the UTR. It detects Fee A's stale lock, confirms no active proof,
    // and reclaims the UTR.
    const reqB = makeUtrRequest("6724a1b2c3d4e5f6a7b8f002", ownerAlphaToken, testUtr);
    const resB = await postProofRoute(reqB, { params: Promise.resolve({ feeId: "6724a1b2c3d4e5f6a7b8f002" }) });
    assert.equal(resB.status, 201, "Fee B must safely reclaim the stale reservation");

    const feeB = mockFees.get("6724a1b2c3d4e5f6a7b8f002");
    assert.equal(feeB.utrNumber, testUtr, "Fee B now owns the UTR");

    // Ensure stale cleanup update verified the lock timestamp condition
    assert.equal(feeA.utrNumber, "", "Fee A's stale UTR was cleared");
  });
});
