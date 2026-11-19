import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { alertEvidenceFixture } from "./alert-evidence-fixture.ts";

export function alertEvidenceWorkspace(t: TestContext) {
  const f = alertEvidenceFixture(),
    directory = mkdtempSync(join(tmpdir(), "nw-evidence-cli-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (file: string, value: unknown) =>
    writeFileSync(join(directory, file), JSON.stringify(value) + "\n", {
      mode: 0o600,
    });
  const hash = (file: string) =>
    createHash("sha256")
      .update(readFileSync(join(directory, file)))
      .digest("hex");
  const base = Date.now() - 60_000;
  const first = f.batch(0, 1, null, {
    event: f.event(1, "firing", { at: base, firingSince: base }),
  });
  const second = f.batch(0, 2, first, {
    event: f.event(3, "reminder", { at: base + 30_000, firingSince: base }),
  });
  const trustDocument = {
    ...f.trustDocument,
    profiles: [f.trustDocument.profiles[0]],
  };
  put("trust.json", trustDocument);
  put("one.json", first);
  put("two.json", second);
  put("one-receipt.json", f.receipt(first));
  put("two-receipt.json", f.receipt(second));
  const artifacts = [
    { kind: "batch", file: "one.json", sha256: hash("one.json") },
    {
      kind: "receipt",
      file: "one-receipt.json",
      sha256: hash("one-receipt.json"),
    },
    { kind: "batch", file: "two.json", sha256: hash("two.json") },
    {
      kind: "receipt",
      file: "two-receipt.json",
      sha256: hash("two-receipt.json"),
    },
  ];
  put("before.json", { version: 1, artifacts: artifacts.slice(0, 2) });
  put("after.json", { version: 1, artifacts });
  writeFileSync(
    join(directory, ".env"),
    "AUTH_JWT_SECRET=evidence-env-file-canary\n",
    { mode: 0o600 },
  );
  const trust = join(directory, "trust.json"),
    before = join(directory, "before.json"),
    after = join(directory, "after.json");
  const snapshot = () =>
    readdirSync(directory)
      .sort()
      .map((file) => [file, hash(file)]);
  return {
    ...f,
    directory,
    trust,
    before,
    after,
    first,
    second,
    put,
    hash,
    artifacts,
    snapshot,
    publicTrustDocument: trustDocument,
    review: ["review", "--trust", trust, "--manifest", before],
    compare: [
      "compare",
      "--trust",
      trust,
      "--before",
      before,
      "--after",
      after,
    ],
  };
}
