import type { GlobOptions } from "./types.ts";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isWindows = (options?: GlobOptions): boolean => options?.windows ?? process.platform === "win32";
const toPosixSlashes = (input: string): string => input.replace(/\\/g, "/");
const removeBackslashes = (input: string): string => input.replace(/\\(.)/gs, "$1");
const escapeRegex = (input: string): string => input.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
const basename = (input: string, options?: GlobOptions): string => {
  const parts = (isWindows(options) ? toPosixSlashes(input) : input).split("/");
  return parts.at(-1) || parts.at(-2) || "";
};

// Micromatch uses these path/result utilities, not a pattern compiler. No glob
// is interpolated into RegExp here; the regular expressions have fixed source.
module.exports = { isObject, isWindows, toPosixSlashes, removeBackslashes, escapeRegex, basename };
