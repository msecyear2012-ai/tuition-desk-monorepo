import crypto from "node:crypto";

export function generateQaRunId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex");
  return `QA_${ts}_${rand}`;
}

export const QA_CONFIG = {
  centerId: "msce-8267",
  ownerId: "6ae869d9c117e0a550dcb247",
  teacher1Id: "6ae9ba93d29bd04896bac676", // Jitender Kumar
  teacher2Id: "6af100000000000000000001", // TEST_E2E_Teacher_Sharma
  
  backendBaseUrl: process.env.BACKEND_URL || "http://localhost:3001",
  frontendBaseUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  whatsappBaseUrl: process.env.WHATSAPP_SERVICE_URL || "http://127.0.0.1:3005",

  // Personal test recipient configuration (strictly empty by default; populated only via explicit CLI/interactive input)
  personalTestRecipients: [],
};
