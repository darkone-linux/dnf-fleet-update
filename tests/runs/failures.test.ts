// Failed hosts still reachable (spec § Erreurs et réparations): build,
// evaluation, units, activation, copy.

import { expect, test } from "bun:test";
import { ORIGIN_PATH } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

test("build failed, unattended: decided at the end of the build, excluded, the rest deployed", async () => {
  const run = await simulateRun({
    behaviours: { "srv-ag": { buildError: "builder for 'foo.drv' failed with exit code 1" } },
    evalWarnings: [
      "'system' has been renamed",
      "'system' has been renamed",
      "swap without randomEncryption",
    ],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ "srv-ag": "excluded", "pc-ag": "deployed" });
  expect(run.sim.count("copy", "srv-ag")).toBe(0);
  expect(run.recorded?.state?.steps.build.status).toBe("done");
  expect(run.feed).toEqual(
    expect.arrayContaining([
      "error srv-ag: build failed: builder for 'foo.drv' failed with exit code 1",
      "warn 5 builds ok, 1 failed",
      "warn srv-ag: excluded",

      // Deduplicated, then one line each: the count alone says nothing.
      "warn 2 evaluation warnings (logs/build.log)",
      "warn evaluation warning: 'system' has been renamed",
      "warn evaluation warning: swap without randomEncryption",
    ]),
  );
  const report = run.recorded?.report ?? "";
  expect(report).toContain("| srv-ag | excluded | builder for 'foo.drv' failed with exit code 1 |");
  expect(report).toContain(
    "## Evaluation warnings\n\n- evaluation warning: 'system' has been renamed\n" +
      "- evaluation warning: swap without randomEncryption\n",
  );
  expect(run.recorded?.logs.get("srv-ag.build")).toContain(
    "error: builder for 'foo.drv' failed with exit code 1",
  );
});

test("--build-only: a failed build is not decided, the host keeps its reason", async () => {
  const run = await simulateRun({
    argv: ["--build-only", "--no-ui"],
    behaviours: { "srv-ag": { buildError: "boom" } },
  });

  expect(run.exitCode).toBe(0);
  expect(run.events.filter((event) => event.kind === "ask")).toEqual([]);
  expect(run.statuses).toMatchObject({ "srv-ag": "failed", "pc-ag": "remaining" });
  expect(run.recorded?.report).toContain("| srv-ag | failed | boom |");
  expect(run.sim.count("copy")).toBe(0);
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
  const ask = run.events.find((event) => event.kind === "ask");
  expect(ask?.kind === "ask" && ask.options.map((option) => option.value)).toEqual([
    "exclude",
    "stop",
  ]);
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
  expect(run.feed).toContain("error lt-cp: evaluation failed: attribute 'foo' missing");
  expect(run.recorded?.logs.get("lt-cp.build")).toEqual([
    "error: attribute 'foo' missing",
    "",
    "  at /ws/x.nix:3:5",
  ]);
});

test("evaluation failed as a whole, interactive: one error, no question, exit 1", async () => {
  const run = await simulateRun({ argv: [], evalFailure: "mismatch in field 'narHash' of input" });

  expect(run.exitCode).toBe(1);
  expect(run.events.filter((event) => event.kind === "ask")).toEqual([]);
  expect(run.feed.filter((line) => line.startsWith("error"))).toEqual([
    "error evaluation failed: exit 1: error: mismatch in field 'narHash' of input",
  ]);
  expect(Object.values(run.statuses)).toEqual(Array(6).fill("failed"));
  expect(run.ui.end?.report).toContain("run stopped on error");
  expect(run.recorded?.state?.steps.build.status).toBe("error");
});

test("nothing built, interactive: no question per host, one error, exit 1", async () => {
  const behaviours = Object.fromEntries(
    ["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"].map((name) => [
      name,
      {
        evalError:
          "error:\n  … while evaluating `sops.package':\n\n  error: Go 1.25 is end-of-life",
      },
    ]),
  );
  const run = await simulateRun({ argv: [], behaviours });

  expect(run.exitCode).toBe(1);
  expect(run.events.filter((event) => event.kind === "ask")).toEqual([]);
  expect(run.feed).toContain("error no host built");
  expect(run.feed).toContain("error hcs: evaluation failed: Go 1.25 is end-of-life");
  expect(Object.values(run.statuses)).toEqual(Array(6).fill("failed"));
  expect(run.recorded?.report).toContain("| hcs | failed | Go 1.25 is end-of-life |");
});

test("the same reason on several hosts, interactive: one question for all of them", async () => {
  const run = await simulateRun({
    argv: [],
    answers: {
      "failed-srv-ag+pc-ag+lt-cp": "exclude",
      "failed-gw-cp": "exclude",
      build: "yes",
      switch: "yes",
    },
    behaviours: {
      "srv-ag": { evalError: "error: Go 1.25 is end-of-life" },
      "pc-ag": { evalError: "error: Go 1.25 is end-of-life" },
      "lt-cp": { evalError: "error: Go 1.25 is end-of-life" },
      "gw-cp": { buildError: "boom" },
    },
  });

  expect(run.exitCode).toBe(0);
  const questions = run.events.flatMap((event) => (event.kind === "ask" ? [event.question] : []));
  expect(questions).toEqual([
    "3 hosts failed: Go 1.25 is end-of-life (srv-ag, pc-ag, lt-cp)",
    "gw-cp failed: boom",
    "Build done. Start publish and test?",
    "Test done. Switch 2 tested hosts?",
  ]);
  expect(run.statuses).toMatchObject({ hcs: "deployed", "lt-cp": "excluded", "gw-cp": "excluded" });
});

test("units failed at the test: left in test, not switched, the run is done", async () => {
  const run = await simulateRun({ behaviours: { "gw-cp": { activation: { test: 4 } } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ "gw-cp": "error", "lt-cp": "deployed" });
  expect(run.sim.count("profile", "gw-cp")).toBe(0);
  expect(run.ui.end?.report?.[0]).toBe("5 deployed, 1 with failed units (gw-cp)");
  expect(run.recorded?.report).toContain("## Hosts left in test\n\n- gw-cp");
});

test("units failed: the host is asked what failed, its journals kept, report and incidents", async () => {
  const run = await simulateRun({
    behaviours: { "gw-cp": { activation: { test: 4 }, failedUnits: ["outline.service"] } },
  });

  expect(run.statuses["gw-cp"]).toBe("error");
  expect(run.feed).toContain("warn gw-cp: units failed: outline.service");
  expect(run.sim.count("journal", "gw-cp")).toBe(1);
  expect(run.recorded?.state?.hosts.find((host) => host.name === "gw-cp")?.diagnosis).toMatchObject(
    { units: ["outline.service"] },
  );
  expect(run.recorded?.report).toContain("### gw-cp\n\nFailed units: outline.service");
  expect(run.recorded?.logs.get("gw-cp.diag")?.join("\n")).toContain("journal of outline.service");
});

test("units restarted and back up: the host goes on, the report blames the order", async () => {
  const run = await simulateRun({
    behaviours: {
      "gw-cp": { activation: { test: 4 }, failedUnits: ["outline.service"], unitsRecover: true },
    },
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["gw-cp"]).toBe("deployed");
  expect(run.states["gw-cp"]).toBe("deployed");
  expect(run.sim.host("gw-cp").history).toContain("units restarted");
  expect(run.feed).toContain(
    "ok gw-cp: units recovered after a restart: probable activation ordering issue",
  );
  expect(run.recorded?.report).toContain(
    "## Notes\n\n- gw-cp: units recovered after a restart: probable activation ordering issue",
  );
});

test("units that resist the restart: the host stays in error, left in test", async () => {
  const run = await simulateRun({
    behaviours: { "gw-cp": { activation: { test: 4 }, failedUnits: ["outline.service"] } },
  });

  expect(run.statuses["gw-cp"]).toBe("error");
  expect(run.feed).toContain("warn gw-cp: units still failed after a restart: outline.service");
  expect(run.recorded?.report).not.toContain("## Notes");
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

test("copy failed on a reachable host: retried, then failed, excluded, not activated", async () => {
  // `hcs`: zone `www` has no cache of its own, so it is the host pushed to.
  const run = await simulateRun({ behaviours: { hcs: { copyExit: 1 } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses.hcs).toBe("excluded");

  // Spec § Exécution: the transfer is relaunched at most twice.
  expect(run.sim.count("copy", "hcs")).toBe(3);
  expect(run.sim.count("activate", "hcs")).toBe(0);
  expect(run.recorded?.report).toContain("| hcs | excluded | copy failed: exit 1:");
  expect(run.feed).toContain(
    "warn hcs: copy failed: exit 1: error: cannot copy to 'hcs', retrying",
  );
});

test("a builder that is down: its hosts built here, warned, deployed all the same", async () => {
  const run = await simulateRun({ behaviours: { "gw-cp": { reachable: false } } });

  expect(run.exitCode).toBe(0);

  // `gw-cp` builds zone `cp` and, being the global harmonia, `hcs` as well.
  expect(run.statuses).toMatchObject({ hcs: "deployed", "lt-cp": "deployed", "gw-cp": "offline" });
  expect(run.feed).toEqual(
    expect.arrayContaining([
      expect.stringContaining("warn hcs: builder gw-cp: derivation not copied:"),
      expect.stringContaining("warn lt-cp: builder gw-cp: derivation not copied:"),
    ]),
  );

  // Built here after the fallback, so pushed from here.
  expect(run.sim.count("copy", "lt-cp")).toBe(1);
});

test("a copy that goes through is not retried", async () => {
  const run = await simulateRun();

  expect(run.sim.count("copy", "hcs")).toBe(1);
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
