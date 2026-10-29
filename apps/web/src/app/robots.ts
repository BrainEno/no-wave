import type { MetadataRoute } from "next";
import { configuredSiteUrl } from "@/lib/site-metadata.ts";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = configuredSiteUrl();
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: new URL("/sitemap.xml", baseUrl).toString(),
  };
}
