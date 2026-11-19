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
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  MonitorFault,
  type MonitorConfig,
  type MonitorFaultCode,
  type MonitorState,
} from "../application/operational-monitor.ts";
import { parseMonitorState } from "../application/operational-monitor-state.ts";
import { reconfigureMonitor } from "../application/operational-monitor-configure.ts";
import { parseMonitorConfig } from "./monitor-config.ts";

export const MONITOR_STATE_MAX_BYTES = 4 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function ownedFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}
function statePath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
    throw new MonitorFault("state_io");
  const path = resolve(value);
  if (basename(path).length > 128) throw new MonitorFault("state_io");
  return path;
}
function privateParent(path: string): void {
  try {
    const parent = dirname(path),
      stat = lstatSync(parent);
    // The lock/rename/fsync contract is deliberately local POSIX, not an
    // untested promise about Windows ACLs, network filesystems or symlinks.
    if (
      process.platform === "win32" ||
      !NOFOLLOW ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(parent) !== parent ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new MonitorFault("state_io");
    }
  } catch {
    throw new MonitorFault("state_io");
  }
}

function readBytes(
  path: string,
  maximum: number,
  code: MonitorFaultCode,
  privateFile: boolean,
  optional = false,
): Buffer | null {
  let descriptor: number;
  try {
    // Opening a FIFO before fstat would block forever waiting for its writer.
    // Nonblocking has no effect on regular files; fstat below still rejects
    // devices, directories, sockets, pipes and symlinks/raced replacements.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW);
  } catch (error) {
    if (optional && missing(error)) return null;
    throw new MonitorFault(code === "config_invalid" ? code : "state_io");
  }
  try {
    const stat = fstatSync(descriptor);
    const unsafe = !ownedFile(stat) || (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0;
    if (unsafe) throw new MonitorFault(code === "config_invalid" ? code : "state_io");
    if (stat.size < 1 || stat.size > maximum) throw new MonitorFault(code);
    // A size check followed by readFile would still allocate an unbounded file
    // if a writer grew it between calls. Read at most the cap plus one byte.
    const buffer = Buffer.allocUnsafe(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const received = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (received === 0) break;
      length += received;
    }
    if (length === 0 || length > maximum) throw new MonitorFault(code);
    return Buffer.from(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof MonitorFault) throw error;
    throw new MonitorFault(code === "config_invalid" ? code : "state_io");
  } finally {
    closeSync(descriptor);
  }
}
function jsonValue(bytes: Buffer, code: MonitorFaultCode): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new MonitorFault(code);
  }
}
export function readMonitorConfigFile(path: string): MonitorConfig {
  const bytes = readBytes(path, 65_536, "config_invalid", false)!;
  return parseMonitorConfig(jsonValue(bytes, "config_invalid"));
}
export function readMonitorJournal(value: string, config: MonitorConfig): MonitorState | null {
  const path = statePath(value);
  privateParent(path);
  const bytes = readBytes(path, MONITOR_STATE_MAX_BYTES, "state_invalid", true, true);
  return bytes === null ? null : parseMonitorState(jsonValue(bytes, "state_invalid"), config);
}

/** A private local journal serializes check/ack across independent commands.
 * Never steals a lock: a crash needs an operator to inspect the owning process
 * before removing the stale lock. Atomic state precedes any event output. */
export function openMonitorJournal(value: string, config: MonitorConfig) {
  const path = statePath(value);
  privateParent(path);
  const lockPath = path + ".lock";
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      throw new MonitorFault("state_locked");
    throw new MonitorFault("state_io");
  }
  const identity = fstatSync(descriptor);
  let closed = false;
  let current: MonitorState | null = null;
  let currentHash: string | null = null;
  let activeConfig = config;
  const ownsLock = () => {
    try {
      const stat = lstatSync(lockPath);
      return ownedFile(stat) && stat.dev === identity.dev && stat.ino === identity.ino;
    } catch {
      return false;
    }
  };
  function close(): void {
    if (closed) return;
    closed = true;
    try {
      if (!ownsLock()) throw new MonitorFault("state_io");
      unlinkSync(lockPath);
    } catch {
      throw new MonitorFault("state_io");
    } finally {
      closeSync(descriptor);
    }
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }) + "\n");
    fsyncSync(descriptor);
    const bytes = readBytes(path, MONITOR_STATE_MAX_BYTES, "state_invalid", true, true);
    if (bytes) {
      current = parseMonitorState(jsonValue(bytes, "state_invalid"), config);
      currentHash = hash(bytes);
    }
  } catch (error) {
    try {
      close();
    } catch {
      /* preserve the primary failure, never unlink a foreign lock */
    }
    if (error instanceof MonitorFault) throw error;
    throw new MonitorFault("state_io");
  }

  function persist(value: unknown, nextConfig: MonitorConfig): void {
    if (closed || !ownsLock()) throw new MonitorFault("state_io");
    privateParent(path);
    const next = parseMonitorState(value, nextConfig);
    const text = JSON.stringify(next) + "\n";
    const present = readBytes(path, MONITOR_STATE_MAX_BYTES, "state_invalid", true, true);
    if ((present === null ? null : hash(present)) !== currentHash) throw new MonitorFault("state_io");
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    if (
      next.revision !== (current?.revision ?? 0) + 1 ||
      next.lastEvaluatedAt === null ||
      (current?.lastEvaluatedAt !== null &&
        current?.lastEvaluatedAt !== undefined &&
        next.lastEvaluatedAt < current.lastEvaluatedAt)
    ) {
      throw new MonitorFault("state_invalid");
    }
    if (Buffer.byteLength(text) > MONITOR_STATE_MAX_BYTES) throw new MonitorFault("state_full");
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let temporaryExists = false;
    let output: number | null = null;
    let directory: number | null = null;
    try {
      output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      temporaryExists = true;
      writeFileSync(output, text);
      fsyncSync(output);
      closeSync(output);
      output = null;
      if (!ownsLock()) throw new MonitorFault("state_io");
      renameSync(temporary, path);
      temporaryExists = false;
      directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
      fsyncSync(directory);
      current = next;
      currentHash = hash(Buffer.from(text));
    } catch {
      throw new MonitorFault("state_io");
    } finally {
      if (output !== null) closeSync(output);
      if (directory !== null) closeSync(directory);
      if (temporaryExists) {
        try {
          unlinkSync(temporary);
        } catch {
          /* report the failed transaction, not its filename */
        }
      }
    }
  }
  function commit(value: unknown): void {
    persist(value, activeConfig);
  }
  function reconfigure(nextConfig: MonitorConfig, now: number) {
    if (current === null) throw new MonitorFault("state_missing");
    const result = reconfigureMonitor(activeConfig, nextConfig, current, now);
    persist(result.state, nextConfig);
    activeConfig = nextConfig;
    return result;
  }
  return Object.freeze({
    get state() {
      return current === null ? null : parseMonitorState(current, activeConfig);
    },
    commit,
    reconfigure,
    close,
  });
}
