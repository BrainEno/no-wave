import type { LoaderFunctionArgs } from "react-router";

/**
 * `GET /api/spike/events` — the server-sent event the spike listens for.
 *
 * One event, then the stream closes: the contract under test is that the
 * headers let it through as a stream at all (`no-store`, `no-transform`, and
 * `X-Accel-Buffering: no` so a proxy does not hold it back).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  void request;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: ready\ndata: {\"refreshRequired\":true}\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
