import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.invalid"),
  title: { default: "无浪潮 · Nowave", template: "%s | 无浪潮" },
  description: "以文学作品发表、认真阅读与深度交流为中心的独立数字出版平台。",
  applicationName: "无浪潮 Nowave",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body style={{ margin: 0, fontFamily: "system-ui, sans-serif", color: "#171717" }}>{children}</body></html>;
}
