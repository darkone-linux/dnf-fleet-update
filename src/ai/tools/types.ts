// What an AI tool is, and what it may touch (spec § analyse, Exposition des
// outils).
//
// Adding a tool touches its own file and the registry list: the published
// schema, the argument validation and the trace are all derived from what the
// tool declares here.

import { z } from "zod";
import type { HostCommand } from "../../engine/commands/host.ts";
import type { Excerpt, LogName } from "../../engine/ports.ts";
import type { Rebuilt } from "../../engine/steps/build.ts";
import type { RunParams } from "../../model/params.ts";
import type { AiAction, PersistedHost, PersistedState } from "../../model/persist.ts";
import type { Suggestion } from "../suggestions.ts";

export const TOOL_LEVELS = ["passive", "active", "repair"] as const;

export type ToolLevel = (typeof TOOL_LEVELS)[number];

const RANK: Record<ToolLevel, number> = { passive: 0, active: 1, repair: 2 };

/** Levels are cumulative: `active` reaches what `passive` grants. */
export const reaches = (level: ToolLevel, wanted: ToolLevel): boolean =>
  RANK[level] >= RANK[wanted];

/** Highest of the levels, `undefined` when none is granted. */
export function highest(levels: readonly ToolLevel[]): ToolLevel | undefined {
  return levels.reduce<ToolLevel | undefined>(
    (best, level) => (best === undefined || RANK[level] > RANK[best] ? level : best),
    undefined,
  );
}

/** Refusal handed back to the model: expected data, never a run failure. */
export class ToolError extends Error {}

/** A guard said no, rather than a command failing: recorded as `refused`. */
export class Refused extends ToolError {}

/**
 * What a tool may touch, and nothing else. Narrow on purpose: a tool written
 * later cannot emit an event nor start a command of its own — the guard is
 * carried by the type, not by discipline.
 */
export interface ToolContext {
  readonly params: RunParams;

  /** `dnf/` is a git tree here, a store path otherwise. */
  readonly codev: boolean;

  /** Fold of the run: the source the report reads, so one truth. */
  state(): PersistedState;

  /** Throws `ToolError` when the name is not a host of this run. */
  host(name: string): PersistedHost;
  readLog(name: LogName, lines: number): Promise<Excerpt>;

  /** Every log the run has written so far. */
  logNames(): LogName[];

  /** Throws `ToolError` when the path leaves the readable trees. */
  readSource(path: string, lines: number): Promise<Excerpt>;

  /** Whole text of a file, for an exact replacement; same refusals as `readSource`. */
  readSourceText(path: string): Promise<string>;

  /** One level of a directory of the readable trees; same refusals as `readSource`. */
  listSource(path: string, limit: number): Promise<Excerpt>;

  /** Lines holding a literal, under a path of the readable trees; same refusals. */
  searchSource(pattern: string, path: string, limit: number): Promise<Excerpt>;

  /**
   * Writes a whole file of the repairable trees and returns its diff, already
   * in `logs/ai.log`. Throws `ToolError` on a path a human or a generator owns,
   * and on a tree that was not clean to start with.
   */
  writeSource(path: string, content: string): Promise<string[]>;

  /** Places the command on the host, as the steps do. Throws `ToolError` on failure. */
  onHost(host: string, command: HostCommand): Promise<Excerpt>;

  /**
   * `just clean`, then this host alone re-evaluated and rebuilt. On success the
   * new toplevel is kept for the redeploy; nothing else on the fleet moves.
   */
  rebuild(host: string): Promise<Rebuilt>;

  /**
   * Commits what the repair wrote as `fix(<scope>): <subject>`: `dnf/` first in
   * co-development, then the consumer with its realigned lock. Returns the
   * revisions written. Throws `ToolError` when a tree refuses — a hook is never
   * bypassed — and `Refused` when a published `dnf/` commit would name a host.
   */
  commitRepair(host: string, scope: string, subject: string): Promise<string[]>;

  /** Suggestion files kept across runs. Throws `Refused` outside the end-of-run review. */
  knownSuggestions(): Promise<Suggestion[]>;

  /**
   * Files a suggestion, or marks a known one seen by this run, its text kept.
   * Returns what happened, for the model. Throws `Refused` outside the review.
   */
  suggest(slug: string, title: string, body: string): Promise<string>;

  /** Run on its way out (stop, rollback, abort): a repair is a new operation. */
  halting(): boolean;

  /** Interactive only: `false` when the operator declined (spec § réparation). */
  confirm(id: string, question: string): Promise<boolean>;

  /** An action the run counts, not merely traces: one `ai.action`, one feed line. */
  record(entry: AiAction): void;

  /** One feed line, one line of `logs/ai.log`: no call goes untraced. */
  trace(message: string): void;
}

/** JSON Schema of one tool, as `tools/list` publishes it (`z.toJSONSchema`). */
export interface ToolSchema {
  type?: string | readonly string[];
  properties?: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: unknown;
}

export interface ToolResult {
  lines: string[];

  /** Lines left out upstream: said to the model, so it knows it holds a slice. */
  dropped?: number;
}

export interface AiTool<A> {
  /** snake_case; published to the tools as `mcp__fleet-update__<name>`. */
  name: string;
  level: ToolLevel;

  /** What the model reads to choose this tool. */
  description: string;
  input: z.ZodType<A>;

  /** Feed line of one call: `reads usr/modules/nginx.nix`. */
  summary: (args: A) => string;
  run: (context: ToolContext, args: A) => Promise<ToolResult>;
}

/** One tool with its argument type erased: what the registry and the dispatch hold. */
export interface RegisteredTool {
  readonly name: string;
  readonly level: ToolLevel;
  readonly description: string;

  /** Published by `tools/list`, derived from the zod schema. */
  readonly schema: ToolSchema;

  /** Validates, traces, runs. Throws `ToolError` on arguments the schema refuses. */
  call(context: ToolContext, raw: unknown): Promise<ToolResult>;
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
}

export function defineTool<A>(tool: AiTool<A>): RegisteredTool {
  return {
    name: tool.name,
    level: tool.level,
    description: tool.description,
    schema: z.toJSONSchema(tool.input),

    async call(context, raw) {
      const parsed = tool.input.safeParse(raw ?? {});
      if (!parsed.success) throw new ToolError(`${tool.name}: ${issuesOf(parsed.error)}`);

      // Traced before it runs: a call refused further down left a trace too.
      context.trace(tool.summary(parsed.data));
      return tool.run(context, parsed.data);
    },
  };
}

/** Excerpt as a tool hands it back: the count of dropped lines travels with it. */
export const fromExcerpt = (excerpt: Excerpt): ToolResult => ({
  lines: excerpt.lines,
  ...(excerpt.dropped > 0 ? { dropped: excerpt.dropped } : {}),
});
