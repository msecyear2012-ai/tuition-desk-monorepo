import test from "node:test";
import assert from "node:assert/strict";

import Fee from "../tution-desk-be/src/models/Fee.ts";
import Attendance from "../tution-desk-be/src/models/Attendance.ts";
import Student from "../tution-desk-be/src/models/Student.ts";
import Test from "../tution-desk-be/src/models/Test.ts";

function normalizeKey(keyObj) {
  return Object.entries(keyObj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

test("F-04 Database Index Implementation Suite", async (t) => {
  await t.test("1. Fee schema indexes", () => {
    const indexes = Fee.schema.indexes();

    // Verify Fee: { centerId: 1, status: 1, createdAt: -1 }
    const statusCreatedIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.status === 1 && key.createdAt === -1
    );
    assert.ok(statusCreatedIdx, "Fee must define { centerId: 1, status: 1, createdAt: -1 }");
    assert.equal(statusCreatedIdx[1]?.name, "centerId_1_status_1_createdAt_-1");

    // Verify Fee: { centerId: 1, studentId: 1, billingMonth: 1 } with partialFilterExpression
    const billingMonthIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.studentId === 1 && key.billingMonth === 1
    );
    assert.ok(billingMonthIdx, "Fee must define { centerId: 1, studentId: 1, billingMonth: 1 }");
    assert.equal(billingMonthIdx[1]?.name, "centerId_1_studentId_1_billingMonth_1_partial");
    assert.deepEqual(billingMonthIdx[1]?.partialFilterExpression, {
      billingMonth: { $type: "string" },
    });

    // Verify legacy Fee index { centerId: 1, studentId: 1, month: 1 } is preserved
    const legacyMonthIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.studentId === 1 && key.month === 1
    );
    assert.ok(legacyMonthIdx, "Fee must retain legacy { centerId: 1, studentId: 1, month: 1 }");

    // Verify no duplicates
    const keyStrings = indexes.map(([key]) => normalizeKey(key));
    const uniqueKeys = new Set(keyStrings);
    assert.equal(keyStrings.length, uniqueKeys.size, "Fee schema must not define duplicate index keys");
  });

  await t.test("2. Attendance schema indexes", () => {
    const indexes = Attendance.schema.indexes();

    // Verify Attendance: { centerId: 1, date: -1, status: 1 }
    const dateStatusIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.date === -1 && key.status === 1
    );
    assert.ok(dateStatusIdx, "Attendance must define { centerId: 1, date: -1, status: 1 }");
    assert.equal(dateStatusIdx[1]?.name, "centerId_1_date_-1_status_1");

    // Verify existing student/batch/teacher indexes are retained
    const studentDateIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.studentId === 1 && key.date === 1
    );
    assert.ok(studentDateIdx, "Attendance must retain { centerId: 1, studentId: 1, date: 1 }");

    const batchDateIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.batch === 1 && key.date === 1
    );
    assert.ok(batchDateIdx, "Attendance must retain { centerId: 1, batch: 1, date: 1 }");

    const teacherDateIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.assignedTeacherId === 1 && key.date === -1
    );
    assert.ok(teacherDateIdx, "Attendance must retain { centerId: 1, assignedTeacherId: 1, date: -1 }");

    // Verify no duplicates
    const keyStrings = indexes.map(([key]) => normalizeKey(key));
    const uniqueKeys = new Set(keyStrings);
    assert.equal(keyStrings.length, uniqueKeys.size, "Attendance schema must not define duplicate index keys");
  });

  await t.test("3. Student schema indexes", () => {
    const indexes = Student.schema.indexes();

    // Verify Student: { centerId: 1, isActive: 1 }
    const activeIdx = indexes.find(
      ([key]) => Object.keys(key).length === 2 && key.centerId === 1 && key.isActive === 1
    );
    assert.ok(activeIdx, "Student must define { centerId: 1, isActive: 1 }");
    assert.equal(activeIdx[1]?.name, "centerId_1_isActive_1");

    // Verify existing indexes are retained
    const batchIdx = indexes.find(([key]) => key.centerId === 1 && key.batch === 1);
    assert.ok(batchIdx, "Student must retain { centerId: 1, batch: 1 }");

    // Verify no duplicates
    const keyStrings = indexes.map(([key]) => normalizeKey(key));
    const uniqueKeys = new Set(keyStrings);
    assert.equal(keyStrings.length, uniqueKeys.size, "Student schema must not define duplicate index keys");
  });

  await t.test("4. Test schema indexes", () => {
    const indexes = Test.schema.indexes();

    // Verify Test: { centerId: 1, "results.studentId": 1, date: -1 }
    const resultStudentIdx = indexes.find(
      ([key]) => key.centerId === 1 && key["results.studentId"] === 1 && key.date === -1
    );
    assert.ok(resultStudentIdx, "Test must define { centerId: 1, results.studentId: 1, date: -1 }");
    assert.equal(resultStudentIdx[1]?.name, "centerId_1_results.studentId_1_date_-1");

    // Verify existing indexes are retained
    const centerDateIdx = indexes.find(
      ([key]) => key.centerId === 1 && key.date === -1 && !key["results.studentId"]
    );
    assert.ok(centerDateIdx, "Test must retain { centerId: 1, date: -1 }");

    // Verify no duplicates
    const keyStrings = indexes.map(([key]) => normalizeKey(key));
    const uniqueKeys = new Set(keyStrings);
    assert.equal(keyStrings.length, uniqueKeys.size, "Test schema must not define duplicate index keys");
  });
});
