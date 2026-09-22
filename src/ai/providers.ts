// Argv of the AI tools (spec § Intégration IA): executables, not an API —
// prompt on stdin, answer on stdout, one line of stdout per `ai.line`.
//
// Every built-in tool is denied: the AI acts only through fleet-update's own
// tools, and this milestone ships none. Both tools resolve from `PATH`.

import { limits } from "../engine/commands/limits.ts";
import type { CommandSpec } from "../engine/ports.ts";
import type { Ai, Timeouts } from "../model/params.ts";
import type { AiTarget } from "./model.ts";

/** Named by the inline config below, so `--agent` has something to select. */
const OPENCODE_AGENT = "fleet-update";

// Denied one by one: opencode documents its wildcard for MCP servers, not for
// the built-in set. The `*` entry is the belt, these names the braces.
const OPENCODE_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "task",
  "webfetch",
  "todowrite",
  "todoread",
];

/** `OPENCODE_CONFIG_CONTENT`: an inline config outranks the operator's own. */
function opencodeConfig(): string {
  const tools: Record<string, boolean> = { "*": false };
  for (const name of OPENCODE_TOOLS) tools[name] = false;
  return JSON.stringify({ agent: { [OPENCODE_AGENT]: { tools } } });
}

function claudeArgv(target: AiTarget): [string, ...string[]] {
  const argv: [string, ...string[]] = ["claude", "-p"];
  if (target.model !== undefined) argv.push("--model", target.model);
  if (target.effort !== undefined) argv.push("--effort", target.effort);

  // `--tools ""` empties the built-in set; `--strict-mcp-config` without a
  // `--mcp-config` leaves no MCP server; nothing may prompt in `-p`.
  argv.push("--tools", "", "--strict-mcp-config", "--permission-prompts", "none");
  return argv;
}

function opencodeArgv(target: AiTarget): [string, ...string[]] {
  const argv: [string, ...string[]] = ["opencode", "run", "--pure", "--agent", OPENCODE_AGENT];
  if (target.model !== undefined) argv.push("-m", target.model);

  // `--variant` is opencode's reasoning effort; `--effort` is claude's.
  if (target.effort !== undefined) argv.push("--variant", target.effort);
  return argv;
}

/** One question, one answer. The prompt travels on stdin, never in argv. */
export function aiCommand(
  target: AiTarget,
  prompt: string,
  ai: Ai,
  timeouts: Timeouts,
): CommandSpec {
  const base = { stdin: prompt, ...limits(ai.timeoutSeconds, timeouts) };
  return target.tool === "claude"
    ? { argv: claudeArgv(target), ...base }
    : { argv: opencodeArgv(target), env: { OPENCODE_CONFIG_CONTENT: opencodeConfig() }, ...base };
}
