// Triggers of the analysis: when it runs, what it leaves behind, and the
// promise that it never costs the run anything.

import { describe, expect, test } from "bun:test";
import { HostTable } from "../engine/hosts.ts";
import type { HostState } from "../model/events.ts";
import type { RunParams } from "../model/params.ts";
import { type CommandScript, fakeRunContext, feed } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { analyseFree, analyseHost, analyseRun } from "./analysis.ts";

/** An answer the scripted tool streams back on stdout. */
const ANSWER: CommandScript = {
  match: ["claude"],
  output: [{ stream: "stdout", line: "nginx cannot bind port 80." }],
};

/** A host the activation left failed, as `deploy.ts` hands it over. */
function failedHost(commands: CommandScript[], params: Partial<RunParams> = {}) {
  const context = fakeRunContext({ commands, params });
  const selection = fleetSelection();

  // The fold is what a prompt reads, and `host.add` comes from the select step.
  for (const host of selection.hosts) {
    context.events.emit({
      kind: "host.add",
      host: host.name,
      profile: host.profile,
      zone: host.zone,
      t: 0,
    });
  }
  const hosts = new HostTable(context, selection);
  for (const state of ["building", "built", "copying", "ready", "testing"] as HostState[]) {
    hosts.set("hcs", state);
  }
  hosts.set("hcs", "failed", { note: "activation failed: exit 1" });
  return { context, hosts };
}

const statesOf = (context: ReturnType<typeof fakeRunContext>) =>
  context.events.events.flatMap((event) =>
    event.kind === "host.state" ? [`${event.state}${event.note === undefined ? "" : "+note"}`] : [],
  );

describe("analyseHost", () => {
  test("marks the host, asks, and puts it back where it failed", async () => {
    const { context, hosts } = failedHost([ANSWER]);
    await analyseHost(context, hosts, "hcs");

    expect(statesOf(context).slice(-2)).toEqual(["ai-analysing+note", "failed+note"]);
    expect(hosts.get("hcs").state).toBe("failed");

    // The reason survives the round trip: losing it would lose why it stopped.
    expect(hosts.get("hcs").note).toBe("activation failed: exit 1");
    expect(context.analyses.all()).toEqual([
      { host: "hcs", lines: ["nginx cannot bind port 80."] },
    ]);
  });

  test("the system prompt and the level travel with the question", async () => {
    const { context, hosts } = failedHost([ANSWER], { aiAnalysis: "active" });
    await analyseHost(context, hosts, "hcs");

    const argv: readonly string[] = context.commands.calls[0]?.argv ?? [];
    expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("read-only");
    expect(argv).toContain("mcp__fleet-update__read_code");
    expect(argv).toContain("mcp__fleet-update__deployment_state");
  });

  test("a passive level publishes no tool that reads code", async () => {
    const { context, hosts } = failedHost([ANSWER], {
      aiAnalysis: "passive",
      aiErrorAction: "none",
    });
    await analyseHost(context, hosts, "hcs");

    const argv: readonly string[] = context.commands.calls[0]?.argv ?? [];
    expect(argv).toContain("mcp__fleet-update__host_log");
    expect(argv).not.toContain("mcp__fleet-update__read_code");
  });

  test("a tool that fails leaves the host exactly as it was", async () => {
    const { context, hosts } = failedHost([{ match: ["claude"], exitCode: 1 }]);
    await analyseHost(context, hosts, "hcs");

    expect(hosts.get("hcs").state).toBe("failed");
    expect(hosts.get("hcs").note).toBe("activation failed: exit 1");
    expect(context.analyses.all()).toEqual([]);
  });

  test("nothing is asked once the run is halting: an analysis is a new operation", async () => {
    const { context, hosts } = failedHost([ANSWER]);
    context.flow.stop("stop");
    await analyseHost(context, hosts, "hcs");

    expect(context.commands.calls).toEqual([]);
    expect(hosts.get("hcs").state).toBe("failed");
  });

  test("`mark: false` explains a recovered host without moving it", async () => {
    const { context, hosts } = failedHost([ANSWER]);
    await analyseHost(context, hosts, "hcs", { mark: false });

    expect(statesOf(context)).not.toContain("ai-analysing+note");
    expect(context.analyses.all()).toHaveLength(1);
  });
});

describe("analyseRun", () => {
  test("summarises once the run is over, under --ai-analysis", async () => {
    const context = fakeRunContext({ commands: [ANSWER], params: { aiAnalysis: "passive" } });
    await analyseRun(context);

    expect(context.analyses.all()).toEqual([{ lines: ["nginx cannot bind port 80."] }]);
  });

  test("`none` summarises nothing", async () => {
    const context = fakeRunContext({ commands: [ANSWER], params: { aiAnalysis: "none" } });
    await analyseRun(context);

    expect(context.commands.calls).toEqual([]);
    expect(context.analyses.all()).toEqual([]);
  });
});

describe("analyseFree", () => {
  test("`a` answers under --ai-analysis none, without a single tool", async () => {
    const context = fakeRunContext({
      commands: [ANSWER],
      params: { aiAnalysis: "none", aiErrorAction: "none" },
    });
    await analyseFree(context, "a1", "what is left to do?");

    const argv: readonly string[] = context.commands.calls[0]?.argv ?? [];
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--allowedTools");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("no tools in this run");
    expect(feed(context.events.events)).toEqual([]);
  });

  test("the question reaches the tool with the run context around it", async () => {
    const context = fakeRunContext({ commands: [ANSWER] });
    await analyseFree(context, "a1", "why is hcs offline?");

    expect(context.commands.calls[0]?.stdin).toContain("why is hcs offline?");
    expect(context.commands.calls[0]?.stdin).toContain("Run:");
  });
});
