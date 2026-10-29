// The tools as the model reaches them: level filter, schemas, guards, results.

import { describe, expect, test } from "bun:test";
import type { EventInput } from "../../engine/context.ts";
import { DEFAULT_AI, DEFAULT_REPAIR } from "../../model/params.ts";
import { spentAttempts } from "../../model/persist.ts";
import { type CommandScript, type FakeRunOptions, fakeRunContext } from "../../testing/fakes.ts";
import { toolContext } from "../context.ts";
import { forSession } from "../providers.ts";
import { qualified, TOOLS, toolByName, toolLevel, toolsFor } from "./registry.ts";
import { type ToolContext, ToolError, type ToolResult } from "./types.ts";

const EVENTS: EventInput[] = [
  { kind: "host.add", host: "gfx", profile: "laptop", zone: "ag" },
  { kind: "host.add", host: "hcs", profile: "hcs", zone: "ag" },
  { kind: "step.start", step: "test" },
  { kind: "wave.start", index: 1, total: 2, hosts: ["gfx"] },
  { kind: "host.state", host: "gfx", state: "failed", note: "activation failed: exit 1" },
  { kind: "host.diagnosis", host: "gfx", units: ["nginx.service"], excerpt: ["bind() failed"] },
  { kind: "note", message: "unlock not re-tested" },
];

/**
 * Seeded through the channel: the tools read the fold a real run would. A host
 * put under repair gets its session from the start, as `repairHost` opens one.
 */
function tools(options: FakeRunOptions = {}, extra: EventInput[] = []) {
  const context = fakeRunContext(options);
  for (const [index, event] of [...EVENTS, ...extra].entries()) {
    context.events.emit({ ...event, t: index * 1000 });
    if (event.kind === "host.state" && event.state === "ai-repairing") {
      context.repairing.set(event.host, { signal: new AbortController().signal, since: 0 });
    }
  }
  return { context, tool: toolContext(context, context.state) };
}

/** One call of a tool published at `level`; throws when the level hides it. */
function call(
  tool: ToolContext,
  level: Parameters<typeof toolsFor>[0],
  name: string,
  args: unknown = {},
): Promise<ToolResult> {
  const found = toolByName(level, name);
  if (found === undefined) throw new Error(`no tool ${name} at level ${level}`);
  return found.call(tool, args);
}

describe("registry", () => {
  test("the level filter is the non-escalation rule", () => {
    const passive = toolsFor("passive").map((tool) => tool.name);
    const active = toolsFor("active").map((tool) => tool.name);

    expect(passive).toEqual([
      "deployment_state",
      "host_diagnosis",
      "host_log",
      "run_log",
      "run_warnings",
    ]);
    expect(active).toEqual([
      ...passive,
      "read_code",
      "search_code",
      "list_code",
      "host_units",
      "host_journal",
      "known_suggestions",
      "suggest",
    ]);
    expect(toolsFor("repair").map((tool) => tool.name)).toEqual([
      ...active,
      "service_action",
      "edit_code",
      "validate",
      "commit",
    ]);
    expect(toolByName("passive", "read_code")).toBeUndefined();
    expect(toolByName("active", "service_action")).toBeUndefined();
  });

  test("a session sees the tools it may use, its own path carrying it", () => {
    const names = (session: Parameters<typeof toolsFor>[1]) =>
      toolsFor("repair", session).map((tool) => tool.name);
    const reading = toolsFor("active")
      .map((tool) => tool.name)
      .filter((name) => !["known_suggestions", "suggest"].includes(name));

    expect(names("analysis")).toEqual(reading);
    expect(names("suggestions")).toEqual([...reading, "known_suggestions", "suggest"]);
    for (const acting of ["repair", "build-repair"] as const) {
      expect(names(acting)).toEqual([
        ...reading,
        "service_action",
        "edit_code",
        "validate",
        "commit",
      ]);
    }

    // A session narrows the level, never raises it.
    expect(toolsFor("passive", "repair").map((tool) => tool.name)).toEqual(
      toolsFor("passive").map((tool) => tool.name),
    );

    const run = {
      endpoint: { url: "http://127.0.0.1:9/mcp", token: "t" },
      level: "active" as const,
    };
    const review = forSession(run, "suggestions");
    expect(review.endpoint).toEqual({ url: "http://127.0.0.1:9/mcp/suggestions", token: "t" });
    expect(review.names).toContain("mcp__fleet-update__suggest");
    expect(forSession(run, "analysis").names).not.toContain("mcp__fleet-update__suggest");
  });

  test("the level is the higher of the two option axes", () => {
    const level = (
      aiAnalysis: "none" | "passive" | "active",
      aiErrorAction: "none" | "analysis" | "repair",
    ) => toolLevel(fakeRunContext({ params: { aiAnalysis, aiErrorAction } }).params);

    expect(level("none", "none")).toBeUndefined();
    expect(level("passive", "none")).toBe("passive");
    expect(level("none", "analysis")).toBe("active");
    expect(level("passive", "analysis")).toBe("active");
    expect(level("active", "none")).toBe("active");
    expect(level("passive", "repair")).toBe("repair");
  });

  test("every tool publishes an object schema and a qualified name", () => {
    for (const tool of TOOLS) {
      expect(tool.schema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(20);
      expect(qualified(tool)).toBe(`mcp__fleet-update__${tool.name}`);
    }
  });
});

describe("passive tools", () => {
  test("deployment_state renders the fold, hosts and notes", async () => {
    const { tool } = tools();
    const result = await call(tool, "passive", "deployment_state");

    expect(result.lines).toContain("hosts (2):");
    expect(result.lines).toContain(
      "  gfx | laptop | ag | failed | failed | reason: activation failed: exit 1",
    );
    expect(result.lines).toContain("  unlock not re-tested");
  });

  test("host_diagnosis gives the units and the excerpt", async () => {
    const { tool } = tools();
    const result = await call(tool, "passive", "host_diagnosis", { host: "gfx" });

    expect(result.lines).toContain("failed units: nginx.service");
    expect(result.lines).toContain("bind() failed");
  });

  test("host_diagnosis says so when nothing was collected", async () => {
    const { tool } = tools();
    const result = await call(tool, "passive", "host_diagnosis", { host: "hcs" });

    expect(result.lines).toEqual([
      "hcs: pending (remaining)",
      "nothing was collected on this host",
    ]);
  });

  test("host_log tails the log and counts what it cut", async () => {
    const { context, tool } = tools();
    for (let line = 1; line <= 10; line += 1) {
      context.run.appendLog({ host: "gfx", phase: "build" }, `line ${line}`);
    }
    const result = await call(tool, "passive", "host_log", {
      host: "gfx",
      phase: "build",
      lines: 3,
    });

    expect(result).toEqual({ lines: ["line 8", "line 9", "line 10"], dropped: 7 });
  });

  test("run_log reads a log of the run itself", async () => {
    const { context, tool } = tools();
    context.run.appendLog({ phase: "update" }, "flake updated");

    expect(await call(tool, "passive", "run_log", { phase: "update" })).toEqual({
      lines: ["flake updated"],
    });
  });
});

describe("guards", () => {
  test("a host outside the run is refused", async () => {
    const { tool } = tools();
    expect(call(tool, "passive", "host_diagnosis", { host: "nope" })).rejects.toThrow(
      "unknown host: nope",
    );
  });

  test("arguments the schema refuses never reach the tool", async () => {
    const { tool } = tools();
    expect(call(tool, "passive", "host_log", { host: "gfx", phase: "shell" })).rejects.toThrow(
      "host_log",
    );
    expect(
      call(tool, "passive", "host_log", { host: "gfx", phase: "build", lines: 0 }),
    ).rejects.toThrow("host_log");
    expect(call(tool, "passive", "deployment_state", { path: "/etc/shadow" })).rejects.toThrow(
      "deployment_state",
    );
  });

  test("a unit name outside the pattern is refused before argv", async () => {
    const { tool } = tools();
    expect(
      call(tool, "active", "host_journal", { host: "gfx", unit: "nginx.service; rm -rf /" }),
    ).rejects.toThrow("host_journal");
  });

  test("a path leaving the readable trees is refused", async () => {
    const { tool } = tools();
    expect(call(tool, "active", "read_code", { path: "../../etc/shadow" })).rejects.toThrow(
      "outside the readable trees",
    );
    expect(call(tool, "active", "read_code", { path: "usr/secrets/keys.yaml" })).rejects.toThrow(
      "not readable: usr/secrets",
    );
  });

  test("every call leaves a feed line and a log line, refused ones included", async () => {
    const { context, tool } = tools();
    await call(tool, "passive", "deployment_state");
    await call(tool, "active", "read_code", { path: "boom" }).catch(() => undefined);

    const feed = context.events.events.flatMap((event) =>
      event.kind === "log" ? [event.message] : [],
    );
    expect(feed).toEqual(["AI reads the deployment state", "AI reads boom"]);
    expect(context.run.logs.get("ai")).toEqual(["reads the deployment state", "reads boom"]);
  });
});

describe("run_warnings", () => {
  test("groups the warnings of every log, the AI's left out", async () => {
    const { context, tool } = tools();
    context.run.appendLog({ host: "gfx", phase: "test" }, "warning: not applying UID change (1)");
    context.run.appendLog({ host: "nlt", phase: "test" }, "warning: not applying UID change (2)");
    context.run.appendLog({ phase: "ai" }, "warning: quoted by the model");

    expect(await call(tool, "passive", "run_warnings")).toEqual({
      lines: ["2× gfx, nlt (test): warning: not applying UID change (1)"],
    });
  });

  test("a run without warning says so", async () => {
    const { tool } = tools();
    expect(await call(tool, "passive", "run_warnings")).toEqual({
      lines: ["no warning in this run's logs"],
    });
  });
});

describe("suggestions", () => {
  const SUGGESTION = {
    slug: "gdm-greeter-uid-shift",
    title: "Pin the gdm greeter UIDs",
    body: "`not applying UID change` on 5 hosts, every activation.",
  };

  /** The end-of-run review under way: the only time the two tools answer. */
  function reviewing(options: FakeRunOptions = {}) {
    const made = tools(options);
    made.context.suggestions.reviewing = true;
    return made;
  }

  test("outside the end-of-run review both tools refuse, and nothing is written", async () => {
    const { context, tool } = tools();

    await expect(call(tool, "active", "suggest", SUGGESTION)).rejects.toThrow(
      "end-of-run review only",
    );
    await expect(call(tool, "active", "known_suggestions")).rejects.toThrow(
      "end-of-run review only",
    );
    expect(context.suggestionFiles.files.size).toBe(0);
  });

  test("a new slug files its file, and the run keeps it for the report", async () => {
    const { context, tool } = reviewing();

    expect(await call(tool, "active", "suggest", SUGGESTION)).toEqual({
      lines: ["filed: var/deployments/suggestions/gdm-greeter-uid-shift.md"],
    });
    expect(context.suggestionFiles.files.get("gdm-greeter-uid-shift")).toContain(
      "- First seen: 20260917T020000Z-full",
    );
    expect(context.suggestions.all()).toEqual([
      {
        slug: "gdm-greeter-uid-shift",
        title: "Pin the gdm greeter UIDs",
        status: "open",
        runs: 1,
        fresh: true,
      },
    ]);
  });

  test("a known slug is marked seen, its text kept; ignored ones say so", async () => {
    const known =
      "# Pin them\n\n- Status: ignored\n- Last seen: old\n- Runs: 2\n\nOperator note.\n";
    const { context, tool } = reviewing({ suggestions: { "gdm-greeter-uid-shift": known } });

    expect(await call(tool, "active", "known_suggestions")).toEqual({
      lines: ["gdm-greeter-uid-shift | ignored | 2 runs, last old | Pin them"],
    });
    expect(await call(tool, "active", "suggest", SUGGESTION)).toEqual({
      lines: [
        "var/deployments/suggestions/gdm-greeter-uid-shift.md: ignored by the operator; marked seen, nothing else",
      ],
    });
    expect(context.suggestionFiles.files.get("gdm-greeter-uid-shift")).toBe(
      "# Pin them\n\n- Status: ignored\n- Last seen: 20260917T020000Z-full\n- Runs: 3\n\nOperator note.\n",
    );

    // Once per run: a second call moves nothing.
    expect((await call(tool, "active", "suggest", SUGGESTION)).lines[0]).toContain(
      "already filed or seen by this run",
    );
    expect(context.suggestions.all()).toHaveLength(1);
  });

  test("a slug or a body out of bounds is refused by the schema", async () => {
    const { tool } = reviewing();

    await expect(
      call(tool, "active", "suggest", { ...SUGGESTION, slug: "../../etc/passwd" }),
    ).rejects.toThrow("suggest: slug");
    await expect(
      call(tool, "active", "suggest", { ...SUGGESTION, body: "x\n".repeat(61) }),
    ).rejects.toThrow("60 lines at most");
  });
});

describe("active tools", () => {
  test("read_code serves a file of the workspace", async () => {
    const { tool } = tools({ sources: { "/ws/usr/modules/nginx.nix": ["{ nginx = true; }"] } });

    expect(await call(tool, "active", "read_code", { path: "usr/modules/nginx.nix" })).toEqual({
      lines: ["{ nginx = true; }"],
    });
  });

  test("search_code finds the module behind a name, in both trees", async () => {
    const { tool } = tools({
      sources: {
        "/ws/dnf/home/modules/music.nix": ["{", "  services.mpdris2.enable = true;", "}"],
        "/ws/usr/modules/nginx.nix": ["{ nginx = true; }"],
      },
    });

    expect(await call(tool, "active", "search_code", { pattern: "MPDRIS2" })).toEqual({
      lines: ["dnf/home/modules/music.nix:2: services.mpdris2.enable = true;"],
    });
    expect(await call(tool, "active", "search_code", { pattern: "mpdris2", path: "usr" })).toEqual({
      lines: ['no line holds "mpdris2"'],
    });
  });

  test("search_code and list_code refuse what read_code refuses", async () => {
    const { tool } = tools();
    expect(
      call(tool, "active", "search_code", { pattern: "key", path: "usr/secrets" }),
    ).rejects.toThrow("not readable: usr/secrets");
    expect(call(tool, "active", "list_code", { path: "/etc" })).rejects.toThrow(
      "outside the readable trees",
    );
  });

  test("list_code gives one level, sub-directories marked", async () => {
    const { tool } = tools({
      sources: {
        "/ws/dnf/home/modules/music.nix": ["{ }"],
        "/ws/dnf/home/default.nix": ["{ }"],
        "/ws/flake.nix": ["{ }"],
      },
    });

    expect(await call(tool, "active", "list_code", {})).toEqual({ lines: ["dnf/", "flake.nix"] });
    expect(await call(tool, "active", "list_code", { path: "dnf/home" })).toEqual({
      lines: ["default.nix", "modules/"],
    });
  });

  test("host_units asks the host through the deploy identity", async () => {
    const { context, tool } = tools({
      commands: [
        {
          match: (argv) => argv.join(" ").includes("systemctl status"),
          output: [{ stream: "stdout", line: "degraded" }],
        },
        {
          match: (argv) => argv.join(" ").includes("list-units"),
          output: [{ stream: "stdout", line: "nginx.service loaded failed failed" }],
        },
      ],
    });
    const result = await call(tool, "active", "host_units", { host: "gfx" });

    expect(result.lines).toEqual([
      "degraded",
      "",
      "failed units:",
      "nginx.service loaded failed failed",
    ]);
    expect(context.commands.calls[0]?.argv[0]).toBe("sudo");
  });

  test("host_journal reads a user unit from its users' managers", async () => {
    const { context, tool } = tools({
      commands: [
        {
          match: (argv) => argv.join(" ").includes("USER_UNIT=mpd-mpris.service"),
          output: [{ stream: "stdout", line: "Two services allocated for the same bus name" }],
        },
      ],
    });
    const result = await call(tool, "active", "host_journal", {
      host: "gfx",
      unit: "mpd-mpris.service",
      scope: "user",
    });

    expect(result.lines).toEqual(["Two services allocated for the same bus name"]);
    expect(context.run.logs.get("ai")).toEqual([
      "reads the journal of user unit mpd-mpris.service on gfx",
    ]);
  });

  test("host_journal windows on the wave and reports a failed command", async () => {
    const { tool } = tools({
      commands: [{ match: (argv) => argv.join(" ").includes("journalctl"), exitCode: 255 }],
    });

    expect(
      call(tool, "active", "host_journal", { host: "gfx", unit: "nginx.service" }),
    ).rejects.toThrow(ToolError);
  });
});

describe("service_action", () => {
  const RESTART = { host: "gfx", units: ["nginx.service"], action: "restart" };

  /** Only the repair session acts: every case below needs the host under repair. */
  const UNDER_REPAIR: EventInput[] = [{ kind: "host.state", host: "gfx", state: "ai-repairing" }];

  /** `gfx` failed with `nginx.service`: the only unit a repair may touch there. */
  const script = (failed: string[] = []) => [
    {
      match: (argv: readonly string[]) => argv.join(" ").includes("systemctl restart"),
      output: [{ stream: "stdout" as const, line: "restarted" }],
    },
    {
      match: (argv: readonly string[]) => argv.join(" ").includes("list-units"),
      output: failed.map((unit) => ({ stream: "stdout" as const, line: `${unit} loaded failed` })),
    },
  ];

  const spent = (name: string, count: number): EventInput[] =>
    Array.from({ length: count }, () => ({
      kind: "ai.action" as const,
      host: name,
      action: "restart nginx.service",
      outcome: "done" as const,
    }));

  test("acts, counts the attempt, then reads the failed units back", async () => {
    const { context, tool } = tools({ commands: script() }, UNDER_REPAIR);

    const result = await call(tool, "repair", "service_action", RESTART);

    expect(result.lines).toEqual(["restarted", "", "failed units now:", "none"]);
    expect(context.state().actions).toEqual([
      { host: "gfx", action: "restart nginx.service", outcome: "done" },
    ]);
    expect(context.commands.calls[0]?.argv.join(" ")).toContain("systemctl restart nginx.service");
  });

  test("a unit the run never saw fail is refused, and costs nothing", async () => {
    const { context, tool } = tools({ commands: script() }, UNDER_REPAIR);

    await expect(
      call(tool, "repair", "service_action", { ...RESTART, units: ["sshd.service"] }),
    ).rejects.toThrow("not failed on gfx: sshd.service (failed units: nginx.service)");

    expect(context.state().actions.map((action) => action.outcome)).toEqual(["refused"]);
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
    expect(context.commands.calls).toEqual([]);
  });

  test("a host outside the run, and a unit name outside the pattern", async () => {
    const { tool } = tools();

    await expect(
      call(tool, "repair", "service_action", { ...RESTART, host: "nope" }),
    ).rejects.toThrow("unknown host: nope");
    await expect(
      call(tool, "repair", "service_action", { ...RESTART, units: ["nginx.service; rm -rf /"] }),
    ).rejects.toThrow("service_action");
  });

  test("a host not under repair is refused, whoever asks", async () => {
    const { context, tool } = tools({ commands: script() });

    await expect(call(tool, "repair", "service_action", RESTART)).rejects.toThrow(
      "gfx is not under repair right now (state failed)",
    );
    expect(context.commands.calls).toEqual([]);
  });

  test("a run on its way out repairs nothing", async () => {
    const { context, tool } = tools({ commands: script() }, UNDER_REPAIR);
    context.flow.stop("stop");

    await expect(call(tool, "repair", "service_action", RESTART)).rejects.toThrow(
      "the run is stopping",
    );
    expect(context.commands.calls).toEqual([]);
  });

  test("the attempts of a host are spent once and for all", async () => {
    const budget = DEFAULT_REPAIR.aiAttempts;
    const { context, tool } = tools({ commands: script() }, [
      ...UNDER_REPAIR,
      ...spent("gfx", budget),
    ]);

    await expect(call(tool, "repair", "service_action", RESTART)).rejects.toThrow(
      `${budget} repair attempts already spent on gfx`,
    );
    expect(spentAttempts(context.state(), "gfx")).toBe(budget);
  });

  test("interactive: the operator is asked, and may decline", async () => {
    const declined = tools(
      { commands: script(), params: { interactive: true }, answers: { "repair-gfx-1": "skip" } },
      UNDER_REPAIR,
    );

    await expect(call(declined.tool, "repair", "service_action", RESTART)).rejects.toThrow(
      "the operator declined",
    );
    expect(declined.context.events.events.some((event) => event.kind === "ask")).toBe(true);
    expect(declined.context.commands.calls).toEqual([]);

    const applied = tools(
      { commands: script(), params: { interactive: true }, answers: { "repair-gfx-1": "apply" } },
      UNDER_REPAIR,
    );
    await call(applied.tool, "repair", "service_action", RESTART);
    expect(applied.context.commands.calls).not.toEqual([]);
  });

  test("edit_code writes, returns the diff, and spends an attempt", async () => {
    const { context, tool } = tools(
      {
        commands: [
          {
            match: (argv) => argv.includes("diff"),
            output: [{ stream: "stdout", line: "+  enable = true;" }],
          },
          { match: ["git"] },
        ],
      },
      UNDER_REPAIR,
    );

    const result = await call(tool, "repair", "edit_code", {
      host: "gfx",
      path: "usr/modules/nginx.nix",
      content: "{ enable = true; }\n",
    });

    expect(result.lines).toEqual([
      "written, diff:",
      "+  enable = true;",
      "a new attempt: the edits up to the next validate belong to it",
    ]);
    expect(context.sources.writes).toEqual([
      { path: "/ws/usr/modules/nginx.nix", content: "{ enable = true; }\n" },
    ]);
    expect(spentAttempts(context.state(), "gfx")).toBe(1);
    expect(context.run.logs.get("ai")).toContain("+  enable = true;");
  });

  test("edit_code: a created file is known to the index before its diff", async () => {
    const { context, tool } = tools({ commands: [{ match: ["git"] }] }, UNDER_REPAIR);

    await call(tool, "repair", "edit_code", { host: "gfx", path: "usr/new.nix", content: "{}\n" });

    // `git diff` skips an untracked file: the model would read "unchanged".
    const git = context.commands.calls.map((spec) => spec.argv.slice(3).join(" "));
    expect(git.slice(-2)).toEqual([
      "add --intent-to-add -- /ws/usr/new.nix",
      "diff --no-ext-diff --no-color HEAD -- /ws/usr/new.nix",
    ]);
  });

  test("edit_code: a diff past ai.sourceLines says how many lines were cut", async () => {
    const diff = ["-a", "+b", "-c", "+d"];
    const { context, tool } = tools(
      {
        commands: [
          {
            match: (argv) => argv.includes("diff"),
            output: diff.map((line) => ({ stream: "stdout" as const, line })),
          },
          { match: ["git"] },
        ],
        params: { ai: { ...DEFAULT_AI, sourceLines: 2 } },
      },
      UNDER_REPAIR,
    );

    const result = await call(tool, "repair", "edit_code", {
      host: "gfx",
      path: "usr/x.nix",
      content: "{}\n",
    });

    expect(result.dropped).toBe(2);
    expect(result.lines).toEqual([
      "written, diff:",
      "-c",
      "+d",
      "a new attempt: the edits up to the next validate belong to it",
    ]);

    // Whole in the log all the same.
    expect(context.run.logs.get("ai")).toEqual(expect.arrayContaining(diff));
  });

  test("edit_code replaces one exact passage, the rest of the file untouched", async () => {
    const { context, tool } = tools(
      {
        sources: { "/ws/usr/music.nix": ["{", "  mpdris2.enable = true;", "  $x = 1;", "}", ""] },
        commands: [{ match: ["git"] }],
      },
      UNDER_REPAIR,
    );

    await call(tool, "repair", "edit_code", {
      host: "gfx",
      path: "usr/music.nix",
      old: "  mpdris2.enable = true;\n",
      new: "  # $& kept literally\n",
    });

    expect(context.sources.writes).toEqual([
      { path: "/ws/usr/music.nix", content: "{\n  # $& kept literally\n  $x = 1;\n}\n" },
    ]);
    expect(spentAttempts(context.state(), "gfx")).toBe(1);
  });

  test("the edits of one fix make one attempt, until validate closes it", async () => {
    const edit = (path: string) => ({
      kind: "ai.action" as const,
      host: "gfx",
      action: `edit ${path}`,
      outcome: "done" as const,
    });
    const write = (tool: ToolContext, path: string) =>
      call(tool, "repair", "edit_code", { host: "gfx", path, content: "{}\n" });

    // Every attempt spent, the last one by an edit: its series stays open.
    const params = { repair: { ...DEFAULT_REPAIR, aiAttempts: 3 } };
    const open = tools({ commands: [{ match: ["git"] }], params }, [
      ...UNDER_REPAIR,
      ...spent("gfx", 2),
      edit("usr/a.nix"),
    ]);
    const result = await write(open.tool, "usr/b.nix");
    expect(result.lines.at(-1)).toBe("part of the attempt the previous edit opened");
    expect(spentAttempts(open.context.state(), "gfx")).toBe(3);
    expect(open.context.state().actions.at(-1)).toMatchObject({ outcome: "done", spends: false });

    // A validate closes the series: the next edit is an attempt of its own.
    const closed = tools({ commands: [{ match: ["git"] }], params }, [
      ...UNDER_REPAIR,
      ...spent("gfx", 2),
      edit("usr/a.nix"),
      { kind: "ai.action", host: "gfx", action: "validate gfx", outcome: "failed", spends: false },
    ]);
    await expect(write(closed.tool, "usr/b.nix")).rejects.toThrow(
      "3 repair attempts already spent on gfx",
    );
    expect(closed.context.sources.writes).toEqual([]);

    // So does the end of its session: the next one opens its own (spec § Essais).
    const ended = tools({ commands: [{ match: ["git"] }], params }, [
      ...UNDER_REPAIR,
      ...spent("gfx", 2),
      edit("usr/a.nix"),
    ]);
    const since = ended.context.state().actions.length;
    ended.context.repairing.set("gfx", { signal: new AbortController().signal, since });
    await expect(write(ended.tool, "usr/b.nix")).rejects.toThrow(
      "3 repair attempts already spent on gfx",
    );
    expect(ended.context.sources.writes).toEqual([]);
  });

  test("a build group acts through the host its session names, never a sibling", async () => {
    const { context, tool } = tools({ commands: [{ match: ["git"] }] }, [
      ...UNDER_REPAIR,
      { kind: "host.state", host: "hcs", state: "ai-repairing" },
    ]);
    context.repairing.delete("hcs");

    const refusal = "no repair session acts on hcs";
    await expect(
      call(tool, "repair", "edit_code", { host: "hcs", path: "usr/a.nix", content: "{}\n" }),
    ).rejects.toThrow(refusal);
    await expect(call(tool, "repair", "validate", { host: "hcs" })).rejects.toThrow(refusal);
    await expect(
      call(tool, "repair", "commit", { host: "hcs", scope: "nginx", subject: "fix it" }),
    ).rejects.toThrow(refusal);
    expect(context.sources.writes).toEqual([]);
    expect(context.commands.calls).toEqual([]);
  });

  test("an answer that comes once the run is stopping changes nothing", async () => {
    const { context, tool } = tools(
      { commands: script(), params: { interactive: true }, answers: { "repair-gfx-1": "apply" } },
      UNDER_REPAIR,
    );

    // The operator answers once a stop was asked meanwhile.
    const answer = context.events.answer.bind(context.events);
    context.events.answer = (id: string) => {
      context.flow.stop("stop");
      return answer(id);
    };

    await expect(call(tool, "repair", "service_action", RESTART)).rejects.toThrow(
      "the run is stopping",
    );
    expect(context.commands.calls).toEqual([]);
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
  });

  test("a passage missing or repeated is refused, and costs no attempt", async () => {
    const { context, tool } = tools(
      { sources: { "/ws/usr/music.nix": ["a = 1;", "a = 1;"] }, commands: [{ match: ["git"] }] },
      UNDER_REPAIR,
    );
    const edit = (args: object) =>
      call(tool, "repair", "edit_code", { host: "gfx", path: "usr/music.nix", ...args });

    await expect(edit({ old: "b = 2;", new: "" })).rejects.toThrow("old not found");
    await expect(edit({ old: "a = 1;", new: "" })).rejects.toThrow("old occurs 2 times");
    await expect(edit({ old: "a", new: "b", content: "x" })).rejects.toThrow("either content");
    await expect(edit({})).rejects.toThrow("either content");
    expect(context.sources.writes).toEqual([]);
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
    expect(context.state().actions.map((action) => action.outcome)).toEqual([
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  test("a tree that is not clean refuses the edit before it touches anything", async () => {
    const { context, tool } = tools(
      {
        commands: [
          {
            match: (argv) => argv.includes("status"),
            output: [{ stream: "stdout", line: " M usr/modules/nginx.nix" }],
          },
        ],
      },
      UNDER_REPAIR,
    );

    await expect(
      call(tool, "repair", "edit_code", { host: "gfx", path: "usr/x.nix", content: "{}" }),
    ).rejects.toThrow("is not clean: a repair commit must carry only the fix");
    expect(context.sources.writes).toEqual([]);
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
  });

  test("what a human or a generator owns is refused, codev or not", async () => {
    const { context, tool } = tools({ commands: [{ match: ["git"] }] }, UNDER_REPAIR);
    const edit = (path: string) =>
      call(tool, "repair", "edit_code", { host: "gfx", path, content: "{}" });

    await expect(edit("etc/config.yaml")).rejects.toThrow("not writable: etc/config.yaml");
    await expect(edit("var/generated/hosts.nix")).rejects.toThrow("not writable: var/generated");
    await expect(edit("flake.lock")).rejects.toThrow("a lock is regenerated");
    await expect(edit("usr/secrets/keys.yaml")).rejects.toThrow("not readable: usr/secrets");

    // Not co-development here: `dnf/` is a store path, writing it changes nothing.
    await expect(edit("dnf/modules/service/nginx.nix")).rejects.toThrow(
      "not writable outside co-development",
    );
    expect(context.sources.writes).toEqual([]);
  });

  const DRV = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gfx.drv";
  const TOPLEVEL = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-gfx";

  /** `validate` end to end: clean, staging, one evaluation, one build. */
  const rebuilding = (build: Partial<CommandScript> = {}): CommandScript[] => [
    { match: ["just", "clean"] },
    { match: ["git"] },
    {
      match: (argv) => argv[0] === "nix-eval-jobs",
      output: [
        {
          stream: "stdout",
          line: JSON.stringify({ attr: "gfx", drvPath: DRV, outputs: { out: TOPLEVEL } }),
        },
      ],
    },
    {
      match: (argv) => argv[0] === "nix",
      output: [{ stream: "stdout", line: TOPLEVEL }],
      ...build,
    },
  ];

  test("validate cleans, rebuilds the host alone, and costs no attempt", async () => {
    const { context, tool } = tools({ commands: rebuilding() }, UNDER_REPAIR);

    const result = await call(tool, "repair", "validate", { host: "gfx" });

    expect(result.lines[0]).toBe(`builds: ${TOPLEVEL}`);
    expect(context.repaired.get("gfx")).toEqual({ path: TOPLEVEL, drv: DRV });

    // A check is not a change: the host keeps its attempts.
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
    expect(context.state().actions.at(-1)).toMatchObject({ outcome: "done", spends: false });
  });

  test("validate evaluates the working trees: dnf/ unlocked, new files staged", async () => {
    const argv = (codev: boolean) => {
      const { context, tool } = tools({ codev, commands: rebuilding() }, UNDER_REPAIR);
      return call(tool, "repair", "validate", { host: "gfx" }).then(() =>
        context.commands.calls.map((spec) => spec.argv.join(" ")),
      );
    };

    // `flake.lock` pins `dnf/` at its commit: without the override, an edit
    // there was never evaluated.
    const codev = await argv(true);
    expect(codev.slice(0, 3)).toEqual([
      "just clean",
      "git -C /ws add --all",
      "git -C /ws/dnf add --all",
    ]);
    expect(codev[3]).toContain(
      "nix-eval-jobs --flake /ws#nixosConfigurations --override-input dnf git+file:///ws/dnf",
    );

    const consumer = await argv(false);
    expect(consumer.slice(0, 2)).toEqual(["just clean", "git -C /ws add --all"]);
    expect(consumer[2]).not.toContain("--override-input");
  });

  test("validate says when the edits leave the derivation as it was", async () => {
    const { context, tool } = tools(
      {
        commands: rebuilding({
          exitCode: 1,
          output: [{ stream: "stderr", line: `error: Cannot build '${DRV}'.` }],
        }),
      },
      UNDER_REPAIR,
    );
    const session = { signal: new AbortController().signal, since: 0, drv: DRV };
    context.repairing.set("gfx", session);

    const refusal = call(tool, "repair", "validate", { host: "gfx" });

    await expect(refusal).rejects.toThrow(
      "derivation unchanged: the edits since the last evaluation do not reach gfx",
    );
    expect(session.drv).toBe(DRV);
  });

  test("a validation outliving its session is cut, its path never kept", async () => {
    const session = new AbortController();

    // The build holds until the session ends, as a timed-out `claude` leaves it.
    const { context, tool } = tools(
      { commands: rebuilding({ onRun: () => session.abort(), gate: new Promise<void>(() => {}) }) },
      UNDER_REPAIR,
    );
    context.repairing.set("gfx", { signal: session.signal, since: 0 });

    await expect(call(tool, "repair", "validate", { host: "gfx" })).rejects.toThrow(
      "repair session ended",
    );
    expect(context.repaired.size).toBe(0);
    expect(context.flow.halt.aborted).toBe(false);
  });

  test("a validation that fails is said, and still costs no attempt", async () => {
    const { context, tool } = tools(
      {
        commands: [
          {
            match: ["just", "clean"],
            exitCode: 1,
            output: [{ stream: "stderr", line: "statix: usr/x.nix" }],
          },
        ],
      },
      UNDER_REPAIR,
    );

    await expect(call(tool, "repair", "validate", { host: "gfx" })).rejects.toThrow(
      "just clean failed",
    );
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
    expect(context.repaired.size).toBe(0);
  });

  test("commit writes one commit per dirty tree, and costs no attempt", async () => {
    const { context, tool } = tools(
      {
        codev: true,
        commands: [
          {
            match: (argv) => argv.includes("status"),
            output: [{ stream: "stdout", line: " M dnf/x.nix" }],
            once: true,
          },
          { match: (argv) => argv.includes("add"), once: true },
          { match: (argv) => argv.includes("commit"), once: true },
          {
            match: (argv) => argv.includes("rev-parse"),
            output: [{ stream: "stdout", line: "1a2b3c4d5e6f" }],
            once: true,
          },
          { match: (argv) => argv.includes("flake"), once: true },
          {
            match: (argv) => argv.includes("status"),
            output: [{ stream: "stdout", line: " M flake.lock" }],
            once: true,
          },
          { match: (argv) => argv.includes("add"), once: true },
          { match: (argv) => argv.includes("commit"), once: true },
          {
            match: (argv) => argv.includes("rev-parse"),
            output: [{ stream: "stdout", line: "9f8e7d6c5b4a" }],
            once: true,
          },
        ],
      },
      UNDER_REPAIR,
    );

    const result = await call(tool, "repair", "commit", {
      host: "gfx",
      scope: "nginx",
      subject: "bind nginx after acme",
    });

    expect(result.lines).toEqual(["committed: dnf 1a2b3c4, consumer 9f8e7d6"]);
    expect(spentAttempts(context.state(), "gfx")).toBe(0);

    // The scope names what the fix touches, in both trees alike.
    const messages = context.events.events.flatMap((event) =>
      event.kind === "commit" ? [event.message] : [],
    );
    expect(messages).toEqual([
      "fix(nginx): bind nginx after acme",
      "fix(nginx): bind nginx after acme",
    ]);
  });

  /** `gfx` edited then validated: a commit may seal it. */
  const VALIDATED: EventInput[] = [
    ...UNDER_REPAIR,
    { kind: "ai.action", host: "gfx", action: "edit usr/x.nix", outcome: "done" },
    { kind: "ai.action", host: "gfx", action: "validate gfx", outcome: "done", spends: false },
  ];
  const BUILT = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-gfx";
  const BUILT_DRV = `${BUILT}.drv`;

  /** Consumer alone: dirty, HEAD read as `head`, committed as `rev`. */
  const consumerCommit = (head: string, rev: string) => [
    {
      match: (argv: readonly string[]) => argv.includes("status"),
      output: [{ stream: "stdout" as const, line: " M usr/x.nix" }],
      once: true,
    },
    {
      match: (argv: readonly string[]) => argv.includes("rev-parse"),
      output: [{ stream: "stdout" as const, line: head }],
      once: true,
    },
    { match: (argv: readonly string[]) => argv.includes("add"), once: true },
    { match: (argv: readonly string[]) => argv.includes("commit"), once: true },
    {
      match: (argv: readonly string[]) => argv.includes("rev-parse"),
      output: [{ stream: "stdout" as const, line: rev }],
      once: true,
    },
  ];
  const FIX = { host: "gfx", scope: "nginx", subject: "bind nginx after acme" };

  test("commit waits for a validation of the last edit, and costs no attempt", async () => {
    const { context, tool } = tools({ commands: [{ match: ["git"] }] }, [
      ...UNDER_REPAIR,
      { kind: "ai.action", host: "gfx", action: "edit usr/x.nix", outcome: "done" },
    ]);

    await expect(call(tool, "repair", "commit", FIX)).rejects.toThrow(
      "the last edit is not validated",
    );
    expect(context.commands.calls).toEqual([]);
    expect(context.state().actions.at(-1)).toMatchObject({ outcome: "refused" });
    expect(spentAttempts(context.state(), "gfx")).toBe(1);
  });

  test("a fix committed again amends its own commit while it is HEAD", async () => {
    const { context, tool } = tools({ commands: consumerCommit("c1", "c2") }, [
      { kind: "commit", repo: "consumer", rev: "c1", message: "fix(nginx): first try" },
      ...VALIDATED,
    ]);
    context.subjects.set("gfx", { revs: { consumer: "c1" } });
    context.repaired.set("gfx", { path: BUILT, drv: BUILT_DRV });

    const result = await call(tool, "repair", "commit", FIX);

    expect(result.lines).toEqual(["committed: consumer c2 (amended)"]);
    expect(context.commands.calls.find((spec) => spec.argv.includes("commit"))?.argv).toContain(
      "--amend",
    );
    expect(context.state().commits).toEqual([
      {
        repo: "consumer",
        rev: "c2",
        message: "fix(nginx): bind nginx after acme",
        subject: "gfx",
        amended: 1,
      },
    ]);

    // What was validated is what is now committed: the only path a redeploy takes.
    expect(context.subjects.get("gfx")).toEqual({
      revs: { consumer: "c2" },
      validated: { path: BUILT, drv: BUILT_DRV },
    });
  });

  test("another repair committed on top: a new commit, said in the report", async () => {
    const { context, tool } = tools({ commands: consumerCommit("c9", "c10") }, VALIDATED);
    context.subjects.set("gfx", { revs: { consumer: "c1" } });

    await call(tool, "repair", "commit", FIX);

    expect(context.commands.calls.find((spec) => spec.argv.includes("commit"))?.argv).not.toContain(
      "--amend",
    );
    expect(context.state().notes).toContainEqual({
      host: "gfx",
      message: "fix of gfx split over two consumer commits: another repair committed on top",
    });
    expect(context.subjects.get("gfx")?.revs).toEqual({ consumer: "c10" });
  });

  test("a framework commit naming a fleet host is refused, before anything is written", async () => {
    const { context, tool } = tools(
      {
        codev: true,
        commands: [
          {
            match: (argv) => argv.includes("status"),
            output: [{ stream: "stdout", line: " M home/modules/music.nix" }],
          },
        ],
      },
      UNDER_REPAIR,
    );

    await expect(
      call(tool, "repair", "commit", { host: "gfx", scope: "gfx", subject: "drop mpdris2" }),
    ).rejects.toThrow("dnf/ is published: its commit may not name the host gfx");
    expect(context.commands.calls.some((spec) => spec.argv.includes("commit"))).toBe(false);
    expect(context.state().actions.at(-1)).toMatchObject({ outcome: "refused", spends: false });
  });

  test("a consumer-only commit may name the host its machine directory holds", async () => {
    const { context, tool } = tools(
      {
        commands: [
          {
            match: (argv) => argv.includes("status"),
            output: [{ stream: "stdout", line: " M usr/machines/gfx/configuration.nix" }],
            once: true,
          },
          { match: (argv) => argv.includes("add"), once: true },
          { match: (argv) => argv.includes("commit"), once: true },
          {
            match: (argv) => argv.includes("rev-parse"),
            output: [{ stream: "stdout", line: "9f8e7d6c5b4a" }],
            once: true,
          },
        ],
      },
      UNDER_REPAIR,
    );

    await call(tool, "repair", "commit", { host: "gfx", scope: "gfx", subject: "pin the gpu" });
    const messages = context.events.events.flatMap((event) =>
      event.kind === "commit" ? [event.message] : [],
    );
    expect(messages).toEqual(["fix(gfx): pin the gpu"]);
  });

  test("a scope the commit gate would refuse is refused by the schema", async () => {
    const { tool } = tools({}, UNDER_REPAIR);
    await expect(
      call(tool, "repair", "commit", { host: "gfx", scope: "Music Box", subject: "x" }),
    ).rejects.toThrow("commit: scope");
  });

  test("nothing changed: the commit is refused rather than invented", async () => {
    const { tool } = tools(
      { commands: [{ match: (argv) => argv.includes("status") }] },
      UNDER_REPAIR,
    );

    await expect(
      call(tool, "repair", "commit", { host: "gfx", scope: "nginx", subject: "nothing" }),
    ).rejects.toThrow("nothing to commit");
  });

  test("a unit still failed after the action is said, and the attempt is spent", async () => {
    const { context, tool } = tools({ commands: script(["nginx.service"]) }, UNDER_REPAIR);

    const result = await call(tool, "repair", "service_action", RESTART);

    expect(result.lines.at(-1)).toContain("nginx.service");
    expect(spentAttempts(context.state(), "gfx")).toBe(1);
  });
});
