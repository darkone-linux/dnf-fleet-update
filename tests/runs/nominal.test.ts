// Whole runs that go through: interactive and unattended, codev commits, the
// deployment host inside the fleet.

import { expect, test } from "bun:test";
import type { HostStatus } from "../../src/model/persist.ts";
import { ORIGIN_PATH, storePath } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";
import { SIM_PATH_SIZE } from "../../src/testing/sim.ts";

const ALL = ["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"];

const every = (status: HostStatus): Record<string, HostStatus> =>
  Object.fromEntries(ALL.map((name) => [name, status]));

test("unattended: every host tested then switched, recorded, reported, exit 0", async () => {
  const run = await simulateRun();

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toEqual(every("deployed"));
  expect(run.ui.end?.report).toEqual(["6 deployed", expect.stringMatching(/^duration /)]);
  for (const name of ALL) {
    expect(run.sim.host(name).history).toEqual([
      "test 0",
      "timer armed test",
      "timer cancelled test",
      "profile set",
      "switch 0",
      "timer armed switch",
      "timer cancelled switch",
    ]);
  }
  // Waves protect the test only: tested hosts switch together, counted one by
  // one like the build.
  const waves = run.recorded?.state?.waves.map((wave) => `${wave.step} ${wave.hosts.join(",")}`);
  expect(waves).toEqual(ALL.map((host) => `test ${host}`));
  expect(run.recorded?.report).toContain("| test | 6/6 | lt-cp |");
  expect(run.feed).toContain("info switching 6 tested hosts");
  expect(run.ui.steps.switch).toMatchObject({ status: "done", done: 6, total: 6 });
});

test("--skip-test: test omitted, hosts copied then switched wave by wave", async () => {
  const run = await simulateRun({ argv: ["--no-ui", "--skip-test"] });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toEqual(every("deployed"));
  expect(run.ui.steps.test.status).toBe("omitted");

  // Published before the waves: only the zone caches, and the zone that has
  // none, are pushed to — the rest of each zone pulls in LAN.
  for (const name of ["hcs", "srv-ag", "gw-cp"]) expect(run.sim.count("copy", name)).toBe(1);
  for (const name of ["gw-ag", "pc-ag", "lt-cp"]) expect(run.sim.count("copy", name)).toBe(0);
  for (const name of ALL) {
    expect(run.sim.host(name).history).toEqual([
      "profile set",
      "switch 0",
      "timer armed switch",
      "timer cancelled switch",
    ]);
  }

  // Nothing proved beforehand: the switch takes the wave order of the test.
  const waves = run.recorded?.state?.waves.map((wave) => `${wave.step} ${wave.hosts.join(",")}`);
  expect(waves).toEqual(ALL.map((host) => `switch ${host}`));
});

test("--skip-switch: hosts left in test, the switch is never proposed", async () => {
  const run = await simulateRun({ argv: ["--skip-switch"], answers: { build: "yes" } });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toEqual(every("tested"));
  expect(run.ui.steps.switch.status).toBe("omitted");
  expect(run.sim.count("profile")).toBe(0);

  // The build still asks: the test runs. Nothing asks about the switch.
  expect(run.events.flatMap((event) => (event.kind === "ask" ? [event.id] : []))).toEqual([
    "build",
  ]);
});

test("--skip-test --skip-switch: fleet published, nothing activated, no question", async () => {
  const run = await simulateRun({ argv: ["--skip-test", "--skip-switch"] });

  expect(run.exitCode).toBe(0);
  expect(run.ui.steps.publish.status).toBe("done");
  expect(run.ui.steps.test.status).toBe("omitted");
  expect(run.ui.steps.switch.status).toBe("omitted");

  // The fleet ends holding its closures: a later run activates without copying.
  expect(Object.values(run.states)).toEqual(Array(6).fill("ready"));
  expect(run.statuses).toEqual(every("remaining"));
  expect(run.sim.count("copy")).toBe(3);
  expect(run.sim.count("profile")).toBe(0);

  // The publication activates nothing: it is never proposed.
  expect(run.events.some((event) => event.kind === "ask")).toBe(false);
});

test("interactive: build and switch confirmed, answers kept in state.json", async () => {
  const run = await simulateRun({
    argv: [],
    answers: { build: "yes", switch: "yes" },
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toEqual(every("deployed"));
  expect(run.recorded?.state?.answers.map(({ id, value }) => `${id}=${value}`)).toEqual([
    "build=yes",
    "switch=yes",
  ]);
});

test("current zone not found, interactive: asked, waves by profile", async () => {
  const run = await simulateRun({
    argv: [],
    addresses: ["192.0.2.7"],
    answers: { zone: "yes", build: "yes", switch: "yes" },
  });

  expect(run.exitCode).toBe(0);
  expect(run.recorded?.state?.plan).toEqual([
    ["hcs"],
    ["gw-ag", "gw-cp"],
    ["srv-ag"],
    ["pc-ag"],
    ["lt-cp"],
  ]);
});

test("codev: dnf/ committed, lock realigned, consumer committed, both in the report", async () => {
  const run = await simulateRun({ codev: true, updates: { dnf: true, consumer: true } });

  expect(run.exitCode).toBe(0);
  expect(run.sim.commits).toEqual([
    { repo: "dnf", message: "chore(update): regular flake upgrade" },
    { repo: "consumer", message: "chore(update): full fleet" },
  ]);
  const order = run.sim.commands
    .map((command) => `${command.kind}${command.detail ? ` ${command.detail}` : ""}`)
    .filter((line) => /^(flake-update|realign|clean|commit)/.test(line));
  // Consumer first: nix writes no lock while `dnf/` is dirty.
  expect(order).toEqual([
    "flake-update consumer",
    "flake-update dnf",
    "clean",
    "commit dnf",
    "realign",
    "commit consumer",
  ]);
  expect(run.recorded?.state?.commits.map((commit) => commit.repo)).toEqual(["dnf", "consumer"]);
  expect(run.recorded?.report).toContain(
    "- Commits: dnf/ d000000 chore(update): regular flake upgrade; consumer c000000 chore(update): full fleet",
  );
});

test("copy counters: one report line per host copied to", async () => {
  const run = await simulateRun({ local: "pc-ag" });
  const counted = run.recorded?.state?.hosts.filter((host) => host.copy !== undefined);

  // The deployment host is never copied to, so it has no counters.
  expect(counted?.map((host) => host.name)).toEqual(ALL.filter((host) => host !== "pc-ag"));
  expect(counted?.[0]?.copy).toEqual({
    builder: "pc-ag",

    // Zone `www` has no harmonia: `hcs` can only substitute from the public cache.
    pulled: [{ source: "cache.nixos.org", paths: 1 }],
    pushed: 1,
    pushedBytes: SIM_PATH_SIZE,
  });
  expect(run.recorded?.report).toContain("| hcs | pc-ag | 1 (cache.nixos.org) | 1 | 1.0 MiB |");

  // `srv-ag` runs the zone harmonia, so `gw-ag` pulls from it by name.
  const served = counted?.find((host) => host.name === "gw-ag");
  expect(served?.copy?.pulled).toEqual([{ source: "harmonia ag", paths: 2 }]);
});

test("--on, deployment host in the selection: no ssh, no copy, no timer for it", async () => {
  const run = await simulateRun({ argv: ["--no-ui", "--on", "@zone-ag"], local: "pc-ag" });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toEqual({ "gw-ag": "deployed", "srv-ag": "deployed", "pc-ag": "deployed" });
  expect(run.recorded?.id).toBe("20260917T020000Z-partial");
  expect(run.sim.count("copy", "pc-ag")).toBe(0);
  expect(run.sim.count("ping", "pc-ag")).toBe(0);
  expect(run.sim.count("settle", "pc-ag")).toBe(0);
  expect(run.sim.host("pc-ag").history).toEqual(["test 0", "profile set", "switch 0"]);
  expect(run.sim.host("hcs").system).toBe(ORIGIN_PATH);
  expect(run.sim.host("gw-ag").system).toBe(storePath("gw-ag"));
});
