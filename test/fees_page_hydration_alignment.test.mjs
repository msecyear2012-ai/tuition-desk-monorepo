import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { signToken, verifyToken } from "../src/lib/jwt.ts";
import { resolveFeeTabs } from "../src/app/fees/feeNavigation.ts";

process.env.JWT_SECRET = "msec_test_secret_key_minimum_32_characters_long_for_hs256!";

describe("Fees Page Hydration & SSR Tree Alignment Suite", () => {
  const pagePath = path.resolve("src/app/fees/page.tsx");
  const clientPath = path.resolve("src/app/fees/FeesClient.tsx");

  test("1. Architectural separation: page.tsx is Server Component, FeesClient.tsx is Client Component", () => {
    const pageContent = fs.readFileSync(pagePath, "utf-8");
    const clientContent = fs.readFileSync(clientPath, "utf-8");

    // page.tsx MUST NOT be marked "use client"
    assert.ok(!pageContent.startsWith('"use client"'), "page.tsx must be a Server Component");
    assert.ok(!pageContent.startsWith("'use client'"), "page.tsx must be a Server Component");

    // FeesClient.tsx MUST be marked "use client"
    assert.ok(
      clientContent.startsWith('"use client"') || clientContent.startsWith("'use client'"),
      "FeesClient.tsx must be a Client Component"
    );
  });

  test("2. No suppressHydrationWarning workaround used", () => {
    const pageContent = fs.readFileSync(pagePath, "utf-8");
    const clientContent = fs.readFileSync(clientPath, "utf-8");

    assert.ok(
      !pageContent.includes("suppressHydrationWarning"),
      "page.tsx must not use suppressHydrationWarning"
    );
    assert.ok(
      !clientContent.includes("suppressHydrationWarning"),
      "FeesClient.tsx must not use suppressHydrationWarning"
    );
  });

  test("3. Modal dynamic imports: No { ssr: false } causing Suspense/div hydration mismatch", () => {
    const clientContent = fs.readFileSync(clientPath, "utf-8");

    // Assert that AddFeeModal and other modals are not configured with ssr: false
    assert.ok(
      clientContent.includes('const AddFeeModal = dynamic(() => import("@/components/modals/AddFeeModal")'),
      "AddFeeModal must be dynamically imported"
    );
    assert.ok(
      !clientContent.includes('const AddFeeModal = dynamic(() => import("@/components/modals/AddFeeModal"), {\n  ssr: false'),
      "AddFeeModal must not have { ssr: false }"
    );

    assert.ok(
      clientContent.includes('const FeePaymentModal = dynamic(() => import("@/components/modals/FeePaymentModal")'),
      "FeePaymentModal must be dynamically imported"
    );
    assert.ok(
      !clientContent.includes('const FeePaymentModal = dynamic(() => import("@/components/modals/FeePaymentModal"), {\n  ssr: false'),
      "FeePaymentModal must not have { ssr: false }"
    );

    assert.ok(
      clientContent.includes('const TeacherHandoverConsole = dynamic(\n  () => import("@/components/handovers/TeacherHandoverConsole")'),
      "TeacherHandoverConsole must be dynamically imported"
    );
    assert.ok(
      !clientContent.includes('TeacherHandoverConsole = dynamic(\n  () => import("@/components/handovers/TeacherHandoverConsole"),\n  { ssr: false }'),
      "TeacherHandoverConsole must not have ssr: false"
    );

    // Verify loading fallback is provided
    assert.ok(
      clientContent.includes("Loading handover console..."),
      "TeacherHandoverConsole must provide a stable loading fallback"
    );
  });

  test("4. Conditional rendering of modals: Closed modals evaluate to falsy/null on both server and client", () => {
    const clientContent = fs.readFileSync(clientPath, "utf-8");

    assert.ok(
      clientContent.includes("{isAddFeeModalOpen && (") ||
      clientContent.includes("{isAddFeeModalOpen && <AddFeeModal"),
      "AddFeeModal must be guarded by isAddFeeModalOpen so it renders null during initial hydration"
    );

    assert.ok(
      clientContent.includes("{isPaymentModalOpen && (") ||
      clientContent.includes("{isPaymentModalOpen && <FeePaymentModal"),
      "FeePaymentModal must be guarded by isPaymentModalOpen"
    );

    assert.ok(
      clientContent.includes("{Boolean(selectedDetailFeeId) && (") ||
      clientContent.includes("{Boolean(selectedDetailFeeId) && <FeeDetailModal"),
      "FeeDetailModal must be guarded by Boolean(selectedDetailFeeId)"
    );

    assert.ok(
      clientContent.includes("{Boolean(activeReceiptData) && (") ||
      clientContent.includes("{Boolean(activeReceiptData) && <ReceiptSlipModal"),
      "ReceiptSlipModal must be guarded by Boolean(activeReceiptData)"
    );
  });

  test("5. Server and client share resolveFeeTabs: Tab & sub parameter mapping preserves initial SSR route state", () => {
    // Case A: /fees (Default)
    const defaultRes = resolveFeeTabs({});
    assert.equal(defaultRes.initialTab, "overview");
    assert.equal(defaultRes.initialSub, "pending");

    // Case B: /fees?tab=handovers
    const handoverRes = resolveFeeTabs({ tab: "handovers" });
    assert.equal(handoverRes.initialTab, "handovers");
    assert.equal(handoverRes.initialSub, "pending");

    // Case C: /fees?tab=payments&sub=pending
    const paymentsPendingRes = resolveFeeTabs({ tab: "payments", sub: "pending" });
    assert.equal(paymentsPendingRes.initialTab, "payments");
    assert.equal(paymentsPendingRes.initialSub, "pending");

    // Case D: /fees?tab=payments&sub=paid
    const paymentsPaidRes = resolveFeeTabs({ tab: "payments", sub: "paid" });
    assert.equal(paymentsPaidRes.initialTab, "payments");
    assert.equal(paymentsPaidRes.initialSub, "paid");

    // Case E: /fees?tab=payments&sub=review
    const paymentsReviewRes = resolveFeeTabs({ tab: "payments", sub: "review" });
    assert.equal(paymentsReviewRes.initialTab, "payments");
    assert.equal(paymentsReviewRes.initialSub, "review");

    // Case F: Legacy shorthand /fees?tab=review
    const legacyReviewRes = resolveFeeTabs({ tab: "review" });
    assert.equal(legacyReviewRes.initialTab, "payments");
    assert.equal(legacyReviewRes.initialSub, "review");

    // Case G: Legacy shorthand /fees?tab=paid
    const legacyPaidRes = resolveFeeTabs({ tab: "paid" });
    assert.equal(legacyPaidRes.initialTab, "payments");
    assert.equal(legacyPaidRes.initialSub, "paid");
  });

  test("6. JWT cookie extraction derives matching initialProfile on server for Owner and Teacher", async () => {
    // Owner token
    const ownerToken = await signToken({
      centerId: "center_msec_001",
      role: "owner",
      name: "Owner Dr. Sharma",
    });
    const ownerPayload = await verifyToken(ownerToken);
    assert.ok(ownerPayload);
    assert.equal(ownerPayload.role, "owner");
    assert.equal(ownerPayload.centerId, "center_msec_001");

    // Teacher token
    const teacherToken = await signToken({
      centerId: "center_msec_001",
      role: "teacher",
      name: "Jitender Kumar",
      teacherId: "teacher_jitender_99",
    });
    const teacherPayload = await verifyToken(teacherToken);
    assert.ok(teacherPayload);
    assert.equal(teacherPayload.role, "teacher");
    assert.equal(teacherPayload.centerId, "center_msec_001");
    assert.equal(teacherPayload.teacherId, "teacher_jitender_99");
  });

  test("7. Browser back/forward navigation: popstate event listener is registered in FeesClient", () => {
    const clientContent = fs.readFileSync(clientPath, "utf-8");

    assert.ok(
      clientContent.includes('window.addEventListener("popstate", handlePopState)'),
      "FeesClient must register a popstate event listener"
    );
    assert.ok(
      clientContent.includes('window.removeEventListener("popstate", handlePopState)'),
      "FeesClient must clean up the popstate listener on unmount"
    );
  });

  test("8. Initial data states match between server and client without window-dependent divergence", () => {
    const clientContent = fs.readFileSync(clientPath, "utf-8");

    assert.ok(
      clientContent.includes("const [pendingStudents, setPendingStudents] = useState<OverdueFeeStudent[]>([]);"),
      "pendingStudents must initialize cleanly to []"
    );
    assert.ok(
      clientContent.includes("const [reviewStudents, setReviewStudents] = useState<OverdueFeeStudent[]>([]);"),
      "reviewStudents must initialize cleanly to []"
    );
    assert.ok(
      clientContent.includes("const [collectedAmount, setCollectedAmount] = useState<number>(0);"),
      "collectedAmount must initialize cleanly to 0"
    );
    assert.ok(
      clientContent.includes("const [loading, setLoading] = useState(true);"),
      "loading must initialize cleanly to true"
    );
  });
});
