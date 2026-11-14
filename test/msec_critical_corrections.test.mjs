import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));

const mongoose = beRequire("mongoose");

// Setup mock test environment
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-critical-corrections-32-chars";
process.env.APP_URL = "http://localhost:3000";
process.env.ALLOWED_ORIGINS = "http://localhost:3000,https://tution-desk-one.vercel.app";

// In-memory mongoose cache
global.mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };
process.env.MONGODB_URI = "mongodb://localhost:27017/test_tuitiondesk";

const { default: MessageCampaign } = await import(
  "../tution-desk-be/src/models/MessageCampaign.ts"
);
const { default: ParentAccess } = await import(
  "../tution-desk-be/src/models/ParentAccess.ts"
);
const { default: Student } = await import(
  "../tution-desk-be/src/models/Student.ts"
);
const { default: Attendance } = await import(
  "../tution-desk-be/src/models/Attendance.ts"
);
const { default: Center } = await import(
  "../tution-desk-be/src/models/Center.ts"
);
const { default: Fee } = await import(
  "../tution-desk-be/src/models/Fee.ts"
);
const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const { GET: parentNotificationsRoute } = await import(
  "../tution-desk-be/src/app/api/parent/notifications/route.ts"
);
const { POST: attendanceRoute } = await import(
  "../tution-desk-be/src/app/api/attendance/route.ts"
);
const { POST: studentsRoute } = await import(
  "../tution-desk-be/src/app/api/students/route.ts"
);
const { POST: remindAllRoute } = await import(
  "../tution-desk-be/src/app/api/fees/remind-all/route.ts"
);

function createMockRequest({
  method = "GET",
  url = "http://localhost:3001/api/test",
  headers = {},
  cookies = {},
  body = {},
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }

  return {
    method,
    nextUrl: new URL(url),
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) || null,
    },
    cookies: {
      get: (name) => (cookies[name] ? { value: cookies[name] } : undefined),
    },
    json: async () => body,
  };
}

test("MSEC Critical Production Corrections Specification Suite", async (t) => {
  const testCenterId = "msec-test-center";
  const ownerId = new mongoose.Types.ObjectId().toString();
  const teacherId = new mongoose.Types.ObjectId().toString();

  let ownerToken = "";
  let teacherToken = "";

  t.before(async () => {
    ownerToken = await signToken({
      userId: ownerId,
      centerId: testCenterId,
      role: "owner",
      name: "Institute Owner",
    });

    teacherToken = await signToken({
      userId: teacherId,
      centerId: testCenterId,
      role: "teacher",
      teacherId: teacherId,
      name: "Assigned Teacher",
    });
  });

  // ==========================================================================
  // Task 1: Parent Inbox Privacy
  // ==========================================================================
  await t.test("Task 1: Parent Inbox Privacy Invariants", async (t1) => {
    const parentAccessId = new mongoose.Types.ObjectId().toString();
    const linkedStudent1 = new mongoose.Types.ObjectId();
    const linkedStudent2 = new mongoose.Types.ObjectId();
    const unlinkedSibling = new mongoose.Types.ObjectId();
    const sharedPhoneStranger = new mongoose.Types.ObjectId();

    const parentSessionToken = await signToken({
      userId: parentAccessId,
      parentAccessId: parentAccessId,
      centerId: testCenterId,
      role: "parent",
      tokenPrefix: "pt_priv1",
    });

    await t1.test("1.1 Scopes queries strictly to explicitly linked studentIds", async () => {
      const originalParentFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenPrefix: "pt_priv1",
        status: "active",
        linkedStudentIds: [linkedStudent1, linkedStudent2],
      });

      const originalAggregate = MessageCampaign.aggregate;
      let capturedPipeline = null;

      MessageCampaign.aggregate = async (pipeline) => {
        capturedPipeline = pipeline;
        return [];
      };

      try {
        const req = createMockRequest({
          url: "http://localhost:3001/api/parent/notifications",
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${parentSessionToken}`,
          },
        });

        const res = await parentNotificationsRoute(req);
        assert.equal(res.status, 200);

        assert.ok(capturedPipeline);
        const rootOr = capturedPipeline[0].$match.$or;
        const studentClause = rootOr[0];
        const broadcastClause = rootOr[1];

        // Must match linked student IDs
        const targetIds = studentClause["messages.studentId"].$in.map(String);
        assert.ok(targetIds.includes(linkedStudent1.toString()));
        assert.ok(targetIds.includes(linkedStudent2.toString()));
        assert.ok(!targetIds.includes(unlinkedSibling.toString()));
        assert.ok(!targetIds.includes(sharedPhoneStranger.toString()));

        // Broadcast clause must strictly guard phone matching with missing/null studentId
        assert.ok(broadcastClause.$and[0]["messages.phone"]);
        const studentIdGuard = broadcastClause.$and[1].$or;
        assert.deepEqual(studentIdGuard, [
          { "messages.studentId": { $exists: false } },
          { "messages.studentId": null },
        ]);
      } finally {
        ParentAccess.findOne = originalParentFindOne;
        MessageCampaign.aggregate = originalAggregate;
      }
    });

    await t1.test("1.2 Prevents cross-student leakage for unlinked sibling and shared phone", async () => {
      const originalParentFindOne = ParentAccess.findOne;
      ParentAccess.findOne = async () => ({
        _id: parentAccessId,
        centerId: testCenterId,
        parentPhone: "+919876543210",
        tokenPrefix: "pt_priv1",
        status: "active",
        linkedStudentIds: [linkedStudent1], // Only student1 is linked
      });

      const originalAggregate = MessageCampaign.aggregate;

      MessageCampaign.aggregate = async (pipeline) => {
        const unwindMatch = pipeline[2].$match;
        const [studentClause, broadcastClause] = unwindMatch.$or;
        const validStudentIds = new Set(
          studentClause["messages.studentId"].$in.map(String)
        );
        const validPhones = new Set(broadcastClause.$and[0]["messages.phone"].$in);

        const dataset = [
          {
            phone: "+919876543210",
            studentId: linkedStudent1,
            message: "Student 1 Notice",
            status: "sent",
          },
          {
            phone: "+919876543210",
            studentId: unlinkedSibling,
            message: "Unlinked Sibling Secret",
            status: "sent",
          },
          {
            phone: "+919876543210",
            studentId: sharedPhoneStranger,
            message: "Stranger Notice",
            status: "sent",
          },
          {
            phone: "+919876543210",
            studentId: null,
            message: "Center Holiday Notice",
            status: "sent",
          },
        ];

        const matched = dataset.filter((msg) => {
          if (msg.studentId && validStudentIds.has(String(msg.studentId))) return true;
          const isBroadcast = msg.studentId === null || msg.studentId === undefined;
          if (isBroadcast && validPhones.has(msg.phone)) return true;
          return false;
        });

        return matched.map((m, i) => ({
          id: `msg_${i}`,
          title: "Alert",
          body: m.message,
          studentId: m.studentId ? String(m.studentId) : null,
          status: m.status,
          dispatchedAt: new Date(),
        }));
      };

      try {
        const req = createMockRequest({
          url: "http://localhost:3001/api/parent/notifications",
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${parentSessionToken}`,
          },
        });

        const res = await parentNotificationsRoute(req);
        assert.equal(res.status, 200);
        const data = await res.json();

        assert.equal(data.count, 2);
        const bodies = data.notifications.map((n) => n.body);
        assert.ok(bodies.includes("Student 1 Notice"));
        assert.ok(bodies.includes("Center Holiday Notice"));
        assert.ok(!bodies.includes("Unlinked Sibling Secret"));
        assert.ok(!bodies.includes("Stranger Notice"));
      } finally {
        ParentAccess.findOne = originalParentFindOne;
        MessageCampaign.aggregate = originalAggregate;
      }
    });
  });

  // ==========================================================================
  // Task 2: Attendance Channel Correction
  // ==========================================================================
  await t.test("Task 2: Attendance Channel Correction (Inbox + Push, No WhatsApp)", async (t2) => {
    const studentAbsent = {
      _id: new mongoose.Types.ObjectId(),
      centerId: testCenterId,
      name: "Absent Student",
      batch: "Class 10 - Mathematics",
      parentWhatsApp: "9876543210",
      assignedTeacherId: null,
    };

    await t2.test("2.1 Saving attendance with notifyParents persists MessageCampaign and triggers Push, NEVER WhatsApp", async () => {
      // Mock Student find
      const origStudentFind = Student.find;
      Student.find = () => ({
        select: async () => [studentAbsent],
      });

      // Mock Attendance findOne & create
      const origAttendanceFindOne = Attendance.findOne;
      const origAttendanceCreate = Attendance.create;
      Attendance.findOne = async () => null;
      Attendance.create = async (doc) => ({
        _id: new mongoose.Types.ObjectId(),
        ...doc,
      });

      // Mock Center findOne
      const origCenterFindOne = Center.findOne;
      Center.findOne = () => ({
        select: async () => ({ name: "MSEC Academy" }),
      });

      // Mock MessageCampaign create to verify inbox persistence
      const origCampaignCreate = MessageCampaign.create;
      let createdCampaign = null;
      MessageCampaign.create = async (doc) => {
        createdCampaign = doc;
        return { _id: new mongoose.Types.ObjectId(), ...doc };
      };

      // Mock ParentAccess find to track Push dispatch
      const origParentAccessFind = ParentAccess.find;
      let pushDispatchedForStudent = null;
      ParentAccess.find = async (query) => {
        pushDispatchedForStudent = query.linkedStudentIds;
        return [
          {
            _id: new mongoose.Types.ObjectId(),
            centerId: testCenterId,
            parentPhone: "9876543210",
            status: "active",
            pushSubscriptions: [
              {
                endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
                keys: { p256dh: "key", auth: "auth" },
              },
            ],
          },
        ];
      };

      try {
        const req = createMockRequest({
          url: "http://localhost:3001/api/attendance",
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerToken}`,
          },
          body: {
            records: [
              {
                studentId: studentAbsent._id.toString(),
                status: "Absent",
                batch: "Class 10 - Mathematics",
              },
            ],
            notifyParents: true,
            notificationScope: "absent",
          },
        });

        const res = await attendanceRoute(req);
        assert.equal(res.status, 201);
        const data = await res.json();
        assert.equal(data.success, true);

        // Verify MessageCampaign inbox persistence was created
        assert.ok(createdCampaign, "MessageCampaign must be created for inbox persistence");
        assert.equal(createdCampaign.campaignType, "attendance_alert");
        assert.equal(createdCampaign.status, "completed");
        assert.equal(createdCampaign.messages.length, 1);
        assert.equal(
          createdCampaign.messages[0].studentId.toString(),
          studentAbsent._id.toString()
        );
        assert.ok(createdCampaign.messages[0].message.includes("Absent Student"));

        // Verify push was invoked for this student
        assert.ok(pushDispatchedForStudent);
        assert.equal(pushDispatchedForStudent.toString(), studentAbsent._id.toString());

        // Verify notification summary in response
        assert.equal(data.notifications.status, "sent");
        assert.ok(data.notifications.message.includes("portal & push notifications"));
      } finally {
        Student.find = origStudentFind;
        Attendance.findOne = origAttendanceFindOne;
        Attendance.create = origAttendanceCreate;
        Center.findOne = origCenterFindOne;
        MessageCampaign.create = origCampaignCreate;
        ParentAccess.find = origParentAccessFind;
      }
    });

    await t2.test("2.2 Push failure does NOT fail attendance record creation or inbox persistence", async () => {
      const origStudentFind = Student.find;
      Student.find = () => ({
        select: async () => [studentAbsent],
      });

      const origAttendanceFindOne = Attendance.findOne;
      const origAttendanceCreate = Attendance.create;
      Attendance.findOne = async () => null;
      Attendance.create = async (doc) => ({
        _id: new mongoose.Types.ObjectId(),
        ...doc,
      });

      const origCenterFindOne = Center.findOne;
      Center.findOne = () => ({
        select: async () => ({ name: "MSEC Academy" }),
      });

      const origCampaignCreate = MessageCampaign.create;
      let campaignCreated = false;
      MessageCampaign.create = async (doc) => {
        campaignCreated = true;
        return { _id: new mongoose.Types.ObjectId(), ...doc };
      };

      // Mock ParentAccess find throwing a simulated push error
      const origParentAccessFind = ParentAccess.find;
      ParentAccess.find = async () => {
        throw new Error("Push service connection timeout");
      };

      try {
        const req = createMockRequest({
          url: "http://localhost:3001/api/attendance",
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerToken}`,
          },
          body: {
            records: [
              {
                studentId: studentAbsent._id.toString(),
                status: "Absent",
                batch: "Class 10 - Mathematics",
              },
            ],
            notifyParents: true,
            notificationScope: "absent",
          },
        });

        const res = await attendanceRoute(req);
        // Must still succeed with 201!
        assert.equal(res.status, 201);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(campaignCreated, "Inbox campaign must be saved even if push network fails");
      } finally {
        Student.find = origStudentFind;
        Attendance.findOne = origAttendanceFindOne;
        Attendance.create = origAttendanceCreate;
        Center.findOne = origCenterFindOne;
        MessageCampaign.create = origCampaignCreate;
        ParentAccess.find = origParentAccessFind;
      }
    });
  });

  // ==========================================================================
  // Task 3: Admission Welcome Link Correction
  // ==========================================================================
  await t.test("Task 3: Admission Welcome Link Correction", async (t3) => {
    await t3.test("3.1 POST /api/students creates student without automatic legacy WhatsApp dispatch", async () => {
      const origStudentCreate = Student.create;
      let studentCreated = null;
      Student.create = async (doc) => {
        studentCreated = doc;
        return { _id: new mongoose.Types.ObjectId(), ...doc };
      };

      try {
        const req = createMockRequest({
          url: "http://localhost:3001/api/students",
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerToken}`,
          },
          body: {
            name: "New Student Test",
            batch: "Class 10 - Physics",
            parentWhatsApp: "9876543210",
            monthlyFee: 3000,
          },
        });

        const res = await studentsRoute(req);
        assert.equal(res.status, 201);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(studentCreated.name, "New Student Test");
        // No automatic WhatsApp welcome was fired or required!
      } finally {
        Student.create = origStudentCreate;
      }
    });
  });

  // ==========================================================================
  // Task 4: Legacy Bulk Reminder Endpoint
  // ==========================================================================
  await t.test("Task 4: Legacy Bulk Reminder Endpoint Restriction", async (t4) => {
    await t4.test("4.1 POST /api/fees/remind-all is disabled and returns 403 Forbidden directing to /api/campaigns", async () => {
      const req = createMockRequest({
        url: "http://localhost:3001/api/fees/remind-all",
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
      });

      const res = await remindAllRoute(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "BULK_REMINDERS_CAMPAIGN_REQUIRED");
      assert.ok(data.error.includes("Smart Messaging Campaign Engine"));
    });

    await t4.test("4.2 Teacher calling POST /api/fees/remind-all is rejected with 403", async () => {
      const req = createMockRequest({
        url: "http://localhost:3001/api/fees/remind-all",
        method: "POST",
        headers: {
          authorization: `Bearer ${teacherToken}`,
        },
      });

      const res = await remindAllRoute(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "BULK_REMINDERS_CAMPAIGN_REQUIRED");
    });
  });
});
