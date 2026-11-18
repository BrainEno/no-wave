import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { jsonValueChunks } from "./json-encoding.ts";

function encoded(value: unknown, key = ""): string {
  const chunks = [...jsonValueChunks(value, key)];
  for (const chunk of chunks) assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 64 * 1024, `unbounded JSON chunk: ${chunk.byteLength}`);
  return Buffer.concat(chunks).toString("utf8");
}

test("incremental JSON equals native array-slot semantics for primitives, escaping, wrappers and cross-realm values", () => {
  const custom = Object.assign(() => {}, { toJSON: () => ({ callable: true }) });
  const values: unknown[] = [null, undefined, Symbol("omitted"), () => {}, true, false, 0, -0, NaN, Infinity, -Infinity,
    "\u0000\u0001\b\t\n\f\r\"\\\u2028\u2029", "浪🙂\ud800a\udc00", { "__proto__": null, constructor: "ok" },
    [1, , undefined, Symbol(), () => {}, NaN], { a: undefined, b: Symbol(), c: () => {}, d: 2 }, new Date("2026-11-01T00:00:00Z"),
    new Number(3), new String("text"), new Boolean(false), Object(Symbol()), custom,
    runInNewContext('({ number: new Number(17), string: new String("字🙂"), boolean: new Boolean(false), date: new Date("2026-01-01T00:00:00Z") })'),
    Object.assign(new Number(2), { [Symbol.toPrimitive]: () => 8 }), Object.assign(new String("one"), { toString: () => "two" }),
    new Proxy([1, 2, 3], { get: (target, property, receiver) => property === "length" ? 1.2 : Reflect.get(target, property, receiver) }),
  ];
  for (const value of values) assert.equal(encoded(value), JSON.stringify([value]).slice(1, -1));
});

test("long CJK, astral, escape-heavy and lone-surrogate strings retain every code unit at arbitrary chunk boundaries", () => {
  for (const length of [16_380, 16_383, 16_384, 16_385, 50_000, 300_000]) {
    for (const suffix of ["🙂尾", "\ud800", "\udc00", "\u0000\n\"\\"]) {
      const value = { ["键🙂".repeat(8000)]: "浪".repeat(length) + suffix };
      assert.equal(encoded(value), JSON.stringify(value));
    }
  }
});

test("property and array toJSON keys, getters and snapshot order match native JSON", () => {
  const keys: string[] = [];
  const child = { toJSON(key: string) { keys.push(key); return { key }; } };
  assert.equal(encoded({ child, rows: [child] }), '{"child":{"key":"child"},"rows":[{"key":"0"}]}');
  assert.deepEqual(keys, ["child", "0"]);
  const calls: string[] = [];
  const object = { get a() { calls.push("a"); return 1; }, get b() { calls.push("b"); return 2; } };
  assert.equal(encoded(object), '{"a":1,"b":2}');
  assert.deepEqual(calls, ["a", "b"]);
  const shared = { text: "same reference, not a cycle" };
  assert.equal(encoded([shared, shared]), JSON.stringify([shared, shared]));
  assert.equal(encoded({ toJSON: () => child }), JSON.stringify({ toJSON: () => child }));
});

test("cycles, unsupported BigInt and throwing hooks fail instead of completing a truncated success", () => {
  const cyclic: Record<string, unknown> = { name: "loop" }; cyclic.self = cyclic;
  for (const value of [cyclic, [1n], Object(3n), { get fail() { throw new Error("hook-failure"); } }]) assert.throws(() => encoded(value));
  let touched = 0;
  const iterator = jsonValueChunks({ text: "x".repeat(100_000), get later() { touched++; return "late"; } });
  assert.equal(iterator.next().done, false);
  assert.equal(touched, 0, "only one bounded chunk is prepared before socket backpressure");
  iterator.return(undefined);
  assert.equal(touched, 0, "cancelled writers never traverse later properties");
});

test("iterative encoding handles deep values without depending on the JavaScript call stack", () => {
  let value: unknown = "leaf";
  for (let depth = 0; depth < 20_000; depth++) value = [value];
  const text = encoded(value);
  assert.equal(text, "[".repeat(20_000) + '"leaf"' + "]".repeat(20_000));
});

test("seeded JSON differential: 4,000 nested legal values match JSON.stringify byte for byte", () => {
  let state = 0x366356;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const string = () => Array.from({ length: random() % 60 }, () => String.fromCharCode(random() % 65_536)).join("");
  const value = (depth: number): unknown => {
    const kind = random() % (depth ? 8 : 5);
    if (kind === 0) return null;
    if (kind === 1) return !!(random() % 2);
    if (kind === 2) return (random() - 0x80000000) / (1 + random());
    if (kind < 5) return string();
    if (kind === 5) return Array.from({ length: random() % 8 }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: random() % 8 }, () => [string(), value(depth - 1)]));
  };
  for (let index = 0; index < 4000; index++) { const input = value(4); assert.equal(encoded(input), JSON.stringify(input), `seeded input ${index}`); }
});
