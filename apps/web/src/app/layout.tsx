import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteChrome } from "@/components/chrome/site-chrome.tsx";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.invalid"),
  title: { default: "无浪潮 · No Wave", template: "%s | 无浪潮" },
  description: "以文学作品发表、认真阅读与深度交流为中心的独立数字出版平台。",
  applicationName: "无浪潮 No Wave",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

const fonts = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;700&family=Noto+Serif+SC:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={fonts} />
      </head>
      <body><SiteChrome>{children}</SiteChrome></body>
    </html>
  );
}
