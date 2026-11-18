import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build, createServer } from "vite";

test("custom assets still reach Vite's authoritative matcher without serializing a glob regex", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-wave-glob-assets-"));
  try {
    await writeFile(join(root, "index.html"), '<script type="module" src="/entry.ts"></script>');
    await writeFile(join(root, "entry.ts"), 'import asset from "./sample.wave-asset"; console.log(asset);');
    await writeFile(join(root, "sample.wave-asset"), "this is an asset, not JavaScript");
    await build({
      configFile: false, root, logLevel: "silent", publicDir: false,
      assetsInclude: ["**/*.wave-asset"],
      build: { outDir: "dist", assetsInlineLimit: 0, minify: false },
    });
    const outputs = await readdir(join(root, "dist/assets"));
    const asset = outputs.find(file => file.endsWith(".wave-asset"));
    assert.ok(asset, "a positively matched custom asset must be emitted");
    assert.equal(await readFile(join(root, "dist/assets", asset), "utf8"), "this is an asset, not JavaScript");
    const script = outputs.find(file => file.endsWith(".js"));
    assert.ok(script);
    assert.ok((await readFile(join(root, "dist/assets", script), "utf8")).includes(asset));

    await writeFile(join(root, "entry.ts"), 'import asset from "./sample.wave-source"; console.log(asset);');
    await writeFile(join(root, "sample.wave-source"), "this must not be accepted as an asset");
    await assert.rejects(build({
      configFile: false, root, logLevel: "silent", publicDir: false,
      assetsInclude: ["**/*.wave-asset"], build: { outDir: "rejected" },
    }), /wave-source|parse|syntax/i, "an unfiltered dispatch must not turn nonmatching files into assets");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real Vite file server still denies private paths with the replacement engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-wave-glob-deny-"));
  const server = await createServer({
    configFile: false, envFile: false, root, logLevel: "silent", publicDir: false,
    server: { host: "0.0.0.0", port: 0, fs: { strict: true, allow: [root], deny: ["**/.env*", "**/*.{crt,pem}", "**/.git/**"] } },
  });
  try {
    await mkdir(join(root, ".git"));
    for (const file of [".env.local", "private.pem", "PRIVATE.PEM", ".git/config"]) {
      await writeFile(join(root, file), "private-glob-fixture");
    }
    await writeFile(join(root, "public.txt"), "public-glob-fixture");
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    for (const file of [".env.local", "private.pem", "PRIVATE.PEM", ".git/config"]) {
      const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 403, file);
      assert.equal((await response.text()).includes("private-glob-fixture"), false);
    }
    const publicResponse = await fetch(`${base}/public.txt`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(publicResponse.status, 200);
    assert.equal(await publicResponse.text(), "public-glob-fixture");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
