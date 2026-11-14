import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Parent Portal | TuitionDesk",
  robots: {
    index: false,
    follow: false,
  },
  referrer: "no-referrer",
};

export default function StudentPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
