import { createHash } from "node:crypto";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const REVISION = "cc5661d43cd4f9aad5567033a8e15ca28dc35c86";
// Locator only: these paths at this immutable google/fonts revision were checked
// against the existing blob receipts. SHA-256 remains the authority for bytes.
const PATHS = new Map([
  [
    "36fac00ef9b7d523236df6536cb09c712bb2c7e4",
    "instrumentserif/InstrumentSerif-Regular.ttf",
  ],
  [
    "192c3eda9864241ad280e9bcc84e258c80a4a588",
    "instrumentserif/InstrumentSerif-Italic.ttf",
  ],
  [
    "7d64212163dc15e7f3de5487672668dbde589365",
    "intertight/InterTight[wght].ttf",
  ],
  [
    "eab063faf229160a52d3760f5555150e4eb9e5bf",
    "notoserifsc/NotoSerifSC[wght].ttf",
  ],
  [
    "fb0637bafbcd804fe32152370a1225990745b4bc",
    "notosanssc/NotoSansSC[wght].ttf",
  ],
  ["669ce7917bec662fcf7244d37f49c4277f6fbd73", "instrumentserif/OFL.txt"],
  ["18d0da5dfcf4b1703293ed87f8e3efcf34aa643f", "intertight/OFL.txt"],
  ["94d1bf7b52481343e2983fb7751e8b7abe1ea07b", "notoserifsc/OFL.txt"],
  ["1c9f43281b8f216c5461fe9ac729afbade7724e4", "notosanssc/OFL.txt"],
]);
export type FontSourceFetch = (
  url: string,
  options: RequestInit,
) => Promise<Response>;

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    await response.body?.cancel();
    throw new Error("Font source response exceeds its size limit.");
  }
  if (!response.body) throw new Error("Empty font source response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Font source response exceeds its size limit.");
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    reader.releaseLock();
  }
}

function verify(bytes: Buffer, expected: string): Buffer {
  if (
    !bytes.length ||
    bytes.length > MAX_SOURCE_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== expected
  ) {
    throw new Error("Upstream font checksum or size mismatch.");
  }
  return bytes;
}

async function gitBlob(
  blob: string,
  expected: string,
  request: FontSourceFetch,
): Promise<Buffer> {
  const response = await request(
    `https://api.github.com/repos/google/fonts/git/blobs/${blob}`,
    {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "no-wave-font-builder",
      },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Pinned Git font source download failed (${response.status}).`,
    );
  }
  // Base64 line breaks and the JSON envelope also have a finite admission bound.
  const json = await boundedBody(
    response,
    Math.ceil(MAX_SOURCE_BYTES * 1.4) + 4096,
  );
  const data: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(json),
  );
  if (
    typeof data !== "object" ||
    data === null ||
    !("encoding" in data) ||
    data.encoding !== "base64" ||
    !("sha" in data) ||
    data.sha !== blob ||
    !("size" in data) ||
    !Number.isSafeInteger(data.size) ||
    Number(data.size) < 1 ||
    Number(data.size) > MAX_SOURCE_BYTES ||
    !("content" in data) ||
    typeof data.content !== "string" ||
    data.content.length > MAX_SOURCE_BYTES * 1.4
  ) {
    throw new Error("Invalid pinned Git font blob response.");
  }
  const bytes = verify(Buffer.from(data.content, "base64"), expected);
  if (bytes.length !== data.size)
    throw new Error("Pinned Git font blob size mismatch.");
  return bytes;
}

/** Same immutable public inputs without spending the shared anonymous Git API quota. */
export async function downloadPinnedFontBlob(
  blob: string,
  expected: string,
  request: FontSourceFetch = fetch,
): Promise<Buffer> {
  const path = PATHS.get(blob);
  if (!path || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("Unknown pinned font source or checksum.");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await request(
      `https://raw.githubusercontent.com/google/fonts/${REVISION}/ofl/${encoded}`,
      {
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "no-wave-font-builder" },
      },
    );
  } catch {
    // Some offline build networks allow only the Git API. Fallback stays pinned
    // to the original blob, carries no token, and must pass the same checksum.
    return gitBlob(blob, expected, request);
  }
  if (response.ok)
    return verify(await boundedBody(response, MAX_SOURCE_BYTES), expected);
  await response.body?.cancel();
  if (![403, 408, 429].includes(response.status) && response.status < 500) {
    throw new Error(
      `Pinned raw font source download failed (${response.status}).`,
    );
  }
  return gitBlob(blob, expected, request);
}
