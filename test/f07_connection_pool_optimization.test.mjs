import test from "node:test";
import assert from "node:assert/strict";

import {
  MONGODB_CONNECTION_OPTIONS,
  connectDB,
} from "../tution-desk-be/src/lib/db.ts";

test("F-07: Database Connection Pool Optimization Suite", async (t) => {
  // =========================================================================
  // 1. POOL SIZE & SERVERLESS CONFIGURATION VERIFICATION
  // =========================================================================
  await t.test("1. MONGODB_CONNECTION_OPTIONS specifies serverless-tuned pool and timeout bounds", () => {
    assert.equal(
      MONGODB_CONNECTION_OPTIONS.maxPoolSize,
      10,
      "maxPoolSize must be reduced to 10 for serverless concurrency safety"
    );
    assert.equal(
      MONGODB_CONNECTION_OPTIONS.minPoolSize,
      1,
      "minPoolSize must be 1 to maintain warm connection in active containers"
    );
    assert.equal(
      MONGODB_CONNECTION_OPTIONS.serverSelectionTimeoutMS,
      5000,
      "serverSelectionTimeoutMS must be 5000ms to fail fast in serverless"
    );
    assert.equal(
      MONGODB_CONNECTION_OPTIONS.maxIdleTimeMS,
      30000,
      "maxIdleTimeMS must be 30000ms to reclaim idle sockets cleanly"
    );
    assert.equal(
      MONGODB_CONNECTION_OPTIONS.bufferCommands,
      false,
      "bufferCommands must be false to fail fast when not connected"
    );
    assert.equal(
      MONGODB_CONNECTION_OPTIONS.autoIndex,
      false,
      "autoIndex must remain false in production"
    );
  });

  // =========================================================================
  // 2. WARM SERVERLESS INVOCATION CONNECTION REUSE
  // =========================================================================
  await t.test("2. connectDB returns cached connection on warm serverless invocation", async () => {
    const originalCache = global.mongooseCache;
    const mockMongoose = {
      connection: {
        readyState: 1, // Connected
      },
    };

    try {
      global.mongooseCache = {
        conn: mockMongoose,
        promise: Promise.resolve(mockMongoose),
      };

      const conn = await connectDB();
      assert.strictEqual(
        conn,
        mockMongoose,
        "connectDB must reuse existing cached connection without reconnecting"
      );
    } finally {
      global.mongooseCache = originalCache;
    }
  });

  // =========================================================================
  // 3. IN-FLIGHT PROMISE DEDUPLICATION ACROSS CONCURRENT CALLS
  // =========================================================================
  await t.test("3. Concurrent connectDB calls share one in-flight connection promise", async () => {
    const originalCache = global.mongooseCache;
    const originalUri = process.env.MONGODB_URI;

    let resolvePromise;
    const mockMongoose = { connection: { readyState: 1 } };
    const sharedPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    try {
      process.env.MONGODB_URI = "mongodb://localhost:27017/dummy_test";
      // Simulate an in-flight connection attempt
      global.mongooseCache = {
        conn: null,
        promise: sharedPromise.then(() => mockMongoose),
      };

      // Both concurrent calls should await the same promise
      const call1 = connectDB();
      const call2 = connectDB();

      resolvePromise();

      const [res1, res2] = await Promise.all([call1, call2]);
      assert.strictEqual(res1, mockMongoose);
      assert.strictEqual(res2, mockMongoose);
      assert.strictEqual(res1, res2, "Both concurrent callers must share the exact same instance");
    } finally {
      global.mongooseCache = originalCache;
      process.env.MONGODB_URI = originalUri;
    }
  });

  // =========================================================================
  // 4. RETRY AFTER INITIAL CONNECTION FAILURE
  // =========================================================================
  await t.test("4. Connection failure clears in-flight promise allowing retry on next request", async () => {
    const originalCache = global.mongooseCache;
    const originalUri = process.env.MONGODB_URI;

    try {
      process.env.MONGODB_URI = "mongodb://localhost:27017/dummy_test";
      let rejectPromise;
      const failingPromise = new Promise((_, reject) => {
        rejectPromise = reject;
      });

      // Attach unhandledRejection sink to test promise directly
      failingPromise.catch(() => {});

      global.mongooseCache = {
        conn: null,
        promise: failingPromise,
      };

      const call = connectDB();
      rejectPromise(new Error("Simulated Atlas Network Error"));

      await assert.rejects(
        () => call,
        /Simulated Atlas Network Error/,
        "Must throw on connection failure"
      );

      // Verify that after failure, cached.promise is cleared to allow retry
      assert.strictEqual(
        global.mongooseCache.promise,
        null,
        "cached.promise must be reset to null after failure"
      );
    } finally {
      global.mongooseCache = originalCache;
      process.env.MONGODB_URI = originalUri;
    }
  });
});
