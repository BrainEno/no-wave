import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test as base } from "./csp-fixture.ts";
import { startFontStack, type FontStack } from "./font-stack.ts";

type StoredObject = { bytes: Buffer; sha256: string };
type MediaStack = FontStack & { objects: Map<string, StoredObject>; requests: { method: string; key: string }[] };

/** Local S3 wire fixture only. The normal API, AWS adapter, image normalization,
 * metadata/ownership store and BFF run unchanged; no upload route is mocked. */
export const test = base.extend<{ mediaStack: MediaStack }>({
  mediaStack: [async ({}, runWithStack) => {
    const objects = new Map<string, StoredObject>();
    const requests: MediaStack["requests"] = [];
    const s3 = createServer(async (request, response) => {
      try {
        const key = new URL(request.url ?? "/", "http://fixture.test").pathname;
        if (!/^\/browser-security-fixture\/assets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/.test(key) ||
            !request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
          response.writeHead(403).end(); return;
        }
        const method = request.method ?? "GET";
        requests.push({ method, key });
        if (method === "PUT") {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += (chunk as Buffer).length;
            if (size > 8 * 1024 * 1024) throw new Error("Fixture object exceeded upload limit.");
            chunks.push(Buffer.from(chunk as Buffer));
          }
          const bytes = Buffer.concat(chunks), sha256 = createHash("sha256").update(bytes).digest("hex");
          if (request.headers["x-amz-meta-sha256"] !== sha256 || request.headers["content-type"] !== "image/webp") {
            response.writeHead(400).end(); return;
          }
          objects.set(key, { bytes, sha256 });
          response.writeHead(200, { etag: `"${sha256}"` }).end();
        } else if (method === "GET" && objects.has(key)) {
          const object = objects.get(key)!;
          response.writeHead(200, { "content-type": "image/webp", "content-length": object.bytes.length,
            "x-amz-meta-sha256": object.sha256 }).end(object.bytes);
        } else if (method === "DELETE") {
          objects.delete(key); response.writeHead(204).end();
        } else response.writeHead(404).end();
      } catch { response.writeHead(500).end(); }
    });
    await new Promise<void>((resolve, reject) => { s3.once("error", reject); s3.listen(0, "0.0.0.0", resolve); });
    try {
      const address = s3.address();
      if (!address || typeof address === "string") throw new Error("No S3 fixture port.");
      const stack = await startFontStack({ mediaEndpoint: `http://127.0.0.1:${address.port}` });
      try { await runWithStack({ ...stack, objects, requests }); }
      finally { await stack.close(); }
    } finally {
      s3.closeIdleConnections();
      await new Promise<void>((resolve, reject) => s3.close(error => error ? reject(error) : resolve()));
    }
  }, { timeout: 60_000 }],
});
