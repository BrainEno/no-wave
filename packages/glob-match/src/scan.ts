import type { ScanOptions, ScanResult, ScanToken } from "./types.ts";

const MAX_PATTERN_LENGTH = 65_536;

/** Metadata only: no pattern-to-RegExp compiler, evaluation, or expansion. */
function scan(input: string, options: ScanOptions = {}): ScanResult {
  if (typeof input !== "string") throw new TypeError("Expected pattern to be a string");
  if (input.length > MAX_PATTERN_LENGTH) throw new RangeError("Glob pattern exceeds 65536 characters");
  let start = 0;
  if (!options.nonegate) while (input[start] === "!" && input[start + 1] !== "(") start++;
  const negated = start > 0;
  while (input.slice(start, start + 2) === "./") start += 2;
  const prefix = input.slice(0, start);
  const parts: string[] = [];
  const slashes: number[] = [];
  const tokens: ScanToken[] = [];
  const groups: string[] = [];
  let braceDepth = 0;
  let token: ScanToken = { value: "", depth: 1, isGlob: false };
  let partStart = start;
  let firstGlobPart = -1;
  let isBrace = false;
  let isBracket = false;
  let isExtglob = false;
  let isGlobstar = false;
  let isGlob = false;

  const markGlob = () => {
    token.isGlob = isGlob = true;
    if (firstGlobPart < 0) firstGlobPart = partStart;
  };
  const finish = (end: number) => {
    token.value = input.slice(partStart, end);
    token.depth = token.isGlobstar ? Infinity : 1;
    parts.push(token.value);
    tokens.push(token);
    token = { value: "", depth: 1, isGlob: false };
    partStart = end + 1;
  };

  // Bracket endpoints are found once. Repeated unmatched '[' must not turn a
  // metadata scan into repeated suffix searches on an adversarial pattern.
  const bracketEnds = new Map<number, number>();
  let openBracket = -1;
  for (let i = start; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input[i] === "[" && openBracket < 0) openBracket = i;
    else if (input[i] === "]" && openBracket >= 0) {
      bracketEnds.set(openBracket, i);
      openBracket = -1;
    }
  }

  for (let i = start; i < input.length; i++) {
    const char = input[i]!;
    if (char === "\\") { token.backslashes = true; i++; continue; }
    if (char === "[") {
      const end = bracketEnds.get(i);
      if (end !== undefined) {
        isBracket = token.isBracket = true;
        markGlob();
        i = end;
        continue;
      }
    }
    if (char === "{") {
      groups.push(char);
      braceDepth++;
      isBrace = token.isBrace = true;
      continue;
    }
    if (char === "}" && groups.at(-1) === "{") { groups.pop(); braceDepth--; continue; }
    if (braceDepth > 0 && (char === "," || (char === "." && input[i + 1] === "."))) markGlob();
    if (!options.noext && "+@*?!".includes(char) && input[i + 1] === "(") {
      isExtglob = token.isExtglob = true;
      markGlob();
      groups.push("(");
      i++;
      continue;
    }
    if (char === "(" && !options.noparen) { groups.push("("); markGlob(); continue; }
    if (char === ")" && groups.at(-1) === "(") { groups.pop(); continue; }
    if (char === "*" || char === "?") {
      markGlob();
      if (char === "*" && input[i + 1] === "*") isGlobstar = token.isGlobstar = true;
    }
    if (char === "/" && groups.length === 0) {
      slashes.push(i);
      finish(i);
    }
  }
  finish(input.length);
  let base = firstGlobPart < 0 ? input.slice(start) : input.slice(start, firstGlobPart);
  let glob = firstGlobPart < 0 ? "" : input.slice(firstGlobPart);
  if (firstGlobPart >= 0 && base.length > 1 && base.endsWith("/")) base = base.slice(0, -1);
  if (options.unescape) {
    base = base.replace(/\\(.)/gs, "$1");
    glob = glob.replace(/\\(.)/gs, "$1");
  }
  const result: ScanResult = {
    prefix, input, start, base, glob, isBrace, isBracket, isGlob, isExtglob, isGlobstar,
    negated, negatedExtglob: !options.noext && input.slice(start, start + 2) === "!(",
  };
  if (options.parts || options.tokens) {
    result.parts = parts;
    result.slashes = slashes;
  }
  if (options.tokens) {
    result.tokens = tokens;
    result.maxDepth = tokens.reduce((depth, item) => depth + item.depth, 0);
  }
  return result;
}

module.exports = { scan };
