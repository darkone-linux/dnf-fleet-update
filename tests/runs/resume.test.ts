// `--resume` across two whole runs (spec § État et reprise): what the first
// run left, what the second picks up, and what it builds again.

import { expect, test } from "bun:test";
import { ExitCode } from "../../src/model/exit-codes.ts";
import { storePath } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

/** First run with `lt-cp` unreachable, then reachable: the classic resume. */
async function offlineThenBack() {
  let up = false;
  const first = await simulateRun({ behaviours: { "lt-cp": { reachable: () => up } } });
  expect(first.statuses["lt-cp"]).toBe("offline");
  up = true;
  return first;
}

test("the host left offline is taken back, its path reused, the rest untouched", async () => {
  const first = await offlineThenBack();

  const run = await simulateRun({ argv: ["--no-ui", "--resume"], after: first });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.statuses).toEqual({ "lt-cp": "deployed" });
  expect(run.recorded?.id).toBe("20260917T020000Z-resume");

  // Update skipped, nothing evaluated or built: the path of the first run is
  // still in the store. The simulated fleet counts both runs.
  expect(run.ui.steps.update.status).toBe("skipped");
  expect(run.sim.count("flake-update")).toBe(1);
  expect(run.sim.count("eval")).toBe(1);
  expect(run.sim.count("build")).toBe(6);
  expect(run.feed).toEqual(
    expect.arrayContaining([
      "info resuming 20260917T020000Z-full",
      "info 1 paths reused, 0 to build",
      "ok 1 hosts selected, 1 waves",
    ]),
  );
  expect(run.sim.host("lt-cp").history).toEqual([
    "test 0",
    "timer armed test",
    "timer cancelled test",
    "profile set",
    "switch 0",
    "timer armed switch",
    "timer cancelled switch",
  ]);
});

test("a collected path is evaluated and built again", async () => {
  const first = await offlineThenBack();
  first.sim.collect(storePath("lt-cp"));

  const run = await simulateRun({ argv: ["--no-ui", "--resume"], after: first });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.statuses).toEqual({ "lt-cp": "deployed" });
  expect(run.feed).toContain("info 0 paths reused, 1 to build");
  expect(run.sim.count("eval")).toBe(2);
  expect(run.sim.count("build", "lt-cp")).toBe(2);
});

test("hosts left in test are switched, nothing built, nothing tested again", async () => {
  const first = await simulateRun({ argv: ["--no-ui", "--skip-switch"] });
  expect(Object.values(first.statuses)).toEqual(Array(6).fill("tested"));
  const tests = first.sim.count("activate");

  const run = await simulateRun({ argv: ["--no-ui", "--resume"], after: first });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(Object.values(run.statuses)).toEqual(Array(6).fill("deployed"));
  expect(run.ui.steps.build.status).toBe("skipped");
  expect(run.ui.steps.test.status).toBe("skipped");
  expect(run.feed).toEqual(
    expect.arrayContaining([
      "info 6 paths reused, 0 to build",
      "info no built host: nothing to test",
    ]),
  );

  // One activation each, the switch: the test of the saved run stands.
  expect(run.sim.count("activate") - tests).toBe(6);
  expect(run.sim.count("copy")).toBe(6);
});

test("--on narrows the resumed hosts without touching the saved selection", async () => {
  let up = false;
  const first = await simulateRun({
    behaviours: {
      "lt-cp": { reachable: () => up },
      "gw-cp": { reachable: () => up },
    },
  });
  expect(first.statuses).toMatchObject({ "gw-cp": "offline", "lt-cp": "offline" });
  up = true;

  const run = await simulateRun({ argv: ["--no-ui", "--resume", "--on", "lt-cp"], after: first });

  expect(run.statuses).toEqual({ "lt-cp": "deployed" });
  expect(run.recorded?.state?.run?.selection).toBe("all");
});

test("nothing left to resume: refused, no run directory, exit 2", async () => {
  const first = await simulateRun();
  expect(Object.values(first.statuses).every((status) => status === "deployed")).toBe(true);

  const run = await simulateRun({ argv: ["--no-ui", "--resume"], after: first });

  expect(run.exitCode).toBe(ExitCode.InvalidOptions);
  expect(run.feed.at(-1)).toContain("no unfinished deployment to resume");
  expect(run.store.runs).toHaveLength(1);
});

test("--resume refuses the options it cannot honour", async () => {
  const first = await offlineThenBack();

  const run = await simulateRun({
    argv: ["--no-ui", "--resume", "--deployment-order", "gateway:[others]"],
    after: first,
  });

  expect(run.exitCode).toBe(ExitCode.InvalidOptions);
  expect(run.feed.at(-1)).toContain("--resume does not accept --deployment-order");
  expect(run.store.runs).toHaveLength(1);
});
