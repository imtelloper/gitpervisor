import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "@/lib/github";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

const title = "Gitpervisor — Your AI Coding Command Center";
const description =
  "Manage multiple Git projects, supervise AI agents like Claude in real time, and monitor everything from one open-source desktop app. Free & MIT-licensed for Windows, macOS, and Linux.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  applicationName: "Gitpervisor",
  keywords: [
    "git",
    "terminal multiplexer",
    "AI coding agent",
    "Claude",
    "developer tools",
    "open source",
    "Tauri",
    "desktop app",
  ],
  authors: [{ name: "Gitpervisor" }],
  openGraph: {
    type: "website",
    url: SITE_URL,
    title,
    description,
    siteName: "Gitpervisor",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geist.variable} ${geistMono.variable}`}
    >
      <body className="min-h-dvh bg-base font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
