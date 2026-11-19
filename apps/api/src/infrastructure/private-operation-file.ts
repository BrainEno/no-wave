import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  linkSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class PrivateOperationFault extends Error {
  readonly code:
    | "state_io"
    | "state_invalid"
    | "state_locked"
    | "state_full"
    | "artifact_conflict";
  constructor(code: PrivateOperationFault["code"]) {
    super(code);
    this.name = "PrivateOperationFault";
    this.code = code;
  }
}
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
function exists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
function ownedFile(stat: Stats): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1 &&
    (typeof process.getuid !== "function" || stat.uid === process.getuid())
  );
}
export function privateOperationPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new PrivateOperationFault("state_io");
  const path = resolve(value);
  if (basename(path).length > 128) throw new PrivateOperationFault("state_io");
  return path;
}
export function assertPrivateOperationParent(path: string): void {
  try {
    const parent = dirname(path),
      stat = lstatSync(parent);
    if (
      process.platform === "win32" ||
      !NOFOLLOW ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(parent) !== parent ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new PrivateOperationFault("state_io");
  } catch {
    throw new PrivateOperationFault("state_io");
  }
}
/** Open nonblocking before fstat: a FIFO must not hang the finite command.
 * This is a local POSIX contract, not Windows ACL/NFS or a same-UID MAC. */
export function readPrivateOperationFile(
  path: string,
  options: { maximum: number; privateFile: boolean; optional?: boolean },
): Buffer | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW,
    );
  } catch (error) {
    if (options.optional && missing(error)) return null;
    throw new PrivateOperationFault("state_io");
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !ownedFile(stat) ||
      (stat.mode & (options.privateFile ? 0o077 : 0o022)) !== 0
    )
      throw new PrivateOperationFault("state_io");
    if (stat.size < 1 || stat.size > options.maximum)
      throw new PrivateOperationFault("state_invalid");
    const buffer = Buffer.allocUnsafe(options.maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const received = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (received === 0) break;
      length += received;
    }
    if (length === 0 || length > options.maximum)
      throw new PrivateOperationFault("state_invalid");
    return Buffer.from(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof PrivateOperationFault) throw error;
    throw new PrivateOperationFault("state_io");
  } finally {
    closeSync(descriptor);
  }
}
function jsonValue(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PrivateOperationFault("state_invalid");
  }
}
export function readPrivateOperationSnapshot(
  pathValue: string,
  maximum: number,
): { value: unknown } | null {
  const path = privateOperationPath(pathValue);
  assertPrivateOperationParent(path);
  const bytes = readPrivateOperationFile(path, {
    maximum,
    privateFile: true,
    optional: true,
  });
  return bytes === null ? null : { value: jsonValue(bytes) };
}

/** Shared monitor/handoff primitive. Semantic parsers and revision policy stay
 * with their owners. Never steal a lock or overwrite externally changed state. */
export function openPrivateOperationJournal<T>(
  pathValue: string,
  options: {
    maximum: number;
    parse: (value: unknown) => T;
    revision: (value: T) => number;
  },
) {
  const path = privateOperationPath(pathValue);
  assertPrivateOperationParent(path);
  const lockPath = path + ".lock";
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new PrivateOperationFault(
      exists(error) ? "state_locked" : "state_io",
    );
  }
  const identity = fstatSync(descriptor);
  let closed = false,
    current: T | null = null,
    currentHash: string | null = null;
  let parser = options.parse;
  const ownsLock = () => {
    try {
      const stat = lstatSync(lockPath);
      return (
        ownedFile(stat) &&
        stat.dev === identity.dev &&
        stat.ino === identity.ino
      );
    } catch {
      return false;
    }
  };
  function close(): void {
    if (closed) return;
    closed = true;
    try {
      if (!ownsLock()) throw new PrivateOperationFault("state_io");
      unlinkSync(lockPath);
    } catch {
      throw new PrivateOperationFault("state_io");
    } finally {
      closeSync(descriptor);
    }
  }
  try {
    writeFileSync(
      descriptor,
      JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }) +
        "\n",
    );
    fsyncSync(descriptor);
    const bytes = readPrivateOperationFile(path, {
      maximum: options.maximum,
      privateFile: true,
      optional: true,
    });
    if (bytes) {
      current = parser(jsonValue(bytes));
      currentHash = hash(bytes);
    }
  } catch (error) {
    try {
      close();
    } catch {
      /* never unlink a foreign lock */
    }
    throw error;
  }
  function commit(value: unknown, nextParser = parser): void {
    if (closed || !ownsLock()) throw new PrivateOperationFault("state_io");
    assertPrivateOperationParent(path);
    const next = nextParser(value),
      text = JSON.stringify(next) + "\n";
    const present = readPrivateOperationFile(path, {
      maximum: options.maximum,
      privateFile: true,
      optional: true,
    });
    if ((present === null ? null : hash(present)) !== currentHash)
      throw new PrivateOperationFault("state_io");
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    if (
      options.revision(next) !==
      (current === null ? 0 : options.revision(current)) + 1
    )
      throw new PrivateOperationFault("state_invalid");
    if (Buffer.byteLength(text) > options.maximum)
      throw new PrivateOperationFault("state_full");
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${randomUUID()}.tmp`,
    );
    let temporaryExists = false,
      output: number | null = null,
      directory: number | null = null;
    try {
      output = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      writeFileSync(output, text);
      fsyncSync(output);
      closeSync(output);
      output = null;
      if (!ownsLock()) throw new PrivateOperationFault("state_io");
      renameSync(temporary, path);
      temporaryExists = false;
      directory = openSync(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW,
      );
      fsyncSync(directory);
      current = next;
      currentHash = hash(Buffer.from(text));
      parser = nextParser;
    } catch {
      throw new PrivateOperationFault("state_io");
    } finally {
      if (output !== null) closeSync(output);
      if (directory !== null) closeSync(directory);
      if (temporaryExists) {
        try {
          unlinkSync(temporary);
        } catch {
          /* preserve transaction failure */
        }
      }
    }
  }
  return Object.freeze({
    get state() {
      return current === null ? null : parser(current);
    },
    commit,
    close,
  });
}

/** A previous publication may have failed after linking but before directory
 * fsync. An identical retry must finish durability, not merely compare bytes. */
function synchronizeExistingArtifact(path: string, expected: Buffer): void {
  let file: number | null = null,
    directory: number | null = null;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW);
    const identity = fstatSync(file);
    if (
      !ownedFile(identity) ||
      (identity.mode & 0o077) !== 0 ||
      identity.size !== expected.length
    )
      throw new PrivateOperationFault("state_io");
    const observed = Buffer.alloc(expected.length + 1);
    let length = 0;
    while (length < observed.length) {
      const received = readSync(
        file,
        observed,
        length,
        observed.length - length,
        null,
      );
      if (received === 0) break;
      length += received;
    }
    if (!observed.subarray(0, length).equals(expected))
      throw new PrivateOperationFault("artifact_conflict");
    fsyncSync(file);
    assertPrivateOperationParent(path);
    const current = lstatSync(path);
    if (
      !ownedFile(current) ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new PrivateOperationFault("state_io");
    directory = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW,
    );
    fsyncSync(directory);
  } catch (error) {
    if (error instanceof PrivateOperationFault) throw error;
    throw new PrivateOperationFault("state_io");
  } finally {
    if (file !== null) closeSync(file);
    if (directory !== null) closeSync(directory);
  }
}

/** Publish a signed artifact without ever replacing a different file. link()
 * is an atomic no-replace publication on the same local filesystem; both file
 * and directory are synced before success. A retry accepts exact bytes only. */
export function writePrivateOperationArtifact(
  pathValue: string,
  bytes: Buffer,
  maximum: number,
): boolean {
  const path = privateOperationPath(pathValue);
  assertPrivateOperationParent(path);
  if (bytes.length < 1 || bytes.length > maximum)
    throw new PrivateOperationFault("state_full");
  const existing = readPrivateOperationFile(path, {
    maximum,
    privateFile: true,
    optional: true,
  });
  if (existing !== null) {
    if (!existing.equals(bytes))
      throw new PrivateOperationFault("artifact_conflict");
    synchronizeExistingArtifact(path, bytes);
    return false;
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let output: number | null = null,
    directory: number | null = null,
    temporaryExists = false;
  try {
    output = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    writeFileSync(output, bytes);
    fsyncSync(output);
    closeSync(output);
    output = null;
    assertPrivateOperationParent(path);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!exists(error)) throw error;
      const raced = readPrivateOperationFile(path, {
        maximum,
        privateFile: true,
      });
      if (!raced?.equals(bytes))
        throw new PrivateOperationFault("artifact_conflict");
      synchronizeExistingArtifact(path, bytes);
      return false;
    }
    // Remove the temporary hard link before exposing the one-link artifact.
    unlinkSync(temporary);
    temporaryExists = false;
    directory = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW,
    );
    fsyncSync(directory);
    return true;
  } catch (error) {
    if (error instanceof PrivateOperationFault) throw error;
    throw new PrivateOperationFault("state_io");
  } finally {
    if (output !== null) closeSync(output);
    if (directory !== null) closeSync(directory);
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch {
        /* preserve failure, don't replace destination */
      }
    }
  }
}
