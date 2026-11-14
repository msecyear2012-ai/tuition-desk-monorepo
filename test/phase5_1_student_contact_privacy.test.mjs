process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";

// Import backend models & routes
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { maskContactNumber } = await import("../tution-desk-be/src/lib/privacyUtils.ts");
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const FeeModel = (await import("../tution-desk-be/src/models/Fee.ts")).default;
const AttendanceModel = (await import("../tution-desk-be/src/models/Attendance.ts")).default;
const BatchModel = (await import("../tution-desk-be/src/models/Batch.ts")).default;
const CenterModel = (await import("../tution-desk-be/src/models/Center.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;
const ParentAccessModel = (await import("../tution-desk-be/src/models/ParentAccess.ts")).default;
const ParentAccessLockModel = (await import("../tution-desk-be/src/models/ParentAccessLock.ts")).default;
const { AdmissionWelcomeJob } = await import("../tution-desk-be/src/models/AdmissionWelcomeJob.ts");

const { GET: getStudentsRoute, POST: postStudentRoute } = await import(
  "../tution-desk-be/src/app/api/students/route.ts"
);
const { GET: getStudentByIdRoute, PUT: putStudentByIdRoute } = await import(
  "../tution-desk-be/src/app/api/students/[id]/route.ts"
);
const { GET: getFeesRoute } = await import(
  "../tution-desk-be/src/app/api/fees/route.ts"
);
const { POST: manualCollectionRoute } = await import(
  "../tution-desk-be/src/app/api/fees/manual-collection/route.ts"
);
const { POST: advanceFeeRoute } = await import(
  "../tution-desk-be/src/app/api/fees/advance/route.ts"
);
const { GET: getAttendanceRoute } = await import(
  "../tution-desk-be/src/app/api/attendance/route.ts"
);
const { GET: getBatchesRoute } = await import(
  "../tution-desk-be/src/app/api/batches/route.ts"
);
const { POST: bulkImportPreviewRoute } = await import(
  "../tution-desk-be/src/app/api/students/bulk-import/preview/route.ts"
);

// Import frontend logic & helpers
const { evaluateStudentPhoneDisplay, formatMaskedPhone } = await import(
  "../src/lib/studentPhoneMasked.ts"
);

function createMockRequest({
  method = "GET",
  token,
  body,
  headers = {},
  url = "http://localhost:3000/api/students",
}) {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body || {});
  const reqHeaders = new Headers(headers);
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  if (!reqHeaders.has("content-type")) {
    reqHeaders.set("content-type", "application/json");
  }
  reqHeaders.set("content-length", String(Buffer.byteLength(bodyString)));

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: new URL(url),
    json: async () => (body ? (typeof body === "string" ? JSON.parse(body) : body) : {}),
    text: async () => bodyString,
    arrayBuffer: async () => Buffer.from(bodyString),
  };
}

test("Phase 5.1: Student Contact Privacy & Response Sanitization Suite (REQ-02)", async (t) => {
  const centerId = "center_msec";
  const foreignCenterId = "center_other";

  const ownerId = "507f191e810c19729de86001";
  const teacherId = "507f191e810c19729de86002";
  const studentAId = "507f191e810c19729de86011";

  const rawPhone = "9876543210";
  const expectedMasked = "******3210";

  // Mock query builder helper for chained Mongoose calls
  function createMockQuery(data = []) {
    const query = {
      sort: () => query,
      populate: () => query,
      select: () => query,
      distinct: async () => data.map((item) => (item && item._id ? item._id : item)),
      then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
      catch: (reject) => Promise.resolve(data).catch(reject),
      [Symbol.asyncIterator]: () => data[Symbol.asyncIterator](),
    };
    return query;
  }

  // Prevent background connection timeouts
  CenterModel.findOne = () => ({
    select: () => ({
      _id: ownerId,
      name: "MSEC Institute",
      ownerName: "Jitender Kumar",
      phone: "9876543210",
    }),
  });
  TeacherModel.find = () => ({
    select: () => [
      { _id: teacherId, name: "Teacher Sharma", phone: "9876543211", loginId: "sharma", role: "teacher" },
    ],
  });
  TeacherModel.findOne = () => ({
    select: () => ({ _id: teacherId, assignedBatches: ["Class 10 - Science"] }),
  });
  ParentAccessModel.findOne = () => null;
  ParentAccessModel.create = async () => ({ _id: "pa_123" });
  ParentAccessLockModel.collection = {
    indexes: async () => [{ key: { lockKey: 1 }, unique: true }],
  };
  ParentAccessLockModel.create = async () => ({ _id: "lock_1" });
  ParentAccessLockModel.deleteOne = async () => ({ acknowledged: true });
  ParentAccessLockModel.findOne = async () => null;
  ParentAccessLockModel.findOneAndUpdate = async () => null;
  if (AdmissionWelcomeJob) {
    AdmissionWelcomeJob.create = async () => ({ _id: "job_123" });
  }

  const ownerToken = await signToken({
    userId: ownerId,
    centerId,
    role: "owner",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    centerId,
    role: "teacher",
    teacherId,
  });

  const foreignToken = await signToken({
    userId: "507f191e810c19729de86099",
    centerId: foreignCenterId,
    role: "owner",
  });

  const sampleStudentA = {
    _id: studentAId,
    centerId,
    name: "Aarav Sharma",
    batch: "Class 10 - Science",
    parentWhatsApp: rawPhone,
    phone: rawPhone,
    parentPhone: rawPhone,
    monthlyFee: 2500,
    billingCycleDate: 5,
    assignedTeacherId: teacherId,
    isActive: true,
    toObject() {
      return { ...this };
    },
  };

  // =========================================================================
  // 1. TEACHER GET STUDENTS RESPONSE (MASKED)
  // =========================================================================
  await t.test("1. Teacher GET /api/students returns masked contact numbers", async () => {
    StudentModel.find = () => ({
      sort: () => [sampleStudentA],
    });

    const req = createMockRequest({
      method: "GET",
      token: teacherToken,
      url: "http://localhost:3000/api/students",
    });

    const res = await getStudentsRoute(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.length, 1);

    const s = json.data[0];
    assert.equal(s.parentWhatsApp, expectedMasked, "Teacher must receive masked parentWhatsApp");
    assert.equal(s.phone, expectedMasked, "Teacher must receive masked phone");
    assert.notEqual(s.parentWhatsApp, rawPhone, "Teacher must never receive raw phone");
  });

  // =========================================================================
  // 2. TEACHER GET INDIVIDUAL STUDENT RESPONSE & TAMPERING REJECTION
  // =========================================================================
  await t.test("2. Teacher GET /api/students/[id] masks phone and rejects PUT modifications", async () => {
    StudentModel.findOne = () => sampleStudentA;

    // GET
    const reqGet = createMockRequest({
      method: "GET",
      token: teacherToken,
      url: `http://localhost:3000/api/students/${studentAId}`,
    });

    const resGet = await getStudentByIdRoute(reqGet, { params: Promise.resolve({ id: studentAId }) });
    assert.equal(resGet.status, 200);
    const jsonGet = await resGet.json();
    assert.equal(jsonGet.data.parentWhatsApp, expectedMasked, "Teacher GET student detail must be masked");

    // PUT Attempt to modify parentWhatsApp as Teacher
    const reqPut = createMockRequest({
      method: "PUT",
      token: teacherToken,
      body: { parentWhatsApp: "9999999999" },
      url: `http://localhost:3000/api/students/${studentAId}`,
    });

    const resPut = await putStudentByIdRoute(reqPut, { params: Promise.resolve({ id: studentAId }) });
    assert.equal(resPut.status, 403, "Teacher attempting to update parent phone must receive HTTP 403 Forbidden");
    const jsonPut = await resPut.json();
    assert.ok(jsonPut.error.includes("Teachers cannot update student contact numbers"));
  });

  // =========================================================================
  // 3. OWNER FULL PHONE ACCESS
  // =========================================================================
  await t.test("3. Owner receives full unmasked phone access on both list and detail endpoints", async () => {
    StudentModel.find = () => ({
      sort: () => [sampleStudentA],
    });
    StudentModel.findOne = () => sampleStudentA;

    // List
    const reqList = createMockRequest({
      method: "GET",
      token: ownerToken,
      url: "http://localhost:3000/api/students",
    });
    const resList = await getStudentsRoute(reqList);
    assert.equal(resList.status, 200);
    const jsonList = await resList.json();
    assert.equal(jsonList.data[0].parentWhatsApp, rawPhone, "Owner must see raw unmasked phone in student list");

    // Detail
    const reqDetail = createMockRequest({
      method: "GET",
      token: ownerToken,
      url: `http://localhost:3000/api/students/${studentAId}`,
    });
    const resDetail = await getStudentByIdRoute(reqDetail, { params: Promise.resolve({ id: studentAId }) });
    assert.equal(resDetail.status, 200);
    const jsonDetail = await resDetail.json();
    assert.equal(jsonDetail.data.parentWhatsApp, rawPhone, "Owner must see raw unmasked phone in student detail");
  });

  // =========================================================================
  // 4. CROSS-CENTER ACCESS REJECTION
  // =========================================================================
  await t.test("4. Cross-center student access is denied with 404/403 and zero data leakage", async () => {
    // Scoped query for foreignCenterId returns null
    StudentModel.findOne = (query) => {
      if (query.centerId === centerId) return sampleStudentA;
      return null;
    };

    const req = createMockRequest({
      method: "GET",
      token: foreignToken,
      url: `http://localhost:3000/api/students/${studentAId}`,
    });

    const res = await getStudentByIdRoute(req, { params: Promise.resolve({ id: studentAId }) });
    assert.equal(res.status, 404, "Cross-center query must return 404 Not Found");
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.data, undefined, "No student data may be returned across centers");
  });

  // =========================================================================
  // 5. NESTED/POPULATED STUDENT PHONE FIELDS (FEES & MANUAL COLLECTION)
  // =========================================================================
  await t.test("5. Nested populated student contact numbers are masked for Teacher in Fee responses", async () => {
    const feeWithStudent = {
      _id: "507f191e810c19729de86050",
      centerId,
      studentId: sampleStudentA,
      month: "November 2026",
      amountDue: 2500,
      paidAmount: 0,
      status: "Pending",
      toObject() {
        return { ...this };
      },
    };

    StudentModel.find = () => createMockQuery([sampleStudentA]);
    FeeModel.find = () => createMockQuery([feeWithStudent]);

    // 5.1 Teacher GET /api/fees
    const reqTeacher = createMockRequest({
      method: "GET",
      token: teacherToken,
      url: "http://localhost:3000/api/fees",
    });

    const resTeacher = await getFeesRoute(reqTeacher);
    assert.equal(resTeacher.status, 200);
    const jsonTeacher = await resTeacher.json();
    const studentInFee = jsonTeacher.data[0].studentId;
    assert.equal(studentInFee.parentWhatsApp, expectedMasked, "Teacher must see masked phone in fee response");

    // 5.2 Owner GET /api/fees
    const reqOwner = createMockRequest({
      method: "GET",
      token: ownerToken,
      url: "http://localhost:3000/api/fees",
    });

    const resOwner = await getFeesRoute(reqOwner);
    assert.equal(resOwner.status, 200);
    const jsonOwner = await resOwner.json();
    assert.equal(jsonOwner.data[0].studentId.parentWhatsApp, rawPhone, "Owner must see raw phone in fee response");
  });

  // =========================================================================
  // 6. ATTENDANCE AND BATCH RESPONSES
  // =========================================================================
  await t.test("6. Attendance populated student is masked for Teacher; Batches contain no phone leakage", async () => {
    const attendanceDoc = {
      _id: "507f191e810c19729de86060",
      centerId,
      studentId: sampleStudentA,
      batch: "Class 10 - Science",
      status: "present",
      date: new Date(),
      toObject() {
        return { ...this };
      },
    };

    StudentModel.find = (q) => {
      if (q && q.assignedTeacherId) {
        return {
          select: () => [{ _id: studentAId }],
        };
      }
      return {
        sort: () => [sampleStudentA],
      };
    };

    AttendanceModel.find = () => ({
      populate: () => ({
        sort: () => [attendanceDoc],
      }),
    });

    // Attendance
    const reqAtt = createMockRequest({
      method: "GET",
      token: teacherToken,
      url: "http://localhost:3000/api/attendance",
    });

    const resAtt = await getAttendanceRoute(reqAtt);
    assert.equal(resAtt.status, 200);
    const jsonAtt = await resAtt.json();
    assert.equal(
      jsonAtt.data[0].studentId.parentWhatsApp,
      expectedMasked,
      "Populated attendance student phone must be masked for Teacher"
    );

    // Batches
    BatchModel.find = () => ({
      sort: () => [
        {
          _id: "507f191e810c19729de86070",
          centerId,
          name: "Class 10 - Science",
          timing: "10:00 AM",
        },
      ],
    });

    const reqBatch = createMockRequest({
      method: "GET",
      token: teacherToken,
      url: "http://localhost:3000/api/batches",
    });

    const resBatch = await getBatchesRoute(reqBatch);
    assert.equal(resBatch.status, 200);
    const jsonBatch = await resBatch.json();
    assert.equal(JSON.stringify(jsonBatch).includes(rawPhone), false, "Batches must never contain student phone");
  });

  // =========================================================================
  // 7. FEE ADVANCE & ADMISSION RESPONSES
  // =========================================================================
  await t.test("7. Returned student in POST /api/students and Advance fee responses is masked for Teacher", async () => {
    StudentModel.create = async (doc) => ({
      ...doc,
      _id: "507f191e810c19729de86080",
      toObject() {
        return { ...this };
      },
    });

    // Teacher POST /api/students
    const reqPost = createMockRequest({
      method: "POST",
      token: teacherToken,
      body: {
        name: "Rahul Verma",
        batch: "Class 10 - Science",
        parentWhatsApp: "9811223344",
        monthlyFee: 2000,
        billingCycleDate: 5,
      },
      url: "http://localhost:3000/api/students",
    });

    const resPost = await postStudentRoute(reqPost);
    assert.equal(resPost.status, 201);
    const jsonPost = await resPost.json();
    assert.equal(
      jsonPost.data.parentWhatsApp,
      "******3344",
      "Created student returned to Teacher must have masked contact"
    );
  });

  // =========================================================================
  // 8. SEARCH AND EXPORT RESPONSES (PROBE RESISTANCE & BULK PREVIEW)
  // =========================================================================
  await t.test("8. Search regex probing by phone is blocked for Teacher; Bulk preview masks rows", async () => {
    let capturedFilter = null;
    StudentModel.find = (f) => {
      capturedFilter = f;
      return createMockQuery([]);
    };
    BatchModel.find = () =>
      createMockQuery([
        {
          _id: "507f191e810c19729de86070",
          centerId,
          name: "Class 10 - Science",
          timing: "10:00 AM",
        },
      ]);

    // Teacher searching with phone number
    const reqSearch = createMockRequest({
      method: "GET",
      token: teacherToken,
      url: `http://localhost:3000/api/students?q=${rawPhone}`,
    });

    await getStudentsRoute(reqSearch);
    assert.ok(capturedFilter, "Filter must be captured");

    // Verify filter does NOT include parentWhatsApp for Teacher
    const orClauses = capturedFilter.$or || (capturedFilter.$and && capturedFilter.$and[0]?.$or) || [];
    const searchesParentWhatsApp = orClauses.some((clause) => "parentWhatsApp" in clause);
    assert.equal(
      searchesParentWhatsApp,
      false,
      "Teacher search filter must NOT search by parentWhatsApp (side-channel probe blocked)"
    );

    // Bulk Import Preview
    const sampleCsv = `Name,Batch,Parent WhatsApp,Monthly Fee,Due Day\nTest Student,Class 10 - Science,9876543210,2500,5`;
    const reqBulk = createMockRequest({
      method: "POST",
      token: teacherToken,
      body: { csvContent: sampleCsv },
      url: "http://localhost:3000/api/students/bulk-import/preview",
    });

    const resBulk = await bulkImportPreviewRoute(reqBulk);
    assert.equal(resBulk.status, 200);
    const jsonBulk = await resBulk.json();
    if (jsonBulk.rows && jsonBulk.rows.length > 0) {
      assert.equal(
        jsonBulk.rows[0].parentWhatsApp,
        expectedMasked,
        "Bulk import preview rows must be masked for Teacher"
      );
    }
  });

  // =========================================================================
  // 9. NO FULL PHONE NUMBER IN TEACHER FRONTEND DOM
  // =========================================================================
  await t.test("9. StudentPhoneMasked evaluates strictly masked phone without raw number anywhere in DOM for Teacher", () => {
    const teacherDisplay = evaluateStudentPhoneDisplay(rawPhone, "teacher", true, true);

    assert.equal(teacherDisplay.isMasked, true, "Display must be masked for Teacher");
    assert.equal(teacherDisplay.displayText, expectedMasked, "Display text must be masked");
    assert.equal(teacherDisplay.hasRawPhoneInOutput, false, "Must not leak raw phone in output");
    assert.equal(
      teacherDisplay.ariaLabel,
      "Parent contact number masked ending in 3210",
      "Aria label must describe masked state without full digits"
    );
  });

  // =========================================================================
  // 10. NO TEL: OR WA.ME LINKS FOR TEACHERS
  // =========================================================================
  await t.test("10. Zero tel: and wa.me links rendered for Teacher; Authorized links present for Owner", () => {
    // Teacher Evaluation
    const teacherDisplay = evaluateStudentPhoneDisplay(rawPhone, "teacher", true, true);
    assert.equal(teacherDisplay.hasTelLink, false, "Teacher must not have tel: link");
    assert.equal(teacherDisplay.hasWaLink, false, "Teacher must not have wa.me link");
    assert.equal(teacherDisplay.telHref, undefined);
    assert.equal(teacherDisplay.waHref, undefined);

    // Owner Evaluation
    const ownerDisplay = evaluateStudentPhoneDisplay(rawPhone, "owner", true, true);
    assert.equal(ownerDisplay.isMasked, false, "Display must not be masked for Owner");
    assert.equal(ownerDisplay.hasRawPhoneInOutput, true, "Owner receives unmasked number");
    assert.equal(ownerDisplay.hasTelLink, true, "Owner has tel: link");
    assert.equal(ownerDisplay.hasWaLink, true, "Owner has wa.me link");
    assert.equal(ownerDisplay.telHref, `tel:+91${rawPhone}`);
    assert.equal(ownerDisplay.waHref, `https://wa.me/91${rawPhone}`);
  });
});
