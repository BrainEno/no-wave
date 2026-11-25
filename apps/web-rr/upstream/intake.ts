import type { IncomingMessage, ServerResponse } from "node:http";
import { WebRequestAdmission } from "@no-wave/web-http";
import { webIntegerSetting } from "./settings.ts";

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(",") : value ?? null;
}

/** Native server protection also covers bodies waiting before their first API call. */
export function createWebIntake(env: Readonly<Record<string, string | undefined>>) {
  const requestTimeout = webIntegerSetting(env, "WEB_REQUEST_TIMEOUT_MS", 60_000, 1000, 120_000);
  const headersTimeout = webIntegerSetting(env, "WEB_HEADERS_TIMEOUT_MS", 15_000, 1000, 120_000);
  if (headersTimeout > requestTimeout) throw new Error("WEB_HEADERS_TIMEOUT_MS must not exceed WEB_REQUEST_TIMEOUT_MS.");
  const keepAliveTimeout = webIntegerSetting(env, "WEB_KEEP_ALIVE_TIMEOUT_MS", 5000, 100, 60_000);
  const admission = new WebRequestAdmission({
    concurrency: webIntegerSetting(env, "WEB_REQUEST_CONCURRENCY", 56, 1, 256),
    bodyBudgetBytes: webIntegerSetting(env, "WEB_REQUEST_BODY_BUDGET_BYTES", 64 * 1024 * 1024, 9 * 1024 * 1024, 128 * 1024 * 1024),
  });
  return {
    httpOptions: { requestTimeout, headersTimeout, keepAliveTimeout, connectionsCheckingInterval: 1000 },
    stop: () => admission.stop(),
    metrics: () => admission.metrics(),
    snapshot: () => admission.snapshot(),
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      const decision = admission.acquire({ method: request.method ?? "GET", path: request.url ?? "/",
        contentLength: header(request, "content-length"), transferEncoding: header(request, "transfer-encoding") });
      if (!decision.ok) {
        const code = decision.status === 503 ? "WEB_BUSY" : decision.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST";
        const message = decision.status === 503 ? "The Web service is temporarily busy. Try again shortly." : decision.status === 413 ? "The request body is too large." : "The request framing is invalid.";
        const body = JSON.stringify({ error: { code, message } });
        response.writeHead(decision.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0",
          "x-content-type-options": "nosniff", "x-robots-tag": "noindex", connection: "close", ...(decision.status === 503 ? { "retry-after": "1" } : {}) });
        response.end(request.method === "HEAD" ? undefined : body);
        return true;
      }
      let inputEnded = request.complete;
      let outputEnded = false;
      let completion: "completed" | "failed" | "aborted" = "completed";
      const release = () => { if (inputEnded && outputEnded) decision.release(completion); };
      request.once("close", () => {
        inputEnded = true;
        if (!request.complete) completion = "aborted";
        release();
      });
      request.once("error", () => {
        completion = "aborted";
        if (!response.destroyed) response.destroy();
      });
      response.once("finish", () => {
        outputEnded = true;
        inputEnded ||= request.complete;
        completion = response.statusCode >= 500 ? "failed" : "completed";
        release();
      });
      response.once("close", () => {
        outputEnded = true;
        inputEnded ||= request.complete;
        if (!response.writableFinished) completion = "aborted";
        // An early response must not leave an unread, slow upload owning a
        // hidden keep-alive socket after the application has finished.
        if (!inputEnded && !request.destroyed) request.destroy();
        release();
      });
      return false;
    },
  };
}
