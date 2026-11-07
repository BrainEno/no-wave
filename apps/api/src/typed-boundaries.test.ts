import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No `any` in the API's non-test sources.
 *
 * F-15 was two findings: `postgres.ts` as a 2,241-line monolith, and persistence
 * ports typed `(...args: any[]) => any`. Both are fixed — the store is ten domain
 * slices behind a 102-line composer, and the port contract is explicit — but "we
 * removed the escape hatch" is only true until the next deadline, because `any`
 * costs nothing to write and silence to review. It does not fail a build, it does
 * not fail a test, and it turns every downstream type into a suggestion.
 *
 * So this is the build failure. The patterns are the type-position forms (`: any`,
 * `as any`, `any[]`, `Record<string, any>`), not the word: prose may say "any"
 * as often as it likes, and comments are stripped before the scan because the
 * files that used to need a cast explain themselves at length.
 *
 * What `any` should be instead, in the shapes this codebase actually needs:
 * `unknown` plus a narrowing guard at a trust boundary, a generic parameter when
 * the caller knows the type, or the declared contract when the value was already
 * checked at runtime (see `assertPersistenceAdapter`).
 */

const API_SOURCE = fileURLToPath(new URL("./", import.meta.url));

/** The type-position spellings of `any`; the bare word is fine in a comment. */
const ANY_PATTERNS = [
  /:\s*any\b/g, // annotation: `value: any`
  /\bas\s+any\b/g, // assertion: `value as any`
  /<any>/g, // instantiation: `Promise<any>`
  /\bany\[\]/g, // array: `string[] | any[]`
  /\bArray<any>/g, // generic array
  /\bRecord<[^>]*\bany\b/g, // row bags: `Record<string, any>`
];

/**
 * Blank out comments, keeping line numbers.
 *
 * A regex cannot understand TypeScript, but it does not have to: the patterns
 * above appear inside comments constantly (every removed cast has a paragraph
 * explaining why), and a false positive here would be a build failure on prose.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    // A `//` that follows a character other than `:` is a line comment; `://`
    // is a URL in a string, and the guard keeps it.
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, lead: string) => lead);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

test("no non-test source file in apps/api smuggles a value through `any`", async () => {
  const files = await sourceFiles(API_SOURCE);
  assert.ok(files.length > 50, "the scan must actually find the API sources");

  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      for (const pattern of ANY_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          offenders.push(`${file.replace(API_SOURCE, "")}:${index + 1}  ${line.trim()}`);
          break;
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "Type-position `any` is banned in apps/api source. Use `unknown` + a guard, a generic "
      + "parameter, or the contract the value was already checked against:\n" + offenders.join("\n"),
  );
});
