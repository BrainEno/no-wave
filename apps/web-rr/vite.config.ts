import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { parseAllowedDevOrigins } from "../web/src/lib/dev-origins.ts";

// Same environment contract as the Next.js app (`apps/web/next.config.ts`):
// the repository-root `.env.local` is the single developer configuration file,
// and a value already exported in the shell wins over it. `loadEnvFile` does not
// overwrite existing variables, so the precedence is inherited, not reimplemented.
const rootEnvFile = fileURLToPath(new URL("../../.env.local", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

/**
 * Vite rejects unknown `Host` headers in development, which breaks LAN access and
 * preview proxies exactly like the Next.js `allowedDevOrigins` gate did. The same
 * `WEB_DEV_ALLOWED_ORIGINS` variable drives both apps; an empty list means "any
 * host" and only ever affects the dev server — `server.ts` has no such filter.
 */
function allowedDevHosts(): string[] | true {
  const declared = parseAllowedDevOrigins(process.env.WEB_DEV_ALLOWED_ORIGINS);
  return declared.length > 0 ? declared : true;
}

/**
 * The prototype shares the React components and framework-neutral helpers that
 * already exist in `apps/web/src`. Two alias groups make that possible without
 * copying or editing them:
 *
 *   `@/*`            -> the existing Web source tree (components, lib, copy)
 *   `next/*`         -> `app/shims/*`, small adapters with the same surface
 *
 * The `next/*` aliases are the migration seam, not a permanent fixture: they are
 * the complete list of framework coupling left in the reused code, so the count
 * is measurable (`grep -rn 'from "next' apps/web/src`) and each one can be
 * deleted from the shared component instead of being re-implemented here.
 */
export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("../web/src/$1", import.meta.url)) },
      { find: /^next\/link$/, replacement: fileURLToPath(new URL("./app/shims/next-link.tsx", import.meta.url)) },
      {
        find: /^next\/navigation$/,
        replacement: fileURLToPath(new URL("./app/shims/next-navigation.ts", import.meta.url)),
      },
    ],
  },
  // Deliberately no `define` for `process.env.*`: server-rendered metadata must
  // read the runtime environment of the process that serves the page (canonical
  // URLs differ per deployment), so these values must not be frozen at build time.
  // The reused helpers only touch `process.env` on server-only code paths.
  server: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3100), allowedHosts: allowedDevHosts() },
  preview: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3100) },
});
