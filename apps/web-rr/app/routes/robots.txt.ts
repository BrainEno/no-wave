import { renderRobotsTxt } from "@/lib/site-metadata.ts";
import { siteUrl } from "../lib/runtime.ts";

/** `GET /robots.txt` — resource route, built from the shared sitemap/robots builder. */
export async function loader() {
  return new Response(renderRobotsTxt(siteUrl()), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=3600",
    },
  });
}
