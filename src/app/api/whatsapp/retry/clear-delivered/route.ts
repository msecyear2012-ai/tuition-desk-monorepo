import { NextRequest, NextResponse } from "next/server";
import { verifyOwnerRequest } from "@/lib/authOwner";

const BACKEND_URL =
  process.env.BACKEND_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/?$/, "") ||
  "http://localhost:3001";

export async function POST(request: NextRequest) {
  const auth = await verifyOwnerRequest(request);
  if (!auth.authenticated || !auth.owner) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status }
    );
  }

  try {
    const token =
      request.cookies.get("auth_token")?.value ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    const bodyText = await request.text().catch(() => "");

    const res = await fetch(`${BACKEND_URL}/api/whatsapp/retry/clear-delivered`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: bodyText || undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json().catch(() => null);
    return NextResponse.json(
      data || { success: false, error: "Empty response from clear delivered service" },
      { status: res.status }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error:
          err instanceof Error
            ? err.message
            : "Failed to connect to backend clear delivered service",
      },
      { status: 503 }
    );
  }
}
