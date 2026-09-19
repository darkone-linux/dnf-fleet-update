// Build step on fakes: evaluation, builds started as hosts evaluate, failures decided.

import { describe, expect, test } from "bun:test";
import type { HostState } from "../../model/events.ts";
import type { RunParams } from "../../model/params.ts";
import { type CommandScript, fakeRunContext, feed } from "../../testing/fakes.ts";
import {
  anywhere,
  centralSelection,
  evalLine,
  fleetSelection,
  storePath,
} from "../../testing/fleet.ts";
import { HostTable } from "../hosts.ts";
import { Presence } from "../presence.ts";
import { build } from "./build.ts";

const NAMES = ["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"];

const nixLog = (json: object) => ({
  stream: "stderr" as const,
  line: `@nix ${JSON.stringify(json)}`,
});

function evaluation(lines: string[]): CommandScript {
  return {
    match: ["nix-eval-jobs"],
    output: [
      { stream: "stderr", line: "evaluation warning: 'system' has been renamed" },
      ...lines.map((line) => ({ stream: "stdout" as const, line })),
      { stream: "stderr", line: "evaluation warning: 'system' has been renamed" },
    ],
  };
}

function setup(
  commands: CommandScript[],
  options: {
    params?: Partial<RunParams>;
    answers?: Record<string, string>;

    /** Default: every closure built here, as `--no-distributed-build` would. */
    delegated?: boolean;
  } = {},
) {
  const { delegated, ...rest } = options;
  const context = fakeRunContext({
    ...rest,
    commands: [{ match: ["ping"], exitCode: 0 }, ...commands, { match: ["nix", "build"] }],
  });
  const hosts = new HostTable(context, delegated ? fleetSelection() : centralSelection());
  const presence = new Presence(context, hosts);
  const states = () =>
    Object.fromEntries(hosts.all().map((host) => [host.name, host.state])) as Record<
      string,
      HostState
    >;
  return { context, hosts, presence, states };
}

describe("build", () => {
  test("every host built from its evaluated derivation, presence pinged meanwhile", async () => {
    const drv = storePath("hcs", ".drv");
    const { context, hosts, presence, states } = setup([
      evaluation(NAMES.map(evalLine)),
      {
        match: ["nix", "build", `${drv}^*`],
        durationMs: 1800,
        output: [
          nixLog({ action: "start", type: 105, text: `building '${drv}'` }),
          nixLog({ action: "result", type: 105, fields: [1, 2, 0, 0] }),
          { stream: "stdout", line: storePath("hcs") },
        ],
      },
    ]);

    const outcome = await build(context, hosts, presence);
    await presence.stop();

    expect(Object.values(states())).toEqual(NAMES.map(() => "built"));
    expect(hosts.get("hcs").path).toBe(storePath("hcs"));
    expect(context.commands.calls.find((call) => call.argv[2] === `${drv}^*`)?.argv).toContain(
      "/deployments/20260917T020000Z-full/gcroots/hcs",
    );
    const events = context.events.events;
    expect(events).toContainEqual({
      t: 0,
      kind: "host.output",
      host: "hcs",
      phase: "build",
      line: `building '${drv}'`,
    });
    expect(events.filter((event) => event.kind === "host.presence")).toHaveLength(6);
    expect(events.filter((event) => event.kind === "step.progress").at(-1)).toMatchObject({
      done: 6,
      total: 6,
    });
    expect(feed(events)).toContain("ok hcs: build ok 1.8s");
    expect(feed(events)).toContain("ok 6 builds ok, 0 failed");
    expect(outcome?.warnings).toEqual(["evaluation warning: 'system' has been renamed"]);
    expect(events.at(-1)).toMatchObject({ kind: "step.end", status: "ok" });
    expect(context.flow.ending).toBeUndefined();
  });

  test("evaluation error, build error, host without result: failed, then excluded unattended", async () => {
    const { context, hosts, presence, states } = setup([
      evaluation([
        JSON.stringify({
          attr: "hcs",
          error: "error:\n  … while evaluating the option `x':\n\n  error: attribute 'x' missing",
        }),
        ...["gw-ag", "srv-ag", "pc-ag", "gw-cp"].map(evalLine),
      ]),
      {
        match: ["nix", "build", `${storePath("gw-ag", ".drv")}^*`],
        exitCode: 1,
        output: [nixLog({ action: "msg", level: 0, msg: "error: builder for x failed\nlast log" })],
      },
    ]);

    await build(context, hosts, presence);
    await presence.stop();

    expect(states()).toMatchObject({ hcs: "excluded", "gw-ag": "excluded", "lt-cp": "excluded" });
    expect(hosts.get("hcs").note).toBe("attribute 'x' missing");
    const hcsLog = context.events.events.flatMap((event) =>
      event.kind === "host.output" && event.host === "hcs" ? [`${event.phase} ${event.line}`] : [],
    );
    expect(hcsLog).toEqual([
      "build error:",
      "build   … while evaluating the option `x':",
      "build ",
      "build   error: attribute 'x' missing",
    ]);
    expect(hosts.get("gw-ag").note).toBe("builder for x failed");
    expect(hosts.get("lt-cp").note).toBe("not evaluated");
    expect(feed(context.events.events)).toContain("warn 3 builds ok, 3 failed");
    expect(context.flow.ending).toBeUndefined();
  });

  test("evaluation failed as a whole: one error, no question per host, the run stops", async () => {
    const { context, hosts, presence, states } = setup(
      [
        {
          ...evaluation(["hcs", "gw-ag"].map(evalLine)),
          exitCode: 1,
          output: [
            ...["hcs", "gw-ag"].map((name) => ({
              stream: "stdout" as const,
              line: evalLine(name),
            })),
            { stream: "stderr", line: "error: mismatch in field 'narHash' of input" },
          ],
        },
      ],
      { params: { interactive: true } },
    );

    await build(context, hosts, presence);
    await presence.stop();

    expect(states()).toMatchObject({ hcs: "built", "gw-ag": "built", "lt-cp": "failed" });
    expect(hosts.get("lt-cp").note).toBe("not evaluated");
    const events = context.events.events;
    expect(events.filter((event) => event.kind === "ask")).toEqual([]);
    expect(feed(events).filter((line) => line.startsWith("error"))).toEqual([
      "error evaluation failed: exit 1: error: mismatch in field 'narHash' of input",
    ]);

    // Known trap: said in plain language, the raw reason untouched.
    expect(feed(events)).toContain(
      "warn hint: nix-eval-jobs is not linked against the same Nix as the system: install the version matching nix --version",
    );
    expect(context.flow.ending).toBe("stop");
    expect(events.at(-1)).toMatchObject({ kind: "step.end", step: "build", status: "error" });
  });

  test("--stop-loss: the first failed host rolls the fleet back, nothing more is decided", async () => {
    const { context, hosts, presence } = setup(
      [evaluation(["hcs", "gw-ag", "srv-ag", "pc-ag"].map(evalLine))],
      { params: { stopLoss: true } },
    );

    await build(context, hosts, presence);
    await presence.stop();

    expect(context.flow.ending).toBe("rollback");
    expect(feed(context.events.events).filter((line) => line.includes("rollback"))).toEqual([
      "error fleet rollback: gw-cp, lt-cp",
    ]);
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });
  });

  test("interactive: a failed host is asked about, then the test is confirmed", async () => {
    const { context, hosts, presence } = setup(
      [evaluation(NAMES.filter((name) => name !== "lt-cp").map(evalLine))],
      { params: { interactive: true }, answers: { "failed-lt-cp": "exclude", build: "no" } },
    );

    await build(context, hosts, presence);
    await presence.stop();

    const asked = context.events.events.flatMap((event) =>
      event.kind === "ask" ? [`${event.id} ${event.options.map((option) => option.value)}`] : [],
    );

    // Nothing activated yet: a rollback would only be a stop.
    expect(asked).toEqual(["failed-lt-cp exclude,stop", "build yes,no"]);
    expect(hosts.get("lt-cp").state).toBe("excluded");
    expect(context.flow.ending).toBe("aborted");
  });

  test("--build-only ends the run after the build, unattended or answered no", async () => {
    for (const interactive of [false, true]) {
      const { context, hosts, presence } = setup([evaluation(NAMES.map(evalLine))], {
        params: { buildOnly: true, interactive },
        answers: { build: "no" },
      });

      await build(context, hosts, presence);
      await presence.stop();

      expect({ interactive, ending: context.flow.ending }).toEqual({ interactive, ending: "done" });
    }
  });

  test("delegated: derivation to the elected builder, build there, nothing here", async () => {
    const { context, hosts, presence } = setup(
      [
        evaluation(NAMES.map(evalLine)),
        { match: anywhere("ssh-ng://") },
        { match: anywhere(".drv^*") },
      ],
      { delegated: true },
    );

    await build(context, hosts, presence);
    await presence.stop();

    const sent = context.commands.calls.map(({ argv }) => argv.join(" "));
    const drv = storePath("hcs", ".drv");

    // Zone `www` has no harmonia: `hcs` is built by the global one.
    expect(sent).toContainEqual(expect.stringContaining(`--to ssh-ng://nix@gw-cp ${drv}`));
    expect(sent).toContainEqual(expect.stringContaining(`nix@gw-cp timeout`));
    expect(hosts.get("hcs").state).toBe("built");
    expect(hosts.get("hcs").builder).toBe("gw-cp");
    expect(hosts.get("pc-ag").builder).toBe("srv-ag");

    // Nothing was built here: every `nix build` went through a builder.
    expect(sent.filter((line) => line.startsWith("nix build"))).toEqual([]);
  });

  test("builder unreachable: built here instead, warned, the host does not fail", async () => {
    const { context, hosts, presence } = setup(
      [
        evaluation(NAMES.map(evalLine)),
        {
          match: anywhere("nix@gw-cp"),
          exitCode: 255,
          output: [{ stream: "stderr", line: "ssh: connect to host gw-cp port 22: No route" }],
        },
        { match: anywhere("ssh-ng://") },
        { match: anywhere(".drv^*") },
      ],
      { delegated: true },
    );

    await build(context, hosts, presence);
    await presence.stop();

    expect(feed(context.events.events)).toContain(
      "warn hcs: builder gw-cp: derivation not copied: exit 255: ssh: connect to host gw-cp port 22: No route, building here",
    );
    expect(hosts.get("hcs").state).toBe("built");
    expect(hosts.get("hcs").builder).toBe("deployer");
  });

  test("nothing built: one error, no question per host, the run stops", async () => {
    const { context, hosts, presence } = setup([evaluation([])], {
      params: { interactive: true },
    });

    await build(context, hosts, presence);
    await presence.stop();

    const events = context.events.events;
    expect(events.filter((event) => event.kind === "ask")).toEqual([]);
    expect(feed(events).filter((line) => line.startsWith("error"))).toEqual([
      ...NAMES.map((name) => `error ${name}: evaluation failed: no result`),
      "error no host built",
    ]);
    expect(context.flow.ending).toBe("stop");
    expect(events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });
  });

  test("the same reason on several hosts: one decision for all of them", async () => {
    const goEol = (attr: string) =>
      JSON.stringify({ attr, error: "error: Go 1.25 is end-of-life" });
    const { context, hosts, presence, states } = setup([
      evaluation([
        ...["hcs", "gw-ag", "gw-cp"].map(evalLine),
        ...["srv-ag", "pc-ag", "lt-cp"].map(goEol),
      ]),
    ]);

    await build(context, hosts, presence);
    await presence.stop();

    expect(states()).toMatchObject({
      "srv-ag": "excluded",
      "pc-ag": "excluded",
      "lt-cp": "excluded",
    });
    expect(feed(context.events.events)).toContain("warn excluded: srv-ag, pc-ag, lt-cp");
  });
});
