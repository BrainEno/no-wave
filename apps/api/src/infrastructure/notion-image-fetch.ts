/**
 * Read a Notion-hosted image without turning the API into an arbitrary URL proxy.
 * Only the known Notion-owned S3 bucket is allowed; redirects are never followed.
 * Signed query strings are credentials, so failures must never include the URL.
 */
export const NOTION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const TRUSTED_HOST = /^prod-files-secure\.s3(?:\.us-west-2)?\.amazonaws\.com$/;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isTrustedNotionImageUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.port === "" && TRUSTED_HOST.test(url.hostname) && url.hash === "";
  } catch {
    return false;
  }
}

export type NotionImageFetchResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; reason: string };

/** Enforces the byte limit on the stream itself, not on Content-Length. */
export async function fetchNotionImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionImageFetchResult> {
  if (!isTrustedNotionImageUrl(url)) return { ok: false, reason: "untrusted image host" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: "image download failed or expired" };
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!TYPES.has(contentType)) {
      await response.body?.cancel();
      return { ok: false, reason: "unsupported image type" };
    }
    if (!response.body) return { ok: false, reason: "image response has no body" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > NOTION_IMAGE_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "image exceeds the 8 MiB limit" };
      }
      chunks.push(next.value);
    }
    if (size === 0) return { ok: false, reason: "image response is empty" };
    return { ok: true, bytes: Buffer.concat(chunks, size), contentType };
  } catch {
    return { ok: false, reason: "image download failed or timed out" };
  } finally {
    clearTimeout(timeout);
  }
}
