import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";

// Independent toolchain paths already owned by frozen ESLint/Vite/Babel deps.
// None of these tools, nor their generated output, count toward production LOC.
type Position = { line: number; column: number };
const { tokenize } = createRequire(import.meta.resolve("eslint"))("espree") as {
  tokenize(
    source: string,
    options: {
      ecmaVersion: "latest";
      sourceType: "module";
      loc: true;
      ecmaFeatures: { jsx: true };
    },
  ): Array<{
    type: string;
    value: string;
    loc: { start: Position; end: Position };
  }>;
};
const webRequire = createRequire(
  new URL("../../apps/web-rr/package.json", import.meta.url),
);
const { transformSync } = createRequire(webRequire.resolve("vite"))(
  "esbuild",
) as {
  transformSync(
    source: string,
    options: {
      loader: "tsx";
      jsx: "preserve";
      target: "esnext";
      sourcefile: string;
      sourcemap: "external";
    },
  ): { code: string; map: string };
};
const { TraceMap, originalPositionFor } = createRequire(
  import.meta.resolve("@babel/core"),
)("@jridgewell/trace-mapping") as {
  TraceMap: new (map: string) => object;
  originalPositionFor(
    map: object,
    position: Position,
  ): { source: string | null; line: number | null };
};

// This checks the primary certificate, never invents replacement credits. TS
// uses Node's line-preserving erasure. TSX uses esbuild (not the primary Babel
// parser), traced back to original lines before Espree token verification.
const reportPath = new URL("./writing-recovery-lines.json", import.meta.url);
const reportText = readFileSync(reportPath, "utf8");
const report = JSON.parse(reportText) as {
  base: string;
  total: number;
  minimum: number;
  files: Array<{
    file: string;
    sha256: string;
    executableNewLines: number;
    lines: number[];
  }>;
};
if (
  report.base !== "c3171b1f13428605c1a5bbf2386071a383b21089" ||
  report.minimum !== 800
)
  throw new Error("Unexpected audit baseline or acceptance minimum.");
const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 20_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const punctuation = new Set(["{", "}", "(", ")", "[", "]", ";", ",", ":", "."]);
function runtime(source: string, file: string): Map<number, string> {
  let code: string;
  let origin: (position: Position) => number | null;
  if (file.endsWith(".tsx")) {
    const transformed = transformSync(source, {
      loader: "tsx",
      jsx: "preserve",
      target: "esnext",
      sourcefile: file,
      sourcemap: "external",
    });
    code = transformed.code;
    const map = new TraceMap(transformed.map);
    origin = (position) => originalPositionFor(map, position).line;
  } else {
    code = stripTypeScriptTypes(source, { mode: "strip" });
    origin = (position) => position.line;
  }
  const lines = new Map<number, string>();
  for (const token of tokenize(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    loc: true,
    ecmaFeatures: { jsx: true },
  })) {
    if (
      token.type === "JSXText" ||
      token.type === "JSXIdentifier" ||
      (token.type === "Punctuator" && punctuation.has(token.value))
    )
      continue;
    for (let line = token.loc.start.line; line <= token.loc.end.line; line++) {
      const mapped = origin({
        line,
        column: line === token.loc.start.line ? token.loc.start.column : 0,
      });
      if (mapped !== null)
        lines.set(
          mapped,
          (lines.get(mapped) ?? "") + JSON.stringify([token.type, token.value]),
        );
    }
  }
  return lines;
}
const historicalRuntime = new Set<string>();
const baselineFiles = git("ls-tree", "-r", "--name-only", report.base)
  .split("\n")
  .filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.d\.ts$|\.(?:test|spec)\.tsx?$|\.config\.ts$|test-support|e2e\//.test(
        file,
      ) &&
      /^(apps\/|packages\/|scripts\/)/.test(file),
  );
for (const file of baselineFiles)
  for (const text of runtime(
    git("show", `${report.base}:${file}`),
    file,
  ).values())
    historicalRuntime.add(text);

const failures: Array<{ file: string; line: number; reason: string }> = [];
const seenRuntime = new Set<string>();
let confirmed = 0;
for (const entry of report.files) {
  const source = readFileSync(entry.file, "utf8");
  if (digest(source) !== entry.sha256)
    throw new Error(`Certificate source changed: ${entry.file}`);
  if (
    !/^packages\/web-ui\/src\/(?:lib\/writing-recovery-(?:model|store|controller|boundary|lifecycle|source)\.ts|components\/authoring\/(?:writing-recovery|article-editor)\.tsx)$/.test(
      entry.file,
    )
  )
    throw new Error(`Non-production claim: ${entry.file}`);
  const runtimeLines = runtime(source, entry.file);
  const added = new Set<number>();
  let inBase = true;
  try {
    git("cat-file", "-e", `${report.base}:${entry.file}`);
  } catch {
    inBase = false;
  }
  if (!inBase) source.split("\n").forEach((_, index) => added.add(index + 1));
  else {
    const patch = git("diff", "--unified=0", report.base, "--", entry.file);
    let nextLine = 0;
    for (const row of patch.split("\n")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (match) nextLine = Number(match[1]);
      else if (row[0] === "+" && !row.startsWith("+++")) {
        added.add(nextLine);
        nextLine++;
      } else if (row[0] === " ") nextLine++;
    }
  }
  if (
    entry.executableNewLines !== entry.lines.length ||
    new Set(entry.lines).size !== entry.lines.length
  )
    throw new Error("Invalid certificate cardinality.");
  for (const claimed of entry.lines) {
    const text = runtimeLines.get(claimed);
    const reason = !added.has(claimed)
      ? "not-added"
      : text === undefined
        ? "erased-or-trivia"
        : historicalRuntime.has(text)
          ? "historical-runtime-fragment"
          : seenRuntime.has(text)
            ? "duplicate-runtime-fragment"
            : null;
    if (reason) failures.push({ file: entry.file, line: claimed, reason });
    else {
      confirmed++;
      seenRuntime.add(text!);
    }
  }
}
console.log(
  JSON.stringify(
    {
      base: report.base,
      certificateSha256: digest(reportText),
      method:
        "Independent Node 24 TS erasure / esbuild TSX erasure with original source maps, then Espree tokens, exact source hashes and git additions. Canonical runtime-token fragments are deduplicated against all baseline production TS/TSX and within new credits. Semantic exclusions remain in the primary ledger; this verifier cannot add credits.",
      claimed: report.total,
      runtimeConfirmed: confirmed,
      failures,
      minimum: report.minimum,
      satisfied:
        failures.length === 0 &&
        confirmed === report.total &&
        confirmed >= report.minimum,
    },
    null,
    2,
  ),
);
if (failures.length || confirmed !== report.total || confirmed < report.minimum)
  process.exitCode = 1;
