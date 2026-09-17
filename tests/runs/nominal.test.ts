// Whole runs that go through: interactive and unattended, codev commits, the
// deployment host inside the fleet.

import { expect, test } from "bun:test";
import type { HostStatus } from "../../src/model/persist.ts";
import { ORIGIN_PATH, storePath } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

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
  const waves = run.recorded?.state?.waves.map((wave) => `${wave.step} ${wave.hosts.join(",")}`);
  expect(waves).toEqual([
    ...["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"].map((hosts) => `test ${hosts}`),
    ...["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"].map((hosts) => `switch ${hosts}`),
  ]);
  expect(run.recorded?.report).toContain("| switch | 6/6 | lt-cp |");
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
  expect(order).toEqual([
    "flake-update dnf",
    "flake-update consumer",
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
