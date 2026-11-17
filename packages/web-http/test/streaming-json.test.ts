import assert from "node:assert/strict";
import test from "node:test";
import { StreamingJsonValidator } from "../src/streaming-json.ts";
import { UpstreamResponseError } from "../src/upstream-errors.ts";

const encoder = new TextEncoder();
function validate(text: string, chunkSize = 1) {
  const validator = new StreamingJsonValidator();
  const bytes = encoder.encode(text);
  for (let position = 0; position < bytes.length; position += chunkSize) validator.write(bytes.subarray(position, position + chunkSize));
  validator.finish();
}

test("valid JSON survives every byte boundary without retaining strings or arrays", () => {
  const values: unknown[] = [null, true, false, 0, -0, 1.5, 1e30, "浪潮🌊\n\t\\\"", [], {},
    { pages: [{ properties: { Title: "作品" }, children: [null, true, -1.2e-8] }], report: { skipped: 0 } }];
  for (const value of values) {
    const text = JSON.stringify(value);
    for (const size of [1, 2, 7, 1024]) assert.doesNotThrow(() => validate(text, size));
  }
  for (const text of [" 0 \r\n", "0.0", "-0.5e+2", "1E-2", '"\\u0000\\uD83C\\uDF0A"']) validate(text);
});

test("truncation, trailing garbage, malformed strings/numbers and separators fail closed", () => {
  const invalid = ["", " ", "{", "[", '{"a":', '{"a" 1}', '{"a":1,}', "[1,]", "[,1]", "{1:2}", "[1 2]", "{}{}", "true false", "nullx",
    "tru", "False", "NaN", "Infinity", "01", "-", "1.", "1e", "1e+", "+1", ".1", "--1", "1e+-2", '"open', '"\\x"', '"\\u123z"', '"\\u123"', '"raw\nline"'];
  for (const text of invalid) assert.throws(() => validate(text), UpstreamResponseError, text);
  const complete = JSON.stringify({ data: ["浪潮", { ok: true }] });
  for (let end = 0; end < complete.length; end++) assert.throws(() => validate(complete.slice(0, end)), UpstreamResponseError);
});

test("malformed or incomplete UTF-8 cannot become replacement characters in a downloaded file", () => {
  for (const bytes of [new Uint8Array([34, 0xff, 34]), new Uint8Array([34, 0xe6, 0xb5])]) {
    const validator = new StreamingJsonValidator();
    assert.throws(() => { validator.write(bytes); validator.finish(); }, UpstreamResponseError);
  }
});

test("deeply nested data has a finite parser stack and failures never contain user content", () => {
  const validator = new StreamingJsonValidator(4);
  assert.throws(() => validator.write(encoder.encode('[[[[["private-bundle-canary"]]]]]')), error => error instanceof UpstreamResponseError && !error.message.includes("private"));
  validate('[{"a":[{"b":"ok"}]}]');
});

test("deterministic structured values agree with JSON.parse under irregular streaming boundaries", () => {
  let seed = 1234567;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const make = (depth: number): unknown => {
    const choice = random() % (depth ? 6 : 4);
    if (choice === 0) return null;
    if (choice === 1) return random() % 2 === 0;
    if (choice === 2) return (random() - 2 ** 31) / 17;
    if (choice === 3) return `作品🌊${random()}\n\\\"`;
    if (choice === 4) return Array.from({ length: random() % 5 }, () => make(depth - 1));
    return Object.fromEntries(Array.from({ length: random() % 5 }, (_, key) => [`key${key}`, make(depth - 1)]));
  };
  for (let iteration = 0; iteration < 1000; iteration++) {
    const text = JSON.stringify(make(5));
    assert.doesNotThrow(() => JSON.parse(text));
    validate(text, random() % 31 + 1);
  }
});
