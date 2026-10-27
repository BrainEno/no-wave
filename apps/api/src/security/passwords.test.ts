import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./passwords.ts";

test("password hashes use unique salts and verify without storing plaintext", async () => {
  const password = "disposable horse battery staple";
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.match(first, /^scrypt\$32768\$8\$3\$/);
  assert.ok(first !== second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword(password, "scrypt$999999999$8$3$invalid$invalid"), false);
});
