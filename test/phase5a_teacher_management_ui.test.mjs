import test from "node:test";
import assert from "node:assert/strict";

test("Phase 5A: Owner Teacher Management UI Specification & Logic Suite", async (t) => {
  // 1. Role Protection Logic: Owner vs Teacher
  await t.test("1. Route Protection: Teacher visiting /teachers is denied and redirected to /", () => {
    function evaluateRouteAccess(role, pathname) {
      const ownerOnlyRoutes = ["/settings", "/teachers", "/reports"];
      if (ownerOnlyRoutes.includes(pathname) && role !== "owner") {
        return { allowed: false, redirect: "/" };
      }
      return { allowed: true };
    }

    const teacherAttempt = evaluateRouteAccess("teacher", "/teachers");
    assert.equal(teacherAttempt.allowed, false);
    assert.equal(teacherAttempt.redirect, "/");

    const ownerAttempt = evaluateRouteAccess("owner", "/teachers");
    assert.equal(ownerAttempt.allowed, true);
  });

  // 2. Search & Filtering Logic
  await t.test("2. Directory Filtering: filters teachers by status and search text", () => {
    const teachers = [
      {
        _id: "t1",
        name: "Rahul Sharma",
        phone: "9876543210",
        loginId: "rahul_phy",
        email: "rahul@example.com",
        subjects: ["Physics", "Mechanics"],
        isActive: true,
      },
      {
        _id: "t2",
        name: "Priya Patel",
        phone: "9123456780",
        loginId: "priya_chem",
        email: "priya@example.com",
        subjects: ["Chemistry"],
        isActive: false,
      },
      {
        _id: "t3",
        name: "Amit Verma",
        phone: "9988776655",
        loginId: "amit_math",
        email: "",
        subjects: ["Mathematics"],
        isActive: true,
      },
    ];

    function filterTeachers(list, filter, query) {
      return list.filter((t) => {
        if (filter === "active" && !t.isActive) return false;
        if (filter === "inactive" && t.isActive) return false;
        if (!query.trim()) return true;
        const q = query.toLowerCase().trim();
        return (
          t.name.toLowerCase().includes(q) ||
          t.phone.includes(q) ||
          t.loginId.toLowerCase().includes(q) ||
          (t.email && t.email.toLowerCase().includes(q)) ||
          t.subjects.some((s) => s.toLowerCase().includes(q))
        );
      });
    }

    // Status filter tests
    assert.equal(filterTeachers(teachers, "all", "").length, 3);
    assert.equal(filterTeachers(teachers, "active", "").length, 2);
    assert.equal(filterTeachers(teachers, "inactive", "").length, 1);
    assert.equal(filterTeachers(teachers, "inactive", "")[0]._id, "t2");

    // Search query tests
    assert.equal(filterTeachers(teachers, "all", "Physics").length, 1);
    assert.equal(filterTeachers(teachers, "all", "rahul").length, 1);
    assert.equal(filterTeachers(teachers, "all", "9123").length, 1);
    assert.equal(filterTeachers(teachers, "all", "chem").length, 1);
    assert.equal(filterTeachers(teachers, "active", "priya").length, 0); // Inactive
  });

  // 3. Client-side Form Validation
  await t.test("3. Form Validation: Create mode enforces required fields & 6-char password", () => {
    function validateTeacherForm(fields, isEditMode) {
      const errors = [];
      if (!fields.name || !fields.name.trim()) errors.push("Name is required");
      if (!fields.loginId || !fields.loginId.trim()) errors.push("Login ID is required");
      if (!fields.phone || fields.phone.replace(/\D/g, "").length < 10) {
        errors.push("Valid 10-digit phone number is required");
      }
      if (!isEditMode && (!fields.password || fields.password.trim().length < 6)) {
        errors.push("Password must be at least 6 characters");
      }
      if (isEditMode && fields.password && fields.password.trim().length < 6) {
        errors.push("New password must be at least 6 characters");
      }
      return errors;
    }

    // Invalid create (empty fields)
    const errs1 = validateTeacherForm({ name: "", loginId: "", phone: "123", password: "123" }, false);
    assert.equal(errs1.length, 4);

    // Valid create
    const errs2 = validateTeacherForm(
      { name: "Suresh Rao", loginId: "suresh123", phone: "9876543210", password: "securepass" },
      false
    );
    assert.equal(errs2.length, 0);

    // Edit mode with empty password (preserves existing password)
    const errs3 = validateTeacherForm(
      { name: "Suresh Rao", loginId: "suresh123", phone: "9876543210", password: "" },
      true
    );
    assert.equal(errs3.length, 0);

    // Edit mode with short new password
    const errs4 = validateTeacherForm(
      { name: "Suresh Rao", loginId: "suresh123", phone: "9876543210", password: "123" },
      true
    );
    assert.equal(errs4.length, 1);
    assert.match(errs4[0], /at least 6 characters/);
  });

  // 4. Subject Parsing Logic
  await t.test("4. Subjects Formatting: splits comma-separated input into clean array", () => {
    function parseSubjects(input) {
      return input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    assert.deepEqual(parseSubjects("Physics, Chemistry , Mathematics"), [
      "Physics",
      "Chemistry",
      "Mathematics",
    ]);
    assert.deepEqual(parseSubjects("  ,  Biology ,   "), ["Biology"]);
    assert.deepEqual(parseSubjects(""), []);
  });

  // 5. Create Teacher Payload Preparation
  await t.test("5. POST Payload Preparation: structures clean Teacher creation request", () => {
    function buildCreatePayload(form) {
      return {
        name: form.name.trim(),
        loginId: form.loginId.trim(),
        phone: form.phone.trim(),
        email: form.email ? form.email.trim().toLowerCase() : "",
        password: form.password.trim(),
        subjects: form.subjectsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        isActive: form.isActive !== false,
      };
    }

    const payload = buildCreatePayload({
      name: "  Vikas Kumar  ",
      loginId: "  vikas_chem  ",
      phone: "  9876543210 ",
      email: "  Vikas@Example.COM ",
      password: "  mypassword123  ",
      subjectsText: "Inorganic Chemistry, Organic Chemistry",
      isActive: true,
    });

    assert.equal(payload.name, "Vikas Kumar");
    assert.equal(payload.loginId, "vikas_chem");
    assert.equal(payload.phone, "9876543210");
    assert.equal(payload.email, "vikas@example.com");
    assert.equal(payload.password, "mypassword123");
    assert.deepEqual(payload.subjects, ["Inorganic Chemistry", "Organic Chemistry"]);
    assert.equal(payload.isActive, true);
  });

  // 6. Edit Teacher Payload Preparation
  await t.test("6. PUT Payload Preparation: omits empty password from update payload", () => {
    function buildUpdatePayload(form) {
      const payload = {
        name: form.name.trim(),
        loginId: form.loginId.trim(),
        phone: form.phone.trim(),
        email: form.email ? form.email.trim().toLowerCase() : "",
        subjects: form.subjectsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        isActive: form.isActive,
      };
      if (form.password && form.password.trim()) {
        payload.password = form.password.trim();
      }
      return payload;
    }

    const withoutPassword = buildUpdatePayload({
      name: "Vikas Kumar",
      loginId: "vikas_chem",
      phone: "9876543210",
      email: "",
      password: "",
      subjectsText: "Physics",
      isActive: false,
    });
    assert.equal(withoutPassword.password, undefined);
    assert.equal(withoutPassword.isActive, false);

    const withPassword = buildUpdatePayload({
      name: "Vikas Kumar",
      loginId: "vikas_chem",
      phone: "9876543210",
      email: "",
      password: "newsecretpassword",
      subjectsText: "Physics",
      isActive: true,
    });
    assert.equal(withPassword.password, "newsecretpassword");
  });

  // 7. Active / Inactive Status Toggle Payload
  await t.test("7. Status Toggle: constructs single-field update for deactivation/activation", () => {
    function buildStatusTogglePayload(currentStatus) {
      return { isActive: !currentStatus };
    }

    assert.deepEqual(buildStatusTogglePayload(true), { isActive: false });
    assert.deepEqual(buildStatusTogglePayload(false), { isActive: true });
  });

  // 8. Error Mapping: HTTP 409 Conflict Handling
  await t.test("8. Error Mapping: Form catches and formats duplicate phone/loginId conflict", () => {
    function formatApiError(responseStatus, responseBody) {
      if (responseStatus === 409) {
        return `Conflict: ${responseBody.error || "Phone number or login ID already exists in this institute."}`;
      }
      if (responseStatus === 403) {
        return "Access denied: Only Institute Owners may manage teachers.";
      }
      return responseBody.error || "An unexpected error occurred.";
    }

    const conflictErr = formatApiError(409, {
      error: "Phone number or login ID conflicts with an existing teacher in this institute",
    });
    assert.match(conflictErr, /Conflict: Phone number or login ID/);

    const forbiddenErr = formatApiError(403, {});
    assert.match(forbiddenErr, /Access denied/);
  });
});
