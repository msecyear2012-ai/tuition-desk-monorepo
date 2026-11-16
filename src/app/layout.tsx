import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import NavigationWrapper from "@/components/layout/NavigationWrapper";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
});

const siteUrl =
  process.env.NEXT_PUBLIC_APP_URL || "https://tuition-desk-monorepo.vercel.app";
const cleanBaseUrl = siteUrl.replace(/\/+$/, "");
const ogImageUrl = `${cleanBaseUrl}/icons/icon-512x512.png`;

export const metadata: Metadata = {
  metadataBase: new URL(cleanBaseUrl),
  title: {
    default: "TuitionDesk | Smart Tuition Center Management",
    template: "%s | TuitionDesk",
  },
  description:
    "Mobile-first tuition center management and automated fee collection platform.",
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: cleanBaseUrl,
    siteName: "TuitionDesk",
    title: "TuitionDesk | Smart Tuition Center Management",
    description:
      "Mobile-first tuition center management and automated fee collection platform.",
    images: [
      {
        url: ogImageUrl,
        secureUrl: ogImageUrl,
        width: 512,
        height: 512,
        alt: "TuitionDesk Logo",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "TuitionDesk | Smart Tuition Center Management",
    description:
      "Mobile-first tuition center management and automated fee collection platform.",
    images: [ogImageUrl],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "TuitionDesk",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={fontSans.variable}>
      <body className="font-sans antialiased bg-slate-100 min-h-screen flex justify-center text-slate-900">
        <Suspense fallback={<div>Loading Navigation...</div>}>
          <NavigationWrapper>{children}</NavigationWrapper>
        </Suspense>
      </body>
    </html>
  );
}
