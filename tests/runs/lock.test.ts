// Busy lock at the start of a whole run (spec § Verrou): refused unattended,
// taken over interactively, and the run it interrupted picked up.

import { expect, test } from "bun:test";
import type { LockHolder } from "../../src/engine/ports.ts";
import { ExitCode } from "../../src/model/exit-codes.ts";
import { simulateRun } from "../../src/testing/runs.ts";

const HOLDER: LockHolder = {
  raw: '{"pid":42}',
  pid: 42,
  startedAt: "2026-09-17T01:00:00.000Z",
  command: "bun src/main.tsx --no-ui",
};

/** First run with `lt-cp` unreachable, then reachable: something to resume. */
async function leftOffline() {
  let up = false;
  const first = await simulateRun({ behaviours: { "lt-cp": { reachable: () => up } } });
  expect(first.statuses["lt-cp"]).toBe("offline");
  up = true;
  return first;
}

test("unattended: exit 4 before anything is run", async () => {
  const run = await simulateRun({ lock: { holder: HOLDER } });

  expect(run.exitCode).toBe(ExitCode.Locked);
  expect(run.recorded).toBeUndefined();
  expect(run.sim.count("flake-update")).toBe(0);
  expect(run.feed).toEqual([
    "error another fleet-update run holds the lock: pid 42, " +
      "started 2026-09-17T01:00:00.000Z, bun src/main.tsx --no-ui",
  ]);
});

test("interactive, holder stopped and its run resumed: the host left offline is deployed", async () => {
  const first = await leftOffline();

  const run = await simulateRun({
    argv: [],
    after: first,
    lock: { holder: HOLDER, diesOn: ["SIGTERM"] },
    answers: { lock: "yes", resume: "yes", build: "yes", switch: "yes" },
  });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.statuses).toEqual({ "lt-cp": "deployed" });
  expect(run.recorded?.id).toBe("20260917T020000Z-resume");
  expect(run.ui.steps.update.status).toBe("skipped");
  expect(run.feed).toEqual(
    expect.arrayContaining([
      "ok lock taken from pid 42",
      "info resuming 20260917T020000Z-full",
      "info 1 paths reused, 0 to build",
    ]),
  );
});

test("interactive, resume declined: a new run under the lock just taken", async () => {
  const first = await leftOffline();

  // `--on`: the memory store dates every run alike, the mode names the directory.
  const run = await simulateRun({
    argv: ["--on", "lt-*"],
    after: first,
    lock: { holder: HOLDER, diesOn: ["SIGTERM"] },
    answers: { lock: "yes", resume: "no", build: "yes", switch: "yes" },
  });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.recorded?.id).toBe("20260917T020000Z-partial");
  expect(run.statuses).toEqual({ "lt-cp": "deployed" });
  expect(run.ui.steps.update.status).toBe("done");
});

test("interactive, holder left alone: exit 4, nothing run", async () => {
  const run = await simulateRun({
    argv: [],
    lock: { holder: HOLDER },
    answers: { lock: "no" },
  });

  expect(run.exitCode).toBe(ExitCode.Locked);
  expect(run.recorded).toBeUndefined();
  expect(run.sim.count("flake-update")).toBe(0);
});
