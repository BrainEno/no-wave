import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FontManifest } from "../lib/font-assets.ts";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Resolve the user's persistent local cache directory on this computer.
 *
 * This directory lives outside the git checkout (e.g. ~/.cache/no-wave-fonts
 * or %LOCALAPPDATA%/no-wave-fonts), so it survives branch switching, git pull,
 * git checkout, git clean, and fresh repository clones.
 */
export function resolveUserFontCacheDir(): string {
  const envOverride = process.env.NO_WAVE_FONT_CACHE?.trim();
  if (envOverride) return envOverride;

  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Caches", "no-wave-fonts");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, "no-wave-fonts");
    return join(home, ".cache", "no-wave-fonts");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, "no-wave-fonts");
  return join(home, ".cache", "no-wave-fonts");
}

/**
 * Return all font cache directories in priority order:
 * 1. User's machine-level persistent cache (~/.cache/no-wave-fonts).
 * 2. Repository-local cache (<repo>/.cache/font-subsets).
 */
export function resolveFontCacheDirectories(root: string): string[] {
  const userCache = resolveUserFontCacheDir();
  const repoCache = join(root, ".cache", "font-subsets");
  if (userCache === repoCache) return [userCache];
  return [userCache, repoCache];
}

/**
 * Compute a deterministic cache key for a font partition shard based on its
 * input source blob, style/weight, shard id, codepoints, and variation axis.
 */
export function computeShardKey(
  sourceBlob: string,
  weight: string,
  shardId: string,
  points: readonly number[],
  axis?: unknown,
): string {
  const sortedPoints = [...points].sort((a, b) => a - b).join(",");
  const axisStr = axis ? JSON.stringify(axis) : "";
  const content = `${sourceBlob}:${weight}:${shardId}:${axisStr}:${sortedPoints}`;
  return digest(content);
}

/**
 * Look up a cached WOFF2 shard by its deterministic shard key.
 */
export async function readCachedShard(
  shardKey: string,
  cacheDirs: readonly string[],
): Promise<Buffer | null> {
  for (const dir of cacheDirs) {
    const filePath = join(dir, "shards", `${shardKey}.woff2`);
    try {
      return await readFile(filePath);
    } catch {
      // not in this directory, continue
    }
  }
  return null;
}

/**
 * Look up a cached WOFF2 subset by its SHA-256 digest.
 */
export async function readCachedSubset(
  sha256: string,
  cacheDirs: readonly string[],
): Promise<Buffer | null> {
  for (const dir of cacheDirs) {
    const filePath = join(dir, "subsets", `${sha256}.woff2`);
    try {
      const bytes = await readFile(filePath);
      if (digest(bytes) === sha256) return bytes;
    } catch {
      // not in this directory, continue
    }
  }
  return null;
}

/**
 * Save a generated WOFF2 shard into local machine cache directories.
 */
export async function writeCachedShard(
  shardKey: string,
  sha256: string,
  bytes: Uint8Array,
  cacheDirs: readonly string[],
): Promise<void> {
  for (const dir of cacheDirs) {
    try {
      const shardDir = join(dir, "shards");
      const subsetDir = join(dir, "subsets");
      await mkdir(shardDir, { recursive: true });
      await mkdir(subsetDir, { recursive: true });
      await writeFile(join(shardDir, `${shardKey}.woff2`), bytes);
      await writeFile(join(subsetDir, `${sha256}.woff2`), bytes);
    } catch {
      // Best-effort cache write
    }
  }
}

/**
 * Look up a cached upstream raw font or license blob by SHA-256 digest.
 */
export async function readCachedSourceBlob(
  blob: string,
  expectedSha256: string,
  cacheDirs: readonly string[],
): Promise<Buffer | null> {
  for (const dir of cacheDirs) {
    const filePath = join(dir, "sources", `${blob}.bin`);
    try {
      const bytes = await readFile(filePath);
      if (bytes.length <= 32 * 1024 * 1024 && digest(bytes) === expectedSha256) {
        return bytes;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Save an upstream raw font or license blob into local machine cache directories.
 */
export async function writeCachedSourceBlob(
  blob: string,
  bytes: Uint8Array,
  cacheDirs: readonly string[],
): Promise<void> {
  for (const dir of cacheDirs) {
    try {
      const sourceDir = join(dir, "sources");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, `${blob}.bin`), bytes);
    } catch {
      // Best-effort
    }
  }
}

export type CacheRestoreResult = {
  restored: number;
  alreadyPresent: number;
  missing: number;
};

/**
 * Fast bundle restoration: if font faces are missing from the target directory,
 * copy them directly from the local computer cache if their exact SHA-256 matches.
 */
export async function restoreBundleFromCache(
  manifest: FontManifest,
  targetDir: string,
  cacheDirs: readonly string[],
): Promise<CacheRestoreResult> {
  await mkdir(targetDir, { recursive: true });
  let restored = 0;
  let alreadyPresent = 0;
  let missing = 0;

  for (const face of manifest.faces) {
    const targetFile = join(targetDir, face.file);
    try {
      const info = await stat(targetFile);
      if (info.size === face.byteLength) {
        alreadyPresent += 1;
        continue;
      }
    } catch {
      // Missing or wrong size, attempt restoration
    }

    let found = false;
    for (const dir of cacheDirs) {
      const cachedFile = join(dir, "subsets", `${face.sha256}.woff2`);
      try {
        const info = await stat(cachedFile);
        if (info.size === face.byteLength) {
          await copyFile(cachedFile, targetFile);
          restored += 1;
          found = true;
          break;
        }
      } catch {
        // try next cache dir
      }
    }

    if (!found) {
      missing += 1;
    }
  }

  return { restored, alreadyPresent, missing };
}

/**
 * Archive all verified files from target directory into the local computer cache
 * so any future clean checkouts can restore them in sub-second time.
 */
export async function archiveTargetToCache(
  manifest: FontManifest,
  targetDir: string,
  cacheDirs: readonly string[],
): Promise<number> {
  let archived = 0;
  for (const face of manifest.faces) {
    const targetFile = join(targetDir, face.file);
    try {
      const info = await stat(targetFile);
      if (info.size !== face.byteLength) continue;
    } catch {
      continue;
    }

    for (const dir of cacheDirs) {
      const cachedFile = join(dir, "subsets", `${face.sha256}.woff2`);
      try {
        const info = await stat(cachedFile);
        if (info.size === face.byteLength) continue;
      } catch {
        // Missing in this cache dir, copy it over
      }
      try {
        const subsetDir = join(dir, "subsets");
        await mkdir(subsetDir, { recursive: true });
        await copyFile(targetFile, cachedFile);
        archived += 1;
      } catch {
        // Best-effort
      }
    }
  }
  return archived;
}

/**
 * Clear all local font cache directories.
 */
export async function clearFontCache(cacheDirs: readonly string[]): Promise<void> {
  for (const dir of cacheDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}
