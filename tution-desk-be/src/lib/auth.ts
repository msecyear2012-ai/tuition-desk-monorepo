import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { NextRequest } from "next/server";
import { getJwtSecretKey } from "./jwt.ts";

export interface AuthPayload extends JWTPayload {
  userId?: string;
  centerId: string;
  role: "owner" | "teacher" | "parent";
  teacherId?: string;
  name?: string;
  mustChangePassword?: boolean;
  parentAccessId?: string;
  tokenPrefix?: string;
  linkedStudentIds?: string[];
}

/**
 * Sign a JWT token with userId, centerId, role, and optional teacher context.
 * Expires in 7 days.
 */
export async function signToken(payload: {
  userId?: string;
  centerId: string;
  role: "owner" | "teacher" | "parent";
  teacherId?: string;
  name?: string;
  mustChangePassword?: boolean;
  [key: string]: unknown;
}): Promise<string> {
  const secretKey = getJwtSecretKey();
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey);
}

/**
 * Verify a JWT token and return the payload.
 * Throws configuration errors if JWT_SECRET is missing.
 * Returns null if invalid or expired.
 */
export async function verifyToken(token: string): Promise<AuthPayload | null> {
  const secretKey = getJwtSecretKey();
  try {
    const { payload } = await jwtVerify(token, secretKey);
    return payload as unknown as AuthPayload;
  } catch {
    return null;
  }
}

/**
 * Extracts and verifies the authenticated user strictly from the request's verified JWT token
 * in cookies or Authorization header (Bearer token).
 * Fails closed and returns null if unauthenticated.
 */
export async function getAuthenticatedUser(
  request: NextRequest
): Promise<AuthPayload | null> {
  // 1. Check cookies (auth_token or token)
  const cookieToken =
    request.cookies.get("auth_token")?.value ||
    request.cookies.get("token")?.value;

  if (cookieToken) {
    const payload = await verifyToken(cookieToken);
    if (payload?.centerId) {
      if (!payload.userId) {
        payload.userId =
          payload.teacherId ||
          (typeof (payload as any).sub === "string" ? (payload as any).sub : null) ||
          String(payload.centerId);
      }
      return payload;
    }
  }

  // 2. Check Authorization header: Bearer <token>
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    const payload = await verifyToken(token);
    if (payload?.centerId) {
      if (!payload.userId) {
        payload.userId =
          payload.teacherId ||
          (typeof (payload as any).sub === "string" ? (payload as any).sub : null) ||
          String(payload.centerId);
      }
      return payload;
    }
  }

  return null;
}

/**
 * Extracts and verifies the centerId strictly from the request's verified JWT token
 * in cookies or Authorization header (Bearer token).
 * Fails closed and returns null if unauthenticated.
 * Preserved for full backward compatibility across existing API routes.
 */
export async function getAuthenticatedCenterId(
  request: NextRequest
): Promise<string | null> {
  const user = await getAuthenticatedUser(request);
  return user?.centerId ? String(user.centerId) : null;
}
