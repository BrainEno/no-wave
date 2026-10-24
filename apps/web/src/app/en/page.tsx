import type { Metadata } from "next";
import { HomeContent } from "@/components/content-pages";
import { homeMetadata } from "@/lib/content.mjs";

export const metadata: Metadata = homeMetadata("en") as Metadata;

export default function EnglishHomePage() {
  return <HomeContent locale="en" />;
}
