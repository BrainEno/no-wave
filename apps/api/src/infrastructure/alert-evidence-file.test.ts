import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { alertEvidenceFixture } from "./test-support/alert-evidence-fixture.ts";
import { parseAlertEvidenceManifest } from "./alert-evidence-manifest.ts";
import { EVIDENCE_LIMITS } from "../application/alert-evidence.ts";
import {
  loadAlertEvidenceFiles,
  readStableEvidenceFile,
} from "./alert-evidence-file.ts";

function fixture(t: TestContext) {
  const f = alertEvidenceFixture(),
    directory = mkdtempSync(join(tmpdir(), "nw-evidence-files-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trust = join(directory, "trust.json"),
    manifest = join(directory, "manifest.json");
  const batch = f.batch(0, 1, null),
    receipt = f.receipt(batch);
  const put = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  put(trust, { ...f.trustDocument, profiles: [f.trustDocument.profiles[0]] });
  put(join(directory, "batch.json"), batch);
  put(join(directory, "receipt.json"), receipt);
  const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const document = {
    version: 1,
    artifacts: [
      {
        kind: "batch",
        file: "batch.json",
        sha256: hash(join(directory, "batch.json")),
      },
      {
        kind: "receipt",
        file: "receipt.json",
        sha256: hash(join(directory, "receipt.json")),
      },
    ],
  };
  put(manifest, document);
  return {
    ...f,
    directory,
    trust,
    manifest,
    document,
    batch,
    receipt,
    put,
    hash,
  };
}

test("a bounded manifest admits only canonical relative files and rejects control, URL and traversal aliases", () => {
  const item = {
    kind: "batch",
    file: "part-1/batch.json",
    sha256: "a".repeat(64),
  };
  assert.equal(
    parseAlertEvidenceManifest({ version: 1, artifacts: [item] }).artifacts[0]!
      .file,
    item.file,
  );
  for (const file of [
    "",
    "/secret.json",
    "../secret.json",
    "a/../secret.json",
    "a//b.json",
    "./b.json",
    "https://example.test/x.json",
    "C:\\x.json",
    "a\\b.json",
    ".env",
    "a\u0000.json",
    "a\n.json",
    "a/b/c/d/e.json",
    "界.json",
    "a".repeat(65) + ".json",
  ])
    assert.throws(
      () =>
        parseAlertEvidenceManifest({
          version: 1,
          artifacts: [{ ...item, file }],
        }),
      { code: "manifest_invalid" },
      JSON.stringify(file),
    );
  for (const value of [
    null,
    { version: 2, artifacts: [] },
    { version: 1, artifacts: [], endpoint: "secret-canary" },
    { version: 1, artifacts: [{ ...item, kind: "profile" }] },
    { version: 1, artifacts: [{ ...item, sha256: "A".repeat(64) }] },
    { version: 1, artifacts: [{ ...item, signingKey: "secret-canary" }] },
    { version: 1, artifacts: [item, item] },
  ])
    assert.throws(() => parseAlertEvidenceManifest(value), {
      code: "manifest_invalid",
    });
  assert.throws(
    () =>
      parseAlertEvidenceManifest({
        version: 1,
        artifacts: Array.from({ length: 257 }, (_, i) => ({
          ...item,
          file: `${i}.json`,
        })),
      }),
    { code: "budget_exceeded" },
  );
});

test("the loader uses one separately pinned public trust file, verifies every raw digest and writes no journal or lock", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, "batch.json.lock"), "held", { mode: 0o600 });
  const names = readdirSync(f.directory),
    before = names.map((name) => readFileSync(join(f.directory, name)));
  const loaded = loadAlertEvidenceFiles(f.trust, [f.manifest]);
  assert.equal(loaded.collections.length, 1);
  assert.equal(loaded.collections[0]!.inputs.length, 2);
  assert.equal(loaded.trust.profiles.length, 1);
  assert.equal(loaded.snapshot, "non_atomic_file_evidence");
  assert.deepEqual(readdirSync(f.directory), names);
  assert.deepEqual(
    names.map((name) => readFileSync(join(f.directory, name))),
    before,
  );
  f.put(join(f.directory, "batch.json"), { ...f.batch, signature: "corrupt" });
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "integrity_mismatch",
  });
});

test("symlinks, hardlinks, unsafe directories, FIFOs and explicit control-file aliases fail without opening another service", (t) => {
  const f = fixture(t),
    artifact = join(f.directory, "batch.json");
  const target = join(f.directory, "target.json");
  f.put(target, f.batch);
  rmSync(artifact);
  symlinkSync(target, artifact);
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "file_io",
  });
  rmSync(artifact);
  linkSync(target, artifact);
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "file_io",
  });
  rmSync(artifact);
  execFileSync("mkfifo", ["-m", "600", artifact]);
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "file_io",
  });
  rmSync(artifact);
  f.put(artifact, f.batch);
  chmodSync(artifact, 0o640);
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "file_io",
  });
  chmodSync(artifact, 0o600);
  f.put(f.manifest, {
    version: 1,
    artifacts: [{ kind: "batch", file: "trust.json", sha256: f.hash(f.trust) }],
  });
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "manifest_invalid",
  });
  chmodSync(f.directory, 0o755);
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "file_io",
  });
});

test("nested private files are allowed but a symlink in the parent chain is not", (t) => {
  const f = fixture(t),
    nested = join(f.directory, "part");
  mkdirSync(nested, { mode: 0o700 });
  f.put(join(nested, "copy.json"), f.batch);
  const manifest = {
    version: 1,
    artifacts: [
      {
        kind: "batch",
        file: "part/copy.json",
        sha256: f.hash(join(nested, "copy.json")),
      },
    ],
  };
  f.put(f.manifest, manifest);
  assert.equal(
    loadAlertEvidenceFiles(f.trust, [f.manifest]).collections[0]!.inputs.length,
    1,
  );
  symlinkSync(nested, join(f.directory, "alias"));
  f.put(f.manifest, {
    ...manifest,
    artifacts: [{ ...manifest.artifacts[0], file: "alias/copy.json" }],
  });
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.manifest]), {
    code: "file_io",
  });
});

test("rewritten trust, manifest or an artifact between read passes invalidates the entire collection", (t) => {
  const f = fixture(t);
  for (const changed of [
    f.trust,
    f.manifest,
    join(f.directory, "batch.json"),
  ]) {
    f.put(f.trust, {
      ...f.trustDocument,
      profiles: [f.trustDocument.profiles[0]],
    });
    f.put(f.manifest, f.document);
    f.put(join(f.directory, "batch.json"), f.batch);
    let mutated = false;
    assert.throws(
      () =>
        loadAlertEvidenceFiles(f.trust, [f.manifest], {
          read: (path, maximum) => {
            const bytes = readStableEvidenceFile(path, maximum);
            if (!mutated && path === join(f.directory, "receipt.json")) {
              mutated = true;
              writeFileSync(
                changed,
                Buffer.concat([readFileSync(changed), Buffer.from(" ")]),
              );
            }
            return bytes;
          },
        }),
      { code: "snapshot_changed" },
    );
  }
});

test("aggregate file admission stops before opening an over-budget artifact and each comparison side has its own budget", (t) => {
  const f = fixture(t);
  const bytes = Buffer.alloc(EVIDENCE_LIMITS.artifactBytes, 32);
  bytes.write(JSON.stringify(f.batch));
  const maximum = EVIDENCE_LIMITS.totalBytes / bytes.length;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifacts = Array.from({ length: maximum + 1 }, (_, index) => {
    const file = `bounded-${index}.json`;
    writeFileSync(join(f.directory, file), bytes, { mode: 0o600 });
    return { kind: "batch", file, sha256 };
  });
  f.put(f.manifest, { version: 1, artifacts: artifacts.slice(0, maximum) });
  const loaded = loadAlertEvidenceFiles(f.trust, [f.manifest, f.manifest]);
  assert.deepEqual(
    loaded.collections.map((collection) => collection.inputs.length),
    [maximum, maximum],
  );
  f.put(f.manifest, { version: 1, artifacts });
  const readPaths: string[] = [];
  assert.throws(
    () =>
      loadAlertEvidenceFiles(f.trust, [f.manifest], {
        read: (path, limit) => {
          readPaths.push(path);
          return readStableEvidenceFile(path, limit);
        },
      }),
    { code: "budget_exceeded" },
  );
  assert.equal(readPaths.length, 2 + maximum);
  assert.equal(
    readPaths.includes(join(f.directory, artifacts.at(-1)!.file)),
    false,
  );
  for (const artifact of artifacts)
    assert.deepEqual(readFileSync(join(f.directory, artifact.file)), bytes);
});

test("cancellation and per-file budgets stop loading without mutating any input", (t) => {
  const f = fixture(t),
    cancelled = new AbortController();
  cancelled.abort();
  assert.throws(
    () =>
      loadAlertEvidenceFiles(f.trust, [f.manifest], {
        signal: cancelled.signal,
      }),
    { code: "cancelled" },
  );
  assert.throws(() => loadAlertEvidenceFiles(f.trust, []), {
    code: "arguments_invalid",
  });
  assert.throws(() => loadAlertEvidenceFiles(f.trust, [f.trust]), {
    code: "arguments_invalid",
  });
  assert.throws(
    () => readStableEvidenceFile(join(f.directory, "batch.json"), 8),
    { code: "budget_exceeded" },
  );
  let reads = 0;
  const midRead = new AbortController();
  assert.throws(
    () =>
      loadAlertEvidenceFiles(f.trust, [f.manifest], {
        read: (path, maximum) => {
          reads++;
          if (path.endsWith("receipt.json")) midRead.abort();
          return readStableEvidenceFile(path, maximum);
        },
        signal: midRead.signal,
      }),
    { code: "cancelled" },
  );
  assert.equal(reads, 4);
});
