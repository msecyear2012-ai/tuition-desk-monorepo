"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowRight } from "lucide-react";

export default function ParentPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/portal");
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-4 text-center space-y-4">
      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      <h2 className="text-base font-bold text-slate-800">Redirecting to Parent Portal...</h2>
      <p className="text-xs text-slate-500">
        If you are not redirected automatically,{" "}
        <Link href="/portal" className="font-bold text-blue-600 underline inline-flex items-center gap-1">
          click here to open the Parent Portal <ArrowRight className="w-3 h-3" />
        </Link>
      </p>
    </div>
  );
}
