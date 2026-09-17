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

describe("FlockLock", () => {
  test("exclusive; the holder is described; the file outlives the release", () => {
    const path = lockPath();
    const first = new FlockLock(path);
    const second = new FlockLock(path);

    expect(first.acquire()).toEqual({ kind: "acquired" });
    const attempt = second.acquire();
    expect(attempt.kind).toBe("busy");
    expect(attempt.kind === "busy" && JSON.parse(attempt.holder)).toMatchObject({
      pid: process.pid,
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
    const script = join(temp, "holder.ts");
    writeFileSync(
      script,
      [
        `import { FlockLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};`,
        "console.log(new FlockLock(process.argv[2]).acquire().kind);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const holder = Bun.spawn([process.execPath, script, path], { stdout: "pipe" });

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
});
