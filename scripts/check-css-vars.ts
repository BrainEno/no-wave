import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

/**
 * Catch misspelled design-token names, not CSS cascade or computed-value bugs.
 * Definitions anywhere in the checked stylesheets count; a token defined only
 * under an unrelated selector can still be invalid at runtime. Browser and axe
 * tests remain responsible for computed styles and contrast.
 */
export type CssSource = { path: string; css: string };
export type CssVarProblem = { path: string; line: number; name: string };

export function undefinedCssVariables(sources: readonly CssSource[]): CssVarProblem[] {
  const definitions = new Set<string>();
  const uses: CssVarProblem[] = [];
  for (const source of sources) {
    const root = postcss.parse(source.css, { from: source.path });
    root.walkAtRules("property", (rule) => {
      const name = rule.params.trim();
      if (name.startsWith("--")) definitions.add(name);
    });
    root.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) definitions.add(declaration.prop);
      // Parsing the value avoids matching strings, comments or url("var(...)").
      // The walker also visits nested fallbacks, e.g. var(--a, var(--b)).
      valueParser(declaration.value).walk((node) => {
        if (node.type !== "function") return;
        if (node.value.toLowerCase() === "url") return false;
        if (node.value.toLowerCase() !== "var") return;
        const first = node.nodes.find((child) => child.type !== "space" && child.type !== "comment");
        if (first?.type !== "word" || !first.value.startsWith("--")) return;
        uses.push({ path: source.path, line: declaration.source?.start?.line ?? 1, name: first.value });
      });
    });
  }
  return uses.filter((use) => !definitions.has(use.name));
}

const skipped = new Set([".git", "node_modules", "build", "dist", ".react-router", ".arena", "coverage"]);

/** Discover source CSS without following symlinks into generated trees. */
export function findStylesheets(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) result.push(...findStylesheets(join(directory, entry.name)));
    } else if (entry.isFile() && extname(entry.name) === ".css") result.push(join(directory, entry.name));
  }
  return result.sort();
}

export function checkRepository(root: string): CssVarProblem[] {
  const files = findStylesheets(root);
  if (files.length === 0) throw new Error("No CSS source files found; refusing to pass an empty check.");
  return undefinedCssVariables(files.map((path) => ({ path: relative(root, path), css: readFileSync(path, "utf8") })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const problems = checkRepository(root);
    for (const { path, line, name } of problems) process.stderr.write(`${path}:${line}: undefined CSS custom property ${name}\n`);
    if (problems.length) process.exitCode = 1;
    else process.stdout.write("CSS custom property references have declarations.\n");
  } catch (error) {
    process.stderr.write(`CSS variable check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
