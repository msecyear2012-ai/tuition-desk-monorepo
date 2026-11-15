import { Suspense } from "react";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/jwt";
import type { SessionPayload } from "@/middleware";
import type { CenterInfo } from "@/lib/centerProfile";
import FeesClient from "./FeesClient";
import { resolveFeeTabs } from "./feeNavigation";

interface FeesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function FeesDataLoader({ searchParams }: FeesPageProps) {
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

function FeesPageFallback() {
  return (
    <div className="p-3.5 min-[380px]:p-4 sm:p-5 md:p-6 space-y-4 max-w-4xl lg:max-w-5xl mx-auto pb-28 sm:pb-24 animate-pulse">
      {/* 3-Section Navigation Bar Skeleton */}
      <div className="p-1 rounded-2xl bg-slate-100 border border-slate-200/90 grid grid-cols-3 gap-1 shadow-2xs h-11" />

      {/* Main Banner / Hero Skeleton */}
      <div className="rounded-2xl sm:rounded-3xl bg-slate-200/70 h-36 w-full" />

      {/* Sub-navigation Skeleton */}
      <div className="p-1 rounded-2xl bg-slate-100 border border-slate-200/80 grid grid-cols-3 gap-1 h-10 w-full" />

      {/* List items Skeleton */}
      <div className="space-y-2.5 pt-1">
        <div className="rounded-2xl border border-slate-100 bg-white p-4 h-24 w-full shadow-xs" />
        <div className="rounded-2xl border border-slate-100 bg-white p-4 h-24 w-full shadow-xs" />
        <div className="rounded-2xl border border-slate-100 bg-white p-4 h-24 w-full shadow-xs" />
      </div>
    </div>
  );
}

export default function FeesPage({ searchParams }: FeesPageProps) {
  return (
    <Suspense fallback={<FeesPageFallback />}>
      <FeesDataLoader searchParams={searchParams} />
    </Suspense>
  );
}
