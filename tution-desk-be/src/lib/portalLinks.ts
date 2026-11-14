/**
 * Canonical Parent VIP Portal link construction.
 *
 * The Parent Portal has exactly one activation mechanism: a high-entropy
 * `pt_...` token delivered in the URL hash fragment (`/portal#token=pt_...`),
 * which the frontend exchanges once for an HttpOnly `parent_portal_session`
 * cookie. The clean URL form (`/p/{studentId}`) intentionally carries NO
 * credential and only works after that session already exists.
 *
 * Therefore every link that is generated for a parent (or shown to an owner)
 * must be built here, so it always uses the supported activation flow.
 */

export const PORTAL_ENTRY_PATH = "/portal";

/**
 * Custom error thrown when a production Parent Portal base URL fails security
 * validation or is missing in a production environment.
 */
export class ProductionAppUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionAppUrlError";
  }
}

/**
 * Checks whether the current execution context is production.
 * Recognizes NODE_ENV === "production" or VERCEL_ENV === "production".
 */
export function isProductionEnvironment(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

/**
 * Checks if a given URL or hostname string points to localhost or loopback addresses.
 */
export function isLocalhostOrLoopbackUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== "string") return false;
  const trimmed = urlStr.trim().toLowerCase();

  try {
    const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const parsed = new URL(hasProtocol ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    );
  } catch {
    return (
      trimmed.includes("localhost") ||
      trimmed.includes("127.0.0.1") ||
      trimmed.includes("0.0.0.0") ||
      trimmed.includes("::1")
    );
  }
}

export interface PortalAppUrlResolution {
  success: boolean;
  url: string;
  error?: string;
  isProduction: boolean;
}

/**
 * Resolves and validates the canonical public frontend application base URL.
 *
 * Priority order of supported environment variables:
 * 1. env.NEXT_PUBLIC_APP_URL
 * 2. env.APP_URL
 * 3. env.FRONTEND_URL
 * 4. env.APP_BASE_URL
 * 5. env.VERCEL_PROJECT_PRODUCTION_URL (prefixed with https://)
 * 6. env.VERCEL_URL (prefixed with https://)
 *
 * Rules:
 * - In production (NODE_ENV === "production" or VERCEL_ENV === "production"):
 *   - Fails closed if no URL is configured.
 *   - Must be a valid URL with HTTPS protocol.
 *   - Must NOT point to localhost, loopback, or private local network hostnames.
 * - In development / test:
 *   - If configured, validates format (allows http/https/localhost).
 *   - If not configured, cleanly falls back to "http://localhost:3000".
 */
export function resolvePortalAppBaseUrl(
  env: Record<string, string | undefined> = process.env
): PortalAppUrlResolution {
  const isProd = isProductionEnvironment(env);

  // Candidate evaluation in priority order
  const rawCandidate =
    env.NEXT_PUBLIC_APP_URL ||
    env.APP_URL ||
    env.FRONTEND_URL ||
    env.APP_BASE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ||
    (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null);

  if (!rawCandidate || !rawCandidate.trim()) {
    if (isProd) {
      return {
        success: false,
        url: "",
        error:
          "Production configuration error: Public application URL is missing. Set NEXT_PUBLIC_APP_URL or APP_URL to a valid public HTTPS origin (e.g. https://tution-desk-one.vercel.app).",
        isProduction: true,
      };
    }
    return {
      success: true,
      url: "http://localhost:3000",
      isProduction: false,
    };
  }

  let trimmed = rawCandidate.trim().replace(/\/+$/, "");

  // If protocol is missing, auto-prefix
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = isProd ? `https://${trimmed}` : `http://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      success: false,
      url: "",
      error: `Configuration error: Provided application URL is not a valid URL: "${trimmed}".`,
      isProduction: isProd,
    };
  }

  // Production security constraints
  if (isProd) {
    if (parsed.protocol !== "https:") {
      return {
        success: false,
        url: "",
        error:
          "Production configuration error: Public application URL must use HTTPS protocol in production.",
        isProduction: true,
      };
    }

    if (isLocalhostOrLoopbackUrl(parsed.href)) {
      return {
        success: false,
        url: "",
        error:
          "Production configuration error: Localhost and loopback URLs are strictly prohibited in production.",
        isProduction: true,
      };
    }

    // Hostname must contain at least one dot or be a valid public FQDN
    if (!parsed.hostname.includes(".")) {
      return {
        success: false,
        url: "",
        error: `Production configuration error: Public application hostname "${parsed.hostname}" is invalid. Must be a fully-qualified domain name.`,
        isProduction: true,
      };
    }
  }

  // Return normalized origin without trailing slash
  const normalized = `${parsed.protocol}//${parsed.host}${
    parsed.pathname === "/" ? "" : parsed.pathname
  }`.replace(/\/+$/, "");

  return {
    success: true,
    url: normalized,
    isProduction: isProd,
  };
}

/**
 * Resolves the canonical public frontend application base URL, throwing
 * ProductionAppUrlError if resolution fails in production.
 */
export function getPortalAppBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const result = resolvePortalAppBaseUrl(env);
  if (!result.success) {
    throw new ProductionAppUrlError(
      result.error || "Invalid production application URL"
    );
  }
  return result.url;
}

/**
 * Builds the supported Parent Portal activation URL.
 *
 * - With a raw token  -> `${base}/portal#token=pt_...` (activates / re-opens)
 * - Without a token   -> `${base}/portal` (session-based entry only)
 *
 * Enforces production security: throws ProductionAppUrlError if in production
 * and the resulting base URL points to localhost or is invalid.
 */
export function buildPortalActivationUrl(
  rawToken?: string | null,
  baseUrl?: string,
  env: Record<string, string | undefined> = process.env
): string {
  let base: string;
  const isProd = isProductionEnvironment(env);

  if (baseUrl && baseUrl.trim()) {
    base = baseUrl.trim().replace(/\/+$/, "");
    if (isProd && isLocalhostOrLoopbackUrl(base)) {
      throw new ProductionAppUrlError(
        "Production configuration error: Cannot build portal activation URL with localhost base URL in production."
      );
    }
  } else {
    base = getPortalAppBaseUrl(env);
  }

  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) return `${base}${PORTAL_ENTRY_PATH}`;
  return `${base}${PORTAL_ENTRY_PATH}#token=${token}`;
}
