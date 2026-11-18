import type { GlobApi, GlobMatcher, GlobOptions, GlobPredicate, GlobResult, GlobState, ScanOptions, ScanResult } from "./types.ts";

const { Minimatch } = require("minimatch") as typeof import("minimatch");
const { Matcher } = require("@isaacs/nonrecursive-glob-match") as typeof import("@isaacs/nonrecursive-glob-match");

class ToolMinimatch extends Minimatch {
  override parse(pattern: string): ReturnType<InstanceType<typeof Minimatch>["parse"]> {
    validateClassConstruction(pattern);
    const compiled = super.parse(pattern);
    // Preserve the existing leading-negated-extglob dot behavior per segment,
    // without allowing globstars to traverse hidden parent directories.
    return compiled instanceof Matcher && !this.options.dot && compiled.pattern.startsWith("!(")
      ? new Matcher(compiled.pattern, { ...compiled.options, dot: true })
      : compiled;
  }
}
const { scan } = require("./scan.ts") as { scan(input: string, options?: ScanOptions): ScanResult };
const utils = require("./utils.ts") as {
  isWindows(options?: GlobOptions): boolean;
  toPosixSlashes(input: string): string;
  basename(input: string, options?: GlobOptions): string;
};

const MAX_PATTERN_LENGTH = 65_536;
const MAX_CONTAINS_INPUT = 512;
const CONTAINS_WORK_BUDGET = 1_000_000;
const CLASS_CONSTRUCTION_BUDGET = 1_000_000;

function validateClassConstruction(input: string): void {
  // The NFA does not backtrack, but parsing an unclosed class can rescan the
  // remaining suffix at each '['. Bound that conservative cost before parsing,
  // including for brace-expanded portions. Escaped brackets cannot start a class.
  let budget = CLASS_CONSTRUCTION_BUDGET;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input[i] === "[") budget -= input.length - i;
    if (budget < 0) throw new RangeError("Glob character-class construction exceeds its work budget");
  }
}

function validateOptions(options: GlobOptions): void {
  if (options.capture || options.regex || options.bash || options.prepend || options.expandRange) {
    throw new TypeError("The non-recursive glob adapter does not support regex source, captures, bash mode, or custom range compilers");
  }
  if (options.flags && options.flags !== "i") throw new TypeError("Only the i glob matching flag is supported");
  if (options.maxLength !== undefined && (!Number.isSafeInteger(options.maxLength) || options.maxLength < 1)) {
    throw new RangeError("Glob maxLength must be a positive safe integer");
  }
}

function validatePattern(input: string, options: GlobOptions): void {
  if (typeof input !== "string" || input === "") throw new TypeError("Expected pattern to be a non-empty string");
  if (input.length > Math.min(options.maxLength ?? MAX_PATTERN_LENGTH, MAX_PATTERN_LENGTH)) {
    throw new RangeError("Glob pattern exceeds its character budget");
  }
  validateClassConstruction(input);
}

function stripDotPrefix(input: string): string {
  let i = 0;
  while (input.slice(i, i + 2) === "./") i += 2;
  return input.slice(i);
}

function patternState(input: string, options: GlobOptions): GlobState {
  validateOptions(options);
  validatePattern(input, options);
  let i = 0;
  if (!options.nonegate) while (input[i] === "!" && input[i + 1] !== "(") i++;
  const metadata = scan(input, { tokens: true, nonegate: options.nonegate, noext: options.noext || options.noextglob });
  return {
    engine: "minimatch@11.0.9", input, negated: i % 2 === 1,
    negatedExtglob: metadata.negatedExtglob, tokens: metadata.tokens ?? [],
  };
}

function formatted(input: string, options: GlobOptions): string {
  if (typeof input !== "string") throw new TypeError("Expected input to be a string");
  const output = options.format ? options.format(input) : utils.isWindows(options) ? utils.toPosixSlashes(input) : input;
  if (typeof output !== "string") throw new TypeError("Glob format must return a string");
  return output;
}

function matchArray(input: string): RegExpExecArray {
  const result = [input] as RegExpExecArray;
  result.index = 0;
  result.input = input;
  result.groups = undefined;
  return result;
}

/**
 * This deliberately is NOT a RegExp. Both test() and exec() use minimatch 11's
 * non-recursive state machine. Serializing a fictitious regex source would
 * accidentally reintroduce backtracking in a downstream/native consumer.
 */
class NonRecursivePredicate implements GlobPredicate {
  readonly flags: string;
  state?: GlobState;
  readonly #state: GlobState;
  readonly #options: GlobOptions;
  readonly #matcher: InstanceType<typeof Minimatch>;
  readonly #pattern: string;

  constructor(state: GlobState, options: GlobOptions) {
    this.#state = state;
    this.#options = options;
    let index = 0;
    if (!options.nonegate) while (state.input[index] === "!" && state.input[index + 1] !== "(") index++;
    this.#pattern = stripDotPrefix(state.input.slice(index));
    this.flags = options.flags ?? (options.nocase ? "i" : "");
    this.#matcher = new ToolMinimatch(this.#pattern, {
      nonegate: true,
      nocomment: true,
      dot: options.dot,
      nocase: options.flags ? options.flags.includes("i") : options.nocase,
      nobrace: options.nobrace,
      noglobstar: options.noglobstar,
      noext: options.noext || options.noextglob,
      matchBase: options.matchBase || options.basename,
      platform: utils.isWindows(options) ? "win32" : "linux",
      // Do not normalize away literal ../ or collapse path separators. A glob
      // filter must not silently change the path being authorized/discovered.
      optimizationLevel: 0,
      preserveMultipleSlashes: true,
      braceExpandMax: 1_000,
    });
  }

  get source(): never {
    throw new TypeError("Non-recursive glob predicates cannot be serialized as RegExp; use test() or exec()");
  }

  matches(output: string): boolean {
    if (output === "") return false;
    const candidate = this.#options.matchBase || this.#options.basename ? utils.basename(output, this.#options) : output;
    let matched = false;
    if (this.#options.contains) {
      if (candidate.length > MAX_CONTAINS_INPUT) throw new RangeError("Glob contains input exceeds its bounded search budget");
      let budget = CONTAINS_WORK_BUDGET;
      search: for (let start = 0; start <= candidate.length; start++) {
        for (let end = start; end <= candidate.length; end++) {
          budget -= Math.max(1, this.#pattern.length) * Math.max(1, end - start) * this.#matcher.globSet.length;
          if (budget < 0) throw new RangeError("Glob contains search exceeded its work budget");
          if (this.#matcher.match(candidate.slice(start, end))) { matched = true; break search; }
        }
      }
    } else if (!(this.#options.strictSlashes && candidate.endsWith("/") !== this.#pattern.endsWith("/")) &&
        !(candidate.endsWith("/") && !this.#pattern.endsWith("/") && !this.#matcher.hasMagic())) {
      matched = this.#matcher.match(candidate);
      // Picomatch permits the directory itself for a trailing globstar, which
      // is also needed by the two directory walkers' pruning predicates.
      if (!matched && !this.#options.noglobstar && this.#pattern.endsWith("/**") && !candidate.endsWith("/")) {
        matched = this.#matcher.match(`${candidate}/`);
      }
    }
    return this.#state.negated ? !matched : matched;
  }

  test(input: string): boolean { return this.matches(formatted(input, this.#options)); }

  exec(input: string): RegExpExecArray | null {
    const output = formatted(input, this.#options);
    return this.matches(output) ? matchArray(output) : null;
  }

  toString(): never { throw new TypeError("Non-recursive glob predicates cannot be serialized as RegExp"); }
}

function makeRe(input: string, options: GlobOptions | null = {}, returnOutput = false, returnState = false): GlobPredicate {
  if (returnOutput) throw new TypeError("Non-recursive glob predicates cannot be serialized as RegExp");
  const opts = options ?? {};
  const state = patternState(input, opts);
  const predicate = new NonRecursivePredicate(state, opts);
  if (returnState) predicate.state = state;
  return predicate;
}

function createMatcher(glob: string | string[] | GlobState, options: GlobOptions | null = {}, returnState = false): GlobMatcher {
  const opts = options ?? {};
  if (Array.isArray(glob)) {
    if (glob.some(pattern => typeof pattern !== "string")) throw new TypeError("Expected an array of string glob patterns");
    const matchers = glob.map(pattern => createMatcher(pattern, opts, returnState));
    // Array form is used by Vite, fdir and tinyglobby only as a boolean union.
    return ((input: string) => {
      if (typeof input !== "string") throw new TypeError("Expected input to be a string");
      return matchers.some(matcher => matcher(input));
    }) as GlobMatcher;
  }
  const input = typeof glob === "string" ? glob : glob?.input;
  const state = patternState(input, opts);
  const predicate = new NonRecursivePredicate(state, opts);
  const ignored = opts.ignore ? createMatcher(opts.ignore, { ...opts, ignore: null, onMatch: null, onResult: null, onIgnore: null }) : () => false;
  const matcher = ((value: string, returnObject = false): boolean | GlobResult => {
    const output = formatted(value, opts);
    const matches = predicate.matches(output);
    const result: GlobResult = {
      glob, state, regex: predicate, posix: utils.isWindows(opts), input: value, output,
      match: matches ? matchArray(output) : null, isMatch: matches,
    };
    opts.onResult?.(result);
    if (matches && ignored(value)) {
      opts.onIgnore?.(result);
      result.isMatch = false;
    } else if (matches) opts.onMatch?.(result);
    return returnObject ? result : result.isMatch;
  }) as GlobMatcher;
  if (returnState) matcher.state = state;
  return matcher;
}

const api: GlobApi = Object.assign(createMatcher, {
  makeRe,
  scan,
  parse: (input: string, options: GlobOptions = {}): GlobState => patternState(input, options),
  compileRe: (state: GlobState, options: GlobOptions = {}, returnOutput = false, returnState = false) => makeRe(state.input, options, returnOutput, returnState),
  isMatch: (input: string, patterns: string | string[], options?: GlobOptions): boolean => createMatcher(patterns, options)(input),
  matchBase: (input: string, pattern: string | GlobPredicate | RegExp, options: GlobOptions = {}): boolean => {
    const predicate = typeof pattern === "string" ? makeRe(pattern, options) : pattern;
    return predicate.test(utils.basename(input, options));
  },
  test: (input: string, predicate: GlobPredicate, options: GlobOptions = {}) => {
    const output = formatted(input, options);
    const match = predicate instanceof NonRecursivePredicate
      ? predicate.matches(output) ? matchArray(output) : null
      : predicate.exec(output);
    return { output, match, isMatch: match !== null };
  },
});

// A CommonJS callable is required by the existing precompiled tool consumers.
// The implementation remains TypeScript and is loaded from its workspace path
// by Node 24, not stripped from an opaque third-party node_modules artifact.
module.exports = api;
