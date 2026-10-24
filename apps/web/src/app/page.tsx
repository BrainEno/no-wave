import type { Metadata } from "next";
import { HomeContent } from "@/components/content-pages";
import { defaultLocale, homeMetadata } from "@/lib/content.mjs";

export const metadata: Metadata = homeMetadata(defaultLocale) as Metadata;

export default function HomePage() {
  return <HomeContent locale={defaultLocale} />;
}
