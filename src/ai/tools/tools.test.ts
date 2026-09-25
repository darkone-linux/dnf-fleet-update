// The tools as the model reaches them: level filter, schemas, guards, results.

import { describe, expect, test } from "bun:test";
import type { EventInput } from "../../engine/context.ts";
import { spentAttempts } from "../../model/persist.ts";
import { type FakeRunOptions, fakeRunContext } from "../../testing/fakes.ts";
import { toolContext } from "../context.ts";
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

/** Seeded through the channel: the tools read the fold a real run would. */
function tools(options: FakeRunOptions = {}, extra: EventInput[] = []) {
  const context = fakeRunContext(options);
  for (const [index, event] of [...EVENTS, ...extra].entries()) {
    context.events.emit({ ...event, t: index * 1000 });
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

    expect(passive).toEqual(["deployment_state", "host_diagnosis", "host_log", "run_log"]);
    expect(active).toEqual([
      ...passive,
      "read_code",
      "search_code",
      "list_code",
      "host_units",
      "host_journal",
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
    const { context, tool } = tools({ commands: script() }, [...UNDER_REPAIR, ...spent("gfx", 3)]);

    await expect(call(tool, "repair", "service_action", RESTART)).rejects.toThrow(
      "3 repair attempts already spent on gfx",
    );
    expect(spentAttempts(context.state(), "gfx")).toBe(3);
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

    expect(result.lines).toEqual(["written, diff:", "+  enable = true;"]);
    expect(context.sources.writes).toEqual([
      { path: "/ws/usr/modules/nginx.nix", content: "{ enable = true; }\n" },
    ]);
    expect(spentAttempts(context.state(), "gfx")).toBe(1);
    expect(context.run.logs.get("ai")).toContain("+  enable = true;");
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

  test("validate cleans, rebuilds the host alone, and costs no attempt", async () => {
    const { context, tool } = tools(
      {
        commands: [
          { match: ["just", "clean"] },
          {
            match: (argv) => argv[0] === "nix-eval-jobs",
            output: [
              {
                stream: "stdout",
                line: JSON.stringify({
                  attr: "gfx",
                  drvPath: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gfx.drv",
                  outputs: { out: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-gfx" },
                }),
              },
            ],
          },
          {
            match: (argv) => argv[0] === "nix",
            output: [
              {
                stream: "stdout",
                line: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-gfx",
              },
            ],
          },
        ],
      },
      UNDER_REPAIR,
    );

    const result = await call(tool, "repair", "validate", { host: "gfx" });

    expect(result.lines[0]).toBe(
      "builds: /nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-gfx",
    );
    expect(context.repaired.get("gfx")).toBe(
      "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-gfx",
    );

    // A check is not a change: the host keeps its three attempts.
    expect(spentAttempts(context.state(), "gfx")).toBe(0);
    expect(context.state().actions.at(-1)).toMatchObject({ outcome: "done", spends: false });
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
      subject: "bind nginx after acme",
    });

    expect(result.lines).toEqual(["committed: dnf 1a2b3c4, consumer 9f8e7d6"]);
    expect(spentAttempts(context.state(), "gfx")).toBe(0);

    // The scope is the host: an AI repair is obvious in `git log`.
    const messages = context.events.events.flatMap((event) =>
      event.kind === "commit" ? [event.message] : [],
    );
    expect(messages).toEqual([
      "fix(gfx): bind nginx after acme",
      "fix(gfx): bind nginx after acme",
    ]);
  });

  test("nothing changed: the commit is refused rather than invented", async () => {
    const { tool } = tools(
      { commands: [{ match: (argv) => argv.includes("status") }] },
      UNDER_REPAIR,
    );

    await expect(
      call(tool, "repair", "commit", { host: "gfx", subject: "nothing" }),
    ).rejects.toThrow("nothing to commit");
  });

  test("a unit still failed after the action is said, and the attempt is spent", async () => {
    const { context, tool } = tools({ commands: script(["nginx.service"]) }, UNDER_REPAIR);

    const result = await call(tool, "repair", "service_action", RESTART);

    expect(result.lines.at(-1)).toContain("nginx.service");
    expect(spentAttempts(context.state(), "gfx")).toBe(1);
  });
});
