// Early ends of a whole run (spec § Raccourcis, abandon; § Mode interactif):
// after wave, now, `no` answers, and which exit code wins.

import { expect, test } from "bun:test";
import { ORIGIN_PATH } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

test("after wave during the build: the build ends, nothing asked, nothing deployed, exit 5", async () => {
  const run = await simulateRun({
    argv: [],
    hooks: (flow) => [{ kind: "build", host: "hcs", run: () => flow.abort("after-wave") }],
  });

  expect(run.exitCode).toBe(5);
  expect(run.events.filter((event) => event.kind === "ask")).toEqual([]);
  expect(run.recorded?.state?.steps.build.status).toBe("done");
  expect(run.sim.count("copy")).toBe(0);
  expect(run.feed).toContain("warn aborting after the current step or wave");
});

test("after wave during a test wave: the whole wave ends, left in test, exit 5", async () => {
  const run = await simulateRun({
    argv: ["--no-ui", "--no-current-zone-before"],
    hooks: (flow) => [
      { kind: "activate", host: "gw-ag", phase: "test", run: () => flow.abort("after-wave") },
    ],
  });

  expect(run.exitCode).toBe(5);
  expect(run.recorded?.state?.plan[1]).toEqual(["gw-ag", "gw-cp"]);
  expect(run.statuses).toEqual({
    hcs: "tested",
    "gw-ag": "tested",
    "srv-ag": "remaining",
    "pc-ag": "remaining",
    "gw-cp": "tested",
    "lt-cp": "remaining",
  });
  expect(run.recorded?.state?.steps.test.status).toBe("done");
  expect(run.ui.end?.report).toEqual([
    "3 left in test (hcs, gw-ag, gw-cp), 3 not done (srv-ag, pc-ag, lt-cp)",
    expect.stringMatching(/^duration /),
    "run aborted",
  ]);
});

test("now during an activation: nothing settled, its timer kept, the host back at expiry", async () => {
  const run = await simulateRun({
    hooks: (flow) => [
      {
        kind: "activate",
        host: "gw-ag",
        phase: "test",
        run: () => flow.abort("now"),
        gate: new Promise(() => {}),
      },
    ],
  });

  expect(run.exitCode).toBe(5);
  expect(run.states["gw-ag"]).toBe("testing");
  expect(run.sim.count("settle", "gw-ag")).toBe(0);
  expect(run.sim.host("gw-ag").timers.has("test")).toBe(true);
  expect(run.sim.commands.filter((c) => c.host === "gw-ag").at(-1)).toMatchObject({
    kind: "maintenance",
    detail: "off",
  });
  expect(run.feed).toContain("warn aborting now");
  expect(run.recorded?.state?.end).toEqual({ status: "aborted", exitCode: 5 });
  expect(run.recorded?.report).toMatch(/\| test \| aborted \|/);
  expect(run.ui.hosts.find((host) => host.name === "gw-ag")?.interrupted).toBe(true);

  run.clock.advance(600_000);
  run.sim.tick();
  expect(run.sim.host("gw-ag").system).toBe(ORIGIN_PATH);
});

test("now while a question is open: the question dropped, exit 5", async () => {
  const run = await simulateRun({
    argv: [],
    answers: { build: (flow) => flow.abort("now") },
  });

  expect(run.exitCode).toBe(5);
  expect(run.ui.ask).toBeUndefined();
  expect(run.feed.filter((line) => line.startsWith("error"))).toEqual([]);
  expect(run.sim.count("copy")).toBe(0);
});

test("no to the switch: hosts left in test, exit 5", async () => {
  const run = await simulateRun({ argv: [], answers: { build: "yes", switch: "no" } });

  expect(run.exitCode).toBe(5);
  expect(Object.values(run.statuses)).toEqual(Array(6).fill("tested"));
  expect(run.sim.count("profile")).toBe(0);
});

test("--build-only, interactive: no ends the run normally, yes goes on with the test", async () => {
  const stopped = await simulateRun({ argv: ["--build-only"], answers: { build: "no" } });
  expect(stopped.exitCode).toBe(0);
  expect(stopped.sim.count("copy")).toBe(0);
  expect(stopped.ui.end?.status).toBe("done");

  // Announced before the build: the deploying steps are ruled out by the option.
  expect(stopped.ui.steps.test.status).toBe("omitted");
  expect(stopped.ui.steps.switch.status).toBe("omitted");
  expect(stopped.recorded?.report).toMatch(/\| switch \| omitted \|/);

  const continued = await simulateRun({
    argv: ["--build-only"],
    answers: { build: "yes", switch: "yes" },
  });
  expect(continued.exitCode).toBe(0);
  expect(Object.values(continued.statuses)).toEqual(Array(6).fill("deployed"));

  // A `yes` starts them after all: the rows leave `omitted` for their own end.
  expect(continued.ui.steps.test.status).toBe("done");
  expect(continued.ui.steps.switch.status).toBe("done");
});

test("a rollback decided wins over an abort now requested during it: exit 1", async () => {
  const run = await simulateRun({
    argv: ["--no-ui", "--stop-loss"],
    behaviours: { "srv-ag": { activation: { test: 2 } } },
    hooks: (flow) => [
      { kind: "rollback", run: () => flow.abort("now"), gate: new Promise(() => {}), once: true },
    ],
  });

  expect(run.exitCode).toBe(1);
  expect(run.ui.end?.status).toBe("failed");
  expect(run.feed).toContain("warn aborting now");
});

test("after wave: failures of the step or wave still decided normally, then the run ends", async () => {
  const duringBuild = await simulateRun({
    argv: [],
    answers: { "failed-srv-ag": "exclude" },
    behaviours: { "srv-ag": { buildError: "boom" } },
    hooks: (flow) => [{ kind: "build", host: "hcs", run: () => flow.abort("after-wave") }],
  });
  expect(duringBuild.exitCode).toBe(5);
  expect(duringBuild.recorded?.state?.answers.map((answer) => answer.id)).toEqual([
    "failed-srv-ag",
  ]);

  const duringWave = await simulateRun({
    argv: ["--no-current-zone-before", "--deployment-order", "hcs:gateway:[others]"],
    answers: { build: "yes", "lost-pc-ag": "exclude" },
    behaviours: { "pc-ag": { dropsOn: "test" } },
    hooks: (flow) => [
      { kind: "activate", host: "srv-ag", phase: "test", run: () => flow.abort("after-wave") },
    ],
    stepMs: 5000,
  });
  expect(duringWave.exitCode).toBe(5);
  expect(duringWave.statuses).toMatchObject({
    "srv-ag": "tested",
    "pc-ag": "excluded",
    "lt-cp": "tested",
  });
  expect(duringWave.sim.count("profile")).toBe(0);
});
