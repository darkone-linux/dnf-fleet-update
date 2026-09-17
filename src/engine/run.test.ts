// Whole runs on fakes: exit codes, what is recorded, the lock released.

import { describe, expect, test } from "bun:test";
import { parseCli, resolveParams } from "../cli/options.ts";
import type { Event } from "../model/events.ts";
import {
  type CommandScript,
  FakeClock,
  FakeCommands,
  FakeLocalHost,
  FakeLock,
  feed,
  MemoryDeploymentStore,
  RecordingChannel,
} from "../testing/fakes.ts";
import {
  anywhere,
  evalLine,
  generatedScripts,
  HAPPY_HOSTS,
  HOSTS_JSON,
  NETWORK_JSON,
  remote,
} from "../testing/fleet.ts";
import { RunFlow } from "./flow.ts";
import { runFleetUpdate } from "./run.ts";

const NAMES = HOSTS_JSON.map((host) => host.hostname);

/** Clean trees, inputs updated, nothing to commit, every host evaluated and built. */
const WORKSPACE: CommandScript[] = [
  { match: ["git", "-C", "/ws", "status"] },
  { match: ["nix", "flake", "update"] },
  { match: ["just", "clean"] },
  {
    match: ["nix-eval-jobs"],
    output: NAMES.map((name) => ({ stream: "stdout", line: evalLine(name) })),
  },
  { match: ["nix", "build"] },
];

function harness(
  options: {
    argv?: string[];
    commands?: CommandScript[];
    network?: unknown;
    holder?: string;
    answers?: Record<string, string>;
  } = {},
) {
  const argv = options.argv ?? ["--no-ui"];
  const cli = parseCli(argv);
  if (cli.kind !== "run") throw new Error(`argv: ${JSON.stringify(cli)}`);
  const ports = {
    commands: new FakeCommands([
      ...(options.commands ?? []),
      ...generatedScripts(HOSTS_JSON, options.network ?? NETWORK_JSON),
      ...WORKSPACE,
      ...HAPPY_HOSTS,
    ]),
    clock: new FakeClock(),
    events: new RecordingChannel(options.answers),
    local: new FakeLocalHost("deployer", ["10.1.0.50"]),
    lock: new FakeLock(options.holder),
    store: new MemoryDeploymentStore(),
  };
  const flow = new RunFlow();
  const request = {
    workspace: "/ws",
    codev: false,
    version: "0.2.0",
    resolve: (defaults: Parameters<typeof resolveParams>[1]) =>
      resolveParams(cli.options, defaults),
  };
  const run = () => runFleetUpdate(ports, request, flow);
  const kinds = () => ports.events.events.map((event) => event.kind);
  const end = () => ports.events.events.at(-1) as Extract<Event, { kind: "run.end" }>;
  return { ports, flow, run, kinds, end };
}

const statesOf = (events: readonly Event[]) => {
  const last: Record<string, string> = {};
  for (const event of events) if (event.kind === "host.state") last[event.host] = event.state;
  return last;
};

describe("runFleetUpdate", () => {
  test("nominal unattended run: every host deployed, recorded, reported, lock released", async () => {
    const { ports, run, kinds, end } = harness();

    expect(await run()).toBe(0);

    expect(kinds()[0]).toBe("run.start");
    expect(end()).toMatchObject({
      status: "done",
      exitCode: 0,
      report: ["6 deployed", "duration 0s"],
    });
    expect(Object.values(statesOf(ports.events.events))).toEqual(NAMES.map(() => "deployed"));
    const recorded = ports.store.runs[0];
    expect(recorded?.id).toBe("20260917T020000Z-full");
    expect(recorded?.events).toEqual(ports.events.events);
    expect(recorded?.state?.end).toEqual({ status: "done", exitCode: 0 });
    expect(recorded?.report).toContain("# fleet-update report");
    expect(ports.lock.held).toBe(false);
  });

  test("lock held elsewhere: exit 4, nothing run, nothing recorded", async () => {
    const { ports, run, kinds, end } = harness({ holder: '{"pid":42}' });

    expect(await run()).toBe(4);

    expect(kinds()).toEqual(["log", "run.end"]);
    expect(feed(ports.events.events)).toEqual([
      'error another fleet-update run holds the lock: {"pid":42}',
    ]);
    expect(end()).toMatchObject({ status: "failed", exitCode: 4 });
    expect(ports.commands.calls).toEqual([]);
    expect(ports.store.runs).toEqual([]);
  });

  test("invalid network.fleetUpdate: exit 2 before any run directory", async () => {
    const network = { ...NETWORK_JSON, fleetUpdate: { deploymentOrder: "hcs::gateway" } };
    const { ports, run, end } = harness({ network });

    expect(await run()).toBe(2);

    expect(end()).toMatchObject({ status: "failed", exitCode: 2 });
    expect(feed(ports.events.events)[0]).toContain("network.fleetUpdate.deploymentOrder");
    expect(ports.store.runs).toEqual([]);
    expect(ports.lock.held).toBe(false);
  });

  test("aborted now while reading network.nix: exit 5 before any run directory", async () => {
    const flowHolder: { flow?: RunFlow } = {};
    const { ports, flow, run, kinds, end } = harness({
      commands: [
        {
          match: (argv) => argv.join(" ").endsWith("/network.nix"),
          onRun: () => flowHolder.flow?.abort("now"),
          gate: new Promise(() => {}),
        },
      ],
    });
    flowHolder.flow = flow;

    expect(await run()).toBe(5);

    expect(kinds()).toEqual(["run.end"]);
    expect(end()).toMatchObject({ status: "aborted", exitCode: 5 });
    expect(ports.store.runs).toEqual([]);
    expect(ports.lock.held).toBe(false);
  });

  test("uncommitted changes: exit 1, no step run, report written", async () => {
    const { ports, run, kinds, end } = harness({
      commands: [
        { match: ["git", "-C", "/ws", "status"], output: [{ stream: "stdout", line: " M x.nix" }] },
      ],
    });

    expect(await run()).toBe(1);

    expect(feed(ports.events.events)).toContain(
      "error consumer: uncommitted changes (1), commit them first",
    );
    expect(kinds().filter((kind) => kind === "step.start")).toEqual(["step.start"]);
    expect(end()).toMatchObject({ status: "failed", exitCode: 1 });
    expect(ports.store.runs[0]?.report).toContain("Status: failed (exit 1)");
  });

  test("--build-only: done after the build, nothing copied", async () => {
    const { ports, run, end } = harness({ argv: ["--no-ui", "--build-only", "--on", "gw-*"] });

    expect(await run()).toBe(0);

    expect(ports.store.runs[0]?.id).toBe("20260917T020000Z-partial");
    expect(ports.commands.calls.some((call) => call.argv.join(" ").includes("ssh-ng://"))).toBe(
      false,
    );
    expect(end()).toMatchObject({
      status: "done",
      report: ["2 not done (gw-ag, gw-cp)", "duration 0s"],
    });
  });

  test("--stop-loss and a failed activation: the fleet rolls back, exit 1", async () => {
    const { ports, run, end } = harness({
      argv: ["--no-ui", "--stop-loss"],
      commands: [
        { match: remote("srv-ag", "[ -f"), output: [{ stream: "stdout", line: "2" }] },
        { match: anywhere("systemd-run --wait --pipe --collect /bin/sh -c") },
      ],
    });

    expect(await run()).toBe(1);

    expect(statesOf(ports.events.events)).toMatchObject({
      hcs: "reverted",
      "gw-ag": "reverted",
      "srv-ag": "reverted",
      "pc-ag": "built",
    });
    expect(end()).toMatchObject({ status: "failed", exitCode: 1 });
    expect(end().report).toContain("run stopped on error");
  });

  test("aborted now during the evaluation: exit 5, lock released", async () => {
    const flowHolder: { flow?: RunFlow } = {};
    const { ports, flow, run, end } = harness({
      commands: [{ match: ["nix-eval-jobs"], onRun: () => flowHolder.flow?.abort("now") }],
    });
    flowHolder.flow = flow;

    expect(await run()).toBe(5);

    expect(end()).toMatchObject({ status: "aborted", exitCode: 5 });
    expect(ports.lock.held).toBe(false);
  });

  test("a bug inside a step: reported, exit 1, run ended properly", async () => {
    const { ports, run, end } = harness({
      commands: [
        {
          match: ["just", "clean"],
          onRun: () => {
            throw new Error("boom");
          },
        },
      ],
    });

    expect(await run()).toBe(1);

    expect(feed(ports.events.events)).toContain("error internal error: boom");
    expect(end()).toMatchObject({ status: "failed", exitCode: 1 });
  });
});
