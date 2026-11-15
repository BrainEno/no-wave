import { AsyncLocalStorage } from "node:async_hooks";
import type { RefreshCoordinator } from "./refresh-coordinator.ts";

const requestCoordinator = new AsyncLocalStorage<RefreshCoordinator>();
const missingSharedContext: RefreshCoordinator = {
  async resolve() {
    return { kind: "failed", status: 503, code: "SERVICE_UNAVAILABLE", message: "Session refresh coordination is unavailable.", retryAfterSeconds: 1 };
  },
};

/** Node-only ingress and external SSR use this exact module instance. */
export function withRefreshCoordinator<Value>(coordinator: RefreshCoordinator, work: () => Value): Value {
  return requestCoordinator.run(coordinator, work);
}

export function requestRefreshCoordinator(env: NodeJS.ProcessEnv = process.env): RefreshCoordinator | undefined {
  const current = requestCoordinator.getStore();
  if (current) return current;
  const count = env.WEB_INSTANCE_COUNT;
  const declaredShared = env.WEB_REFRESH_COORDINATOR !== undefined && env.WEB_REFRESH_COORDINATOR !== "memory";
  const invalidCount = count !== undefined && (!/^[1-9]\d*$/.test(count) || Number(count) > 1);
  // Missing/duplicated ingress must not silently choose process-local memory
  // in a deployment whose safety depends on cross-process claims.
  return declaredShared || invalidCount ? missingSharedContext : undefined;
}
