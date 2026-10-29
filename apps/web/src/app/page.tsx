import type { Metadata } from "next";
import { HomeContent } from "@/components/content-pages";
import { defaultLocale, homeMetadata } from "@/lib/content.ts";
import { configuredSiteUrl } from "@/lib/site-metadata.ts";

// Vercel service bindings are only injected at runtime, not during the build.
export const dynamic = "force-dynamic";

export const metadata: Metadata = homeMetadata(defaultLocale, configuredSiteUrl()) as Metadata;

export default function HomePage() {
  return <HomeContent locale={defaultLocale} />;
}
