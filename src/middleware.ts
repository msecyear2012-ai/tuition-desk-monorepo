import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyToken } from "@/lib/jwt";

export interface SessionPayload {
  userId?: string;
  centerId: string;
  role: "owner" | "teacher" | "parent";
  teacherId?: string;
  name?: string;
  mustChangePassword?: boolean;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Allow public access to /login, /api/*, /portal, /p/*, _next static files
  if (
    pathname.startsWith("/api") ||
    pathname === "/portal" ||
    pathname.startsWith("/portal/") ||
    pathname.startsWith("/p/") ||
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname.includes(".") ||
    pathname === "/favicon.ico"
  ) {
    // If logged-in owner or teacher visits /login, redirect to dashboard
    if (pathname === "/login") {
      const token = request.cookies.get("auth_token")?.value;
      if (token) {
        const payload = await verifyToken<SessionPayload>(token);
        if (payload && (payload.role === "owner" || payload.role === "teacher")) {
          return NextResponse.redirect(new URL("/", request.url));
        }
      }
    }

    const response = NextResponse.next();

    // Attach strict privacy & security headers to parent portal views
    if (pathname === "/portal" || pathname.startsWith("/portal") || pathname.startsWith("/p/")) {
      response.headers.set(
        "Cache-Control",
        "private, no-store, no-cache, must-revalidate"
      );
      response.headers.set("Referrer-Policy", "no-referrer");
    }

    return response;
  }

  // 2. Protect Authenticated Routes (/, /attendance, /fees, /tests, /admissions, etc.)
  const token = request.cookies.get("auth_token")?.value;

  if (!token) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Verify JWT claims
  const payload = await verifyToken<SessionPayload>(token);
  if (
    !payload ||
    (payload.role !== "owner" && payload.role !== "teacher") ||
    !payload.centerId
  ) {
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("auth_token");
    response.cookies.delete("center_id");
    return response;
  }

  // 3. Strict Role-based Route Protection (DEC-MSEC-01/02):
  // Settings & WhatsApp microservice integration are strictly restricted to the Owner.
  // Additional teachers attempting to navigate to /settings, /teachers, or /reports
  // are redirected back to the main dashboard.
  if (payload.role === "teacher") {
    if (
      pathname.startsWith("/settings") ||
      pathname.startsWith("/teachers") ||
      pathname.startsWith("/reports")
    ) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  const response = NextResponse.next();
  response.headers.set("x-center-id", payload.centerId);
  response.headers.set("x-user-role", payload.role);
  if (payload.teacherId) {
    response.headers.set("x-teacher-id", payload.teacherId);
  }

  // Synchronize client-readable center_id cookie with verified JWT payload
  if (request.cookies.get("center_id")?.value !== payload.centerId) {
    response.cookies.set({
      name: "center_id",
      value: payload.centerId,
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
