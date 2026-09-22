// The repair session: when it opens, what it does with the host, and the
// promise that a host never ends in repair.

import { describe, expect, test } from "bun:test";
import { HostTable } from "../engine/hosts.ts";
import type { HostState } from "../model/events.ts";
import type { RunParams } from "../model/params.ts";
import { type CommandScript, fakeRunContext, feed } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { repairHost } from "./repair.ts";

const ANSWER: CommandScript = {
  match: ["claude"],
  output: [{ stream: "stdout", line: "Restarted nginx, it holds." }],
};

/** `systemctl list-units --failed` read back after the session. */
const stillFailed = (units: string[]): CommandScript => ({
  match: (argv) => argv.join(" ").includes("list-units"),
  output: units.map((unit) => ({ stream: "stdout" as const, line: `${unit} loaded failed` })),
});

/** A host the activation left in `error`, as `concluded()` hands it over. */
function erroredHost(commands: CommandScript[], params: Partial<RunParams> = {}) {
  const context = fakeRunContext({ commands, params: { aiErrorAction: "repair", ...params } });
  const selection = fleetSelection();
  for (const host of selection.hosts) {
    const { name, profile, zone } = host;
    context.events.emit({ kind: "host.add", host: name, profile, zone, t: 0 });
  }
  const hosts = new HostTable(context, selection);
  for (const state of ["building", "built", "copying", "ready", "testing"] as HostState[]) {
    hosts.set("hcs", state);
  }
  hosts.set("hcs", "error", { note: "some units failed" });
  context.events.emit({
    kind: "host.diagnosis",
    host: "hcs",
    units: ["nginx.service"],
    t: 1,
  });
  return { context, hosts };
}

const statesOf = (context: ReturnType<typeof fakeRunContext>) =>
  context.events.events.flatMap((event) => (event.kind === "host.state" ? [event.state] : []));

describe("repairHost", () => {
  test("units back up: the host rejoins the run, and the report says what it took", async () => {
    const { context, hosts } = erroredHost([ANSWER, stillFailed([])]);
    context.events.emit({
      kind: "ai.action",
      host: "hcs",
      action: "restart nginx.service",
      outcome: "done",
      t: 2,
    });

    await repairHost(context, hosts, "hcs", "tested");

    expect(statesOf(context).slice(-2)).toEqual(["ai-repairing", "tested"]);
    expect(context.state().notes).toEqual([
      { host: "hcs", message: "recovered by an AI repair: restart nginx.service" },
    ]);
  });

  test("a unit that resists puts the host back where it was, with a new reason", async () => {
    const { context, hosts } = erroredHost([ANSWER, stillFailed(["nginx.service"])]);

    await repairHost(context, hosts, "hcs", "tested");

    expect(hosts.get("hcs").state).toBe("error");
    expect(hosts.get("hcs").note).toBe("units still failed after an AI repair: nginx.service");
    expect(feed(context.events.events)).toContain(
      "warn hcs: units still failed after an AI repair: nginx.service",
    );
  });

  test("the session is told it may act, and gets the action tool", async () => {
    const { context, hosts } = erroredHost([ANSWER, stillFailed([])]);
    await repairHost(context, hosts, "hcs", "tested");

    const argv: readonly string[] = context.commands.calls[0]?.argv ?? [];
    expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("You may act");
    expect(argv).toContain("mcp__fleet-update__service_action");
    expect(context.commands.calls[0]?.stdin).toContain("Failed units: nginx.service");
  });

  test("a tool that fails leaves the host in error, run unaffected", async () => {
    const { context, hosts } = erroredHost([
      { match: ["claude"], exitCode: 1 },
      stillFailed(["nginx.service"]),
    ]);

    await repairHost(context, hosts, "hcs", "tested");
    expect(hosts.get("hcs").state).toBe("error");
  });

  test("nothing opens without --ai-error-action repair, nor while the run halts", async () => {
    const analysing = erroredHost([ANSWER], { aiErrorAction: "analysis" });
    await repairHost(analysing.context, analysing.hosts, "hcs", "tested");
    expect(analysing.context.commands.calls).toEqual([]);

    const halting = erroredHost([ANSWER]);
    halting.context.flow.stop("stop");
    await repairHost(halting.context, halting.hosts, "hcs", "tested");
    expect(halting.context.commands.calls).toEqual([]);
  });

  test("no failed unit, no session: the action tool would have nothing to touch", async () => {
    const context = fakeRunContext({ commands: [ANSWER], params: { aiErrorAction: "repair" } });
    const selection = fleetSelection();
    for (const host of selection.hosts) {
      const { name, profile, zone } = host;
      context.events.emit({ kind: "host.add", host: name, profile, zone, t: 0 });
    }
    const hosts = new HostTable(context, selection);

    await repairHost(context, hosts, "hcs", "tested");
    expect(context.commands.calls).toEqual([]);
  });
});
