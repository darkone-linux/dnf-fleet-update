import { describe, expect, test } from "bun:test";
import { parseAiModel } from "./model.ts";

describe("parseAiModel", () => {
  test("tool alone", () => {
    expect(parseAiModel("claude")).toEqual({
      ok: true,
      value: { tool: "claude", model: undefined, effort: undefined },
    });
  });

  test("tool, model and effort; ollama tags keep their colon", () => {
    expect(parseAiModel("claude:opus@high")).toEqual({
      ok: true,
      value: { tool: "claude", model: "opus", effort: "high" },
    });
    expect(parseAiModel("opencode:ollama/qwen3:32b")).toEqual({
      ok: true,
      value: { tool: "opencode", model: "ollama/qwen3:32b", effort: undefined },
    });
  });

  test("effort without a model", () => {
    expect(parseAiModel("claude@max")).toEqual({
      ok: true,
      value: { tool: "claude", model: undefined, effort: "max" },
    });
  });

  test("an unknown tool is refused", () => {
    const result = parseAiModel("gemini:pro");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("<tool>[:<model>][@<effort>]");
  });
});
