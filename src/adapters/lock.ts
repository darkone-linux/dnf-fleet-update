// Real `RunLock`: flock(2) of the libc through `bun:ffi` (spec § Verrou).
//
// `open(2)` with `O_CLOEXEC`, which `node:fs` of Bun does not set: no exec
// path hands the lock to nix or ssh, it dies with this process only.

import { dlopen, FFIType, read } from "bun:ffi";
import { ftruncateSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { LockAttempt, RunLock } from "../engine/ports.ts";

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
      return { kind: "busy", holder: readFileSync(this.path, "utf8").trim() };
    }
    this.fd = fd;

    // Rewritten in place, never deleted: a new file would allow a second lock.
    const holder = { pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv };
    ftruncateSync(fd, 0);
    writeSync(fd, `${JSON.stringify(holder)}\n`, 0);
    return { kind: "acquired" };
  }

  release(): void {
    if (this.fd === undefined) return;
    libc().close(this.fd);
    this.fd = undefined;
  }
}
