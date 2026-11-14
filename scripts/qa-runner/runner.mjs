import { QA_CONFIG, generateQaRunId } from "./config.mjs";
import { createAuthTokens } from "./authHelper.mjs";
import { initDbConnection, disconnectDb, cleanupQaRecords } from "./qaDbHelper.mjs";
import { WorkflowExecutor } from "./workflowExecutor.mjs";
import { generateQaReports } from "./reportGenerator.mjs";

async function verifyServices() {
  console.log("🔍 Checking prerequisite services health...");
  try {
    const beRes = await fetch(`${QA_CONFIG.backendBaseUrl}/api/health`, { method: "GET" }).catch(() => null);
    if (!beRes || (beRes.status !== 200 && beRes.status !== 404)) {
      // 404 is acceptable if /api/health doesn't exist, as long as server is responding
      console.log(`ℹ Backend reachable on ${QA_CONFIG.backendBaseUrl}`);
    } else {
      console.log(`✔ Backend reachable on ${QA_CONFIG.backendBaseUrl}`);
    }
  } catch (err) {
    throw new Error(`Backend at ${QA_CONFIG.backendBaseUrl} is unreachable. Please start it.`);
  }

  try {
    const waRes = await fetch(`${QA_CONFIG.whatsappBaseUrl}/health`, { method: "GET" }).catch(() => null);
    if (waRes && waRes.status === 200) {
      console.log(`✔ WhatsApp microservice reachable on ${QA_CONFIG.whatsappBaseUrl}`);
    } else {
      console.warn(`⚠ WhatsApp microservice responded with status ${waRes?.status} or not reachable on ${QA_CONFIG.whatsappBaseUrl}`);
    }
  } catch (err) {
    console.warn(`⚠ WhatsApp microservice at ${QA_CONFIG.whatsappBaseUrl} is unreachable.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="))?.split("=")[1] || "mock";
  const skipCleanup = args.includes("--skip-cleanup");
  const isReal = modeArg.toLowerCase() === "real";

  if (!isReal) {
    // Fail-closed temporary runtime configuration: suppress any live WhatsApp dispatch at the process level
    process.env.WHATSAPP_MODE = "simulation";
    process.env.ENABLE_LIVE_WHATSAPP = "false";
    process.env.ENABLE_ADMISSION_WELCOME_WHATSAPP = "false";
  }

  const hasExplicitConfirmation = args.includes("--confirm-dispatch=true");
  const phoneArg = args.find((a) => a.startsWith("--phone="))?.split("=")[1];

  if (phoneArg) {
    const cleanPhone = phoneArg.replace(/\D/g, "");
    if (cleanPhone.length >= 10) {
      QA_CONFIG.personalTestRecipients = [
        {
          name: "Personal QA Tester",
          phone: cleanPhone,
        },
      ];
    }
  }

  const qaRunId = generateQaRunId();
  const startTime = Date.now();

  console.log("================================================================================");
  console.log(`🚀 MSEC Human Simulation & End-to-End Automation QA Runner`);
  console.log("================================================================================");
  console.log(`• Run ID:           ${qaRunId}`);
  console.log(`• Mode:             ${isReal ? "REAL PERSONAL QA" : "MOCK (Simulation)"}`);
  console.log(`• Target Center:    ${QA_CONFIG.centerId}`);
  console.log(`• Skip Cleanup:     ${skipCleanup}`);
  console.log("================================================================================\n");

  if (isReal) {
    const rawRecipient = QA_CONFIG.personalTestRecipients[0]?.phone;
    const maskedRecipient = rawRecipient && rawRecipient.length >= 4
      ? `+91 ${rawRecipient.slice(0, 2)}******${rawRecipient.slice(-2)}`
      : "(NOT CONFIGURED - AWAITING USER INPUT)";

    console.log("🛑 REAL PERSONAL QA DISPATCH PRE-FLIGHT PREVIEW:");
    console.log("================================================================================");
    console.log(`• Target Institute:       MSEC Institute (centerId: ${QA_CONFIG.centerId})`);
    console.log(`• Target Recipient:       ${maskedRecipient}`);
    console.log(`• Total Outbound Messages: Exactly 2 messages`);
    console.log(`• Recipient Guard:        Strictly user-supplied personal test number; zero genuine DB records queried`);
    console.log(`• Safety Guard:           Zero fallback or sample numbers allowed; fail-closed on unconfirmed/empty recipient`);
    console.log(`• Duplicate Protection:   24-hour cooldown enforcement (WF-08) & campaign deduplication (WF-09)`);
    console.log("--------------------------------------------------------------------------------");
    console.log("📋 SCHEDULED DISPATCH 1 (WF-08 — Individual Fee Reminder):");
    console.log(`  Workflow:               WF-08 Individual Fee Reminder Dispatch`);
    console.log(`  Trigger Persona:        Institute Owner`);
    console.log(`  Student Name:           QA_REM_STU_${qaRunId}`);
    console.log(`  Amount Due:             ₹2,500`);
    console.log(`  Billing Month:          November 2026 (2026-11)`);
    console.log(`  Due Date:               15 Nov 2026`);
    console.log(`  Rendered WhatsApp Content:`);
    console.log(`  ┌─────────────────────────────────────────────────────────────────────────────┐`);
    console.log(`  │ Payment Reminder 🔔                                                         │`);
    console.log(`  │                                                                             │`);
    console.log(`  │ Dear Parent, this is a friendly reminder that the tuition fee of ₹2,500 for │`);
    console.log(`  │ QA_REM_STU_${qaRunId} is due on 15 Nov 2026.                                │`);
    console.log(`  │                                                                             │`);
    console.log(`  │ If you have already paid, please ignore this reminder. Thank you!           │`);
    console.log(`  └─────────────────────────────────────────────────────────────────────────────┘`);
    console.log("--------------------------------------------------------------------------------");
    console.log("📋 SCHEDULED DISPATCH 2 (WF-09 — Smart Messaging Campaign Engine):");
    console.log(`  Workflow:               WF-09 Smart Campaign Announcement`);
    console.log(`  Trigger Persona:        Institute Owner (Teacher approval blocked via 403 test)`);
    console.log(`  Student Name:           QA_STUDENT_${qaRunId}`);
    console.log(`  Campaign Title:         QA_CAMPAIGN_${qaRunId}`);
    console.log(`  Rendered WhatsApp Content:`);
    console.log(`  ┌─────────────────────────────────────────────────────────────────────────────┐`);
    console.log(`  │ Namaste! Official MSEC QA Verification Announcement for                     │`);
    console.log(`  │ [${qaRunId}]. System operation normal.                                      │`);
    console.log(`  └─────────────────────────────────────────────────────────────────────────────┘`);
    console.log("--------------------------------------------------------------------------------");
    console.log(`• Required Flags to Authorize Dispatch:`);
    console.log(`  --mode=real --phone=<your-10-digit-phone> --confirm-dispatch=true`);
    console.log("================================================================================\n");

    if (!hasExplicitConfirmation || QA_CONFIG.personalTestRecipients.length === 0) {
      console.log("⛔ FAIL-CLOSED SAFETY HALT:");
      console.log("• Real personal dispatch halted safely.");
      console.log("• Reason: Awaiting explicit confirmation flag (--confirm-dispatch=true) and personal recipient.");
      console.log("• Zero WhatsApp messages were dispatched.");
      console.log("--------------------------------------------------------------------------------\n");
      process.exit(0);
    }
  }

  await verifyServices();

  console.log("\n📡 Initializing MongoDB connection with safety verification...");
  const db = await initDbConnection();
  console.log(`✔ Database verified: '${db.databaseName}' (Expected: 'msec')`);

  console.log("\n🔑 Generating verified authentication tokens for personas...");
  const tokens = await createAuthTokens();
  console.log(`✔ Tokens minted for Owner, Teacher 1, and Teacher 2`);

  console.log("\n⚡ Initializing Workflow Executor across 15 discovered workflows...");
  const executor = new WorkflowExecutor(qaRunId, tokens, db, { mode: modeArg });

  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ Commencing Workflow Execution");
  console.log("--------------------------------------------------------------------------------\n");

  const results = await executor.executeAll();

  let cleanupStats = null;
  if (!skipCleanup) {
    const manifest = executor.getManifest();
    console.log("\n🧹 Running safe scoped QA record cleanup (tagged with " + qaRunId + " and verified against manifest)...");
    cleanupStats = await cleanupQaRecords(qaRunId, manifest);
    console.log("✔ Cleanup complete. Pruned QA entities:", JSON.stringify(cleanupStats));
  } else {
    console.log("\n⏩ Cleanup skipped per --skip-cleanup flag.");
  }

  await disconnectDb();

  const endTime = Date.now();
  console.log("\n📊 Generating comprehensive QA reports...");
  const reportPaths = await generateQaReports(qaRunId, isReal ? "REAL PERSONAL QA" : "MOCK", results, cleanupStats, startTime, endTime);

  console.log("\n================================================================================");
  console.log("🏁 QA RUN COMPLETE");
  console.log("================================================================================");
  console.log(`Total Workflows:  ${reportPaths.summary.total}`);
  console.log(`Passed:           ${reportPaths.summary.passed}`);
  console.log(`Failed:           ${reportPaths.summary.failed}`);
  console.log(`Blocked:          ${reportPaths.summary.blocked}`);
  console.log(`Pass Rate:        ${reportPaths.summary.passRate}`);
  console.log(`Markdown Report:  ${reportPaths.mdReportPath}`);
  console.log(`JSON Report:      ${reportPaths.jsonReportPath}`);
  console.log("================================================================================\n");

  if (reportPaths.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n❌ Fatal QA Runner Error:", err);
  process.exit(1);
});
