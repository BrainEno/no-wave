import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";

// ESLint already owns this parser in the frozen toolchain; no new dependency.
const { tokenize } = createRequire(import.meta.resolve("eslint"))("espree") as {
  tokenize(source: string, options: { ecmaVersion: "latest"; sourceType: "module"; loc: true }): Array<{
    type: string; value: string; loc: { start: { line: number }; end: { line: number } };
  }>;
};

// Independent of the primary Babel/token walker. This verifies its certificate;
// it does not manufacture replacement lines if runtime erasure rejects a claim.
const reportPath = new URL("./article-collection-lines.json", import.meta.url);
const reportText = readFileSync(reportPath, "utf8");
const report = JSON.parse(reportText) as { base: string; total: number; minimum: number; files: Array<{
  file: string; sha256: string; executableNewLines: number; lines: number[];
}> };
if (report.base !== "7c3b2c355f63442bba49d4678520aada6271eb7e" || report.minimum !== 800) throw new Error("Unexpected audit baseline or acceptance minimum.");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 20_000_000, stdio: ["ignore", "pipe", "pipe"] });
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const normalize = (line: string) => line.replace(/\s+/g, "").replace(/;$/, "");
const erase = (source: string) => stripTypeScriptTypes(source, { mode: "strip" }).split("\n");
const punctuation = new Set(["{", "}", "(", ")", "[", "]", ";", ",", ":", "."]);
const historicalRuntime = new Set<string>();
const baselineFiles = git("ls-tree", "-r", "--name-only", report.base).split("\n").filter(file =>
  /\.ts$/.test(file) && !/\.d\.ts$|\.(?:test|spec)\.ts$|\.config\.ts$|test-support|e2e\//.test(file) && /^(apps\/|packages\/|scripts\/)/.test(file));
for (const file of baselineFiles) {
  for (const line of erase(git("show", `${report.base}:${file}`))) historicalRuntime.add(normalize(line));
}
const failures: Array<{ file: string; line: number; reason: string }> = [];
const seenRuntime = new Set<string>();
let confirmed = 0;
for (const entry of report.files) {
  const source = readFileSync(entry.file, "utf8");
  if (digest(source) !== entry.sha256) throw new Error(`Certificate source changed: ${entry.file}`);
  if (!entry.lines.length) continue;
  if (!/^(?:apps\/(?:api\/src\/|web-rr\/)|packages\/web-(?:http|ui)\/src\/)/.test(entry.file) || !/\.ts$/.test(entry.file) || /test\/|\.config\.ts$/.test(entry.file)) {
    throw new Error(`Non-production claim: ${entry.file}`);
  }
  const erased = erase(source);
  const runtimeLines = new Set<number>();
  for (const token of tokenize(erased.join("\n"), { ecmaVersion: "latest", sourceType: "module", loc: true })) {
    if (token.type === "Punctuator" && punctuation.has(token.value)) continue;
    for (let line = token.loc.start.line; line <= token.loc.end.line; line++) runtimeLines.add(line);
  }
  const added = new Set<number>();
  let inBase = true;
  try { git("cat-file", "-e", `${report.base}:${entry.file}`); } catch { inBase = false; }
  if (!inBase) erased.forEach((_, index) => added.add(index + 1));
  else {
    const patch = git("diff", "--unified=0", report.base, "--", entry.file);
    let nextLine = 0;
    for (const row of patch.split("\n")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (match) nextLine = Number(match[1]);
      else if (row[0] === "+" && !row.startsWith("+++")) { added.add(nextLine); nextLine++; }
      else if (row[0] === " ") nextLine++;
    }
  }
  if (entry.executableNewLines !== entry.lines.length || new Set(entry.lines).size !== entry.lines.length) throw new Error("Invalid certificate cardinality.");
  for (const claimed of entry.lines) {
    const text = normalize(erased[claimed - 1] ?? "");
    const reason = !added.has(claimed) ? "not-added" : !runtimeLines.has(claimed) ? "erased-or-trivia"
      : historicalRuntime.has(text) ? "historical-runtime-fragment" : seenRuntime.has(text) ? "duplicate-runtime-fragment" : null;
    if (reason) failures.push({ file: entry.file, line: claimed, reason });
    else { confirmed++; seenRuntime.add(text); }
  }
}
console.log(JSON.stringify({ base: report.base, certificateSha256: digest(reportText),
  method: "Independent Node 24 type erasure + Espree JavaScript tokenizer + exact source hashes and git additions; second baseline runtime-fragment and new-fragment deduplication; semantic decisions remain explicit in the primary exclusion ledger.",
  claimed: report.total, runtimeConfirmed: confirmed, failures, minimum: report.minimum,
  satisfied: failures.length === 0 && confirmed === report.total && confirmed >= report.minimum,
}, null, 2));
if (failures.length || confirmed !== report.total || confirmed < report.minimum) process.exitCode = 1;
