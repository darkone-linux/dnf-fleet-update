// Process runner on local programs only: `sh`, `cat`, `sleep`.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputLine } from "../engine/ports.ts";
import { SystemClock } from "./clock.ts";
import { ProcessRunner } from "./process.ts";

const runner = new ProcessRunner();
const BOUNDS = { timeoutMs: 10_000, killGraceMs: 10_000 };
const temp = mkdtempSync(join(tmpdir(), "fleet-update-process-"));

afterAll(() => rmSync(temp, { recursive: true, force: true }));

const of = (lines: OutputLine[], stream: OutputLine["stream"]) =>
  lines.filter((line) => line.stream === stream).map((line) => line.line);

/** `sh -c <script>`, aborted as soon as it prints `ready`. */
function abortOnReady(script: string, killGraceMs: number) {
  const abort = new AbortController();
  return runner.run(
    { argv: ["sh", "-c", script], timeoutMs: 10_000, killGraceMs },
    {
      signal: abort.signal,
      onLine: ({ line }) => {
        if (line === "ready") abort.abort(new Error("abort now"));
      },
    },
  );
}

describe("ProcessRunner", () => {
  test("lines of both streams, the last one without newline included", async () => {
    const lines: OutputLine[] = [];
    const result = await runner.run(
      { argv: ["sh", "-c", "echo one; echo oops >&2; printf 'two\\nthree'"], ...BOUNDS },
      { onLine: (line) => lines.push(line) },
    );

    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(of(lines, "stdout")).toEqual(["one", "two", "three"]);
    expect(of(lines, "stderr")).toEqual(["oops"]);
  });

  test("a non-zero exit is data", async () => {
    const result = await runner.run({ argv: ["sh", "-c", "exit 3"], ...BOUNDS });

    expect(result).toMatchObject({ exitCode: 3, signal: null, timedOut: false });
  });

  test("stdin, environment merged over the engine's, working directory", async () => {
    const lines: OutputLine[] = [];
    await runner.run(
      {
        argv: ["sh", "-c", 'cat; echo "$GREETING"; pwd -P'],
        cwd: temp,
        env: { GREETING: "hello" },
        stdin: "a\nb\n",
        ...BOUNDS,
      },
      { onLine: (line) => lines.push(line) },
    );

    expect(of(lines, "stdout")).toEqual(["a", "b", "hello", realpathSync(temp)]);
  });

  test("a program that cannot start rejects", async () => {
    await expect(runner.run({ argv: ["fleet-update-no-such-program"], ...BOUNDS })).rejects.toThrow(
      "cannot start fleet-update-no-such-program",
    );
    await expect(
      runner.run({ argv: ["true"], cwd: join(temp, "missing"), ...BOUNDS }),
    ).rejects.toThrow("cannot start true");
  });

  test("already aborted: nothing starts", async () => {
    const abort = new AbortController();
    abort.abort(new Error("aborted before"));

    await expect(
      runner.run({ argv: ["true"], ...BOUNDS }, { signal: abort.signal }),
    ).rejects.toThrow("aborted before");
  });

  test("deadline: SIGTERM to the group, grandchildren included", async () => {
    // The grandchild holds stdout: the run can only end once it is gone.
    const result = await runner.run({
      argv: ["sh", "-c", "sleep 30 & wait"],
      timeoutMs: 100,
      killGraceMs: 10_000,
    });

    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("deadline also bounds leftovers holding the pipes after the leader exits", async () => {
    const result = await runner.run({
      argv: ["sh", "-c", "sleep 30 & echo started"],
      timeoutMs: 100,
      killGraceMs: 10_000,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: true });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("abort: SIGTERM, not a timeout", async () => {
    const result = await abortOnReady("echo ready; sleep 30", 10_000);

    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: false });
  });

  test("SIGTERM ignored: SIGKILL after the grace", async () => {
    // `trap ''` is inherited by `sleep` across exec: only SIGKILL ends it.
    const result = await abortOnReady("trap '' TERM; echo ready; sleep 30", 50);

    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("a throwing line handler rejects the run", async () => {
    const run = runner.run(
      { argv: ["sh", "-c", "echo ready; sleep 30"], ...BOUNDS },
      {
        onLine: () => {
          throw new Error("handler bug");
        },
      },
    );

    await expect(run).rejects.toThrow("handler bug");
  });
});

describe("SystemClock", () => {
  const clock = new SystemClock();

  test("monotonic, sleeps at least the delay", async () => {
    const before = clock.now();
    await clock.sleep(5);

    expect(clock.now() - before).toBeGreaterThanOrEqual(4);
  });

  test("an abort interrupts a pending sleep", async () => {
    const abort = new AbortController();
    const sleeping = clock.sleep(60_000, abort.signal);

    abort.abort(new Error("aborted now"));

    await expect(sleeping).rejects.toThrow("aborted now");
  });
});
