import { cookies } from "next/headers";
import { verifyToken } from "@/lib/jwt";
import type { SessionPayload } from "@/middleware";
import type { CenterInfo } from "@/lib/centerProfile";
import FeesClient from "./FeesClient";
import { resolveFeeTabs } from "./feeNavigation";

interface FeesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function FeesPage({ searchParams }: FeesPageProps) {
  const sp = await searchParams;
  const { initialTab, initialSub } = resolveFeeTabs({
    tab: sp.tab,
    sub: sp.sub,
  });

  // Derive initial profile identity from auth_token cookie
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  let initialProfile: CenterInfo | null = null;

  if (token) {
    try {
      const payload = await verifyToken<SessionPayload>(token);
      if (payload && payload.centerId) {
        initialProfile = {
          centerId: payload.centerId,
          role: payload.role as "owner" | "teacher",
          name: payload.name || (payload.role === "owner" ? "Institute Owner" : "Teacher"),
          teacherName: payload.name,
          teacherId: payload.teacherId,
        };
      }
    } catch {
      // Token verification failed or invalid; client useEffect will fall back cleanly
    }
  }

  return (
    <FeesClient
      initialTab={initialTab}
      initialSub={initialSub}
      initialProfile={initialProfile}
    />
  );
}
