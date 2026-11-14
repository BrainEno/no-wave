import { createRequire } from "node:module";
import type { Plugin } from "vite";

/** The dev HTTP listener has the same socket boundary as the production server. */
export function clientAddressIngress(): Plugin {
  return {
    name: "client-address-ingress",
    apply: "serve",
    configureServer(server) {
      // The config itself is bundled by Vite. Native resolution is deliberate:
      // the middleware and external SSR entry must use one Node module instance.
      const { createWebClientAddressBridge } = createRequire(import.meta.url)("@bot-thk/web-http/client-address") as typeof import("@bot-thk/web-http/client-address");
      const bridge = createWebClientAddressBridge(process.env);
      server.middlewares.use((request, _response, next) => bridge.run(request, next));
    },
  };
}
