import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { parseAllowedDevOrigins } from "@bot-thk/web-ui/src/lib/dev-origins.ts";

// Environment contract: the repository-root `.env.local` is the single developer
// configuration file, and a value already exported in the shell wins over it.
// `loadEnvFile` does not overwrite existing variables, so the precedence is
// inherited, not reimplemented.
const rootEnvFile = fileURLToPath(new URL("../../.env.local", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

/**
 * Vite rejects unknown `Host` headers in development, which breaks LAN access and
 * preview proxies. `WEB_DEV_ALLOWED_ORIGINS` lists what is allowed; an empty list
 * means "any host" and only ever affects the dev server — `server.ts` has no such
 * filter.
 */
function allowedDevHosts(): string[] | true {
  const declared = parseAllowedDevOrigins(process.env.WEB_DEV_ALLOWED_ORIGINS);
  return declared.length > 0 ? declared : true;
}

/**
 * This application renders the shared UI in `@bot-thk/web-ui`, so `@/*` — the
 * specifier every shared file already uses for itself — resolves to that
 * package's source. Nothing is copied and no import is rewritten.
 *
 * The shared UI reaches the router only through that package's `lib/framework/`
 * directory, which is written against React Router; there is no per-application
 * navigation adapter left to alias.
 */
export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/web-ui/src/$1", import.meta.url)) },
    ],
  },
  // Deliberately no `define` for `process.env.*`: server-rendered metadata must
  // read the runtime environment of the process that serves the page (canonical
  // URLs differ per deployment), so these values must not be frozen at build time.
  // The reused helpers only touch `process.env` on server-only code paths.
  server: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3100), allowedHosts: allowedDevHosts() },
  preview: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3100) },
});
