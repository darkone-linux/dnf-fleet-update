// Every tool of a run, and the level that publishes it.
//
// The only list: `tools/list`, the argument validation and the names allowed
// on the two executables all read it. A new family is added here.

import type { RunParams } from "../../model/params.ts";
import { codeTools } from "./code.ts";
import { hostTools } from "./host.ts";
import { logTools } from "./logs.ts";
import { stateTools } from "./state.ts";
import { highest, type RegisteredTool, reaches, type ToolLevel } from "./types.ts";

export const TOOLS: readonly RegisteredTool[] = [
  ...stateTools,
  ...logTools,
  ...codeTools,
  ...hostTools,
];

/** Name of the MCP server, as both executables are told to call it. */
export const MCP_SERVER = "fleet-update";

/** How a tool is named once the server is mounted: `mcp__<server>__<tool>`. */
export const qualified = (tool: RegisteredTool): string => `mcp__${MCP_SERVER}__${tool.name}`;

/**
 * Level the options grant, the higher of the two axes (spec mère
 * § Intégration IA). `undefined`: no tool at all — the free question still
 * answers, without a server (spec § Déclencheurs).
 */
export function toolLevel(params: RunParams): ToolLevel | undefined {
  const granted: ToolLevel[] = [];
  if (params.aiAnalysis !== "none") granted.push(params.aiAnalysis);
  if (params.aiErrorAction === "analysis") granted.push("active");
  if (params.aiErrorAction === "repair") granted.push("repair");
  return highest(granted);
}

/** What `tools/list` publishes: the filter *is* the non-escalation rule. */
export function toolsFor(level: ToolLevel): RegisteredTool[] {
  return TOOLS.filter((tool) => reaches(level, tool.level));
}

export function toolByName(level: ToolLevel, name: string): RegisteredTool | undefined {
  return toolsFor(level).find((tool) => tool.name === name);
}
