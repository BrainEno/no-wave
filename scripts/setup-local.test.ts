import assert from "node:assert/strict";
import test from "node:test";
import { generateAuthSecret, parseSetupArguments } from "./setup-local.ts";

test("parseSetupArguments accepts default options", () => {
  const result = parseSetupArguments([]);
  assert.ok(result.args);
  assert.equal(result.args.postgres, false);
  assert.equal(result.args.force, false);
  assert.equal(result.args.print, false);
  assert.equal(result.args.migrate, false);
  assert.equal(result.args.all, false);
});

test("parseSetupArguments recognizes flag combinations and aliases", () => {
  const flags = parseSetupArguments(["--postgres", "-f", "--print", "-m"]);
  assert.ok(flags.args);
  assert.equal(flags.args.postgres, true);
  assert.equal(flags.args.force, true);
  assert.equal(flags.args.print, true);
  assert.equal(flags.args.migrate, true);
  assert.equal(flags.args.all, false);

  const allFlag = parseSetupArguments(["--all"]);
  assert.ok(allFlag.args);
  assert.equal(allFlag.args.all, true);
  assert.equal(allFlag.args.migrate, true);

  const aFlag = parseSetupArguments(["-a"]);
  assert.ok(aFlag.args);
  assert.equal(aFlag.args.all, true);
  assert.equal(aFlag.args.migrate, true);
});

test("parseSetupArguments rejects unknown options with descriptive error", () => {
  const result = parseSetupArguments(["--invalid-option"]);
  assert.equal(result.args, undefined);
  assert.match(result.error ?? "", /Unknown option "--invalid-option"/);
});

test("generateAuthSecret produces high-entropy base64url secrets with safe length", () => {
  const secret1 = generateAuthSecret();
  const secret2 = generateAuthSecret();
  assert.notEqual(secret1, secret2);
  assert.ok(secret1.length >= 64);
  assert.match(secret1, /^[A-Za-z0-9_-]+$/);
});
