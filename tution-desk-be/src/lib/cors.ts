import type { NextRequest } from "next/server";
import { NextResponse } from "next/server.js";

// Default allowed origins (in production, localhost is strictly excluded unless explicitly set via ALLOWED_ORIGINS)
const PRODUCTION_ALLOWED_ORIGINS = [
  "https://tuition-desk-monorepo.vercel.app",
  "https://tuition-desk-one.vercel.app",
  "https://tution-desk-one.vercel.app",
];

const DEVELOPMENT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...PRODUCTION_ALLOWED_ORIGINS,
];

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function getAllowedOrigins(): Set<string> {
  const envOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : [];

  const baseOrigins =
    process.env.NODE_ENV === "production"
      ? PRODUCTION_ALLOWED_ORIGINS
      : DEVELOPMENT_ALLOWED_ORIGINS;

  const combined = [...baseOrigins, ...envOrigins]
    .map((o) => normalizeOrigin(o))
    .filter(Boolean);

  return new Set(combined);
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = getAllowedOrigins();
  return allowed.has(normalizeOrigin(origin));
}

/**
 * Validates request origin against allowed origins for sensitive mutations and session endpoints.
 * Explicitly rejects unapproved origins before body parsing or database queries.
 * Behavior for missing Origin:
 * - If Sec-Fetch-Site indicates 'cross-site' without an approved Origin, request is rejected.
 * - If Referer is present, its origin is validated against allowed origins.
 * - Same-origin, direct server-to-server, or test calls without cross-origin indicators are permitted.
 */
export function validateRequestOrigin(request: NextRequest | Request): {
  allowed: boolean;
  origin: string | null;
  reason?: string;
} {
  const origin = request.headers.get("origin");
  const secFetchSite = request.headers.get("sec-fetch-site");

  // 1. If Sec-Fetch-Site indicates cross-site, require valid approved Origin
  if (secFetchSite === "cross-site") {
    if (!origin || !isOriginAllowed(origin)) {
      return {
        allowed: false,
        origin,
        reason: "Cross-site request rejected by Sec-Fetch-Site policy",
      };
    }
  }

  // 2. If Origin header is present, strictly check against allowed origins
  if (origin) {
    if (!isOriginAllowed(origin)) {
      return {
        allowed: false,
        origin,
        reason: `Origin '${origin}' is not authorized`,
      };
    }
    return { allowed: true, origin };
  }

  // 3. If Origin is absent, check Referer if provided by client
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`;
      if (!isOriginAllowed(refererOrigin)) {
        return {
          allowed: false,
          origin: refererOrigin,
          reason: `Referer origin '${refererOrigin}' is not authorized`,
        };
      }
    } catch {
      return {
        allowed: false,
        origin: null,
        reason: "Malformed Referer header",
      };
    }
  }

  // 4. Same-origin or local non-browser calls with no cross-origin indicators
  return { allowed: true, origin: null };
}

/**
 * Returns dynamic CORS headers for an incoming request.
 * - If request origin matches an allowed origin:
 *   - Access-Control-Allow-Origin: <exact_request_origin>
 *   - Access-Control-Allow-Credentials: "true"
 *   - Vary: "Origin"
 * - If request origin is unapproved or absent:
 *   - NO Access-Control-Allow-Origin header is emitted (no fallback, no wildcard).
 *   - Vary: "Origin" is always included.
 */
export function getCorsHeaders(
  request: NextRequest | Request
): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    Vary: "Origin",
  };

  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

/**
 * Handles CORS OPTIONS preflight request.
 * - Allowed origin: 204 No Content with approved methods, headers, credentials, max-age, and Vary.
 * - Unapproved origin: 403 Forbidden with Vary: Origin, and NO Access-Control headers.
 */
export function handleCorsPreflight(
  request: NextRequest | Request,
  allowedMethods = "GET, POST, PUT, DELETE, PATCH, OPTIONS"
): NextResponse {
  const origin = request.headers.get("origin");

  if (origin && isOriginAllowed(origin)) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": allowedMethods,
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, x-center-id, Idempotency-Key, idempotency-key, x-idempotency-key, x-portal-token, Cookie, Set-Cookie",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }

  // Reject unapproved preflight requests with 403 and no CORS allowance
  return new NextResponse(null, {
    status: 403,
    headers: {
      Vary: "Origin",
    },
  });
}
