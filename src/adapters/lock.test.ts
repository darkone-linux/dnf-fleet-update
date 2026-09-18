// Run lock on temp files; the other holder is a real process when it matters.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlockLock } from "./lock.ts";

const temp = mkdtempSync(join(tmpdir(), "fleet-update-lock-"));
let count = 0;
const lockPath = () => join(temp, `run-${++count}`, "current.lock");

afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** First stdout line of a process, without waiting for its end. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n")[0] ?? "";
}

/** Holds the lock on its argument and stays alive; written once, reused. */
function holderScript(): string {
  const script = join(temp, "holder.ts");
  writeFileSync(
    script,
    [
      `import { FlockLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};`,
      "console.log(new FlockLock(process.argv[2]).acquire().kind);",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return script;
}

describe("FlockLock", () => {
  test("exclusive; the holder is described; the file outlives the release", () => {
    const path = lockPath();
    const first = new FlockLock(path);
    const second = new FlockLock(path);

    expect(first.acquire()).toEqual({ kind: "acquired" });
    const attempt = second.acquire();
    expect(attempt.kind).toBe("busy");

    // Same process on both ends: `/proc/locks` names it, `/proc/<pid>/cmdline`
    // describes it, and the line it wrote is the one read back.
    expect(attempt.kind === "busy" && attempt.holder).toMatchObject({
      pid: process.pid,
      startedAt: expect.stringContaining("T"),
      command: expect.any(String),
    });
    expect(() => first.acquire()).toThrow("already held");

    first.release();
    expect(existsSync(path)).toBe(true);
    expect(second.acquire()).toEqual({ kind: "acquired" });
    second.release();
  });

  test("a child started while holding does not keep the lock", async () => {
    const path = lockPath();
    const lock = new FlockLock(path);
    lock.acquire();
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });

    try {
      lock.release();
      const other = new FlockLock(path);
      expect(other.acquire()).toEqual({ kind: "acquired" });
      other.release();
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("the kernel releases it when the holder dies", async () => {
    const path = lockPath();
    const holder = Bun.spawn([process.execPath, holderScript(), path], { stdout: "pipe" });

    try {
      expect(await firstLine(holder.stdout)).toBe("acquired");
      const lock = new FlockLock(path);
      expect(lock.acquire()).toMatchObject({ kind: "busy" });

      holder.kill("SIGKILL");
      await holder.exited;
      expect(lock.acquire()).toEqual({ kind: "acquired" });
      lock.release();
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("another process: described by its pid, stopped by SIGTERM", async () => {
    const path = lockPath();
    const holder = Bun.spawn([process.execPath, holderScript(), path], { stdout: "pipe" });

    try {
      expect(await firstLine(holder.stdout)).toBe("acquired");
      const lock = new FlockLock(path);
      const attempt = lock.acquire();
      expect(attempt.kind === "busy" && attempt.holder).toMatchObject({
        pid: holder.pid,
        command: expect.stringContaining(path),
      });

      expect(lock.stopHolder(holder.pid, "SIGTERM")).toBe(true);
      await holder.exited;
      expect(lock.acquire()).toEqual({ kind: "acquired" });
      expect(lock.stopHolder(holder.pid, "SIGTERM")).toBe(false);
      lock.release();
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
