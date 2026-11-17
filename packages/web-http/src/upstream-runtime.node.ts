import { AsyncLocalStorage } from "node:async_hooks";
import type { UpstreamTransport } from "./upstream.ts";

/** Kept in an external Node-only package entry so SSR and ingress share one store. */
const upstreamContext = new AsyncLocalStorage<UpstreamTransport>();
export function withUpstreamTransport<Value>(transport: UpstreamTransport, work: () => Value): Value {
  return upstreamContext.run(transport, work);
}
export function requestUpstreamTransport(): UpstreamTransport | undefined {
  return upstreamContext.getStore();
}
