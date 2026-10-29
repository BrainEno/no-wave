import path from "node:path";
import type { NextConfig } from "next";
import { parseAllowedDevOrigins } from "./src/lib/dev-origins.ts";

/**
 * Load the repository-root `.env.local` so one file configures both the API and
 * the Web dev server. Next.js itself only reads `.env*` files from `apps/web`,
 * which previously meant `API_BASE_URL` set at the root silently did nothing
 * here and the public pages kept rendering the fixture registry.
 *
 * `process.loadEnvFile` never overwrites variables that are already set, so an
 * explicit shell export still wins, and a missing file (CI, Docker builds,
 * Vercel) is simply ignored.
 */
const repositoryEnvFile = path.join(process.cwd(), "..", "..", ".env.local");
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(repositoryEnvFile);
  } catch {
    // No repository-level .env.local: rely on the real environment.
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  poweredByHeader: false,
  // Development-only: allow the dev server to serve assets to LAN addresses and
  // preview proxies. Production builds do not use this list.
  allowedDevOrigins: parseAllowedDevOrigins(process.env.WEB_DEV_ALLOWED_ORIGINS),
};

export default nextConfig;
