import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

/** A file URL must encode spaces, # and %. Constructing `file://${argv}` is
 * neither a portable Windows path nor a safe comparison with import.meta.url. */
export function isMainModule(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry || entry.startsWith("-")) return false;
  try {
    const windows = /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith("\\\\");
    const absolute = windows ? win32.resolve(entry) : resolve(entry);
    return new URL(moduleUrl).href === pathToFileURL(absolute, { windows }).href;
  } catch { return false; }
}
