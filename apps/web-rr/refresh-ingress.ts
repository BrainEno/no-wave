import { createRequire } from "node:module";
import type { Plugin } from "vite";

/** Development and production enforce the same topology and ingress contract. */
export function refreshCoordinationIngress(): Plugin {
  return {
    name: "refresh-coordination-ingress",
    apply: "serve",
    async configureServer(server) {
      // Native loading avoids a config-bundled duplicate of the SSR context.
      const { createWebRefreshRuntime } = createRequire(import.meta.url)("./refresh/runtime.ts") as typeof import("./refresh/runtime.ts");
      const runtime = await createWebRefreshRuntime(process.env);
      server.middlewares.use((_request, _response, next) => runtime.run(next));
      server.httpServer?.once("close", () => { void runtime.close(); });
    },
  };
}
