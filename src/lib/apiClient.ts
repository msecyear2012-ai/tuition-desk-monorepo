const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

/**
 * Retrieves the active tuition center ID dynamically from cookies or localStorage.
 * No hardcoding — correctly scopes data to the currently authenticated owner.
 */
export function getCurrentCenterId(): string {
  if (typeof window !== "undefined") {
    // 1. Read from document.cookie (set on login/register & refreshed by middleware)
    const cookieMatch = document.cookie.match(/(?:^|;\s*)center_id=([^;]+)/);
    if (cookieMatch && cookieMatch[1]) {
      return decodeURIComponent(cookieMatch[1]);
    }
    // 2. Read from localStorage
    const stored = localStorage.getItem("user_center_id");
    if (stored) {
      return stored;
    }
  }
  return "";
}

/**
 * Dynamically resolves the active center ID.
 * Kept for backwards compatibility with existing UI components.
 */
export const CURRENT_CENTER_ID = typeof window !== "undefined" ? getCurrentCenterId() : "";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: string;
  code?: string;
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * Set to true to bypass cache read and force a fresh network fetch.
   */
  skipCache?: boolean;
  /**
   * Custom cache time-to-live in milliseconds. Defaults to 60,000ms (60s).
   * Set to 0 to disable caching of the response.
   */
  cacheTtlMs?: number;
}

interface CacheEntry<T> {
  data: ApiResponse<T>;
  expiresAt: number;
  centerId: string;
}

// In-memory short-lived cache and in-flight request deduplication map
const apiCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<ApiResponse<unknown>>>();

// Conservative endpoint-to-cache dependency mapping
const DOMAIN_DEPENDENCY_MAP: Record<string, string[]> = {
  "/attendance": ["/attendance", "/dashboard"],
  "/teachers": ["/teachers"],
  "/tests": ["/tests"],
  "/parent": ["/parent"],
  "/handovers": ["/handovers", "/fees"],
  "/fees": ["/fees", "/dashboard", "/reports", "/handovers"],
  "/students": ["/students", "/dashboard", "/reports", "/batches"],
  "/batches": ["/batches", "/dashboard", "/attendance"],
  "/batch-requests": ["/batch-requests", "/students", "/batches"],
};

// Generation tracking for stale in-flight response protection
let globalCacheGeneration = 0;
const domainGenerations = new Map<string, number>();

function getDomainFromEndpoint(endpoint: string): string {
  const norm = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const firstSegment = norm.split("/").filter(Boolean)[0];
  return firstSegment ? `/${firstSegment}` : norm;
}

function getEndpointGeneration(endpoint: string): number {
  const domain = getDomainFromEndpoint(endpoint);
  return (domainGenerations.get(domain) || 0) + globalCacheGeneration;
}

function bumpGeneration(patterns?: string[]): void {
  if (!patterns || patterns.length === 0) {
    globalCacheGeneration++;
  } else {
    for (const p of patterns) {
      const domain = getDomainFromEndpoint(p);
      domainGenerations.set(domain, (domainGenerations.get(domain) || 0) + 1);
    }
  }
}

/**
 * Builds a deterministic cache key scoped by active center ID and sorted query parameters.
 */
function buildCacheKey(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined | null> | undefined,
  centerId: string
): string {
  const normEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (!params || Object.keys(params).length === 0) {
    return `${centerId}::${normEndpoint}`;
  }
  const keys = Object.keys(params)
    .filter((k) => k !== "centerId")
    .sort();
  const searchParams = new URLSearchParams();
  for (const k of keys) {
    const val = params[k];
    if (val !== undefined && val !== null && val !== "") {
      searchParams.append(k, String(val));
    }
  }
  const queryString = searchParams.toString();
  return queryString
    ? `${centerId}::${normEndpoint}?${queryString}`
    : `${centerId}::${normEndpoint}`;
}

/**
 * Clears the in-memory API response cache and any active in-flight request records.
 * If centerIdOnly is provided, only entries for that center are cleared.
 */
export function clearApiCache(centerIdOnly?: string): void {
  if (centerIdOnly) {
    for (const [key, entry] of apiCache.entries()) {
      if (entry.centerId === centerIdOnly) {
        apiCache.delete(key);
      }
    }
  } else {
    apiCache.clear();
    domainGenerations.clear();
  }
  globalCacheGeneration++;
  inFlightRequests.clear();
}

/**
 * Invalidates cache entries matching an endpoint pattern or all entries for the active center.
 */
export function invalidateApiCache(pattern?: string | RegExp): void {
  const activeCenterId = getCurrentCenterId();

  // Case A: No pattern provided -> Global invalidation for active center
  if (!pattern) {
    bumpGeneration();
    for (const [key, entry] of apiCache.entries()) {
      if (!activeCenterId || entry.centerId === activeCenterId) {
        apiCache.delete(key);
      }
    }
    inFlightRequests.clear();
    return;
  }

  // Case B: String pattern (either mutating endpoint or explicit pattern)
  if (typeof pattern === "string") {
    const domain = getDomainFromEndpoint(pattern);
    const mappedPatterns = DOMAIN_DEPENDENCY_MAP[domain];

    // If endpoint starts with "/" and is unrecognized in dependency map, fall back to safe global invalidation
    if (pattern.startsWith("/") && !mappedPatterns) {
      bumpGeneration();
      for (const [key, entry] of apiCache.entries()) {
        if (!activeCenterId || entry.centerId === activeCenterId) {
          apiCache.delete(key);
        }
      }
      inFlightRequests.clear();
      return;
    }

    const targetPatterns = mappedPatterns || [pattern];
    bumpGeneration(targetPatterns);

    for (const [key, entry] of apiCache.entries()) {
      if (activeCenterId && entry.centerId !== activeCenterId) continue;
      if (targetPatterns.some((target) => key.includes(target))) {
        apiCache.delete(key);
      }
    }

    for (const key of inFlightRequests.keys()) {
      if (targetPatterns.some((target) => key.includes(target))) {
        inFlightRequests.delete(key);
      }
    }
    return;
  }

  // Case C: RegExp pattern
  if (pattern instanceof RegExp) {
    bumpGeneration();
    for (const [key, entry] of apiCache.entries()) {
      if (activeCenterId && entry.centerId !== activeCenterId) continue;
      if (pattern.test(key)) {
        apiCache.delete(key);
      }
    }
    for (const key of inFlightRequests.keys()) {
      if (pattern.test(key)) {
        inFlightRequests.delete(key);
      }
    }
  }
}

/**
 * Synchronously retrieves valid, unexpired cached data if available.
 * Enables instant frame-0 rendering when navigating between tabs.
 */
export function getApiCache<T = unknown>(
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined | null>
): ApiResponse<T> | null {
  if (typeof window === "undefined") return null;
  const activeCenterId = getCurrentCenterId();
  if (!activeCenterId) return null;
  const key = buildCacheKey(endpoint, params, activeCenterId);
  const entry = apiCache.get(key);
  if (entry && entry.centerId === activeCenterId && Date.now() < entry.expiresAt) {
    return entry.data as ApiResponse<T>;
  }
  if (entry && Date.now() >= entry.expiresAt) {
    apiCache.delete(key);
  }
  return null;
}

/**
 * Generic API client utility for fetching backend endpoints.
 * Automatically attaches authentication cookies, Bearer token, and active centerId.
 * Includes short-lived read caching, in-flight deduplication, and mutation invalidation.
 */
export async function apiClient<T = unknown>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const { params = {}, body, headers = {}, skipCache = false, cacheTtlMs, ...rest } = options;

  let url = `${BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  // Automatically inject dynamic centerId if not explicitly provided or if legacy hardcoded
  const activeCenterId = getCurrentCenterId();
  const queryParams: Record<string, string | number | boolean | undefined | null> = {
    ...params,
  };

  if ((!queryParams.centerId || queryParams.centerId === "aroven-001") && activeCenterId) {
    queryParams.centerId = activeCenterId;
  }

  const searchParams = new URLSearchParams();
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.append(key, String(value));
    }
  });
  const queryString = searchParams.toString();
  if (queryString) {
    url += (url.includes("?") ? "&" : "?") + queryString;
  }

  // Retrieve auth token if stored locally
  const token =
    typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;

  const authHeaders: Record<string, string> = {};
  if (token) {
    authHeaders["Authorization"] = `Bearer ${token}`;
  }
  if (activeCenterId) {
    authHeaders["x-center-id"] = activeCenterId;
  }

  // If body is an object, inject centerId if missing or hardcoded
  let payloadBody = body;
  if (
    payloadBody &&
    typeof payloadBody === "object" &&
    !Array.isArray(payloadBody) &&
    activeCenterId
  ) {
    const obj = payloadBody as Record<string, unknown>;
    if (!obj.centerId || obj.centerId === "aroven-001") {
      payloadBody = { ...obj, centerId: activeCenterId };
    }
  }

  const method = (rest.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const isEligibleForCache = isGet && (cacheTtlMs === undefined || cacheTtlMs > 0);
  const cacheKey = isEligibleForCache ? buildCacheKey(endpoint, queryParams, activeCenterId) : "";
  const canReadCache = isEligibleForCache && !skipCache;

  // 1. If eligible for cache read, check synchronous memory cache
  if (canReadCache && cacheKey) {
    const cachedEntry = apiCache.get(cacheKey);
    if (cachedEntry && cachedEntry.centerId === activeCenterId && Date.now() < cachedEntry.expiresAt) {
      return cachedEntry.data as ApiResponse<T>;
    }
    // 2. Check in-flight request deduplication
    const inFlight = inFlightRequests.get(cacheKey);
    if (inFlight) {
      return inFlight as Promise<ApiResponse<T>>;
    }
  }

  const requestGeneration = isEligibleForCache ? getEndpointGeneration(endpoint) : 0;

  // 3. Construct and execute the fetch
  const executeFetch = async (): Promise<ApiResponse<T>> => {
    try {
      const response = await fetch(url, {
        credentials: "include", // Pass cookies cross-origin between port 3000 & 3001
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...headers,
        },
        body: payloadBody !== undefined ? JSON.stringify(payloadBody) : undefined,
        ...rest,
      });

      const json = (await response.json()) as ApiResponse<T>;

      if (!response.ok || !json.success) {
        // If mutation failed (e.g. 409 Conflict, stale state), flush cache so subsequent reads get server truth
        if (!isGet) {
          invalidateApiCache();
        }
        const error = new Error(json.error || `Request failed with status ${response.status}`) as Error & {
          code?: string;
          status?: number;
          data?: unknown;
        };
        error.code = json.code;
        error.status = response.status;
        error.data = json.data;
        throw error;
      }

      // If GET was successful and cacheable, update client cache with fresh authoritative response
      // Version guard: only write to cache if no invalidation for this endpoint occurred while in-flight
      if (isEligibleForCache && cacheKey) {
        const currentGeneration = getEndpointGeneration(endpoint);
        if (requestGeneration === currentGeneration) {
          const ttl = cacheTtlMs ?? 60000; // 60s default
          apiCache.set(cacheKey, {
            data: json,
            expiresAt: Date.now() + ttl,
            centerId: activeCenterId,
          });
        }
      }

      // If mutation (POST/PUT/PATCH/DELETE), invalidate cache for active center
      if (!isGet) {
        invalidateApiCache(endpoint);
      }

      return json;
    } finally {
      if (isEligibleForCache && cacheKey) {
        inFlightRequests.delete(cacheKey);
      }
    }
  };

  if (canReadCache && cacheKey) {
    const promise = executeFetch();
    inFlightRequests.set(cacheKey, promise);
    return promise;
  }

  return executeFetch();
}

export default apiClient;
