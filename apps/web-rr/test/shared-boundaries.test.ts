import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "@babel/parser";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [join(directory, entry.name)] : []);
}

test("every BFF resource imports its shared handler directly and no app-local proxy remains", () => {
  const directory = join(root, "apps/web-rr/app/routes");
  const routes = readdirSync(directory).filter(name => /^api\..*\.ts$/.test(name));
  assert.ok(routes.length >= 38);
  for (const route of routes) {
    const tree = parse(readFileSync(join(directory, route), "utf8"), { sourceType: "module", plugins: ["typescript"] });
    const imports = tree.program.body.filter(node => node.type === "ImportDeclaration").map(node => node.source.value);
    assert.ok(imports.includes("@no-wave/web-http"), route);
    assert.ok(!imports.some(specifier => /-proxy\.ts$/.test(specifier)), route);
  }
  for (const name of ["account", "auth", "authoring", "notifications"]) assert.equal(existsSync(join(root, `apps/web-rr/app/lib/${name}-proxy.ts`)), false);
});

test("production shared UI receives configuration and never reads a Node environment", () => {
  const offenders: string[] = [];
  function visit(value: unknown, file: string) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, file)); return; }
    const node = value as Record<string, unknown>;
    const object = node.object as Record<string, unknown> | undefined;
    const property = node.property as Record<string, unknown> | undefined;
    if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && object?.type === "Identifier" && object.name === "process" &&
        (property?.name === "env" || node.computed === true && property?.value === "env")) offenders.push(file);
    if (node.type === "VariableDeclarator") {
      const initial = node.init as Record<string, unknown> | undefined;
      const pattern = node.id as { type?: string; properties?: Array<{ key?: { name?: string; value?: string } }> } | undefined;
      if (initial?.type === "Identifier" && initial.name === "process" && pattern?.type === "ObjectPattern" &&
          pattern.properties?.some(property => property.key?.name === "env" || property.key?.value === "env")) offenders.push(file);
    }
    for (const [key, child] of Object.entries(node)) if (!["tokens", "comments", "loc", "extra"].includes(key)) visit(child, file);
  }
  for (const file of sources(join(root, "packages/web-ui/src"))) visit(parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] }).program, file);
  assert.deepEqual(offenders, []);
});

test("the shared-module entrypoints remain short and the accepted framework/storage boundaries are discoverable", () => {
  for (const document of ["apps/web-rr/README.md", "packages/web-http/README.md", "packages/web-ui/README.md"]) {
    assert.ok(readFileSync(join(root, document), "utf8").trimEnd().split("\n").length <= 80, document);
  }
  const guidance = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(guidance, /shared-modules\.md/); assert.match(guidance, /bff-routes\.md/);
  assert.match(guidance, /ADR 0025/);
  assert.doesNotMatch(guidance, /framework is not selected|before the framework decision is accepted/);
});
