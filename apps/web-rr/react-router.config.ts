import type { Config } from "@react-router/dev/config";

/**
 * React Router 8 Framework Mode, server-rendered.
 *
 * `ssr: true` is the whole point of this prototype: public routes must emit
 * meaningful HTML and metadata without a browser, and the route modules must run
 * on a plain Node.js server (see `server.ts`).
 *
 * React Router 8 is the version this file is written for. Its five v7 future
 * flags — middleware, split route modules, the Vite Environment API, request
 * pass-through and trailing-slash-aware data requests — were adopted on 7.18.5
 * first (https://reactrouter.com/upgrading/v7) and are unconditional defaults
 * here, so there is no `future` block left to opt in or out of.
 */
export default {
  ssr: true,
  // `build/client` and `build/server`, which is what `server.ts` and the
  // container image serve. (The directory name predates ADR 0017 retiring the
  // other framework; nothing else reads it, and renaming it would churn the
  // Dockerfile and the smoke test for no behaviour.)
  buildDirectory: "build",
} satisfies Config;
