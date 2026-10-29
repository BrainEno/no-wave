import { PassThrough } from "node:stream";
import type { EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { renderToPipeableStream } from "react-dom/server";

/**
 * Node.js server entry: streaming SSR with a bounded timeout, so a stuck loader
 * cannot hold a connection open indefinitely. The shell is flushed as soon as it
 * is ready, and the abort timer is the React Router document default plus slack.
 */
const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onShellReady() {
          shellRendered = true;
          const body = new PassThrough();
          responseHeaders.set("content-type", "text/html; charset=utf-8");
          resolve(new Response(createReadableStreamFromReadable(body), {
            headers: responseHeaders,
            status: responseStatusCode,
          }));
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          // After the shell is committed the status line cannot change; React
          // renders the error boundary markup into the stream instead.
          if (shellRendered) console.error(error);
        },
      },
    );

    setTimeout(abort, streamTimeout + 1_000);
  });
}
