import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENAPI_DOCUMENT_JSON } from "../../apps/api/src/transport/rest/openapi/index.ts";

/**
 * The checked-in copy of the published contract.
 *
 * `GET /api/v1/openapi.json` serves the document the API generates at import, so
 * there is one definition. This file only decides whether the copy a reader finds
 * in the repository is that same definition: `openapi:check` compares bytes, and
 * `openapi:write` refreshes the copy after an intentional change.
 *
 * Checking in a generated artifact is a deliberate trade. A file that is generated
 * on demand is invisible in review — a diff that renames a route never shows the
 * contract moving with it. A checked-in file shows the change, and the byte
 * comparison makes "forgot to regenerate" a failing test instead of a stale doc.
 */

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const OPENAPI_FILE = join("docs", "api", "openapi.json");

/** The document as it should appear on disk. */
export function expectedDocument(): string {
  return OPENAPI_DOCUMENT_JSON;
}

/** The document as it appears on disk, or `null` when the file is missing. */
export async function readCheckedInDocument(root: string = ROOT): Promise<string | null> {
  try {
    return await readFile(join(root, OPENAPI_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * Problems with the checked-in copy, in the same shape `slices:check` reports.
 *
 * An empty array means the file is current. The first differing line is named
 * rather than dumping two JSON documents at the reader.
 */
export async function checkOpenApiFile(root: string = ROOT): Promise<string[]> {
  const checkedIn = await readCheckedInDocument(root);
  if (checkedIn === null) return [`${OPENAPI_FILE} is missing. Run \`pnpm openapi:write\`.`];

  const expected = expectedDocument();
  if (checkedIn === expected) return [];

  const actualLines = checkedIn.split("\n");
  const expectedLines = expected.split("\n");
  const limit = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (actualLines[index] === expectedLines[index]) continue;
    return [
      `${OPENAPI_FILE} is stale at line ${index + 1}: expected ${JSON.stringify(expectedLines[index] ?? "<end of file>")}, found ${JSON.stringify(actualLines[index] ?? "<end of file>")}. Run \`pnpm openapi:write\`.`,
    ];
  }
  return [`${OPENAPI_FILE} differs from the generated document. Run \`pnpm openapi:write\`.`];
}

/** Overwrite the checked-in copy. Returns the path written. */
export async function writeOpenApiFile(root: string = ROOT): Promise<string> {
  const target = join(root, OPENAPI_FILE);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, expectedDocument(), "utf8");
  return OPENAPI_FILE;
}
