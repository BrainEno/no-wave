import type { Metadata } from "next";
import { HomeContent } from "@/components/content-pages";
import { homeMetadata } from "@/lib/content.ts";

// Vercel service bindings are only injected at runtime, not during the build.
export const dynamic = "force-dynamic";

export const metadata: Metadata = homeMetadata("en") as Metadata;

export default function EnglishHomePage() {
  return <HomeContent locale="en" />;
}
