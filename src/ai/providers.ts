// Argv of the AI tools (spec § Intégration IA): executables, not an API —
// prompt on stdin, answer on stdout, one line of stdout per `ai.line`.
//
// Built-in tools are always denied: the AI acts only through the MCP server
// this run serves, whose tool list is the level (spec § analyse).

import { limits } from "../engine/commands/limits.ts";
import type { CommandSpec, ToolEndpoint } from "../engine/ports.ts";
import type { Ai, Timeouts } from "../model/params.ts";
import type { AiTarget } from "./model.ts";
import { MCP_SERVER } from "./tools/registry.ts";

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

/** One call: what the AI is asked, what it is told to be, what it may use. */
export interface AiCall {
  /** User prompt, on stdin. */
  prompt: string;

  /** Replaces the tool's own system prompt; absent: the tool keeps its default. */
  system?: string;
  tools?: AiTools;
}

/** Endpoint of the run and the tool names its level publishes. */
export interface AiTools {
  endpoint: ToolEndpoint;

  /** Qualified names, as `registry.qualified` builds them. */
  names: readonly string[];
}

const headers = (endpoint: ToolEndpoint) => ({ Authorization: `Bearer ${endpoint.token}` });

/** `OPENCODE_CONFIG_CONTENT`: an inline config outranks the operator's own. */
function opencodeConfig(call: AiCall): string {
  const { tools, system } = call;
  const denied: Record<string, boolean> = { "*": false };
  for (const name of OPENCODE_TOOLS) denied[name] = false;

  // Shape `opencode mcp add` writes itself; the wildcard re-opens ours alone.
  const mcp =
    tools === undefined
      ? {}
      : {
          mcp: {
            [MCP_SERVER]: {
              type: "remote",
              url: tools.endpoint.url,
              headers: headers(tools.endpoint),
            },
          },
        };
  const allowed = tools === undefined ? {} : { [`${MCP_SERVER}*`]: true };

  // `prompt` is opencode's system prompt; `--system-prompt` is claude's.
  return JSON.stringify({
    ...mcp,
    agent: {
      [OPENCODE_AGENT]: {
        ...(system === undefined ? {} : { prompt: system }),
        tools: { ...denied, ...allowed },
      },
    },
  });
}

function claudeArgv(target: AiTarget, ai: Ai, call: AiCall): [string, ...string[]] {
  const { tools, system } = call;
  const argv: [string, ...string[]] = ["claude", "-p"];
  if (target.model !== undefined) argv.push("--model", target.model);
  if (target.effort !== undefined) argv.push("--effort", target.effort);
  if (system !== undefined) argv.push("--system-prompt", system);

  // `--tools ""` empties the built-in set only: MCP tools live on (verified).
  // `--restricted` and `--setting-sources ""` cut the `CLAUDE.md` the workspace
  // would otherwise hand it; `--bare` would too but demands an API key.
  argv.push(
    "--tools",
    "",
    "--restricted",
    "--setting-sources",
    "",
    "--permission-prompts",
    "none",
    "--max-budget-usd",
    String(ai.budgetUsd),
  );

  // Without `--mcp-config`, `--strict-mcp-config` leaves no server at all.
  argv.push("--strict-mcp-config");
  if (tools !== undefined) {
    const servers = {
      mcpServers: {
        [MCP_SERVER]: {
          type: "http",
          url: tools.endpoint.url,
          headers: headers(tools.endpoint),
        },
      },
    };
    argv.push("--mcp-config", JSON.stringify(servers), "--allowedTools", ...tools.names);
  }
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
export function aiCommand(target: AiTarget, call: AiCall, ai: Ai, timeouts: Timeouts): CommandSpec {
  const base = { stdin: call.prompt, ...limits(ai.timeoutSeconds, timeouts) };
  return target.tool === "claude"
    ? { argv: claudeArgv(target, ai, call), ...base }
    : {
        argv: opencodeArgv(target),
        env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(call) },
        ...base,
      };
}
