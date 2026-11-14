import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/jwt";

export async function POST(request: NextRequest) {
  try {
    const token =
      request.cookies.get("auth_token")?.value ||
      request.headers.get("authorization")?.replace("Bearer ", "");

    let centerId = request.headers.get("x-center-id");

    if (token) {
      const payload = await verifyToken<{ role: string; centerId: string }>(token);
      if (payload?.centerId) {
        centerId = payload.centerId;
      }
    }

    if (!centerId) {
      centerId = request.cookies.get("center_id")?.value || "aroven-001";
    }

    const backendUrl =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

    const body = await request.json().catch(() => ({}));

    const res = await fetch(`${backendUrl}/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
        "x-center-id": centerId,
        cookie: request.headers.get("cookie") || (token ? `auth_token=${token}` : ""),
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => null);

    if (res.ok && data) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(
      data || { success: false, error: "Failed to update push subscription" },
      { status: res.status || 500 }
    );
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to proxy push subscription";
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
