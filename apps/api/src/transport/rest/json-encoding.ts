import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from "node:util/types";

const MAX_CHUNK_CHARACTERS = 16_384;
const controls: Readonly<Record<number, string>> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
type JsonObject = Record<string, unknown>;
type ArrayFrame = { kind: "array"; value: unknown[]; index: number; length: number };
type ObjectFrame = { kind: "object"; value: JsonObject; keys: string[]; index: number; written: boolean };
type Frame = ArrayFrame | ObjectFrame;
const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const unicodeEscape = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;

/** Call toJSON just once, with the same key that an enclosing array/object uses. */
function jsonValue(value: unknown, key: string): unknown {
  if ((typeof value === "object" && value !== null) || typeof value === "function" || typeof value === "bigint") {
    const toJSON: unknown = Reflect.get(Object(value), "toJSON");
    if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]);
  }
  // Intrinsic checks work across realms without invoking Symbol.toStringTag
  // getters or throwing four exceptions for every ordinary stored JSON object.
  if (isNumberObject(value)) value = +(value as unknown as number);
  else if (isStringObject(value)) value = String(value);
  else if (isBooleanObject(value)) value = Boolean.prototype.valueOf.call(value);
  else if (isBigIntObject(value)) value = BigInt.prototype.valueOf.call(value);
  if (typeof value === "bigint") throw new TypeError("A BigInt is not JSON serializable.");
  return typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" ? undefined : value;
}

/** String escaping is bounded even for one long code block or poem line. */
function* quoted(value: string): Generator<string> {
  yield '"';
  let start = 0;
  let run = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    let escaped: string | undefined;
    if (code === 34) escaped = '\\"';
    else if (code === 92) escaped = "\\\\";
    else if (code < 32) escaped = controls[code] ?? unicodeEscape(code);
    else if (highSurrogate(code)) {
      if (lowSurrogate(value.charCodeAt(index + 1))) {
        if (run >= MAX_CHUNK_CHARACTERS - 1) {
          if (index > start) yield value.slice(start, index);
          start = index; run = 0;
        }
        index++; run += 2;
      } else escaped = unicodeEscape(code);
    } else if (lowSurrogate(code)) escaped = unicodeEscape(code);
    if (escaped !== undefined) {
      if (index > start) yield value.slice(start, index);
      yield escaped;
      start = index + 1; run = 0;
    } else {
      if (!highSurrogate(code)) run++;
      if (run >= MAX_CHUNK_CHARACTERS) {
        yield value.slice(start, index + 1);
        start = index + 1; run = 0;
      }
    }
  }
  if (start < value.length) yield value.slice(start);
  yield '"';
}

/**
 * Iterative traversal: no recursively generated whole row, no call-stack limit,
 * and no unbounded escaped-string allocation. Only ancestor objects are held in
 * the cycle set; repeated references in different branches remain legal JSON.
 */
function* pieces(input: unknown, key: string): Generator<string> {
  const stack: Frame[] = [];
  const ancestors = new Set<object>();
  let value = jsonValue(input, key);
  while (true) {
    if (value === null || value === undefined) yield "null";
    else if (typeof value === "string") yield* quoted(value);
    else if (typeof value === "number") yield Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value) : "null";
    else if (typeof value === "boolean") yield value ? "true" : "false";
    else if (typeof value === "object") {
      if (ancestors.has(value)) throw new TypeError("A cyclic value is not JSON serializable.");
      ancestors.add(value);
      if (Array.isArray(value)) {
        yield "[";
        const length = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(+value.length))) || 0;
        stack.push({ kind: "array", value, index: 0, length });
      } else {
        yield "{";
        const object = value as JsonObject;
        stack.push({ kind: "object", value: object, keys: Object.keys(object), index: 0, written: false });
      }
    }
    let next = false;
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.kind === "array") {
        if (frame.index < frame.length) {
          if (frame.index > 0) yield ",";
          const index = frame.index++;
          value = jsonValue(frame.value[index], String(index));
          next = true;
          break;
        }
        yield "]";
      } else {
        while (frame.index < frame.keys.length) {
          const property = frame.keys[frame.index++]!;
          value = jsonValue(frame.value[property], property);
          if (value === undefined) continue;
          if (frame.written) yield ",";
          frame.written = true;
          yield* quoted(property);
          yield ":";
          next = true;
          break;
        }
        if (next) break;
        yield "}";
      }
      ancestors.delete(frame.value);
      stack.pop();
    }
    if (!next) return;
  }
}

/**
 * At most 64 KiB of UTF-8 per yielded Buffer, including adversarial escape-heavy
 * strings and astral characters at chunk boundaries. The caller can await socket
 * drain/cancellation between chunks instead of synchronously encoding a page.
 * Root values have array-slot semantics (undefined -> null), as REST data does.
 */
export function* jsonValueChunks(value: unknown, key = ""): Generator<Buffer> {
  let pending = "";
  for (const piece of pieces(value, key)) {
    let offset = 0;
    while (offset < piece.length) {
      let end = Math.min(piece.length, offset + MAX_CHUNK_CHARACTERS - pending.length);
      if (end < piece.length && highSurrogate(piece.charCodeAt(end - 1)) && lowSurrogate(piece.charCodeAt(end))) end--;
      if (end === offset) {
        yield Buffer.from(pending, "utf8");
        pending = "";
        continue;
      }
      pending += piece.slice(offset, end);
      offset = end;
      if (pending.length === MAX_CHUNK_CHARACTERS) {
        yield Buffer.from(pending, "utf8");
        pending = "";
      }
    }
  }
  if (pending) yield Buffer.from(pending, "utf8");
}
