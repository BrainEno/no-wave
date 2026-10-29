import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-metadata.ts";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = siteOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: new URL("/sitemap.xml", baseUrl).toString(),
  };
}
