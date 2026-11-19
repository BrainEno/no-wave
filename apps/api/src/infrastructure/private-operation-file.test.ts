import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  openPrivateOperationJournal,
  readPrivateOperationFile,
  writePrivateOperationArtifact,
} from "./private-operation-file.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "no-wave-operation-file-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "state.json") };
}
const options = {
  maximum: 1024,
  parse(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      !("revision" in value) ||
      typeof value.revision !== "number"
    )
      throw new Error("invalid");
    return { revision: value.revision };
  },
  revision: (value: { revision: number }) => value.revision,
};

test("private artifact publication is atomic create-only and identical retries never overwrite", (t) => {
  const f = fixture(t),
    bytes = Buffer.from('{"proof":"signed-fixture"}\n');
  assert.equal(writePrivateOperationArtifact(f.path, bytes, 1024), true);
  assert.equal(writePrivateOperationArtifact(f.path, bytes, 1024), false);
  assert.throws(
    () => writePrivateOperationArtifact(f.path, Buffer.from("different"), 1024),
    /artifact_conflict/,
  );
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(
    readPrivateOperationFile(f.path, {
      maximum: 1024,
      privateFile: true,
    })!.toString(),
    bytes.toString(),
  );
});

test("hard links, symlinks and unsafe output parents are never reused as artifacts", (t) => {
  const f = fixture(t),
    target = join(f.directory, "target");
  writeFileSync(target, "original", { mode: 0o600 });
  symlinkSync(target, f.path);
  assert.throws(
    () => writePrivateOperationArtifact(f.path, Buffer.from("original"), 1024),
    /state_io/,
  );
  rmSync(f.path);
  linkSync(target, f.path);
  assert.throws(
    () => writePrivateOperationArtifact(f.path, Buffer.from("original"), 1024),
    /state_io/,
  );
  assert.equal(readFileSync(target, "utf8"), "original");
  rmSync(f.path);
  chmodSync(f.directory, 0o755);
  assert.throws(
    () => writePrivateOperationArtifact(f.path, Buffer.from("new"), 1024),
    /state_io/,
  );
  assert.equal(existsSync(f.path), false);
});

test("the shared journal serializes independent users, rejects disk changes and validates revision progress", (t) => {
  const f = fixture(t),
    journal = openPrivateOperationJournal(f.path, options);
  assert.throws(
    () => openPrivateOperationJournal(f.path, options),
    /state_locked/,
  );
  assert.throws(() => journal.commit({ revision: 2 }), /state_invalid/);
  journal.commit({ revision: 1 });
  const before = readFileSync(f.path);
  journal.commit({ revision: 1 });
  assert.deepEqual(readFileSync(f.path), before);
  writeFileSync(f.path, '{"revision":99}', { mode: 0o600 });
  assert.throws(() => journal.commit({ revision: 2 }), /state_io/);
  journal.close();
  assert.equal(existsSync(f.path + ".lock"), false);
});

test("a missing or foreign lock is never stolen or deleted by a former owner", (t) => {
  const f = fixture(t),
    journal = openPrivateOperationJournal(f.path, options);
  rmSync(f.path + ".lock");
  writeFileSync(f.path + ".lock", "foreign", { mode: 0o600 });
  assert.throws(() => journal.commit({ revision: 1 }), /state_io/);
  assert.throws(() => journal.close(), /state_io/);
  assert.equal(readFileSync(f.path + ".lock", "utf8"), "foreign");
});
