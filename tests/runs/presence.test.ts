// Presence across a whole run (spec § Présence): hosts offline at their wave,
// back later, or gone for good.

import { expect, test } from "bun:test";
import { simulateRun } from "../../src/testing/runs.ts";

const waves = (run: Awaited<ReturnType<typeof simulateRun>>) =>
  run.recorded?.state?.waves.map(
    (wave) => `${wave.step} ${wave.index}/${wave.total} ${wave.hosts.join(",")}`,
  );

test("offline at its test wave, back later: joins the next wave, deployed", async () => {
  let back = false;
  const run = await simulateRun({
    behaviours: { "srv-ag": { reachable: () => back } },
    hooks: () => [{ kind: "activate", host: "pc-ag", run: () => (back = true) }],
  });

  expect(run.exitCode).toBe(0);
  expect(Object.values(run.statuses)).toEqual(Array(6).fill("deployed"));
  // Numbered on the waves that run, not on the plan: the wave of `srv-ag`,
  // empty while it is offline, is neither counted nor numbered.
  expect(waves(run)?.slice(0, 5)).toEqual([
    "test 1/5 hcs",
    "test 2/5 gw-ag",
    "test 3/5 pc-ag",
    "test 4/5 srv-ag,gw-cp",
    "test 5/5 lt-cp",
  ]);
  expect(run.feed.filter((line) => line.startsWith("warn offline"))).toEqual([
    "warn offline, retried next wave: srv-ag",
    "warn offline, retried next wave: srv-ag",
  ]);
});

test("offline for the whole run: built, reported offline, the run is done", async () => {
  const run = await simulateRun({ behaviours: { "lt-cp": { reachable: false } } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["lt-cp"]).toBe("offline");
  expect(run.states["lt-cp"]).toBe("built");
  expect(run.sim.count("copy", "lt-cp")).toBe(0);
  expect(run.feed).toContain("warn offline, not tested: lt-cp");

  // Offline since the build: its wave, the last one, is out of the count from
  // the first wave on, so the step ends on its total.
  expect(waves(run)?.slice(0, 5)).toEqual([
    "test 1/5 hcs",
    "test 2/5 gw-ag",
    "test 3/5 srv-ag",
    "test 4/5 pc-ag",
    "test 5/5 gw-cp",
  ]);
  expect(run.ui.steps.test).toMatchObject({ status: "done", done: 5, total: 5 });
  expect(run.ui.end?.report?.[0]).toBe("5 deployed, 1 offline (lt-cp)");
  expect(run.recorded?.report).toContain("| lt-cp | offline |  |");
});

test("tested, offline at the switch: left in test, listed in the report", async () => {
  let gone = false;
  const run = await simulateRun({
    behaviours: { "pc-ag": { reachable: () => !gone } },
    hooks: () => [{ kind: "settle", host: "pc-ag", phase: "test", run: () => (gone = true) }],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["pc-ag"]).toBe("tested");
  expect(run.sim.count("profile", "pc-ag")).toBe(0);
  expect(run.feed).toContain("warn offline, left in test: pc-ag");
  expect(run.ui.end?.report?.[0]).toBe("5 deployed, 1 left in test (pc-ag)");
  expect(run.recorded?.report).toContain("## Hosts left in test\n\n- pc-ag");
});

test("presence unknown until the first answer, an unreachable host reported once", async () => {
  const run = await simulateRun({ behaviours: { "gw-cp": { reachable: false } } });

  const presence = run.events.flatMap((event) =>
    event.kind === "host.presence" ? [`${event.host} ${event.online}`] : [],
  );
  expect(presence).toContain("hcs true");
  expect(presence.filter((line) => line.startsWith("gw-cp"))).toEqual(["gw-cp false"]);
  expect(run.ui.hosts.find((host) => host.name === "gw-cp")?.online).toBe(false);
});
