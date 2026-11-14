import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
import { currentWebRequestIsSecure } from "@bot-thk/web-http/client-address";
import { writeLogLine } from "@bot-thk/web-http/log";
import { browserSecurityHeaders, DEVELOPMENT_CSP, protectHtmlResponse } from "../document-security.ts";

export const streamTimeout = 5_000;

export function handleError(error: unknown, { request }: { request: Request }) {
  if (!request.signal.aborted) writeLogLine("ssr_request_failed", {
    errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error",
  });
}

/** React still streams its handoff internally; production seals one bounded HTML
 * document before committing its hashes. This preserves the public CDN cache
 * contract without sharing an authorizing nonce between readers (ADR 0039). */
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  // This is a build capability, not a host-supplied opt-out. `node server.ts`
  // defaults to production even when a host supplies no NODE_ENV at all.
  const production = import.meta.env.PROD;
  const marker = randomBytes(24).toString("base64url");
  const secure = currentWebRequestIsSecure();
  const renderFailure = new AbortController();
  const signal = AbortSignal.any([request.signal, renderFailure.signal, AbortSignal.timeout(streamTimeout + 1_000)]);
  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const body = new PassThrough();
    body.once("error", reject);
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} nonce={production ? marker : undefined} />,
      {
        nonce: production ? marker : undefined,
        onShellReady() {
          shellRendered = true;
          responseHeaders.set("content-type", "text/html; charset=utf-8");
          if (production) {
            protectHtmlResponse(body, { marker, signal, headers: responseHeaders, status: responseStatusCode, secure })
              .then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
          } else {
            // Vite HMR/React Refresh require development transforms. Keep the
            // framing/object/form baseline, never relax production script policy.
            for (const [name, value] of Object.entries(browserSecurityHeaders(secure, DEVELOPMENT_CSP))) responseHeaders.set(name, value);
            if (!secure) responseHeaders.delete("strict-transport-security");
            resolve(new Response(createReadableStreamFromReadable(body), { headers: responseHeaders, status: responseStatusCode }));
            body.once("close", () => signal.removeEventListener("abort", cancel));
          }
          pipe(body);
        },
        onShellError(error: unknown) {
          signal.removeEventListener("abort", cancel);
          body.destroy();
          reject(error);
        },
        onError(error: unknown) {
          if (shellRendered) writeLogLine("ssr_render_failed", {
            errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error",
          });
          // A late Suspense failure must not turn a partially rendered public
          // shell into a cacheable 200. Nothing has been committed yet: cancel
          // this attempt and let Router render its protected error boundary.
          if (production) renderFailure.abort();
        },
      },
    );
    function cancel() { abort(); body.destroy(new Error("Document rendering aborted.")); }
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
