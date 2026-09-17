// Test and switch waves on fakes: commands per host, presence at wave start,
// dropped sessions, lost hosts and their decisions.

import { describe, expect, test } from "bun:test";
import type { HostState } from "../../model/events.ts";
import type { RunParams } from "../../model/params.ts";
import { type CommandScript, drive, fakeRunContext, feed } from "../../testing/fakes.ts";
import {
  anywhere,
  fleetSelection,
  HAPPY_HOSTS as HAPPY,
  ORIGIN_PATH as OLD,
  pingOf,
  remote,
  storePath,
} from "../../testing/fleet.ts";
import { HostTable } from "../hosts.ts";
import { Presence } from "../presence.ts";
import { switchWaves, testWaves } from "./waves.ts";

const PING_ROUND = 15_000;

function setup(
  commands: CommandScript[] = [],
  options: { params?: Partial<RunParams>; answers?: Record<string, string>; local?: string } = {},
) {
  const context = fakeRunContext({
    params: options.params,
    answers: options.answers,
    commands: [...commands, ...HAPPY],
  });
  const selection = fleetSelection(options.local);
  const hosts = new HostTable(context, selection);
  for (const host of hosts.all()) {
    hosts.set(host.name, "building");
    hosts.set(host.name, "built", { path: storePath(host.name) });
  }
  context.events.events.length = 0;
  const presence = new Presence(context, hosts);
  const states = () =>
    Object.fromEntries(hosts.all().map((host) => [host.name, host.state])) as Record<
      string,
      HostState
    >;
  const commandsOf = (host: string) =>
    context.commands.calls
      .map((call) => call.argv)
      .filter((argv) => argv.includes(`nix@${host}`) || argv.includes(`ssh-ng://nix@${host}`));
  return { context, selection, hosts, presence, states, commandsOf };
}

const kinds = (events: { kind: string }[], kind: string) =>
  events.filter((event) => event.kind === kind);

describe("test waves", () => {
  test("waves in plan order: silenced, copied, origin read, activated with a timer, settled", async () => {
    const { context, selection, hosts, presence, states, commandsOf } = setup();

    await testWaves(context, hosts, presence, selection);

    expect(Object.values(states())).toEqual(Array(6).fill("tested"));
    const waves = context.events.events.flatMap((event) =>
      event.kind === "wave.start" ? [event.hosts.join(",")] : [],
    );
    expect(waves).toEqual(["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"]);

    const steps = commandsOf("gw-ag").map((argv) => {
      const inner = argv.at(-1) ?? "";
      if (argv.includes("ssh-ng://nix@gw-ag")) return "copy";
      for (const word of [
        "dnf-maintenance on",
        "readlink",
        "rc=$?",
        "[ -f",
        "dnf-maintenance off",
      ]) {
        if (inner.includes(word)) return word;
      }
      return inner;
    });
    expect(steps).toEqual([
      "dnf-maintenance on",
      "copy",
      "readlink",
      "rc=$?",
      "[ -f",
      "dnf-maintenance off",
    ]);
    const activation = commandsOf("gw-ag").find((argv) => (argv.at(-1) ?? "").includes("rc=$?"));
    expect(activation?.at(-1)).toContain("--on-active=600");

    expect(context.events.events).toContainEqual({
      t: 0,
      kind: "host.state",
      host: "gw-ag",
      state: "testing",
      origin: { system: OLD, profile: OLD },
    });
    expect(feed(context.events.events)).toContain("ok gw-ag: test ok");
    expect(kinds(context.events.events, "step.progress").at(-1)).toMatchObject({
      done: 6,
      total: 6,
    });
    expect(context.events.events.at(-1)).toMatchObject({
      kind: "step.end",
      step: "test",
      status: "ok",
    });
  });

  test("offline at its wave: joins the next one once back; offline to the end: not tested", async () => {
    const { context, selection, hosts, presence, states } = setup([
      pingOf("srv-ag", 1, true),
      pingOf("lt-cp", 1),
    ]);

    await testWaves(context, hosts, presence, selection);

    const waves = context.events.events.flatMap((event) =>
      event.kind === "wave.start" ? [event.hosts.join(",")] : [],
    );
    expect(waves).toEqual(["hcs", "gw-ag", "srv-ag,pc-ag", "gw-cp"]);
    expect(states()).toMatchObject({ "srv-ag": "tested", "lt-cp": "built" });
    expect(feed(context.events.events)).toContain("warn offline, not tested: lt-cp");
  });

  test("units failed: error, the next waves go on", async () => {
    const { context, selection, hosts, presence, states } = setup([
      { match: remote("gw-ag", "[ -f"), output: [{ stream: "stdout", line: "4" }] },
    ]);

    await testWaves(context, hosts, presence, selection);

    expect(states()).toMatchObject({ "gw-ag": "error", "lt-cp": "tested" });
    expect(feed(context.events.events)).toContain("warn gw-ag: test: some units failed");
  });

  test("activation failed on a reachable host: failed, excluded unattended", async () => {
    const { context, selection, hosts, presence, states } = setup([
      { match: remote("srv-ag", "[ -f"), output: [{ stream: "stdout", line: "2" }] },
    ]);

    await testWaves(context, hosts, presence, selection);

    expect(states()).toMatchObject({ "srv-ag": "excluded", "lt-cp": "tested" });
    expect(hosts.get("srv-ag").note).toBe("test failed: switch-to-configuration exit 2");
  });

  test("session dropped during the activation: the result is read once reconnected", async () => {
    const { context, selection, hosts, presence, states } = setup([
      { match: remote("gw-ag", "rc=$?"), exitCode: 255 },
      { match: remote("gw-ag", "[ -f"), exitCode: 255, once: true },
      { match: remote("gw-ag", "[ -f"), exitCode: 3, once: true },
    ]);

    await drive(context.clock, testWaves(context, hosts, presence, selection), PING_ROUND);

    expect(states()["gw-ag"]).toBe("tested");
    expect(context.clock.now()).toBeGreaterThanOrEqual(2 * PING_ROUND);
  });

  test("activation never ran (session ended, no result): failed at once", async () => {
    const { context, selection, hosts, presence } = setup([
      { match: remote("hcs", "rc=$?"), exitCode: 1 },
      { match: remote("hcs", "[ -f"), exitCode: 3 },
    ]);

    await testWaves(context, hosts, presence, selection);

    expect(hosts.get("hcs").note).toBe("test did not run: exit 1");
    expect(context.clock.now()).toBe(0);
  });

  test("gateway lost after activation: its rollback waited for, then the run stops", async () => {
    const { context, selection, hosts, presence, states } = setup([
      { match: remote("gw-ag", "[ -f"), exitCode: 255 },
    ]);

    await drive(context.clock, testWaves(context, hosts, presence, selection), PING_ROUND);

    expect(states()).toMatchObject({ hcs: "tested", "gw-ag": "failed", "srv-ag": "built" });
    expect(hosts.get("gw-ag")).toMatchObject({ lost: true, online: false });
    expect(context.flow.ending).toBe("stop");

    // Attempts until 600 - 30 s, then ssh + activation waited: 330 s.
    expect(context.clock.now()).toBeGreaterThanOrEqual(570_000 + 330_000);
    expect(feed(context.events.events)).toEqual(
      expect.arrayContaining([
        "error gw-ag: unreachable after test",
        "warn gw-ag: gateway lost: waiting for its automatic rollback",
        "error gw-ag: run stopped",
      ]),
    );
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });
  });

  test("lost host: excluded unattended, rollback under --stop-loss, asked interactively", async () => {
    const lost: CommandScript = { match: remote("srv-ag", "[ -f"), exitCode: 255 };

    const unattended = setup([lost]);
    await drive(
      unattended.context.clock,
      testWaves(unattended.context, unattended.hosts, unattended.presence, unattended.selection),
      PING_ROUND,
    );
    expect(unattended.states()).toMatchObject({ "srv-ag": "excluded", "lt-cp": "tested" });

    const stopLoss = setup([lost], { params: { stopLoss: true } });
    await drive(
      stopLoss.context.clock,
      testWaves(stopLoss.context, stopLoss.hosts, stopLoss.presence, stopLoss.selection),
      PING_ROUND,
    );
    expect(stopLoss.context.flow.ending).toBe("rollback");
    expect(stopLoss.states()["lt-cp"]).toBe("built");

    const asked = setup([lost], {
      params: { interactive: true },
      answers: { "lost-srv-ag": "stop" },
    });
    await drive(
      asked.context.clock,
      testWaves(asked.context, asked.hosts, asked.presence, asked.selection),
      PING_ROUND,
    );
    expect(asked.context.flow.ending).toBe("stop");
  });

  test("copy failed and no answer to the ping: lost before activation, nothing to wait for", async () => {
    const { context, selection, hosts, presence, states } = setup([
      { match: anywhere("ssh-ng://nix@pc-ag"), exitCode: 1 },
      pingOf("pc-ag", 0, true),
      pingOf("pc-ag", 1),
    ]);

    await testWaves(context, hosts, presence, selection);

    expect(states()["pc-ag"]).toBe("excluded");
    expect(hosts.get("pc-ag").lost).toBe(true);
    expect(hosts.get("pc-ag").activated).toBeUndefined();
    expect(hosts.get("pc-ag").note).toBe("unreachable: copy failed: exit 1");
    expect(context.clock.now()).toBe(0);
  });

  test("deployment host: no copy, no ssh, no timer, no reconnection", async () => {
    const { context, selection, hosts, presence, states } = setup([], { local: "pc-ag" });

    await testWaves(context, hosts, presence, selection);

    expect(states()["pc-ag"]).toBe("tested");
    const local = context.commands.calls
      .map((call) => call.argv.join(" "))
      .filter((line) => line.includes("pc-ag") || line.startsWith("sudo -n timeout"));
    expect(local.filter((line) => line.includes("ssh"))).toEqual([]);
    expect(local.filter((line) => line.includes("[ -f"))).toEqual([]);
    const activation = local.find((line) => line.includes("rc=$?"));
    expect(activation?.startsWith("sudo -n timeout --kill-after=10 300 systemd-run")).toBe(true);
    expect(activation).not.toContain("--on-active");
  });

  test("abort after wave: the wave in progress ends, no other starts", async () => {
    const { context, selection, hosts, presence, states } = setup([
      { match: remote("gw-ag", "rc=$?"), onRun: () => context.flow.abort("after-wave") },
    ]);

    await testWaves(context, hosts, presence, selection);

    expect(states()).toMatchObject({ "gw-ag": "tested", "srv-ag": "built" });
    expect(context.flow.ending).toBe("aborted");
  });

  test("a halt starts no other host of the wave; dnf-maintenance off all the same", async () => {
    const { context, selection, hosts, presence, states } = setup(
      [{ match: remote("gw-ag", "[ -f"), output: [{ stream: "stdout", line: "2" }] }],
      { params: { stopLoss: true, maxParallel: 1 } },
    );
    selection.waves = [["hcs"], ["gw-ag", "gw-cp"], ["srv-ag", "pc-ag", "lt-cp"]];

    await testWaves(context, hosts, presence, selection);

    expect(states()).toMatchObject({ "gw-ag": "failed", "gw-cp": "built" });
    const off = context.commands.calls.filter((call) =>
      call.argv.at(-1)?.includes("dnf-maintenance off"),
    );
    expect(off.map((call) => call.argv.find((arg) => arg.startsWith("nix@")))).toEqual([
      "nix@hcs",
      "nix@gw-ag",
      "nix@gw-cp",
    ]);
  });

  test("dnf-maintenance: absent ignored, failure a warning", async () => {
    const { context, selection, hosts, presence } = setup([
      { match: remote("hcs", "dnf-maintenance"), exitCode: 127 },
      { match: remote("gw-ag", "dnf-maintenance on"), exitCode: 1 },
    ]);

    await testWaves(context, hosts, presence, selection);

    const warnings = feed(context.events.events).filter((line) => line.includes("dnf-maintenance"));
    expect(warnings).toEqual(["warn gw-ag: dnf-maintenance on failed: exit 1"]);
  });
});

describe("switch waves", () => {
  async function tested(options: Parameters<typeof setup>[1] = {}, commands: CommandScript[] = []) {
    const harness = setup(commands, options);
    await testWaves(harness.context, harness.hosts, harness.presence, harness.selection);
    harness.context.events.events.length = 0;
    harness.context.commands.calls.length = 0;
    return harness;
  }

  test("tested hosts: profile set, then switched; hosts in error left in test", async () => {
    const { context, selection, hosts, presence, states, commandsOf } = await tested({}, [
      { match: remote("gw-cp", "[ -f"), output: [{ stream: "stdout", line: "4" }], once: true },
    ]);

    await switchWaves(context, hosts, presence, selection);

    expect(states()).toMatchObject({ hcs: "deployed", "lt-cp": "deployed", "gw-cp": "error" });
    const inner = commandsOf("hcs").map((argv) => argv.at(-1) ?? "");
    expect(inner.findIndex((line) => line.includes("nix-env"))).toBeLessThan(
      inner.findIndex((line) => line.includes("rc=$?")),
    );
    expect(inner.some((line) => line.includes("readlink"))).toBe(false);
    expect(context.commands.calls.some((call) => call.argv.join(" ").includes("ssh-ng://"))).toBe(
      false,
    );
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", step: "switch" });
  });

  test("interactive: confirmed first; no ends the run, hosts left in test", async () => {
    const { context, selection, hosts, presence, states } = await tested({
      params: { interactive: true },
      answers: { switch: "no" },
    });

    await switchWaves(context, hosts, presence, selection);

    expect(states().hcs).toBe("tested");
    expect(context.flow.ending).toBe("aborted");
    expect(context.events.events.map((event) => event.kind)).toEqual(["ask", "ask.close"]);
  });

  test("no tested host: switch skipped, straight to the report", async () => {
    const { context, selection, hosts, presence } = setup([{ match: ["ping"], exitCode: 1 }]);
    await testWaves(context, hosts, presence, selection);

    await switchWaves(context, hosts, presence, selection);

    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "skipped" });
    expect(context.flow.ending).toBe("done");
  });
});
