// The tools as the model reaches them: level filter, schemas, guards, results.

import { describe, expect, test } from "bun:test";
import type { EventInput } from "../../engine/context.ts";
import { initialPersisted, type PersistedState, persist } from "../../model/persist.ts";
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

function state(): PersistedState {
  return EVENTS.reduce<PersistedState>(
    (folded, event, index) => persist(folded, { ...event, t: index * 1000 }),
    initialPersisted(),
  );
}

function tools(options: FakeRunOptions = {}) {
  const context = fakeRunContext(options);
  const folded = state();
  return { context, tool: toolContext(context, () => folded), folded };
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
    expect(active).toEqual([...passive, "read_code", "host_units", "host_journal"]);
    expect(toolByName("passive", "read_code")).toBeUndefined();
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
