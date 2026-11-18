import { redactDiagnostic, secretValues } from "./log-redaction.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createNotionJobKeyring } from "./notion-job-keys.ts";

const key = () => randomBytes(32).toString("base64");
test("a key ring seals with its explicit active key and opens old jobs during a staged rotation", () => {
  const old = key(), next = key();
  const first = createNotionJobKeyring({ NOTION_IMPORT_JOB_KEYS: `old:${old}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "old" });
  const expected = { jobId: randomUUID(), ownerId: "author", expiresAt: Date.now() + 10000 };
  const input = first.seal({ ...expected, bundle: Buffer.from("bundle secret"), plan: Buffer.from("plan secret"), now: Date.now() });
  const rotated = createNotionJobKeyring({ NOTION_IMPORT_JOB_KEYS: `old:${old},new:${next}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "new" });
  const opened = rotated.open(input, expected, Date.now());
  assert.equal(opened.bundle.toString(), "bundle secret");
  assert.equal(opened.plan.toString(), "plan secret");
  opened.bundle.fill(0); opened.plan.fill(0);
  const nextInput = rotated.seal({ ...expected, bundle: Buffer.from("new input"), plan: Buffer.from("new plan"), now: Date.now() });
  assert.equal(nextInput.keyId, "new");
  const removed = createNotionJobKeyring({ NOTION_IMPORT_JOB_KEYS: `new:${next}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "new" });
  assert.throws(() => removed.open(input, expected, Date.now()), /unavailable or invalid/);
  assert.throws(() => rotated.open({ ...input, keyId: "new" }, expected, Date.now()), /unavailable or invalid/);
  assert.throws(() => rotated.open(input, { ...expected, ownerId: "other" }, Date.now()), /unavailable or invalid/);
});
test("key aliases are authenticated, even if two ids accidentally contain the same material", () => {
  const same = key(), expected = { jobId: randomUUID(), ownerId: "author", expiresAt: Date.now() + 10000 };
  const ring = createNotionJobKeyring({ NOTION_IMPORT_JOB_KEYS: `a:${same},b:${same}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "a" });
  const input = ring.seal({ ...expected, bundle: Buffer.from("input"), plan: Buffer.from("plan"), now: Date.now() });
  assert.throws(() => ring.open({ ...input, keyId: "b" }, expected, Date.now()));
});
test("ambiguous, duplicate, unknown and oversized key configurations fail without echoing material", () => {
  const secret = key();
  for (const env of [
    {}, { NOTION_IMPORT_JOB_KEYS: `a:${secret}` },
    { NOTION_IMPORT_JOB_KEY: secret, NOTION_IMPORT_JOB_KEYS: `a:${secret}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "a" },
    { NOTION_IMPORT_JOB_KEYS: `a:${secret},a:${secret}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "a" },
    { NOTION_IMPORT_JOB_KEYS: `a:${secret}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "absent" },
    { NOTION_IMPORT_JOB_KEYS: `a:${secret},b:${secret},c:${secret},d:${secret}`, NOTION_IMPORT_JOB_ACTIVE_KEY: "a" },
    { NOTION_IMPORT_JOB_KEYS: `a:${secret},`, NOTION_IMPORT_JOB_ACTIVE_KEY: "a" },
  ]) assert.throws(() => createNotionJobKeyring(env), error => !String(error).includes(secret));
});

test("diagnostics mask individual active and previous keys, not just the entire ring string", () => {
  const old = key(), next = key();
  const secrets = secretValues({ NOTION_IMPORT_JOB_KEYS: `old:${old},next:${next}` });
  const logged = redactDiagnostic(`failed external adapter: ${old} / ${next}`, { secrets });
  assert.ok(logged);
  assert.ok(!logged.includes(old) && !logged.includes(next));
});
