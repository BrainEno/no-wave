import type { Config } from "@react-router/dev/config";

/**
 * React Router 7 Framework Mode, server-rendered.
 *
 * `ssr: true` is the whole point of this prototype: public routes must emit
 * meaningful HTML and metadata without a browser, and the route modules must run
 * on a plain Node.js server (see `server.ts`).
 */
export default {
  ssr: true,
  // Keep the production build out of the Next.js app's `.next` directory.
  buildDirectory: "build",
} satisfies Config;
