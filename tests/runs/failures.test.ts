// Failed hosts still reachable (spec § Erreurs et réparations): build,
// evaluation, units, activation, copy.

import { expect, test } from "bun:test";
import { ORIGIN_PATH } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

test("build failed, unattended: decided at the end of the build, excluded, the rest deployed", async () => {
  const run = await simulateRun({
    behaviours: { "srv-ag": { buildError: "builder for 'foo.drv' failed with exit code 1" } },
    evalWarnings: ["'system' has been renamed", "'system' has been renamed"],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ "srv-ag": "excluded", "pc-ag": "deployed" });
  expect(run.sim.count("copy", "srv-ag")).toBe(0);
  expect(run.recorded?.state?.steps.build.status).toBe("done");
  expect(run.feed).toEqual(
    expect.arrayContaining([
      "error srv-ag: build failed: error: builder for 'foo.drv' failed with exit code 1",
      "warn 5 builds ok, 1 failed",
      "warn srv-ag: excluded",
    ]),
  );
  const report = run.recorded?.report ?? "";
  expect(report).toContain(
    "| srv-ag | excluded | error: builder for 'foo.drv' failed with exit code 1 |",
  );
  expect(report).toContain(
    "## Evaluation warnings\n\n- evaluation warning: 'system' has been renamed\n",
  );
  expect(run.recorded?.logs.get("srv-ag.build")).toContain(
    "error: builder for 'foo.drv' failed with exit code 1",
  );
});

test("build failed, interactive stop: nothing copied, exit 1", async () => {
  const run = await simulateRun({
    argv: [],
    answers: { "failed-gw-cp": "stop" },
    behaviours: { "gw-cp": { buildError: "boom" } },
  });

  expect(run.exitCode).toBe(1);
  expect(run.sim.count("copy")).toBe(0);
  expect(run.statuses).toMatchObject({ "gw-cp": "failed", hcs: "remaining" });
  expect(run.recorded?.state?.answers.map((answer) => answer.id)).toEqual(["failed-gw-cp"]);
  expect(run.events.some((event) => event.kind === "ask" && event.id === "build")).toBe(false);
});

test("evaluation error: that host failed and excluded, the others built from the same evaluation", async () => {
  const run = await simulateRun({
    behaviours: { "lt-cp": { evalError: "error: attribute 'foo' missing\n\n  at /ws/x.nix:3:5" } },
  });

  expect(run.exitCode).toBe(0);
  expect(run.sim.count("eval")).toBe(1);
  expect(run.sim.count("build", "lt-cp")).toBe(0);
  expect(run.statuses["lt-cp"]).toBe("excluded");
  expect(run.feed).toContain("error lt-cp: evaluation failed: error: attribute 'foo' missing");
});

test("nothing built: no test, no switch, the run is done", async () => {
  const behaviours = Object.fromEntries(
    ["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"].map((name) => [
      name,
      { buildError: "x" },
    ]),
  );
  const run = await simulateRun({ behaviours });

  expect(run.exitCode).toBe(0);
  expect(run.feed).toContain("warn no host built: nothing to deploy");
  expect(run.recorded?.state?.steps.test.status).toBe("todo");
  expect(run.ui.end?.report?.[0]).toBe("6 excluded (hcs, gw-ag, srv-ag, pc-ag, gw-cp, lt-cp)");
});

test("units failed at the test: left in test, not switched, the run is done", async () => {
  const run = await simulateRun({ behaviours: { "gw-cp": { activation: { test: 4 } } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ "gw-cp": "error", "lt-cp": "deployed" });
  expect(run.sim.count("profile", "gw-cp")).toBe(0);
  expect(run.ui.end?.report?.[0]).toBe("5 deployed, 1 with failed units (gw-cp)");
  expect(run.recorded?.report).toContain("## Hosts left in test\n\n- gw-cp");
});

test("units failed at the switch: error, switched all the same", async () => {
  const run = await simulateRun({ behaviours: { hcs: { activation: { switch: 4 } } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses.hcs).toBe("error");
  expect(run.sim.host("hcs").profile).not.toBe(ORIGIN_PATH);
  expect(run.feed).toContain("warn hcs: switch: some units failed");
});

test("activation failed on a reachable host, --stop-loss: the fleet rolls back", async () => {
  const run = await simulateRun({
    argv: ["--no-ui", "--stop-loss"],
    behaviours: { "pc-ag": { activation: { test: 2 } } },
  });

  expect(run.exitCode).toBe(1);
  expect(run.statuses).toMatchObject({
    hcs: "reverted",
    "gw-ag": "reverted",
    "srv-ag": "reverted",
    "pc-ag": "reverted",
    "gw-cp": "remaining",
  });
  expect(run.feed).toContain("error pc-ag: test failed: switch-to-configuration exit 2");
});

test("copy failed on a reachable host: failed, excluded, not activated", async () => {
  const run = await simulateRun({ behaviours: { "srv-ag": { copyExit: 1 } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["srv-ag"]).toBe("excluded");
  expect(run.sim.count("activate", "srv-ag")).toBe(0);
  expect(run.recorded?.report).toContain("| srv-ag | excluded | copy failed: exit 1 |");
});

test("forced rollback failing on a host: failed with its reason, the others reverted", async () => {
  const run = await simulateRun({
    argv: ["--no-ui", "--stop-loss"],
    behaviours: { "srv-ag": { activation: { test: 2 } }, hcs: { rollbackExit: 1 } },
  });

  expect(run.exitCode).toBe(1);
  expect(run.statuses).toMatchObject({ hcs: "failed", "gw-ag": "reverted" });
  expect(run.feed).toContain("error hcs: rollback failed: exit 1");
});

test("activation failed at the test, unattended: that host back to its origin, the run goes on", async () => {
  const run = await simulateRun({ behaviours: { "srv-ag": { activation: { test: 2 } } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({
    "srv-ag": "reverted",
    "pc-ag": "deployed",
    "lt-cp": "deployed",
  });
  expect(run.sim.host("srv-ag").history).toEqual([
    "test 2",
    "timer armed test",
    "timer cancelled test",
    "rollback test 0",
  ]);
  expect(run.ui.end?.report?.[0]).toBe("5 deployed, 1 rolled back (srv-ag)");
  expect(run.recorded?.report).toContain(
    "| srv-ag | reverted | test failed: switch-to-configuration exit 2 |",
  );
});

test("activation failed at the switch: back to its origin, profile included", async () => {
  const run = await simulateRun({ behaviours: { "gw-cp": { activation: { switch: 100 } } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["gw-cp"]).toBe("reverted");
  expect(run.sim.host("gw-cp")).toMatchObject({ system: ORIGIN_PATH, profile: ORIGIN_PATH });
});

test("activation failed, interactive: revert, keep, stop or rollback; keep leaves it as it is", async () => {
  const run = await simulateRun({
    argv: [],
    answers: { build: "yes", "failed-pc-ag": "keep", switch: "yes" },
    behaviours: { "pc-ag": { activation: { test: 2 } } },
  });

  expect(run.exitCode).toBe(0);
  const ask = run.events.find((event) => event.kind === "ask" && event.id === "failed-pc-ag");
  expect(ask?.kind === "ask" && ask.options.map((option) => option.value)).toEqual([
    "revert",
    "keep",
    "stop",
    "rollback",
  ]);
  expect(run.statuses["pc-ag"]).toBe("excluded");
  expect(run.sim.count("rollback", "pc-ag")).toBe(0);
  expect(run.feed).toContain("warn pc-ag: excluded, left as it is");
});

test("revert failing too: failed, both reasons kept, the run goes on", async () => {
  const run = await simulateRun({
    behaviours: { "srv-ag": { activation: { test: 2 }, rollbackExit: 1 } },
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ "srv-ag": "failed", "lt-cp": "deployed" });
  expect(run.recorded?.report).toContain(
    "| srv-ag | failed | test failed: switch-to-configuration exit 2; rollback failed: exit 1 |",
  );
});
