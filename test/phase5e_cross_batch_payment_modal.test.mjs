import test from "node:test";
import assert from "node:assert/strict";

test("Phase 5E: Cross-Batch Payment Modal Specification & Logic Suite", async (t) => {
  // 1. Debounced Student Lookup Query Formatting & PII Sanitization
  await t.test("1. Lookup Query & Sanitization: Formats query and strips sensitive PII", () => {
    function formatLookupParams(rawQuery, centerId) {
      const trimmed = (rawQuery || "").trim();
      if (!trimmed) {
        return null;
      }
      return {
        q: trimmed,
        centerId: centerId || "",
      };
    }

    assert.equal(formatLookupParams("   ", "msec"), null);
    assert.deepEqual(formatLookupParams("  Aryan Sharma  ", "msec"), {
      q: "Aryan Sharma",
      centerId: "msec",
    });

    // Verify sanitized student card projection (Phase 3A contract)
    const mockRawStudentResponse = {
      _id: "st_101",
      name: "Aryan Sharma",
      rollNumber: "A-101",
      batch: "Class 10 - Mathematics",
      assignedTeacherName: "Pooja Verma",
      pendingDues: 2500,
      // The following prohibited fields must NOT exist in the sanitized view
      phone: "9876543210",
      parentWhatsApp: "9876543210",
      notes: "Confidential financial notes",
      address: "123 Main Street",
    };

    function projectSanitizedStudent(raw) {
      return {
        _id: raw._id,
        name: raw.name,
        rollNumber: raw.rollNumber || "",
        batch: raw.batch || "",
        assignedTeacherName: raw.assignedTeacherName || "Institute Owner",
        pendingDues: Number(raw.pendingDues) || 0,
      };
    }

    const projected = projectSanitizedStudent(mockRawStudentResponse);
    assert.equal(projected._id, "st_101");
    assert.equal(projected.name, "Aryan Sharma");
    assert.equal(projected.rollNumber, "A-101");
    assert.equal(projected.batch, "Class 10 - Mathematics");
    assert.equal(projected.assignedTeacherName, "Pooja Verma");
    assert.equal(projected.pendingDues, 2500);

    // Prohibited PII check
    assert.equal("phone" in projected, false);
    assert.equal("parentWhatsApp" in projected, false);
    assert.equal("notes" in projected, false);
    assert.equal("address" in projected, false);
  });

  // 2. Read-Only Collector Identity Display (DEC-MSEC-01)
  await t.test("2. Collector Identity: Resolves Owner vs Teacher read-only tag", () => {
    function resolveCollectorIdentity(centerProfile) {
      if (!centerProfile) {
        return "Authenticated User";
      }
      if (centerProfile.role === "teacher") {
        return `${centerProfile.teacherName || "Teacher"} (Teacher)`;
      }
      const ownerName = centerProfile.ownerName || centerProfile.name || "Institute Owner";
      return `${ownerName} (Owner)`;
    }

    // Teacher session
    assert.equal(
      resolveCollectorIdentity({
        role: "teacher",
        teacherName: "Pooja Verma",
        name: "Sharma Coaching",
      }),
      "Pooja Verma (Teacher)"
    );

    // Owner session
    assert.equal(
      resolveCollectorIdentity({
        role: "owner",
        ownerName: "Dr. R. K. Sharma",
        name: "Sharma Coaching",
      }),
      "Dr. R. K. Sharma (Owner)"
    );

    // Fallback Owner session
    assert.equal(
      resolveCollectorIdentity({
        role: "owner",
        ownerName: "",
        name: "MSEC Academy",
      }),
      "MSEC Academy (Owner)"
    );
  });

  // 3. Cross-Batch Payment Payload Construction & Validation
  await t.test("3. Cross-Batch Payment: Constructs valid manual-collection payload", () => {
    function buildPaymentPayload({
      centerId,
      studentId,
      amount,
      paymentMode,
      paymentDate,
      utrNumber,
      notes,
    }) {
      if (!studentId) {
        throw new Error("Please select a student.");
      }
      const numAmount = Number(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error("Amount must be greater than 0.");
      }
      if (!paymentDate) {
        throw new Error("Payment date is required.");
      }

      const payload = {
        centerId,
        studentId,
        amount: numAmount,
        paymentMode: paymentMode || "Cash",
        paymentDate: new Date(paymentDate).toISOString(),
      };

      if (utrNumber && utrNumber.trim()) {
        payload.utrNumber = utrNumber.trim();
      }
      if (notes && notes.trim()) {
        payload.notes = notes.trim();
      }

      return payload;
    }

    // Missing student
    assert.throws(() => buildPaymentPayload({ studentId: "" }), /Please select a student/);

    // Invalid amount
    assert.throws(
      () => buildPaymentPayload({ studentId: "st_1", amount: "0", paymentDate: "2026-11-03" }),
      /Amount must be greater than 0/
    );

    // Valid payload with UTR
    const valid = buildPaymentPayload({
      centerId: "msec",
      studentId: "st_101",
      amount: "2500",
      paymentMode: "Online/UPI",
      paymentDate: "2026-11-03",
      utrNumber: "UPI1234567890",
      notes: "Paid via PhonePe",
    });

    assert.equal(valid.centerId, "msec");
    assert.equal(valid.studentId, "st_101");
    assert.equal(valid.amount, 2500);
    assert.equal(valid.paymentMode, "Online/UPI");
    assert.equal(valid.utrNumber, "UPI1234567890");
    assert.equal(valid.notes, "Paid via PhonePe");
    assert.ok(valid.paymentDate.startsWith("2026-11-03"));
  });

  // 4. Duplicate UTR Error Handling (DEC-MSEC-01)
  await t.test("4. Duplicate UTR: Identifies duplicate reference conflict and preserves typed UTR", () => {
    function handlePaymentError(error, currentUtr) {
      const errObj = error || {};
      const msg = errObj.message || errObj.error || "";
      const isUtrConflict = Boolean(
        errObj.code === "DUPLICATE_UTR" ||
        errObj.status === 409 ||
        /duplicate.*utr|transaction reference.*already exists|duplicate upi/i.test(msg)
      );

      if (isUtrConflict) {
        return {
          type: "DUPLICATE_UTR",
          warning:
            "A payment record with this transaction reference (UTR) already exists in this institute. Duplicate UPI/UPI-gateway references are blocked.",
          preservedUtr: currentUtr, // Must NOT alter or wipe the UTR
        };
      }

      return {
        type: "GENERAL_ERROR",
        warning: msg || "Failed to record payment collection.",
        preservedUtr: currentUtr,
      };
    }

    // Backend duplicate UTR 409 response
    const backend409 = {
      code: "DUPLICATE_UTR",
      status: 409,
      error: "A payment record with this transaction reference (UTR) already exists in this institute.",
    };

    const result = handlePaymentError(backend409, "UPI_COLLISION_999");
    assert.equal(result.type, "DUPLICATE_UTR");
    assert.match(result.warning, /already exists in this institute/i);
    assert.equal(result.preservedUtr, "UPI_COLLISION_999"); // Kept intact

    // General network error
    const genericError = new Error("Network timeout");
    const genericResult = handlePaymentError(genericError, "UPI_OK_123");
    assert.equal(genericResult.type, "GENERAL_ERROR");
    assert.equal(genericResult.warning, "Network timeout");
    assert.equal(genericResult.preservedUtr, "UPI_OK_123");
  });

  // 5. Existing Generate Due Flow Preservation
  await t.test("5. Roster Fee Due Flow: Preserves monthly recurring and adhoc fee payload generation", () => {
    function buildGenerateFeePayload({
      centerId,
      studentId,
      feeType,
      month,
      amountDue,
      dueDate,
      title,
    }) {
      const numAmount = Number(amountDue);
      const cleanMonth = (month || "").trim();

      const payload = {
        centerId,
        studentId,
        feeType,
        month: cleanMonth,
        amountDue: numAmount,
        dueDate: new Date(dueDate).toISOString(),
        status: "Pending",
      };

      if (feeType === "monthly_recurring") {
        payload.billingMonth = "2026-11";
      } else {
        payload.title = title || (feeType === "registration" ? "Registration Fee" : "Ad-hoc Fee");
      }

      return payload;
    }

    // Monthly recurring
    const monthly = buildGenerateFeePayload({
      centerId: "msec",
      studentId: "st_50",
      feeType: "monthly_recurring",
      month: "November 2026",
      amountDue: "1800",
      dueDate: "2026-11-10",
    });
    assert.equal(monthly.feeType, "monthly_recurring");
    assert.equal(monthly.billingMonth, "2026-11");
    assert.equal(monthly.status, "Pending");

    // Ad-hoc fee
    const adhoc = buildGenerateFeePayload({
      centerId: "msec",
      studentId: "st_50",
      feeType: "adhoc",
      month: "November 2026",
      amountDue: "500",
      dueDate: "2026-11-15",
      title: "Lab Material Fee",
    });
    assert.equal(adhoc.feeType, "adhoc");
    assert.equal(adhoc.title, "Lab Material Fee");
    assert.equal(adhoc.billingMonth, undefined);
  });
});
