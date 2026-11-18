export type GlobOptions = {
  dot?: boolean;
  nocase?: boolean;
  nobrace?: boolean;
  noglobstar?: boolean;
  noext?: boolean;
  noextglob?: boolean;
  nonegate?: boolean;
  matchBase?: boolean;
  basename?: boolean;
  windows?: boolean;
  strictSlashes?: boolean;
  contains?: boolean;
  ignore?: string | string[] | null;
  format?: ((input: string) => string) | null;
  flags?: string;
  maxLength?: number;
  capture?: boolean;
  regex?: boolean;
  bash?: boolean;
  prepend?: string;
  expandRange?: unknown;
  fastpaths?: boolean;
  posix?: boolean;
  onResult?: ((result: GlobResult) => void) | null;
  onMatch?: ((result: GlobResult) => void) | null;
  onIgnore?: ((result: GlobResult) => void) | null;
};

export type ScanOptions = {
  parts?: boolean;
  tokens?: boolean;
  scanToEnd?: boolean;
  nonegate?: boolean;
  noext?: boolean;
  noparen?: boolean;
  unescape?: boolean;
};

export type ScanToken = {
  value: string;
  depth: number;
  isGlob: boolean;
  isGlobstar?: boolean;
  isBrace?: boolean;
  isBracket?: boolean;
  isExtglob?: boolean;
  backslashes?: boolean;
};

export type ScanResult = {
  prefix: string;
  input: string;
  start: number;
  base: string;
  glob: string;
  isBrace: boolean;
  isBracket: boolean;
  isGlob: boolean;
  isExtglob: boolean;
  isGlobstar: boolean;
  negated: boolean;
  negatedExtglob: boolean;
  parts?: string[];
  slashes?: number[];
  tokens?: ScanToken[];
  maxDepth?: number;
};

export type GlobState = {
  engine: "minimatch@11.0.9";
  input: string;
  negated: boolean;
  negatedExtglob: boolean;
  tokens: ScanToken[];
};

export type GlobPredicate = {
  readonly source: never;
  readonly flags: string;
  state?: GlobState;
  test(input: string): boolean;
  exec(input: string): RegExpExecArray | null;
};

export type GlobResult = {
  glob: string | GlobState;
  state: GlobState;
  regex: GlobPredicate;
  posix: boolean;
  input: string;
  output: string;
  match: RegExpExecArray | null;
  isMatch: boolean;
};

export type GlobMatcher = {
  (input: string, returnObject?: false): boolean;
  (input: string, returnObject: true): GlobResult;
  state?: GlobState;
};

export type GlobApi = {
  (pattern: string | string[] | GlobState, options?: GlobOptions | null, returnState?: boolean): GlobMatcher;
  isMatch(input: string, pattern: string | string[], options?: GlobOptions): boolean;
  makeRe(pattern: string, options?: GlobOptions | null, returnOutput?: boolean, returnState?: boolean): GlobPredicate;
  scan(input: string, options?: ScanOptions): ScanResult;
  parse(input: string, options?: GlobOptions): GlobState;
  compileRe(state: GlobState, options?: GlobOptions, returnOutput?: boolean, returnState?: boolean): GlobPredicate;
  matchBase(input: string, pattern: string | GlobPredicate | RegExp, options?: GlobOptions): boolean;
  test(input: string, predicate: GlobPredicate, options?: GlobOptions): { isMatch: boolean; match: RegExpExecArray | null; output: string };
};
