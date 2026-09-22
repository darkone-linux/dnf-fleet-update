// Argv of the two executables: the contract of what the AI is allowed to be.

import { describe, expect, test } from "bun:test";
import { DEFAULT_AI, DEFAULT_TIMEOUTS } from "../model/params.ts";
import type { AiTarget } from "./model.ts";
import { type AiTools, aiCommand } from "./providers.ts";

const PROMPT = "why did nginx fail on nlt?";

const TOOLS: AiTools = {
  endpoint: { url: "http://127.0.0.1:4242/mcp", token: "s3cr3t" },
  names: ["mcp__fleet-update__deployment_state", "mcp__fleet-update__host_log"],
};

const command = (target: AiTarget, tools?: AiTools) =>
  aiCommand(target, PROMPT, DEFAULT_AI, DEFAULT_TIMEOUTS, tools);

/** Value following `flag` in the argv. */
const after = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("claude", () => {
  test("model, effort, and no built-in tool left enabled", () => {
    const argv = command({ tool: "claude", model: "opus", effort: "high" }).argv;

    expect(argv.slice(0, 6)).toEqual(["claude", "-p", "--model", "opus", "--effort", "high"]);
    expect(after(argv, "--tools")).toBe("");
    expect(argv).toContain("--restricted");
    expect(after(argv, "--permission-prompts")).toBe("none");
  });

  test("the workspace CLAUDE.md is cut: `--restricted` and no setting source", () => {
    const argv = command({ tool: "claude" }).argv;

    expect(argv).toContain("--restricted");
    expect(after(argv, "--setting-sources")).toBe("");

    // `--bare` would cut them too, but forces an API key and ignores OAuth.
    expect(argv).not.toContain("--bare");
  });

  test("the budget is carried to the tool that knows how to hold it", () => {
    expect(after(command({ tool: "claude" }).argv, "--max-budget-usd")).toBe(
      String(DEFAULT_AI.budgetUsd),
    );
  });

  test("without tools, strict MCP leaves no server at all", () => {
    const argv = command({ tool: "claude" }).argv;

    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--allowedTools");
  });

  test("with tools, the endpoint is passed and only our names are allowed", () => {
    const argv = command({ tool: "claude" }, TOOLS).argv;
    const config = JSON.parse(after(argv, "--mcp-config") ?? "{}");

    expect(config.mcpServers["fleet-update"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4242/mcp",
      headers: { Authorization: "Bearer s3cr3t" },
    });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual([...TOOLS.names]);
  });
});

describe("opencode", () => {
  test("`--variant` carries the effort, tools denied by inline config", () => {
    const spec = command({ tool: "opencode", model: "ollama/qwen3:32b", effort: "high" });

    expect(spec.argv).toEqual([
      "opencode",
      "run",
      "--pure",
      "--agent",
      "fleet-update",
      "-m",
      "ollama/qwen3:32b",
      "--variant",
      "high",
    ]);

    const config = JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.agent["fleet-update"].tools).toMatchObject({ "*": false, bash: false });
    expect(Object.values(config.agent["fleet-update"].tools)).not.toContain(true);
    expect(config.mcp).toBeUndefined();
  });

  test("with tools, the remote server is declared and re-opened by wildcard", () => {
    const spec = command({ tool: "opencode" }, TOOLS);
    const config = JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? "{}");

    // Shape `opencode mcp add --url --header` writes itself.
    expect(config.mcp["fleet-update"]).toEqual({
      type: "remote",
      url: "http://127.0.0.1:4242/mcp",
      headers: { Authorization: "Bearer s3cr3t" },
    });
    expect(config.agent["fleet-update"].tools).toMatchObject({
      "*": false,
      bash: false,
      "fleet-update*": true,
    });
  });
});

describe("both", () => {
  test("a tool alone carries neither model nor effort", () => {
    expect(command({ tool: "claude" }).argv).not.toContain("--model");
    expect(command({ tool: "opencode" }).argv).not.toContain("-m");
  });

  test("the prompt travels on stdin, never in argv", () => {
    for (const tool of ["claude", "opencode"] as const) {
      const spec = command({ tool }, TOOLS);
      expect(spec.stdin).toBe(PROMPT);
      expect(spec.argv).not.toContain(PROMPT);
    }
  });

  test("the token never lands in argv of the tool that takes a config by env", () => {
    expect(command({ tool: "opencode" }, TOOLS).argv.join(" ")).not.toContain("s3cr3t");
  });

  test("bounded like every other command", () => {
    const spec = command({ tool: "claude" });
    expect(spec.timeoutMs).toBe(DEFAULT_AI.timeoutSeconds * 1000);
    expect(spec.killGraceMs).toBe(DEFAULT_TIMEOUTS.killGrace * 1000);
  });
});
