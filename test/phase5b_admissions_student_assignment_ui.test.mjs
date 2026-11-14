import test from "node:test";
import assert from "node:assert/strict";

test("Phase 5B: Admissions & Student Assignment UI Specification & Logic Suite", async (t) => {
  const mockStudents = [
    {
      _id: "s1",
      name: "Aarav Sharma",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9876543210",
      assignedTeacherId: null, // Owner assigned
      monthlyFee: 3000,
      isActive: true,
    },
    {
      _id: "s2",
      name: "Rohan Verma",
      batch: "Class 10 - Science",
      parentWhatsApp: "9123456789",
      assignedTeacherId: "teacher_alpha",
      monthlyFee: 2500,
      isActive: true,
    },
    {
      _id: "s3",
      name: "Neha Gupta",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9988776655",
      assignedTeacherId: "teacher_beta",
      monthlyFee: 2800,
      isActive: true,
    },
    {
      _id: "s4",
      name: "Simran Kaur",
      batch: "Class 9 - Foundation",
      parentWhatsApp: "9876501234",
      // legacy record without assignedTeacherId field
      monthlyFee: 2200,
      isActive: false,
    },
    {
      _id: "s5",
      name: "Ananya Iyer",
      batch: "Class 10 - Science",
      parentWhatsApp: "9000011111",
      assignedTeacherId: "teacher_alpha",
      monthlyFee: 2500,
      isActive: true,
    },
  ];

  const mockTeachers = [
    { _id: "teacher_alpha", name: "Rahul Sharma", loginId: "rahul_phy", isActive: true },
    { _id: "teacher_beta", name: "Priya Patel", loginId: "priya_chem", isActive: true },
    { _id: "teacher_gamma", name: "Amit Verma", loginId: "amit_math", isActive: false },
  ];

  // 1. Owner Filter Logic across All Students, My Students (Owner), and Individual Teachers
  await t.test("1. Owner Filters: 'all', 'owner', and specific teacher ID scoping", () => {
    function filterByTeacher(students, filter) {
      return students.filter((s) => {
        if (filter === "all") return true;
        if (filter === "owner") return !s.assignedTeacherId;
        return s.assignedTeacherId === filter;
      });
    }

    const all = filterByTeacher(mockStudents, "all");
    assert.equal(all.length, 5);

    const ownerOnly = filterByTeacher(mockStudents, "owner");
    // s1 (null) and s4 (undefined/legacy)
    assert.equal(ownerOnly.length, 2);
    assert.deepEqual(
      ownerOnly.map((s) => s._id),
      ["s1", "s4"]
    );

    const teacherAlphaOnly = filterByTeacher(mockStudents, "teacher_alpha");
    // s2 and s5
    assert.equal(teacherAlphaOnly.length, 2);
    assert.deepEqual(
      teacherAlphaOnly.map((s) => s._id),
      ["s2", "s5"]
    );

    const teacherBetaOnly = filterByTeacher(mockStudents, "teacher_beta");
    // s3
    assert.equal(teacherBetaOnly.length, 1);
    assert.equal(teacherBetaOnly[0]._id, "s3");
  });

  // 2. Multi-Axis Filtering (Search Text + Batch + Teacher Filter)
  await t.test("2. Multi-Axis Filter: Combines search text, batch selection, and teacher scoping", () => {
    function multiFilter(students, query, batchFilter, teacherFilter) {
      const q = query.trim().toLowerCase();
      const rawQ = query.trim();

      return students.filter((s) => {
        const matchSearch =
          q === "" ||
          s.name.toLowerCase().includes(q) ||
          s.parentWhatsApp.includes(rawQ);

        const matchBatch =
          batchFilter === "all" || s.batch === batchFilter;

        const matchTeacher =
          teacherFilter === "all" ||
          (teacherFilter === "owner" && !s.assignedTeacherId) ||
          s.assignedTeacherId === teacherFilter;

        return matchSearch && matchBatch && matchTeacher;
      });
    }

    // Teacher Alpha + Class 10 - Science -> s2, s5
    const res1 = multiFilter(mockStudents, "", "Class 10 - Science", "teacher_alpha");
    assert.equal(res1.length, 2);

    // Teacher Alpha + Class 10 - Science + search "Ananya" -> s5
    const res2 = multiFilter(mockStudents, "Ananya", "Class 10 - Science", "teacher_alpha");
    assert.equal(res2.length, 1);
    assert.equal(res2[0]._id, "s5");

    // Owner + Class 10 - Science -> 0 (none of Owner's students are in Science)
    const res3 = multiFilter(mockStudents, "", "Class 10 - Science", "owner");
    assert.equal(res3.length, 0);

    // Owner + Class 10 - Mathematics -> s1
    const res4 = multiFilter(mockStudents, "", "Class 10 - Mathematics", "owner");
    assert.equal(res4.length, 1);
    assert.equal(res4[0]._id, "s1");
  });

  // 3. Teacher Map Resolution
  await t.test("3. Teacher Map: resolves teacher ID to name and handles legacy records", () => {
    const teacherMap = {};
    mockTeachers.forEach((t) => {
      teacherMap[t._id] = t.name;
    });

    function resolveTeacherLabel(student) {
      if (!student.assignedTeacherId) {
        return "Owner";
      }
      return teacherMap[student.assignedTeacherId] || "Assigned Teacher";
    }

    assert.equal(resolveTeacherLabel(mockStudents[0]), "Owner");
    assert.equal(resolveTeacherLabel(mockStudents[1]), "Rahul Sharma");
    assert.equal(resolveTeacherLabel(mockStudents[2]), "Priya Patel");
    assert.equal(resolveTeacherLabel(mockStudents[3]), "Owner"); // legacy without field

    // Unknown foreign teacher ID
    assert.equal(resolveTeacherLabel({ assignedTeacherId: "foreign_id" }), "Assigned Teacher");
  });

  // 4. StudentFormModal Payload: Owner Mode
  await t.test("4. StudentFormModal: Owner mode formats assignedTeacherId as null or teacher ID", () => {
    function buildOwnerPayload(form) {
      const isTeacherUser = form.userRole === "teacher";
      const payloadTeacherId = isTeacherUser
        ? undefined
        : form.assignedTeacherId && form.assignedTeacherId !== "owner"
        ? form.assignedTeacherId
        : null;

      return {
        name: form.name.trim(),
        batch: form.batch.trim(),
        parentWhatsApp: form.parentWhatsApp.trim(),
        monthlyFee: Number(form.monthlyFee),
        billingCycleDate: Number(form.billingCycleDate),
        ...(!isTeacherUser ? { assignedTeacherId: payloadTeacherId } : {}),
      };
    }

    // Case 1: Owner assigns to Myself (Owner = empty string)
    const payload1 = buildOwnerPayload({
      userRole: "owner",
      name: "Tarun Das",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9876543210",
      monthlyFee: 2500,
      billingCycleDate: 5,
      assignedTeacherId: "",
    });
    assert.strictEqual(payload1.assignedTeacherId, null);

    // Case 2: Owner assigns to Myself (Owner = "owner")
    const payload2 = buildOwnerPayload({
      userRole: "owner",
      name: "Tarun Das",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9876543210",
      monthlyFee: 2500,
      billingCycleDate: 5,
      assignedTeacherId: "owner",
    });
    assert.strictEqual(payload2.assignedTeacherId, null);

    // Case 3: Owner assigns to Teacher Alpha
    const payload3 = buildOwnerPayload({
      userRole: "owner",
      name: "Tarun Das",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9876543210",
      monthlyFee: 2500,
      billingCycleDate: 5,
      assignedTeacherId: "teacher_alpha",
    });
    assert.equal(payload3.assignedTeacherId, "teacher_alpha");
  });

  // 5. StudentFormModal Payload: Teacher Mode
  await t.test("5. StudentFormModal: Teacher mode locks assignment and omits client override", () => {
    function buildTeacherPayload(form) {
      const isTeacherUser = form.userRole === "teacher";
      const payloadTeacherId = isTeacherUser
        ? undefined
        : form.assignedTeacherId && form.assignedTeacherId !== "owner"
        ? form.assignedTeacherId
        : null;

      return {
        name: form.name.trim(),
        batch: form.batch.trim(),
        parentWhatsApp: form.parentWhatsApp.trim(),
        monthlyFee: Number(form.monthlyFee),
        billingCycleDate: Number(form.billingCycleDate),
        ...(!isTeacherUser ? { assignedTeacherId: payloadTeacherId } : {}),
      };
    }

    // Teacher creating student: assignedTeacherId must not be supplied in payload
    const payload = buildTeacherPayload({
      userRole: "teacher",
      teacherId: "teacher_alpha",
      name: "Sneha Roy",
      batch: "Class 10 - Science",
      parentWhatsApp: "9123456789",
      monthlyFee: 2500,
      billingCycleDate: 5,
      assignedTeacherId: "rogue_teacher_id", // Client manipulation attempt
    });

    assert.equal(payload.assignedTeacherId, undefined);
  });

  // 6. Active Teachers Filtering for Modal Dropdown
  await t.test("6. Active Teachers Dropdown: Inactive teachers are excluded from assignment dropdown", () => {
    const activeTeachersOnly = mockTeachers.filter((t) => t.isActive !== false);

    assert.equal(activeTeachersOnly.length, 2);
    assert.deepEqual(
      activeTeachersOnly.map((t) => t._id),
      ["teacher_alpha", "teacher_beta"]
    );
    assert.ok(!activeTeachersOnly.some((t) => t._id === "teacher_gamma"));
  });
});
