import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";

// Independent lexer/emitter, not the primary Babel AST walk. This tool cannot add credit.
type Position = { line: number; column: number };
const { tokenize } = createRequire(import.meta.resolve("eslint"))("espree") as {
  tokenize(
    source: string,
    options: object,
  ): { type: string; value: string; loc: { start: Position; end: Position } }[];
};
const viteRequire = createRequire(
  createRequire(
    new URL("../../apps/web-rr/package.json", import.meta.url),
  ).resolve("vite"),
);
const { transformSync } = viteRequire("esbuild") as {
  transformSync(source: string, options: object): { code: string; map: string };
};
const { TraceMap, originalPositionFor } = createRequire(
  import.meta.resolve("@babel/core"),
)("@jridgewell/trace-mapping") as {
  TraceMap: new (map: string) => object;
  originalPositionFor(map: object, at: Position): { line: number | null };
};
const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 30_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const reportText = readFileSync(
  new URL("./writing-cadence-lines.json", import.meta.url),
  "utf8",
);
const report = JSON.parse(reportText) as {
  base: string;
  minimum: number;
  total: number;
  semanticLedgerSha256: string;
  files: {
    file: string;
    sha256: string;
    lines: number[];
    executableNewLines: number;
  }[];
};
if (
  report.base !== "491e6e91fe4a4d7ae8fee6126e35b6421cc3eb9e" ||
  report.minimum !== 800
)
  throw new Error("Wrong independent baseline/minimum.");
const ledgerText = readFileSync(
  new URL("./writing-cadence-line-exclusions.json", import.meta.url),
  "utf8",
);
const ledger = JSON.parse(ledgerText) as {
  base: string;
  rules: { file: string; fragments: { line: number; text: string }[] }[];
};
if (
  ledger.base !== report.base ||
  sha(ledgerText) !== report.semanticLedgerSha256
)
  throw new Error("Semantic exclusion ledger changed.");
const punctuation = new Set(["{", "}", "(", ")", "[", "]", ";", ",", ":", "."]);
function runtime(source: string, file: string): Map<number, string> {
  let code: string, origin: (position: Position) => number | null;
  if (file.endsWith(".tsx")) {
    const output = transformSync(source, {
      loader: "tsx",
      jsx: "preserve",
      target: "esnext",
      sourcefile: file,
      sourcemap: "external",
    });
    code = output.code;
    const map = new TraceMap(output.map);
    origin = (at) => originalPositionFor(map, at).line;
  } else {
    code = stripTypeScriptTypes(source, { mode: "strip" });
    origin = (at) => at.line;
  }
  const lines = new Map<number, string>();
  for (const token of tokenize(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    loc: true,
    ecmaFeatures: { jsx: true },
  })) {
    if (
      ["JSXIdentifier", "JSXText"].includes(token.type) ||
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
const historical = new Set<string>();
for (const file of git("ls-tree", "-r", "--name-only", report.base)
  .trim()
  .split("\n")
  .filter(
    (file) =>
      /^(apps|packages|scripts)\//u.test(file) &&
      /\.tsx?$/u.test(file) &&
      !/\.d\.ts$|\.(test|spec)\.tsx?$|\.config\.ts$|test-support|e2e\//u.test(
        file,
      ),
  )) {
  for (const fragment of runtime(
    git("show", `${report.base}:${file}`),
    file,
  ).values())
    historical.add(fragment);
}
const seen = new Set<string>(),
  seenFiles = new Set<string>();
const failures: { file: string; line: number; reason: string }[] = [];
let confirmed = 0;
for (const entry of report.files) {
  if (
    seenFiles.has(entry.file) ||
    !/^packages\/web-ui\/src\/lib\/writing-cadence(?:-(symbols|source|scan|rhythm|index|review|profile|report|controller|explain|enclosures|crossings))?\.ts$/u.test(
      entry.file,
    )
  )
    throw new Error("Duplicate or nonproduction file in certificate.");
  seenFiles.add(entry.file);
  let existed = true;
  try {
    git("cat-file", "-e", `${report.base}:${entry.file}`);
  } catch {
    existed = false;
  }
  if (existed)
    throw new Error(
      "Historical files cannot be credited by this new-file audit.",
    );
  const source = readFileSync(entry.file, "utf8");
  if (
    sha(source) !== entry.sha256 ||
    entry.lines.length !== entry.executableNewLines ||
    new Set(entry.lines).size !== entry.lines.length
  )
    throw new Error("Source hash/line cardinality changed.");
  const sourceLines = source.split("\n");
  for (const rule of ledger.rules.filter((rule) => rule.file === entry.file))
    for (const item of rule.fragments) {
      if (
        sourceLines[item.line - 1]?.trim() !== item.text ||
        entry.lines.includes(item.line)
      )
        throw new Error(
          "A pinned semantic exclusion became stale or was credited.",
        );
    }
  const lines = runtime(source, entry.file);
  for (const line of entry.lines) {
    const fragment = lines.get(line);
    const reason =
      !Number.isSafeInteger(line) ||
      line < 1 ||
      line > source.split("\n").length
        ? "not-added"
        : fragment === undefined
          ? "erased-or-trivia"
          : historical.has(fragment)
            ? "historical-runtime-fragment"
            : seen.has(fragment)
              ? "duplicate-runtime-fragment"
              : null;
    if (reason) failures.push({ file: entry.file, line, reason });
    else {
      confirmed++;
      seen.add(fragment!);
    }
  }
}
console.log(
  JSON.stringify(
    {
      base: report.base,
      certificateSha256: sha(reportText),
      method:
        "Independent Node24 TS erasure / esbuild TSX erasure with source maps / Espree runtime tokens; exact source hashes and new-file additions; canonical runtime fragment deduplication against all baseline production TS/TSX and within accepted new credits. Semantic exclusions cannot be overridden or supplemented with credits.",
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
if (
  process.argv.includes("--enforce") &&
  (failures.length || confirmed !== report.total || confirmed < report.minimum)
)
  process.exitCode = 1;
