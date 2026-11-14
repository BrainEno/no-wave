import { createHash } from "node:crypto";
import { addAbortSignal, type Readable } from "node:stream";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_SCRIPT_HASHES = 32;
export const RESOURCE_CSP = "default-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export const DEVELOPMENT_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const COMMON_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

export function browserSecurityHeaders(secure: boolean, policy = RESOURCE_CSP): Record<string, string> {
  return { ...COMMON_HEADERS, "content-security-policy": policy,
    ...(secure ? { "strict-transport-security": "max-age=31536000" } : {}) };
}

type DocumentSecurityCode = "DOCUMENT_TOO_LARGE" | "TOO_MANY_SCRIPT_HASHES" | "UNTRUSTED_INLINE_SCRIPT" | "INVALID_RENDER_MARKER" | "INVALID_UTF8";
export class DocumentSecurityError extends Error {
  readonly code: DocumentSecurityCode;
  constructor(code: DocumentSecurityCode) {
    super(code);
    this.code = code;
    this.name = "DocumentSecurityError";
  }
}

/**
 * Parse as a browser does, not with a regexp that can mistake comments, raw text,
 * template content or quoted '>' for executable scripts. The random marker is
 * trusted renderer provenance, NOT a nonce-source in the delivered policy.
 * Cached HTML may reveal this marker without authorizing a different script.
 */
export function documentScriptHashes(html: string, marker: string): string[] {
  if (!/^[A-Za-z0-9_-]{32}$/.test(marker)) throw new DocumentSecurityError("INVALID_RENDER_MARKER");
  const document = parse(html, { scriptingEnabled: true });
  const pending: DefaultTreeAdapterMap["node"][] = [document];
  const hashes = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "script" && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
      const attribute = (name: string) => node.attrs.find(item => item.name === name)?.value;
      const type = (attribute("type") ?? "").trim().toLowerCase();
      const executable = ["", "module", "importmap", "speculationrules", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"].includes(type);
      if (attribute("src") === undefined && executable) {
        if (attribute("nonce") !== marker) throw new DocumentSecurityError("UNTRUSTED_INLINE_SCRIPT");
        const source = node.childNodes.map(child => "value" in child ? child.value : "").join("");
        hashes.add(`'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`);
        if (hashes.size > MAX_DOCUMENT_SCRIPT_HASHES) throw new DocumentSecurityError("TOO_MANY_SCRIPT_HASHES");
      }
    }
    // A template's inert .content is deliberately not traversed. It cannot run
    // until application code activates it, at which point ordinary CSP applies.
    if ("childNodes" in node) for (const child of node.childNodes) pending.push(child);
  }
  return [...hashes].sort();
}

export function documentContentSecurityPolicy(hashes: readonly string[]): string {
  if (hashes.length > MAX_DOCUMENT_SCRIPT_HASHES || hashes.some(hash => !/^'sha256-[A-Za-z0-9+/]{43}='$/.test(hash))) {
    throw new TypeError("Invalid document script hashes.");
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${[...new Set(hashes)].sort().join(" ")}`.trim(),
    "script-src-attr 'none'",
    // GSAP and Lexical mutate style attributes/CSSOM. This compatibility grant
    // is deliberately STYLE-only; scripts have neither unsafe-inline nor eval.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Headers must precede bytes, while React can emit hydration scripts after its
 * shell. Collect one bounded UTF-8 document before sealing its exact script
 * hashes; do not abandon public caching or bless arbitrary inline user markup.
 * Aborts and bounds fail before any HTML is sent. Non-HTML stays streaming.
 */
export async function protectHtmlResponse(body: Readable, {
  marker, signal, headers: initialHeaders, status, secure,
}: { marker: string; signal: AbortSignal; headers: Headers; status: number; secure: boolean }): Promise<Response> {
  const chunks: Buffer[] = [];
  let size = 0;
  addAbortSignal(signal, body);
  try {
    for await (const chunk of body) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > MAX_DOCUMENT_BYTES) throw new DocumentSecurityError("DOCUMENT_TOO_LARGE");
      chunks.push(bytes);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    let html: string;
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new DocumentSecurityError("INVALID_UTF8"); }
    const policy = documentContentSecurityPolicy(documentScriptHashes(html, marker));
    const headers = new Headers(initialHeaders);
    for (const [name, value] of Object.entries(browserSecurityHeaders(secure, policy))) headers.set(name, value);
    if (!secure) headers.delete("strict-transport-security");
    headers.delete("content-security-policy-report-only");
    headers.delete("content-length");
    // A render-phase retry can carry the original public route's headers.
    // Never let a failure or cookie-bearing document inherit that cache grant.
    if (status >= 400 || headers.has("set-cookie")) headers.set("cache-control", "no-store, max-age=0");
    if (status >= 400) headers.set("x-robots-tag", "noindex");
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(bytes, { headers, status });
  } finally {
    if (!body.destroyed) body.destroy();
  }
}
