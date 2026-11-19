process.env.JWT_SECRET = "tuition-desk-test-jwt-secret-key-32-chars-ok";
process.env.NODE_ENV = "test";
globalThis.mongooseCache = { conn: {}, promise: Promise.resolve({}) };

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(__dirname, "../tution-desk-be");
const beRequire = createRequire(path.join(beDir, "package.json"));
const mongoose = beRequire("mongoose");

const { signToken } = await import("../tution-desk-be/src/lib/auth.ts");
const BatchModel = (await import("../tution-desk-be/src/models/Batch.ts")).default;
const StudentModel = (await import("../tution-desk-be/src/models/Student.ts")).default;
const TeacherModel = (await import("../tution-desk-be/src/models/Teacher.ts")).default;

const { GET: getBatchesRoute } = await import(
  "../tution-desk-be/src/app/api/batches/route.ts"
);
const { GET: getStudentsRoute } = await import(
  "../tution-desk-be/src/app/api/students/route.ts"
);

function createMockRequest({
  method = "GET",
  token,
  url = "http://localhost:3000/api/batches",
}) {
  const reqHeaders = new Headers();
  if (token) {
    reqHeaders.set("authorization", `Bearer ${token}`);
  }
  reqHeaders.set("content-type", "application/json");

  const parsedUrl = new URL(url);

  return {
    method,
    headers: reqHeaders,
    cookies: {
      get: () => undefined,
    },
    nextUrl: parsedUrl,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => Buffer.from(""),
  };
}

test("Student Count & Pagination Synchronization Test Suite", async (t) => {
  const centerId = "center_sync_test";
  const teacherId = "507f191e810c19729de86077";

  const ownerToken = await signToken({
    userId: "507f191e810c19729de86001",
    centerId,
    role: "owner",
    name: "Owner Sharma",
  });

  const teacherToken = await signToken({
    userId: teacherId,
    centerId,
    role: "teacher",
    teacherId,
    name: "Teacher Verma",
  });

  // Seed 65 students across two batches:
  // Batch A: "Physics Olympiad" -> 55 students (54 active @ 1000/mo, 1 inactive @ 1000/mo), assigned to owner
  // Batch B: "Math JEE Advanced" -> 10 students (10 active @ 2000/mo), assigned to teacher
  const seededBatches = [
    {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86011"),
      centerId,
      name: "Physics Olympiad",
      timing: "4:00 PM - 5:30 PM",
      subject: "Physics",
      assignedTeacherId: null,
      isActive: true,
      toObject() {
        return { ...this };
      },
    },
    {
      _id: new mongoose.Types.ObjectId("507f191e810c19729de86022"),
      centerId,
      name: "Math JEE Advanced",
      timing: "6:00 PM - 7:30 PM",
      subject: "Mathematics",
      assignedTeacherId: new mongoose.Types.ObjectId(teacherId),
      isActive: true,
      toObject() {
        return { ...this };
      },
    },
  ];

  const seededStudents = [];

  // 55 students in Physics Olympiad
  for (let i = 1; i <= 55; i++) {
    const isInactive = i === 55; // 1 inactive student
    seededStudents.push({
      _id: new mongoose.Types.ObjectId(`507f191e810c19729de810${String(i).padStart(2, "0")}`),
      centerId,
      name: `Physics Student ${i}`,
      batch: "Physics Olympiad",
      monthlyFee: 1000,
      billingCycleDate: 5,
      parentWhatsApp: `+9198765${String(10000 + i)}`,
      assignedTeacherId: null,
      isActive: !isInactive,
      createdAt: new Date("2026-01-01"),
      toObject() {
        return { ...this };
      },
    });
  }

  // 10 students in Math JEE Advanced
  for (let i = 1; i <= 10; i++) {
    seededStudents.push({
      _id: new mongoose.Types.ObjectId(`507f191e810c19729de820${String(i).padStart(2, "0")}`),
      centerId,
      name: `Math Student ${i}`,
      batch: "Math JEE Advanced",
      monthlyFee: 2000,
      billingCycleDate: 10,
      parentWhatsApp: `+9198766${String(10000 + i)}`,
      assignedTeacherId: new mongoose.Types.ObjectId(teacherId),
      isActive: true,
      createdAt: new Date("2026-02-01"),
      toObject() {
        return { ...this };
      },
    });
  }

  // Backup original model methods
  const originalStudentAggregate = StudentModel.aggregate;
  const originalStudentFind = StudentModel.find;
  const originalStudentCountDocuments = StudentModel.countDocuments;
  const originalBatchFind = BatchModel.find;
  const originalTeacherFindOne = TeacherModel.findOne;

  // Setup aggregation engine on in-memory seeded students
  StudentModel.aggregate = async (pipeline) => {
    let dataset = [...seededStudents];

    for (const stage of pipeline) {
      if (stage.$match) {
        const match = stage.$match;
        dataset = dataset.filter((s) => {
          if (match.centerId && s.centerId !== match.centerId) return false;
          if (match.assignedTeacherId) {
            if (
              !s.assignedTeacherId ||
              String(s.assignedTeacherId) !== String(match.assignedTeacherId)
            ) {
              return false;
            }
          }
          return true;
        });
      }

      if (stage.$facet) {
        const facetResult = {};
        for (const [key, subPipeline] of Object.entries(stage.$facet)) {
          let facetData = [...dataset];
          for (const subStage of subPipeline) {
            if (subStage.$group) {
              const groupSpec = subStage.$group;
              if (groupSpec._id === null) {
                // Overall group
                let totalStudents = 0;
                let activeStudents = 0;
                let totalMonthlyFee = 0;
                for (const item of facetData) {
                  totalStudents++;
                  if (item.isActive !== false) {
                    activeStudents++;
                    totalMonthlyFee += item.monthlyFee || 0;
                  }
                }
                facetData = [{ _id: null, totalStudents, activeStudents, totalMonthlyFee }];
              } else if (groupSpec._id === "$batch") {
                // Per-batch group
                const map = new Map();
                for (const item of facetData) {
                  const bName = item.batch;
                  if (!map.has(bName)) {
                    map.set(bName, {
                      _id: bName,
                      studentCount: 0,
                      activeStudentCount: 0,
                      monthlyFeeSum: 0,
                    });
                  }
                  const entry = map.get(bName);
                  entry.studentCount++;
                  if (item.isActive !== false) {
                    entry.activeStudentCount++;
                    entry.monthlyFeeSum += item.monthlyFee || 0;
                  }
                }
                facetData = Array.from(map.values());
              }
            }
          }
          facetResult[key] = facetData;
        }
        return [facetResult];
      }
    }

    return dataset;
  };

  StudentModel.find = (query) => {
    let result = seededStudents.filter((s) => {
      if (query.centerId && s.centerId !== query.centerId) return false;
      if (query.assignedTeacherId) {
        if (!s.assignedTeacherId || String(s.assignedTeacherId) !== String(query.assignedTeacherId)) {
          return false;
        }
      }
      if (query.batch && s.batch !== query.batch) return false;
      if (query.isActive !== undefined && s.isActive !== query.isActive) return false;
      return true;
    });

    const chain = {
      select: () => chain,
      sort: () => chain,
      skip: (skipVal) => {
        result = result.slice(skipVal);
        return chain;
      },
      limit: (limitVal) => {
        result = result.slice(0, limitVal);
        return chain;
      },
      then: (resolve) => resolve(result),
    };
    return chain;
  };

  StudentModel.countDocuments = async (query) => {
    return seededStudents.filter((s) => {
      if (query.centerId && s.centerId !== query.centerId) return false;
      if (query.assignedTeacherId) {
        if (!s.assignedTeacherId || String(s.assignedTeacherId) !== String(query.assignedTeacherId)) {
          return false;
        }
      }
      if (query.batch && s.batch !== query.batch) return false;
      if (query.isActive !== undefined && s.isActive !== query.isActive) return false;
      return true;
    }).length;
  };

  BatchModel.find = (query) => {
    let filtered = seededBatches.filter((b) => {
      if (query.centerId && b.centerId !== query.centerId) return false;
      if (query.assignedTeacherId) {
        if (
          !b.assignedTeacherId ||
          String(b.assignedTeacherId) !== String(query.assignedTeacherId)
        ) {
          return false;
        }
      }
      if (query.name && query.name.$in) {
        if (!query.name.$in.includes(b.name)) return false;
      }
      return true;
    });

    return {
      sort: () => Promise.resolve(filtered),
      select: () => Promise.resolve(filtered),
    };
  };

  TeacherModel.findOne = (query) => {
    if (query._id && String(query._id) === teacherId) {
      return {
        select: async () => ({
          _id: new mongoose.Types.ObjectId(teacherId),
          name: "Teacher Verma",
          assignedBatches: ["Math JEE Advanced"],
        }),
      };
    }
    return { select: async () => null };
  };

  try {
    // =========================================================================
    // 1. Owner GET /api/batches: exact 65 student count & per-batch stats
    // =========================================================================
    await t.test(
      "1. With 65 seeded students, backend batch aggregation returns exact totalStudents === 65 and exact per-batch counts & fee sums",
      async () => {
        const req = createMockRequest({
          token: ownerToken,
          url: "http://localhost:3000/api/batches",
        });

        const res = await getBatchesRoute(req);
        assert.equal(res.status, 200);
        const json = await res.json();

        assert.equal(json.success, true);
        assert.ok(json.summary, "Must return overall summary alongside batches");
        assert.equal(json.summary.totalStudents, 65, "Total students must be exact 65 (not capped at 50)");
        assert.equal(json.summary.activeStudents, 64, "Active students must be exact 64 (54 in A + 10 in B)");
        assert.equal(
          json.summary.totalMonthlyFee,
          74000,
          "Total active monthly fee must be exact 74,000 (54k + 20k)"
        );

        // Verify per-batch stats on data array
        assert.equal(json.data.length, 2);
        const batchPhysics = json.data.find((b) => b.name === "Physics Olympiad");
        const batchMath = json.data.find((b) => b.name === "Math JEE Advanced");

        assert.ok(batchPhysics);
        assert.equal(batchPhysics.studentCount, 55, "Physics Olympiad must have exact 55 students");
        assert.equal(batchPhysics.activeStudentCount, 54, "Physics Olympiad must have 54 active students");
        assert.equal(batchPhysics.monthlyFeeSum, 54000, "Physics Olympiad fee sum must be 54,000");

        assert.ok(batchMath);
        assert.equal(batchMath.studentCount, 10, "Math JEE Advanced must have exact 10 students");
        assert.equal(batchMath.activeStudentCount, 10, "Math JEE Advanced must have 10 active students");
        assert.equal(batchMath.monthlyFeeSum, 20000, "Math JEE Advanced fee sum must be 20,000");

        // Verify summary.byBatch mapping
        assert.ok(json.summary.byBatch["Physics Olympiad"]);
        assert.equal(json.summary.byBatch["Physics Olympiad"].studentCount, 55);
        assert.ok(json.summary.byBatch["Math JEE Advanced"]);
        assert.equal(json.summary.byBatch["Math JEE Advanced"].studentCount, 10);
      }
    );

    // =========================================================================
    // 2. Teacher GET /api/batches: role scoping isolates to assigned students
    // =========================================================================
    await t.test(
      "2. Teacher role only sees aggregated counts for their assigned batches/students",
      async () => {
        const req = createMockRequest({
          token: teacherToken,
          url: "http://localhost:3000/api/batches",
        });

        const res = await getBatchesRoute(req);
        assert.equal(res.status, 200);
        const json = await res.json();

        assert.equal(json.success, true);
        assert.equal(json.data.length, 1, "Teacher must only see their 1 assigned batch");
        assert.equal(json.data[0].name, "Math JEE Advanced");
        assert.equal(json.data[0].studentCount, 10);
        assert.equal(json.data[0].activeStudentCount, 10);
        assert.equal(json.data[0].monthlyFeeSum, 20000);

        // Overall summary must be scoped to teacher's authorized students
        assert.equal(json.summary.totalStudents, 10, "Teacher totalStudents must be 10, not institute 65");
        assert.equal(json.summary.activeStudents, 10);
        assert.equal(json.summary.totalMonthlyFee, 20000);
      }
    );

    // =========================================================================
    // 3. Batch-scoped pagination: ?batch=...&limit=250 returns all 55 students
    // =========================================================================
    await t.test(
      "3. Fetching a batch with >50 students using ?batch=...&limit=250 returns all students without truncating at 50",
      async () => {
        // Query batch with 55 students
        const req = createMockRequest({
          token: ownerToken,
          url: "http://localhost:3000/api/students?batch=Physics%20Olympiad&limit=250",
        });

        const res = await getStudentsRoute(req);
        assert.equal(res.status, 200);
        const json = await res.json();

        assert.equal(json.success, true);
        assert.equal(
          json.data.length,
          55,
          "Batch-scoped fetch with limit=250 must return all 55 students without capping at 50"
        );
        assert.equal(json.pagination.total, 55);
        assert.equal(json.pagination.limit, 250);
        assert.equal(json.pagination.page, 1);
        assert.equal(json.pagination.totalPages, 1);
      }
    );

    // =========================================================================
    // 4. Default unscoped GET /api/students safely caps at 50 with accurate pagination
    // =========================================================================
    await t.test(
      "4. Default unscoped GET /api/students defaults to limit=50 with accurate total=65 and totalPages=2",
      async () => {
        const req = createMockRequest({
          token: ownerToken,
          url: "http://localhost:3000/api/students",
        });

        const res = await getStudentsRoute(req);
        assert.equal(res.status, 200);
        const json = await res.json();

        assert.equal(json.success, true);
        assert.equal(json.data.length, 50, "Default unscoped call must safely return 50 items");
        assert.equal(json.pagination.total, 65, "Total count must accurately reflect all 65 students");
        assert.equal(json.pagination.limit, 50);
        assert.equal(json.pagination.totalPages, 2);
      }
    );
  } finally {
    StudentModel.aggregate = originalStudentAggregate;
    StudentModel.find = originalStudentFind;
    StudentModel.countDocuments = originalStudentCountDocuments;
    BatchModel.find = originalBatchFind;
    TeacherModel.findOne = originalTeacherFindOne;
  }
});
