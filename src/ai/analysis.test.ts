// Triggers of the analysis: when it runs, what it leaves behind, and the
// promise that it never costs the run anything.

import { describe, expect, test } from "bun:test";
import { HostTable } from "../engine/hosts.ts";
import type { HostState } from "../model/events.ts";
import type { RunParams } from "../model/params.ts";
import { type CommandScript, fakeRunContext, feed } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { analyseFree, analyseHost, analyseRun, commitSuggestions, reviewRun } from "./analysis.ts";
import type { SuggestionEntry } from "./suggestions.ts";

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

/** One suggestion the review filed this run. */
const FILED: SuggestionEntry = {
  slug: "nginx-option",
  title: "Nginx option",
  status: "open",
  runs: 1,
  fresh: true,
};
const DIR = "var/deployments/suggestions";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

const head = (rev: string): CommandScript => ({
  match: ["git", "-C", "/ws", "rev-parse"],
  output: [{ stream: "stdout", line: rev }],
  once: true,
});

/** A versioned suggestions directory, HEAD at `before` until the commit moves it. */
function versioned(before: string, after: string, commitExit = 0): CommandScript[] {
  return [
    {
      match: ["git", "-C", "/ws", "status", "--porcelain", "--", DIR],
      output: [{ stream: "stdout", line: `?? ${DIR}/nginx-option.md` }],
    },
    head(before),
    { match: ["git", "-C", "/ws", "add", "--all", "--", DIR] },
    { match: ["git", "-C", "/ws", "commit"], exitCode: commitExit },
    head(after),
  ];
}

describe("reviewRun", () => {
  /** A run whose logs hold one warning, under `--ai-analysis active`. */
  function warned(params: Partial<RunParams> = { aiAnalysis: "active" }) {
    const context = fakeRunContext({ commands: [ANSWER], params });
    context.run.appendLog({ host: "gfx", phase: "test" }, "warning: not applying UID change");
    return context;
  }

  test("reviews the warnings once the run is over, in its own session", async () => {
    const context = warned();
    await reviewRun(context);

    const call = context.commands.calls[0];
    const argv: readonly string[] = call?.argv ?? [];
    expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("you file suggestions");
    expect(call?.stdin).toContain("known_suggestions");
    expect(call?.stdin).toContain("Scope: the project only");

    // Closed again: a later session cannot file.
    expect(context.suggestions.reviewing).toBe(false);
  });

  test("only under --ai-analysis active", async () => {
    for (const aiAnalysis of ["none", "passive"] as const) {
      const context = warned({ aiAnalysis, aiErrorAction: "repair" });
      await reviewRun(context);
      expect(context.commands.calls).toEqual([]);
    }
  });

  test("what a repair left for a human is reviewed too, warnings or not", async () => {
    const context = fakeRunContext({ commands: [ANSWER], params: { aiAnalysis: "active" } });
    context.analyses.addRepair(
      ["validate ignored dnf/: nothing committed. **For a human**: redo the edit."],
      "ms-a2",
    );
    await reviewRun(context);

    const call = context.commands.calls[0];
    expect(call?.stdin).toContain("### Repair of ms-a2");
    expect(call?.stdin).toContain("validate ignored dnf/: nothing committed.");
    expect(call?.stdin).toContain("a limit");
  });

  test("no warning in the logs: no session, nothing paid for", async () => {
    const context = fakeRunContext({ commands: [ANSWER], params: { aiAnalysis: "active" } });
    context.run.appendLog({ phase: "ai" }, "warning: the AI's own words do not count");
    await reviewRun(context);

    expect(context.commands.calls).toEqual([]);
  });

  test("what the review filed is committed once it is over", async () => {
    const context = fakeRunContext({
      commands: [ANSWER, ...versioned(OLD, NEW)],
      params: { aiAnalysis: "active" },
    });
    context.run.appendLog({ host: "gfx", phase: "test" }, "warning: not applying UID change");

    // Filed by the session: the scripted answer calls no tool.
    context.suggestions.add(FILED);
    await reviewRun(context);

    expect(context.state().commits.map((commit) => commit.message)).toEqual([
      "chore(deployments): suggestions of run 20260917T020000Z-full",
    ]);
  });
});

describe("commitSuggestions", () => {
  /** The fleet aligned on `aligned`, one suggestion filed. */
  function filed(commands: CommandScript[], aligned = OLD) {
    const context = fakeRunContext({ commands });
    context.events.emit({ kind: "revision", repo: "consumer", rev: aligned, t: 0 });
    context.suggestions.add(FILED);
    return context;
  }

  test("a versioned directory: committed alone, the fleet still aligned for --resume", async () => {
    const context = filed(versioned(OLD, NEW));
    await commitSuggestions(context);

    // The path is the contract: whatever else the index holds stays out.
    const commit = context.commands.calls.find((call) => call.argv[3] === "commit");
    expect(commit?.argv).toEqual([
      "git",
      "-C",
      "/ws",
      "commit",
      "-m",
      "chore(deployments): suggestions of run 20260917T020000Z-full",
      "--",
      DIR,
    ]);
    expect(context.state().commits).toEqual([
      {
        repo: "consumer",
        rev: NEW,
        message: "chore(deployments): suggestions of run 20260917T020000Z-full",
      },
    ]);
    expect(context.state().revisions.consumer).toBe(NEW);
  });

  test("a fleet not aligned on HEAD is not said aligned by this commit", async () => {
    const context = filed(versioned(OLD, NEW), "c".repeat(40));
    await commitSuggestions(context);

    expect(context.state().commits.map((commit) => commit.rev)).toEqual([NEW]);
    expect(context.state().revisions.consumer).toBe("c".repeat(40));
  });

  test("an ignored directory shows nothing: nothing is committed", async () => {
    const context = filed([{ match: ["git", "-C", "/ws", "status"] }]);
    await commitSuggestions(context);

    expect(context.commands.calls).toHaveLength(1);
    expect(context.state().commits).toEqual([]);
  });

  test("nothing filed by the run: git is not even asked", async () => {
    const context = fakeRunContext();
    await commitSuggestions(context);

    expect(context.commands.calls).toEqual([]);
  });

  test("a refused commit is a warning, never a failure", async () => {
    const context = filed(versioned(OLD, NEW, 1));
    await commitSuggestions(context);

    expect(context.state().commits).toEqual([]);
    expect(feed(context.events.events)).toEqual([
      expect.stringMatching(/^warn var\/deployments\/suggestions: not committed \(.*\), commit it/),
    ]);
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
    const context = fakeRunContext({
      commands: [ANSWER],
      params: { aiContext: "Answer in French, concisely." },
    });
    await analyseFree(context, "a1", "why is hcs offline?");

    expect(context.commands.calls[0]?.stdin).toContain("why is hcs offline?");
    expect(context.commands.calls[0]?.stdin).toContain("Run:");
    expect(context.commands.calls[0]?.stdin).toContain(
      "Operator context:\nAnswer in French, concisely.",
    );
  });
});
