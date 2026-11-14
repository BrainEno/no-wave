import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer, request as tlsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { promisify } from "node:util";

/** Ephemeral test-only CA/key, never a checked-in private key or relaxed TLS
 * verification. OpenSSL is a test prerequisite, not a production dependency. */
export async function tlsCredentials() {
  const directory = await mkdtemp(join(tmpdir(), "nw-tls-proof-"));
  try {
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { timeout: 10_000 });
    return { key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function listen(server: Server, secure = false): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS fixture did not open a TCP socket.");
  return `${secure ? "https" : "http"}://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

type WireResponse = { status: number; headers: Headers; text: string };
export function call(origin: string, cert: Buffer, path: string, {
  method = "GET", headers = {}, body,
}: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<WireResponse> {
  const url = new URL(path, origin), secure = url.protocol === "https:";
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = (secure ? tlsRequest : request)(url, {
      agent: false, method, ...(secure ? { ca: cert, servername: "localhost" } : {}),
      headers: { origin, ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        resolve({ status: response.statusCode!, headers, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error("TLS fixture request timed out.")));
    outgoing.once("error", reject);
    outgoing.end(data);
  });
}

/** One ingress serves both HTTP and HTTPS, discarding all browser-supplied
 * forwarding claims and stamping only the actual socket's peer and protocol. */
export async function startTlsIngress(destination: string, credentials: Awaited<ReturnType<typeof tlsCredentials>>) {
  const handler = (incoming: IncomingMessage, response: ServerResponse) => {
    const headers: IncomingMessage["headers"] = { ...incoming.headers, "x-forwarded-for": incoming.socket.remoteAddress!,
      "x-forwarded-proto": (incoming.socket as TLSSocket).encrypted === true ? "https" : "http" };
    delete headers.forwarded;
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-ssl"];
    const upstream = request(new URL(destination), { method: incoming.method, path: incoming.url,
      headers, localAddress: "127.0.0.10", agent: false }, reply => {
      response.writeHead(reply.statusCode!, reply.headers);
      reply.once("error", () => response.destroy());
      reply.pipe(response);
    });
    upstream.once("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.pipe(upstream);
  };
  const tls = createTlsServer(credentials, handler), http = createServer(handler);
  try {
    return { https: await listen(tls, true), http: await listen(http),
      close: async () => { await Promise.all([close(tls), close(http)]); } };
  } catch (error) { await Promise.all([close(tls), close(http)]); throw error; }
}
