import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var mongooseCache: MongooseCache | undefined;
}

function getCache(): MongooseCache {
  if (!global.mongooseCache) {
    global.mongooseCache = {
      conn: null,
      promise: null,
    };
  }
  return global.mongooseCache;
}

/**
 * Production-tuned MongoDB connection options for Next.js serverless execution.
 * - bufferCommands: false to fail fast if connection is not ready.
 * - autoIndex: false to prevent background index builds during request lifecycle.
 * - maxPoolSize: 10 to prevent connection exhaustion across concurrent serverless instances.
 * - minPoolSize: 1 to maintain a warm connection in active containers.
 * - serverSelectionTimeoutMS: 5000 to fail fast within 5s instead of default 30s.
 * - maxIdleTimeMS: 30000 to reclaim idle sockets after 30s of container inactivity.
 */
export const MONGODB_CONNECTION_OPTIONS: mongoose.ConnectOptions = {
  bufferCommands: false,
  autoIndex: false,
  maxPoolSize: 10,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 5000,
  maxIdleTimeMS: 30000,
};

/**
 * Connect to MongoDB Atlas using Mongoose.
 * Caches the connection in development to prevent creating multiple connections
 * during Next.js hot-reloading, and reuses connections across warm serverless invocations.
 */
export async function connectDB(): Promise<typeof mongoose> {
  const cached = getCache();
  if (cached.conn) {
    return cached.conn;
  }

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      "Please define the MONGODB_URI environment variable inside .env.local"
    );
  }

  if (!cached.promise) {
    const opts = MONGODB_CONNECTION_OPTIONS;

    cached.promise = mongoose.connect(uri, opts).then((mongooseInstance) => {
      return mongooseInstance;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (error) {
    cached.promise = null;
    throw error;
  }

  return cached.conn;
}

export default connectDB;
