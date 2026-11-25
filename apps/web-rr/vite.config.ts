import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { parseAllowedDevOrigins } from "@no-wave/web-ui/src/lib/dev-origins.ts";
import { firstPartyFontLicenses } from "./font-licenses.ts";
import { clientAddressIngress } from "./client-address-ingress.ts";
import { refreshCoordinationIngress } from "./refresh-ingress.ts";
import { upstreamIngress } from "./upstream-ingress.ts";

// Environment contract: the repository-root `.env.local` is the single developer
// configuration file, and a value already exported in the shell wins over it.
// `loadEnvFile` does not overwrite existing variables, so the precedence is
// inherited, not reimplemented.
const rootEnvFile = fileURLToPath(new URL("../../.env.local", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const executeFile = promisify(execFile);
async function prepareFirstPartyFonts(): Promise<void> {
  // Native CLI users (portable/perf/dev) bypass package scripts. Prepare before
  // Vite reads font imports; use the current Node, never a global pnpm shim.
  const { stdout, stderr } = await executeFile(process.execPath, [
    fileURLToPath(new URL("../../scripts/fonts/generate.ts", import.meta.url)), "--prepare",
  ], { timeout: 300_000, windowsHide: true });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

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
 * This application renders the shared UI in `@no-wave/web-ui`, so `@/*` — the
 * specifier every shared file already uses for itself — resolves to that
 * package's source. Nothing is copied and no import is rewritten.
 *
 * The shared UI reaches the router only through that package's `lib/framework/`
 * directory, which is written against React Router; there is no per-application
 * navigation adapter left to alias.
 */
export default defineConfig(async () => {
  await prepareFirstPartyFonts();
  return {
    plugins: [clientAddressIngress(), refreshCoordinationIngress(), upstreamIngress(), reactRouter(), firstPartyFontLicenses()],
    build: {
      // Keep even tiny Unicode shards addressable and independently cacheable;
      // inlining them would hide their transfer cost inside a global stylesheet.
      assetsInlineLimit: (filePath: string) => filePath.endsWith(".woff2") ? false : undefined,
    },
    // The shared UI is compiled into the server bundle. Bundle its ZIP decoder
    // too: the runtime image does not have web-ui source or its node_modules.
    ssr: { noExternal: ["fflate"] },
    // React Router 8 uses environment-level resolution. Keep the Node ingress and
    // SSR on one module/AsyncLocalStorage instance, not an inlined copy per build.
    // The main entry stays native too: transport exceptions must have the exact
    // same class identity in handlers and ingress, including UPSTREAM_BUSY/504.
    environments: { ssr: {
      resolve: { external: ["@no-wave/web-http", "@no-wave/web-http/client-address", "@no-wave/web-http/refresh-runtime", "@no-wave/web-http/upstream-runtime"] },
      // Node 24 loads this TypeScript package entry directly; do not let the
      // bundler's ordinary TS-source inlining create a second request store.
      build: { rolldownOptions: { external: ["@no-wave/web-http", "@no-wave/web-http/client-address", "@no-wave/web-http/refresh-runtime", "@no-wave/web-http/upstream-runtime"] } },
    } },
    resolve: {
      alias: [
        { find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/web-ui/src/$1", import.meta.url)) },
      ],
    },
    // Deliberately no `define` for `process.env.*`: server-rendered metadata must
    // read the runtime environment of the process that serves the page (canonical
    // URLs differ per deployment), so these values must not be frozen at build time.
    // Shared UI helpers receive explicit values from app/lib/runtime.ts.
    server: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3100), allowedHosts: allowedDevHosts() },
    preview: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3100) },
  };
});
