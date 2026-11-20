import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { format } from "prettier";

// Audit tooling and its output receive no production-function line credit.
const base = "93f516230cb58dc72aedc71b9069c12d97ea1eed";
const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 30_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const paths = [
  "packages/web-ui/src/lib/writing-parallel-align.ts",
  "packages/web-ui/src/lib/writing-parallel-asymmetry.ts",
  "packages/web-ui/src/lib/writing-parallel-controller.ts",
  "packages/web-ui/src/lib/writing-parallel-explain.ts",
  "packages/web-ui/src/lib/writing-parallel-index.ts",
  "packages/web-ui/src/lib/writing-parallel-model.ts",
  "packages/web-ui/src/lib/writing-parallel-profile.ts",
  "packages/web-ui/src/lib/writing-parallel-ratios.ts",
  "packages/web-ui/src/lib/writing-parallel-report.ts",
  "packages/web-ui/src/lib/writing-parallel-review.ts",
  "packages/web-ui/src/lib/writing-parallel-skeleton.ts",
  "packages/web-ui/src/lib/writing-parallel-source.ts",
  "packages/web-ui/src/lib/writing-parallel-symbols.ts",
  "packages/web-ui/src/lib/writing-parallel.ts",
].sort();
const ledgerText = readFileSync(
  new URL("./writing-parallel-line-exclusions.json", import.meta.url),
  "utf8",
);
const ledger = JSON.parse(ledgerText) as {
  base: string;
  rules: {
    file: string;
    reason: string;
    fragments: { line: number; text: string }[];
  }[];
};
if (
  ledger.base !== base ||
  ledger.rules.some((rule) => !paths.includes(rule.file) || !rule.reason)
)
  throw new Error("Semantic ledger baseline/allowlist mismatch.");

function executable(source: string): Set<number> {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    tokens: true,
  });
  const blocked: [number, number][] = [];
  const exclude = (node: Record<string, unknown>) =>
    blocked.push([Number(node.start), Number(node.end)]);
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>,
      kind = String(node.type);
    if (
      (kind.startsWith("TS") &&
        ![
          "TSAsExpression",
          "TSSatisfiesExpression",
          "TSNonNullExpression",
          "TSInstantiationExpression",
        ].includes(kind)) ||
      [
        "ImportDeclaration",
        "ExportAllDeclaration",
        "JSXIdentifier",
        "JSXText",
        "JSXEmptyExpression",
        "JSXClosingElement",
        "JSXOpeningFragment",
        "JSXClosingFragment",
      ].includes(kind) ||
      node.declare === true
    ) {
      exclude(node);
      return;
    }
    if (kind === "ExportNamedDeclaration") {
      if (!node.declaration || node.exportKind === "type") {
        exclude(node);
        return;
      }
      blocked.push([
        Number(node.start),
        Number((node.declaration as Record<string, unknown>).start),
      ]);
    }
    if (
      (kind === "JSXAttribute" &&
        (!node.value ||
          (node.value as Record<string, unknown>).type === "StringLiteral")) ||
      (["ClassProperty", "ClassPrivateProperty"].includes(kind) &&
        node.value == null) ||
      (kind === "VariableDeclarator" && node.init == null)
    ) {
      exclude(node);
      return;
    }
    if (
      (kind.includes("Function") ||
        [
          "ClassMethod",
          "ClassPrivateMethod",
          "ObjectMethod",
          "ClassDeclaration",
          "ClassExpression",
        ].includes(kind)) &&
      node.body
    ) {
      blocked.push([
        Number(node.start),
        Number((node.body as Record<string, unknown>).start),
      ]);
    }
    for (const [key, child] of Object.entries(node))
      if (!["tokens", "comments", "loc", "extra"].includes(key)) visit(child);
  }
  visit(ast.program);
  const trivia = new Set([
    "{",
    "}",
    "(",
    ")",
    "[",
    "]",
    ";",
    ",",
    ":",
    ".",
    "eof",
    "jsxTagStart",
    "jsxTagEnd",
    "jsxText",
    "as",
    "satisfies",
  ]);
  const lines = new Set<number>();
  for (const raw of ast.tokens ?? []) {
    const token = raw as unknown as {
      type: string | { label?: string };
      start: number;
      end: number;
      loc: { start: { line: number }; end: { line: number } };
    };
    if (
      typeof token.type === "string" ||
      trivia.has(token.type.label ?? "") ||
      blocked.some(([start, end]) => token.start >= start && token.end <= end)
    )
      continue;
    for (let line = token.loc.start.line; line <= token.loc.end.line; line++)
      lines.add(line);
  }
  return lines;
}
const normalize = (line: string) =>
  line.replace(/\s+/gu, "").replace(/;$/u, "");
const baseline = new Set<string>();
for (const file of git("ls-tree", "-r", "--name-only", base)
  .trim()
  .split("\n")
  .filter(
    (path) =>
      /^(apps|packages|scripts)\//u.test(path) &&
      /\.tsx?$/u.test(path) &&
      !/\.d\.ts$|\.(test|spec)\.tsx?$|\.config\.ts$|test-support|e2e\//u.test(
        path,
      ),
  )) {
  for (const line of git("show", `${base}:${file}`).split("\n"))
    baseline.add(normalize(line));
}
const seen = new Set<string>();
const files = paths.map((file) => {
  // Every allowlisted implementation is a new file in this round, never a moved historical module.
  let existed = true;
  try {
    git("cat-file", "-e", `${base}:${file}`);
  } catch {
    existed = false;
  }
  if (existed) throw new Error(`Audit requires a new production file: ${file}`);
  const source = readFileSync(file, "utf8"),
    text = source.split("\n"),
    runtime = executable(source);
  const candidates = [...runtime]
    .sort((a, b) => a - b)
    .filter((line) => {
      const key = normalize(text[line - 1]!);
      if (!key || baseline.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const exclusions = new Set<number>();
  for (const rule of ledger.rules.filter((rule) => rule.file === file))
    for (const item of rule.fragments) {
      if (
        text[item.line - 1]?.trim() !== item.text ||
        exclusions.has(item.line)
      )
        throw new Error(
          `Stale/duplicate semantic exclusion: ${file}:${item.line}`,
        );
      exclusions.add(item.line);
    }
  const lines = candidates.filter((line) => !exclusions.has(line));
  return {
    file,
    sha256: createHash("sha256").update(source).digest("hex"),
    executableCandidateLines: candidates.length,
    semanticExclusions: candidates.filter((line) => exclusions.has(line)),
    executableNewLines: lines.length,
    lines,
  };
});
const total = files.reduce((sum, file) => sum + file.executableNewLines, 0);
const dumpAt = process.argv.find((argument) =>
  argument.startsWith("--dump-candidates="),
);
if (dumpAt)
  writeFileSync(
    dumpAt.slice("--dump-candidates=".length),
    JSON.stringify(
      {
        base,
        files: files.map((file) => ({
          file: file.file,
          lines: [...file.lines, ...file.semanticExclusions].sort(
            (a, b) => a - b,
          ),
        })),
      },
      null,
      2,
    ) + "\n",
  );
process.stdout.write(
  await format(
    JSON.stringify(
      {
        base,
        minimum: 800,
        semanticLedgerSha256: createHash("sha256")
          .update(ledgerText)
          .digest("hex"),
        method:
          "Exact round allowlist; Babel runtime tokens with TS/import/signature/static-JSX/trivia erasure; deduplicate normalized source fragments against every baseline production TS/TSX line and within this round; then pinned semantic exclusions for DTO/static copy/config/thin wiring/repetition. No tests/docs/audit tooling/generated output/old feature code is credited. Independent runtime verifier may only reject credits.",
        candidates: files.reduce(
          (sum, file) => sum + file.executableCandidateLines,
          0,
        ),
        deductions: files.reduce(
          (sum, file) => sum + file.semanticExclusions.length,
          0,
        ),
        total,
        files,
        satisfied: total >= 800,
      },
      null,
      2,
    ),
    { parser: "json" },
  ),
);
if (process.argv.includes("--enforce") && total < 800) process.exitCode = 1;
