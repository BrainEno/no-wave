import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createApiServer } from "../../../api/src/server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../../api/src/persistence/sqlite.ts";
import { createSqliteStore } from "../../../api/src/persistence/sqlite-store.ts";
import { startProductionWeb } from "./production-web.ts";

export const BRIDGE_SECRET = "test-only-client-address-bridge-key-not-a-real-secret";
export const BRIDGE_PASSWORD = "Fixture password only 4826!";
export const FIRST_CLIENT = "127.0.0.2";
export const SECOND_CLIENT = "127.0.0.3";
export const EDGE_PEER = "127.0.0.10";
export type HttpResult = { status: number; headers: Headers; text: string };
export type ViewEnvelope = { data: { counted: boolean; viewCount: number } };

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

/** A real TCP source address, not a header that pretends to be one. */
export function callFrom(origin: string, peer: string, path: string, {
  method = "POST", headers = {}, body,
}: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, origin), {
      method, localAddress: peer, agent: false,
      headers: { origin, ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const result = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) result.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        resolve({ status: response.statusCode!, headers: result, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("Fixture request timed out.")));
    request.once("error", reject);
    request.end(text);
  });
}

/** An actual ingress: append the peer we observed and connect from its named address. */
export async function startEdge(webOrigin: string) {
  const edge = createServer((request, response) => {
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    const incoming = request.headers["x-forwarded-for"];
    const previous = Array.isArray(incoming) ? incoming.join(", ") : incoming;
    const upstream = httpRequest(new URL(request.url ?? "/", webOrigin), {
      method: request.method, localAddress: EDGE_PEER, agent: false,
      headers: { ...request.headers, "x-forwarded-for": previous ? `${previous}, ${peer}` : peer },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  return { origin: await listen(edge), close: () => closeServer(edge) };
}

export async function startClientAddressStack(webEnvironment: Record<string, string> = {}) {
  const database = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(database);
  const store = createSqliteStore(database);
  const slug = `client-address-${randomUUID()}`;
  const article = await store.createArticle({ authorId: "client-address-fixture-author", slug, title: "Client address fixture",
    locale: "en", contentBlocks: [{ id: "p1", type: "paragraph", text: "A real persisted view counter." }], publish: true });
  const env = { AUTH_JWT_SECRET: "test-only-identity-secret-at-least-thirty-two-bytes", AUTH_JWT_ISSUER: "https://bridge.example.test",
    AUTH_JWT_AUDIENCE: "bridge-test", BFF_CLIENT_ADDRESS_SECRET: BRIDGE_SECRET, TRUSTED_PROXY_HOPS: "0" };
  const api = createApiServer({ store, env, logger: () => {} });
  let web: Awaited<ReturnType<typeof startProductionWeb>> | undefined;
  try {
    const apiOrigin = await listen(api);
    web = await startProductionWeb({ API_BASE_URL: apiOrigin, API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: BRIDGE_SECRET,
      WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "", ...webEnvironment });
    return { origin: web.origin, apiOrigin, store, article, slug,
      viewPath: `/api/articles/${slug}/views?locale=en`,
      async close() { await web?.close(); await closeServer(api); database.close(); } };
  } catch (error) { await web?.close(); await closeServer(api); database.close(); throw error; }
}

export async function registerClient(origin: string, peer: string, email: string) {
  const response = await callFrom(origin, peer, "/api/auth/register", { body: { email, password: BRIDGE_PASSWORD } });
  assert.equal(response.status, 201);
  const access = response.headers.getSetCookie().find((cookie) => cookie.startsWith("nw_access="))?.split(";")[0];
  assert.ok(access);
  return { email, cookie: access };
}
