// Real `RunLock`: flock(2) of the libc through `bun:ffi` (spec § Verrou).
//
// `open(2)` with `O_CLOEXEC`, which `node:fs` of Bun does not set: no exec
// path hands the lock to nix or ssh, it dies with this process only.

import { dlopen, FFIType, read } from "bun:ffi";
import { ftruncateSync, mkdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { LockAttempt, LockHolder, RunLock } from "../engine/ports.ts";

// Linux, asm-generic values: x86_64 and aarch64 alike.
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_CLOEXEC = 0o2000000;
const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = 11;

function openLibc() {
  return dlopen("libc.so.6", {
    open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;
}

let loaded: ReturnType<typeof openLibc> | undefined;

/** Loaded on first use: importing the module has no side effect. */
function libc() {
  loaded ??= openLibc();
  return loaded;
}

/** Read right after the failing call, before any other libc call. */
function errno(): number {
  const location = libc().__errno_location();
  return location === null ? -1 : read.i32(location, 0);
}

export class FlockLock implements RunLock {
  private fd: number | undefined;

  constructor(private readonly path: string) {}

  acquire(): LockAttempt {
    if (this.fd !== undefined) throw new Error(`lock already held by this process: ${this.path}`);
    mkdirSync(dirname(this.path), { recursive: true });

    const fd = libc().open(Buffer.from(`${this.path}\0`), O_RDWR | O_CREAT | O_CLOEXEC, 0o644);
    if (fd < 0) throw new Error(`cannot open ${this.path}: errno ${errno()}`);

    if (libc().flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      const code = errno();
      libc().close(fd);
      if (code !== EWOULDBLOCK) throw new Error(`cannot lock ${this.path}: errno ${code}`);
      return { kind: "busy", holder: this.holder() };
    }
    this.fd = fd;

    // Rewritten in place, never deleted: a new file would allow a second lock.
    const holder = { pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv };
    ftruncateSync(fd, 0);
    writeSync(fd, `${JSON.stringify(holder)}\n`, 0);
    return { kind: "acquired" };
  }

  stopHolder(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
    // Never this process: a second lock taken here would kill the run itself.
    if (pid === process.pid) return false;

    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.fd === undefined) return;
    libc().close(this.fd);
    this.fd = undefined;
  }

  /** The written line is diagnostic; `/proc` alone says which process to stop. */
  private holder(): LockHolder {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8").trim();
    } catch {
      raw = "";
    }
    const pid = flockOwner(this.path, writtenPid(raw));
    if (pid === undefined) return { raw };

    const command = commandLine(pid);
    const startedAt = startedAtOf(raw, pid);
    return {
      raw,
      pid,
      ...(command === undefined ? {} : { command }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
  }
}

/**
 * Pid holding a `FLOCK WRITE` on the file's inode, from `/proc/locks`. A stale
 * pid in the file, or a holder that already died, yields `undefined`.
 *
 * Matched on the inode alone: btrfs prints a subvolume device there that
 * `stat(2)` does not report. `written` breaks a tie between two filesystems.
 */
function flockOwner(path: string, written: number | undefined): number | undefined {
  let inode: number;
  let locks: string;
  try {
    inode = statSync(path).ino;
    locks = readFileSync("/proc/locks", "utf8");
  } catch {
    return undefined;
  }

  const owners: number[] = [];
  for (const line of locks.split("\n")) {
    // `1: FLOCK ADVISORY WRITE <pid> <major>:<minor>:<inode> 0 EOF`; a `->`
    // second field marks a waiter, not the holder.
    const fields = line.trim().split(/\s+/).slice(1);
    if (fields[0] !== "FLOCK" || fields[2] !== "WRITE") continue;
    if (fields[4]?.split(":")[2] !== String(inode)) continue;

    const pid = Number(fields[3]);
    if (Number.isInteger(pid) && pid > 0) owners.push(pid);
  }
  if (owners.length === 1) return owners[0];
  return owners.find((pid) => pid === written);
}

/** `pid` of the diagnostic line, before `/proc/locks` confirms anything. */
function writtenPid(raw: string): number | undefined {
  const pid = field(raw, "pid");
  return typeof pid === "number" && Number.isInteger(pid) ? pid : undefined;
}

/** NUL-separated argv of `/proc/<pid>/cmdline`; `undefined` once the process is gone. */
function commandLine(pid: number): string | undefined {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return argv.length === 0 ? undefined : argv.join(" ");
  } catch {
    return undefined;
  }
}

/** Only from a line naming the confirmed pid: an older line describes another run. */
function startedAtOf(raw: string, pid: number): string | undefined {
  const startedAt = field(raw, "startedAt");
  if (writtenPid(raw) !== pid || typeof startedAt !== "string") return undefined;
  return startedAt;
}

/** One key of the diagnostic line; the file is outside data, even though we wrote it. */
function field(raw: string, key: string): unknown {
  let line: unknown;
  try {
    line = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof line === "object" && line !== null
    ? (line as Record<string, unknown>)[key]
    : undefined;
}
