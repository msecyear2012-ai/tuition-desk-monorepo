import { after } from "next/server.js";

/**
 * Executes a background task decoupled from the HTTP response.
 * 
 * On Vercel / Next.js serverless runtimes, uses Next.js after() to prevent premature Lambda context freezing.
 * In unit tests or environments outside of an active Next.js request scope, gracefully falls back to setImmediate.
 */
export function runBackgroundTask(task: () => Promise<unknown> | unknown): void {
  try {
    after(async () => {
      try {
        await task();
      } catch (err) {
        console.error("[SERVERLESS BACKGROUND TASK ERROR]", err);
      }
    });
  } catch {
    // Fallback for unit testing and standalone contexts outside Next.js request scope
    setImmediate(async () => {
      try {
        await task();
      } catch (err) {
        console.error("[BACKGROUND TASK ERROR]", err);
      }
    });
  }
}

export default runBackgroundTask;
