import assert from "node:assert/strict";
import test from "node:test";
import { CollectionJsonDecoder } from "../src/collection-json.ts";
import { UpstreamResponseError } from "../src/upstream-errors.ts";
import { bufferUpstreamResponse } from "../src/upstream-response.ts";

const utf8 = new TextEncoder();
const reason = (value: string) => (error: unknown) => error instanceof UpstreamResponseError && error.reason === value;
function decode(text: string, width = 31, bom = false): Record<string, unknown> {
  const decoder = new CollectionJsonDecoder();
  const bytes = utf8.encode((bom ? "\ufeff" : "") + text);
  for (let index = 0; index < bytes.length; index += width) decoder.write(bytes.subarray(index, index + width));
  decoder.finish();
  return JSON.parse(JSON.stringify(decoder.payload())) as Record<string, unknown>;
}

test("collection framing preserves nested containers, primitive slots, escaped keys, multibyte text and split BOM", () => {
  const payload = { before: { note: [1, "{,]}\\\"", null] }, data: [{ text: "浪🙂\ud800", nested: [[], {}, false] }, null, 17, "str", true], meta: { nextCursor: "opaque" } };
  for (const width of [1, 2, 3, 7, 64, 65536]) for (const bom of [false, true]) assert.deepEqual(decode(JSON.stringify(payload), width, bom), payload);
  assert.deepEqual(decode('{"d\\u0061ta":[],"__proto__":{"polluted":true}}'), JSON.parse('{"data":[],"__proto__":{"polluted":true}}'));
  assert.equal(Object.hasOwn({}, "polluted"), false);
});

test("reused Node Buffer backing storage cannot corrupt retained keys, metadata or article bytes", async () => {
  const text = '{"data":[{"text":"浪🙂"},{"text":"tail"}],"meta":{"next":"cursor"}}';
  const decoder = new CollectionJsonDecoder();
  const scratch = Buffer.alloc(1);
  for (const byte of utf8.encode(text)) { scratch[0] = byte; decoder.write(scratch); }
  scratch.fill(0);
  decoder.finish();
  assert.deepEqual(JSON.parse(JSON.stringify(decoder.payload())), JSON.parse(text));
  const body = utf8.encode(text);
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === body.length) { controller.close(); return; }
    scratch[0] = body[offset++]!;
    controller.enqueue(scratch);
  } }, { highWaterMark: 0 }));
  const result = await bufferUpstreamResponse(response, 1024, new AbortController().signal);
  assert.equal(new TextDecoder().decode(result.bytes), text);
});

test("decoded per-item, count and cumulative envelope fences accept exact boundaries and reject boundary plus one", () => {
  for (const [options, text] of [
    [{ itemBytes: 5 }, '{"data":["浪"]}'], [{ maxItems: 2 }, '{"data":[0,0]}'], [{ envelopeBytes: 11 }, '{"data":[]}'],
  ] as const) { const decoder = new CollectionJsonDecoder(options); decoder.write(utf8.encode(text)); decoder.finish(); }
  for (const [options, text] of [
    [{ itemBytes: 4 }, '{"data":["浪"]}'], [{ maxItems: 2 }, '{"data":[0,0,0]}'], [{ envelopeBytes: 10 }, '{"data":[]}'],
    [{ envelopeBytes: 25 }, '{"meta":"' + "x".repeat(30) + '","data":[]}'],
  ] as const) assert.throws(() => { const decoder = new CollectionJsonDecoder(options); decoder.write(utf8.encode(text)); decoder.finish(); }, reason("too-large"));
  for (const options of [{ maxItems: 301 }, { maxItems: 0 }, { maxItems: 1.5 }, { itemBytes: 8 * 1024 * 1024 + 1 }, { envelopeBytes: 65537 }]) assert.throws(() => new CollectionJsonDecoder(options), RangeError);
});

test("a forwarding decoder validates every item and EOF without parsing/projecting or retaining item bodies", () => {
  let mapped = 0;
  const decoder = new CollectionJsonDecoder({ retainItems: false, project: () => { mapped++; throw new Error("should not map"); } });
  decoder.write(utf8.encode('{"data":[{"text":"x"},false,null],"meta":{"offset":3}}'));
  assert.throws(() => decoder.payload(), /incomplete/);
  decoder.finish();
  assert.equal(mapped, 0);
  assert.deepEqual(decoder.payload().data, []);
  assert.deepEqual(decoder.payload().meta, { offset: 3 });
});

test("fatal UTF-8, malformed tokens, duplicate top-level keys and every incomplete prefix fail closed", () => {
  const invalid = ['[]', 'null', '{"data":[1,]}', '{"data":[],}', '{"data":[],"d\\u0061ta":[]}', '{"data":[],"meta":1,"meta":2}',
    '{"data":[01]}', '{"data":[1e]}', '{"data":["\\uQQQQ"]}', '{"data":[]}false', '{"data":["\n"]}', '{"data":[' + '['.repeat(129) + '0' + ']'.repeat(129) + ']}'];
  for (const input of invalid) assert.throws(() => decode(input, 1), reason("invalid-json"), input);
  const text = '{"data":[{"key":"tail"}],"meta":{"next":null}}';
  for (let end = 0; end < text.length; end++) assert.throws(() => decode(text.slice(0, end), 3), reason("invalid-json"));
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xe6, 0xb5])]) {
    const decoder = new CollectionJsonDecoder();
    assert.throws(() => { decoder.write(utf8.encode('{"data":["')); decoder.write(bytes); decoder.write(utf8.encode('"]}')); decoder.finish(); }, reason("invalid-json"));
  }
});

test("deadlines are checked inside a giant adapter chunk and after projection; no result escapes before validated EOF", () => {
  const timeout = new Error("deadline witness");
  let checks = 0;
  const decoder = new CollectionJsonDecoder({ checkpoint: () => { if (++checks === 8) throw timeout; } });
  assert.throws(() => decoder.write(utf8.encode('{"data":["' + "a".repeat(1_000_000) + '"]}')), error => error === timeout);
  assert.throws(() => decoder.payload());
  let projected = false;
  const mapped = new CollectionJsonDecoder({ project: () => { projected = true; return "safe"; }, checkpoint: () => { if (projected) throw timeout; } });
  assert.throws(() => mapped.write(utf8.encode('{"data":[1]}')), error => error === timeout);
  assert.throws(() => mapped.payload());
});

test("seeded collection differential: 2,000 arbitrary JSON arrays across random byte boundaries", () => {
  let state = 0x366b0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const value = (depth: number): unknown => {
    const kind = random() % (depth ? 7 : 5);
    if (kind === 0) return null;
    if (kind === 1) return !!(random() % 2);
    if (kind === 2) return random() / 3;
    if (kind < 5) return String.fromCharCode(...Array.from({ length: random() % 30 }, () => random() % 65536));
    if (kind === 5) return Array.from({ length: random() % 5 }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: random() % 5 }, (_, index) => [`key${index}`, value(depth - 1)]));
  };
  for (let index = 0; index < 2000; index++) {
    const input = { data: Array.from({ length: random() % 10 }, () => value(4)), meta: value(3) };
    assert.deepEqual(decode(JSON.stringify(input), 1 + random() % 71), input, `seeded input ${index}`);
  }
});

test("terminal decoder failures cannot be recovered into a successful page or retain partial projected results", () => {
  const failure = new Error("projection rejected");
  const decoder = new CollectionJsonDecoder({ project: () => { throw failure; } });
  assert.throws(() => decoder.write(utf8.encode('{"data":[1]}')), error => error === failure);
  assert.throws(() => decoder.finish(), error => error === failure);
  assert.throws(() => decoder.write(utf8.encode(']}')), error => error === failure);
  assert.throws(() => decoder.payload());
});
