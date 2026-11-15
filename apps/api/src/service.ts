import { isMainModule } from "./infrastructure/entrypoint.ts";
import { serviceRole } from "./infrastructure/service-settings.ts";
import { writeStructuredLog } from "./infrastructure/http-observability.ts";

/** One image, one explicit long-running role per container. The worker never
 * becomes an API timer, and selecting it does not require JWT or media setup. */
export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const role = serviceRole(env);
  if (role === "notification-worker") {
    const { runNotificationWorkerProcess } = await import("./persistence/notification-worker.ts");
    return runNotificationWorkerProcess(env);
  }
  const { runApiProcess } = await import("./server.ts");
  await runApiProcess(env);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runService().then(code => {
    process.exitCode = code;
    if (code !== 0) process.exit(code);
  }, async error => {
    if ((process.env.SERVICE_ROLE ?? "api") === "api") {
      const { reportApiStartupFailure } = await import("./server.ts");
      reportApiStartupFailure(error);
    } else if (process.env.SERVICE_ROLE === "notification-worker") {
      const { reportWorkerStartupFailure } = await import("./persistence/notification-worker.ts");
      reportWorkerStartupFailure(error);
    } else {
      writeStructuredLog({ level: "error", event: "service_startup_failed", configurationField: "SERVICE_ROLE",
        errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error" });
    }
    process.exit(1);
  });
}
