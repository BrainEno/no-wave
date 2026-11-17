import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
const base = "e53904a2e6d3ae8aab38d10f18542b64c52a6581";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 20_000_000, stdio: ["ignore", "pipe", "pipe"] });
const manual = JSON.parse(readFileSync(new URL("./writing-collections-line-exclusions.json", import.meta.url), "utf8")) as {
  base: string; rules: { file: string; fragments: { line: number; text: string }[]; reason: string }[];
};
if (manual.base !== base) throw new Error("Semantic exclusions must refer to the exact audit baseline.");
const files = [...new Set([...git("diff", "--name-only", base).trim().split("\n"), ...git("ls-files", "--others", "--exclude-standard").trim().split("\n")])]
  .filter(file => /^packages\/web-ui\/src\/(?:lib\/(?:writing-collection(?:-[a-z]+)?|authoring-catalogue-open|writing-backup)\.ts|components\/authoring\/writing-collections?(?:-[a-z]+)*\.tsx)$/.test(file)
    && !/\.(test|spec)\.tsx?$/.test(file)).sort();
function executableLines(source: string): Set<number> {
  const tree = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], tokens: true });
  const excluded: Array<[number, number]> = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const node = value as Record<string, unknown>;
    if (["JSXIdentifier", "JSXText", "JSXEmptyExpression", "JSXClosingElement", "JSXOpeningFragment", "JSXClosingFragment"].includes(String(node.type)) ||
        node.type === "JSXAttribute" && (!node.value || typeof node.value === "object" && (node.value as Record<string, unknown>).type === "StringLiteral")) {
      excluded.push([Number(node.start), Number(node.end)]); return;
    }
    if (String(node.type).startsWith("TS") && !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSInstantiationExpression"].includes(String(node.type))) {
      excluded.push([Number(node.start), Number(node.end)]); return;
    }
    if ((node.type === "ClassProperty" || node.type === "ClassPrivateProperty") && node.value == null ||
        node.type === "ExportSpecifier" && node.exportKind === "type" ||
        node.type === "ImportSpecifier" && node.importKind === "type" || node.declare === true) {
      excluded.push([Number(node.start), Number(node.end)]); return;
    }
    if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") {
      excluded.push([Number(node.start), Number(node.end)]); return;
    }
    if (["ImportDeclaration", "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSTypeAnnotation", "TSTypeParameterDeclaration", "TSTypeParameterInstantiation"].includes(String(node.type))) {
      excluded.push([Number(node.start), Number(node.end)]); return;
    }
    for (const [key, child] of Object.entries(node)) if (!["tokens", "comments", "loc", "extra"].includes(key)) visit(child);
  }
  visit(tree.program);
  const lines = new Set<number>();
  for (const token of tree.tokens ?? []) {
    const t = token as unknown as { type: { label?: string } | string; start: number; end: number; loc: { start: { line: number }; end: { line: number } } };
    if (typeof t.type === "string" || excluded.some(([start, end]) => t.start >= start && t.end <= end)) continue;
    if (["{", "}", "(", ")", "[", "]", ";", ",", ":", ".", "eof", "jsxTagStart", "jsxTagEnd", "jsxText", "as", "satisfies"].includes(t.type.label ?? "")) continue;
    for (let line = t.loc.start.line; line <= t.loc.end.line; line++) lines.add(line);
  }
  return lines;
}
const normalize = (line: string) => line.replace(/\s+/g, "").replace(/;$/, "");
const baselineLines = new Set<string>();
const baselineFiles = git("ls-tree", "-r", "--name-only", base).split("\n").filter(file =>
  /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file) && !/\.config\.ts$|test-support|e2e\//.test(file)
  && /^(apps\/|packages\/|scripts\/)/.test(file));
for (const file of baselineFiles) {
  const source = git("show", `${base}:${file}`);
  for (const line of source.split("\n")) baselineLines.add(normalize(line));
}
const seenNew = new Set<string>();
const results = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  let original = "";
  try { original = git("show", `${base}:${file}`); } catch {}
  const originalLines = original.split("\n");
  const oldText = new Set(originalLines.map(normalize));
  const changed = new Set<number>();
  if (!original) for (let n = 1; n <= source.split("\n").length; n++) changed.add(n);
  else {
    const diff = git("diff", "--unified=0", "--ignore-all-space", base, "--", file);
    let line = 0;
    for (const row of diff.split("\n")) {
      const hunk = /^@@ .* \+(\d+)/.exec(row);
      if (hunk) { line = Number(hunk[1]); continue; }
      if (row.startsWith("+++") || row.startsWith("---")) continue;
      if (row.startsWith("+")) { changed.add(line); line += 1; }
      else if (row.startsWith(" ")) line += 1;
    }
  }
  const executable = executableLines(source);
  const content = source.split("\n");
  const eligible = [...changed].filter(line => executable.has(line) && !oldText.has(normalize(content[line - 1])) && !baselineLines.has(normalize(content[line - 1])));
  const unique = eligible.filter(line => {
    const text = normalize(content[line-1]);
    if (seenNew.has(text)) return false;
    seenNew.add(text); return true;
  });
  const fragments = manual.rules.filter(rule => rule.file === file).flatMap(rule => rule.fragments);
  for (const { line, text } of fragments) {
    if (line < 1 || line > content.length || content[line - 1].trim() !== text) throw new Error(`Stale audit exclusion: ${file}:${line}`);
  }
  const excluded = new Set(fragments.map(fragment => fragment.line));
  const accepted = unique.filter(line => !excluded.has(line));
  results.push({ file, sha256: createHash("sha256").update(source).digest("hex"), changed: changed.size,
    executableCandidateLines: unique.length, semanticExclusions: unique.filter(line => excluded.has(line)),
    executableNewLines: accepted.length, lines: accepted });
}
const candidates = results.reduce((n, row) => n + row.executableCandidateLines, 0);
const deductions = results.reduce((n, row) => n + row.semanticExclusions.length, 0);
const total = results.reduce((n, row) => n + row.executableNewLines, 0);
console.log(JSON.stringify({ base,
  method: "Production TS only; git changed executable-token lines; exclude comments, blank/punctuation, imports, erased class fields and type-only exports/annotations; remove normalized lines from every baseline production TS/TSX module and duplicate new fragments; subtract the separately reviewed semantic-move ledger. Tests, smoke/audit scripts, translations, static JSX-only markup/text, docs, CSS, configuration and generated artifacts are never eligible.",
  files: results, candidates, semanticDeductions: deductions, total, minimum: 800, satisfied: total >= 800,
}, null, 2));
if (total < 800) process.exitCode = 1;
