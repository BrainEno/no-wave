import { createRequire } from "node:module";
import type { Plugin } from "vite";

/** Match production capacity/cancellation semantics without bundling a second request store. */
export function upstreamIngress(): Plugin {
  return {
    name: "upstream-boundary-ingress",
    apply: "serve",
    configureServer(server) {
      const { createWebUpstreamRuntime } = createRequire(import.meta.url)("./upstream/runtime.ts") as typeof import("./upstream/runtime.ts");
      const runtime = createWebUpstreamRuntime(process.env);
      const { createWebIntake } = createRequire(import.meta.url)("./upstream/intake.ts") as typeof import("./upstream/intake.ts");
      const intake = createWebIntake(process.env);
      if (server.httpServer) Object.assign(server.httpServer, intake.httpOptions);
      server.middlewares.use((request, response, next) => {
        if (request.url === "/healthz" || request.url === "/readyz") { runtime.run(next); return; }
        if (!intake.handle(request, response)) runtime.run(next);
      });
      server.httpServer?.once("close", () => { intake.stop(); void runtime.close(); });
    },
  };
}
