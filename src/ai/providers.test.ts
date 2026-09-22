import { describe, expect, test } from "bun:test";
import { DEFAULT_AI, DEFAULT_TIMEOUTS } from "../model/params.ts";
import type { AiTarget } from "./model.ts";
import { aiCommand } from "./providers.ts";

const command = (target: AiTarget, prompt = "why did nginx fail on nlt?") =>
  aiCommand(target, prompt, DEFAULT_AI, DEFAULT_TIMEOUTS);

describe("aiCommand", () => {
  test("claude: model, effort, and no tool left enabled", () => {
    expect(command({ tool: "claude", model: "opus", effort: "high" }).argv).toEqual([
      "claude",
      "-p",
      "--model",
      "opus",
      "--effort",
      "high",
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-prompts",
      "none",
    ]);
  });

  test("opencode: `--variant` carries the effort, tools denied by inline config", () => {
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
  });

  test("a tool alone carries neither model nor effort", () => {
    expect(command({ tool: "claude" }).argv).not.toContain("--model");
    expect(command({ tool: "opencode" }).argv).not.toContain("-m");
  });

  test("the prompt travels on stdin, never in argv", () => {
    const prompt = "why did nginx fail on nlt?";
    for (const tool of ["claude", "opencode"] as const) {
      const spec = command({ tool });
      expect(spec.stdin).toBe(prompt);
      expect(spec.argv).not.toContain(prompt);
    }
  });

  test("bounded like every other command", () => {
    const spec = command({ tool: "claude" });
    expect(spec.timeoutMs).toBe(DEFAULT_AI.timeoutSeconds * 1000);
    expect(spec.killGraceMs).toBe(DEFAULT_TIMEOUTS.killGrace * 1000);
  });
});
