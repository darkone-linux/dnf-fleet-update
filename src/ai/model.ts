// AI target of a run: the `<tool>[:<model>][@<effort>]` of `--ai-model`.
//
// Model and effort are handed to the tool as they came: an unknown value is
// the tool's error to report, not ours (spec § Intégration IA).

import { fail, ok, type Result } from "../model/result.ts";

export const AI_TOOLS = ["claude", "opencode"] as const;

export type AiTool = (typeof AI_TOOLS)[number];

export interface AiTarget {
  tool: AiTool;
  model?: string;
  effort?: string;
}

// Effort after `@`, never after `:`: an ollama tag carries its own colon
// (`opencode:ollama/qwen3:32b`).
const SYNTAX = /^(claude|opencode)(?::([^@\s]+))?(?:@([a-zA-Z0-9_-]+))?$/;

export function parseAiModel(value: string): Result<AiTarget> {
  const match = SYNTAX.exec(value);
  if (!match) return fail(`--ai-model: expected <tool>[:<model>][@<effort>], got "${value}"`);
  return ok({ tool: match[1] as AiTool, model: match[2], effort: match[3] });
}
