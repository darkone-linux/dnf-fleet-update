// Hosts lost after their activation (spec § Erreurs et réparations): exclusion,
// forced rollback of the fleet, gateway guard.

import { expect, test } from "bun:test";
import { ORIGIN_PATH } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

/** Reconnection attempts end `ssh` seconds before the 600 s timer. */
const ATTEMPTS_END = 570_000;
const TIMER = 600_000;

test("lost after its test, unattended: excluded, the run goes on, its timer brings it back", async () => {
  const run = await simulateRun({ behaviours: { "srv-ag": { dropsOn: "test" } }, stepMs: 5000 });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({
    "srv-ag": "excluded",
    "pc-ag": "deployed",
    "lt-cp": "deployed",
  });
  expect(run.clock.now()).toBeGreaterThanOrEqual(ATTEMPTS_END);
  expect(run.sim.count("rollback")).toBe(0);
  expect(run.recorded?.report).toContain("| srv-ag | excluded | unreachable after test |");

  run.clock.advance(TIMER);
  run.sim.tick();
  expect(run.sim.host("srv-ag")).toMatchObject({ system: ORIGIN_PATH, dropped: false });
  expect(run.sim.host("srv-ag").history.at(-1)).toBe("timer fired test");
});

test("lost, interactive rollback: activated hosts reverted in reverse order, lost one left to its timer", async () => {
  const run = await simulateRun({
    argv: [],
    answers: { build: "yes", "lost-srv-ag": "rollback" },
    behaviours: { "srv-ag": { dropsOn: "test" } },
    stepMs: 5000,
  });

  expect(run.exitCode).toBe(1);
  expect(run.statuses).toMatchObject({
    hcs: "reverted",
    "gw-ag": "reverted",
    "srv-ag": "failed",
    "pc-ag": "remaining",
  });
  const rollbacks = run.sim.commands.filter((command) => command.kind === "rollback");
  expect(rollbacks.map((command) => `${command.host} ${command.phase}`)).toEqual([
    "gw-ag test",
    "hcs test",
  ]);
  expect(run.ui.end?.report).toContain("run stopped on error");
  expect(run.recorded?.state?.steps.switch.status).toBe("todo");
});

test("gateway lost, unattended: its rollback waited for, then the run stops", async () => {
  const run = await simulateRun({ behaviours: { "gw-ag": { dropsOn: "test" } }, stepMs: 5000 });

  expect(run.exitCode).toBe(1);
  expect(run.statuses).toMatchObject({ hcs: "tested", "gw-ag": "failed", "srv-ag": "remaining" });
  expect(run.feed).toEqual(
    expect.arrayContaining([
      "error gw-ag: unreachable after test",
      "warn gw-ag: gateway lost: waiting for its automatic rollback",
      "error gw-ag: run stopped",
    ]),
  );

  // Attempts, then `ssh` + `activation` for the timer and its rollback.
  expect(run.clock.now()).toBeGreaterThanOrEqual(ATTEMPTS_END + 330_000);
  expect(run.sim.count("copy", "srv-ag")).toBe(0);
  run.sim.tick();
  expect(run.sim.host("gw-ag").system).toBe(ORIGIN_PATH);
});

test("gateway lost, interactive: asked after the wait, without exclude", async () => {
  const run = await simulateRun({
    argv: [],
    answers: { build: "yes", "lost-gw-ag": "stop" },
    behaviours: { "gw-ag": { dropsOn: "test" } },
    stepMs: 5000,
  });

  expect(run.exitCode).toBe(1);
  const ask = run.events.find((event) => event.kind === "ask" && event.id === "lost-gw-ag");
  expect(ask?.kind === "ask" && ask.options.map((option) => option.value)).toEqual([
    "stop",
    "rollback",
  ]);
  expect(ask?.t).toBeGreaterThanOrEqual(ATTEMPTS_END + 330_000);
});

test("--stop-loss, lost during the switch: switched and tested hosts reverted by phase", async () => {
  const run = await simulateRun({
    argv: ["--no-ui", "--stop-loss"],
    behaviours: { "pc-ag": { dropsOn: "switch" } },
    stepMs: 5000,
  });

  expect(run.exitCode).toBe(1);
  expect(run.statuses).toEqual({
    hcs: "reverted",
    "gw-ag": "reverted",
    "srv-ag": "reverted",
    "pc-ag": "failed",
    "gw-cp": "reverted",
    "lt-cp": "reverted",
  });
  const rollbacks = run.sim.commands.filter((command) => command.kind === "rollback");
  expect(rollbacks.map((command) => `${command.host} ${command.phase}`)).toEqual([
    "lt-cp test",
    "gw-cp test",
    "srv-ag switch",
    "gw-ag switch",
    "hcs switch",
  ]);
  for (const name of ["hcs", "srv-ag", "lt-cp"]) {
    expect(run.sim.host(name)).toMatchObject({ system: ORIGIN_PATH, profile: ORIGIN_PATH });
  }
  expect(run.ui.end?.report?.[0]).toBe(
    "1 failed (pc-ag), 5 rolled back (hcs, gw-ag, srv-ag, gw-cp, lt-cp)",
  );
});

test("unreachable when its copy starts: lost before activation, no wait, excluded", async () => {
  let down = false;
  const run = await simulateRun({
    behaviours: { "pc-ag": { reachable: () => !down } },
    hooks: () => [{ kind: "maintenance", host: "pc-ag", run: () => (down = true), once: true }],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["pc-ag"]).toBe("excluded");
  expect(run.sim.count("activate", "pc-ag")).toBe(0);
  expect(run.clock.now()).toBeLessThan(ATTEMPTS_END);
  expect(run.recorded?.report).toContain("| pc-ag | excluded | unreachable: copy failed: exit 1:");
});
