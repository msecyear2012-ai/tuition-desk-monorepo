import type { Metadata } from "next";

const siteUrl =
  process.env.NEXT_PUBLIC_APP_URL || "https://tuition-desk-monorepo.vercel.app";
const cleanBaseUrl = siteUrl.replace(/\/+$/, "");
const portalUrl = `${cleanBaseUrl}/portal`;
const ogImageUrl = `${cleanBaseUrl}/icons/icon-512x512.png`;

export const metadata: Metadata = {
  metadataBase: new URL(cleanBaseUrl),
  title: "Parent Portal | TuitionDesk",
  description:
    "Secure Parent Access: Track attendance records, test results, monthly tuition fee payments, and institute announcements.",
  openGraph: {
    title: "Parent Portal | TuitionDesk",
    description:
      "Secure Parent Access: Track attendance records, test results, monthly tuition fee payments, and institute announcements.",
    url: portalUrl,
    siteName: "TuitionDesk",
    type: "website",
    locale: "en_IN",
    images: [
      {
        url: ogImageUrl,
        secureUrl: ogImageUrl,
        width: 512,
        height: 512,
        alt: "Parent Portal | TuitionDesk",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Parent Portal | TuitionDesk",
    description:
      "Secure Parent Access: Track attendance records, test results, monthly tuition fee payments, and institute announcements.",
    images: [ogImageUrl],
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function StudentPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
