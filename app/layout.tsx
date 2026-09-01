import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const isLoopbackHost = host === "localhost"
    || host.startsWith("localhost:")
    || host === "127.0.0.1"
    || host.startsWith("127.0.0.1:");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (isLoopbackHost ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Weave — 人とAgentでつくるHTMLエディター";
  const description = "人とAgentが一緒に、完成度の高いスライド資料をつくるビジュアルHTMLエディターです。";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Weave HTMLエディターの作業画面" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
