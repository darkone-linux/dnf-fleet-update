// Run context of the steps: ports, parameters, run clock, questions.

import { join } from "node:path";
import type { AiAnalyses } from "../ai/analysis.ts";
import type { AiToolSession } from "../ai/server.ts";
import type { AiSuggestions } from "../ai/suggestions.ts";
import type { AskOption, Event, Level } from "../model/events.ts";
import type { RunParams } from "../model/params.ts";
import type { PersistedState } from "../model/persist.ts";
import type { RunFlow } from "./flow.ts";
import type { KnownErrors } from "./known-errors.ts";
import type { Turn } from "./pool.ts";
import type {
  EngineContext,
  LocalHost,
  RunStore,
  SourceFiles,
  SuggestionFiles,
  ToolServer,
} from "./ports.ts";
import type { SavedState } from "./resume.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the engine stamps its `t`. */
export type EventInput = DistributiveOmit<Event, "t">;

/** One question at a time: the interface shows a single `ask`. */
export class QuestionQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * AI availability of a run (spec § Intégration IA). Closed by the first call
 * that fails for good — executable absent, credentials refused; a deployment
 * is never blocked by the AI.
 *
 * Nothing probes: `--ai-error-action` defaults to `analysis`, so an eager
 * probe would run on every deployment for a tool most of them never use.
 */
export class AiGate {
  private reason?: string;

  get open(): boolean {
    return this.reason === undefined;
  }

  /** `true` the first time only: a run explains itself once. */
  close(reason: string): boolean {
    if (this.reason !== undefined) return false;
    this.reason = reason;
    return true;
  }
}

/** `--resume`: what the last run left, and the `--on` of this invocation. */
export interface ResumeContext {
  saved: SavedState;

  /** Narrows the resumed hosts; the saved selection itself is not touched. */
  filter?: string;
}

/** What one repair subject committed in this run (spec § réparation, Règle de commit). */
export interface RepairSubject {
  /** Full revision by tree: a further correction amends it while it is HEAD. */
  revs: Partial<Record<"dnf" | "consumer", string>>;

  /** Validated when last committed: the only toplevel a redeploy takes, read once. */
  validated?: Validated;
}

/** Toplevel a `validate` built, and the derivation it came from. */
export interface Validated {
  path: string;
  drv: string;
}

/** A repair session under way (spec § réparation, J10, Délai). */
export interface RepairSession {
  /** Its end cuts a `validate` still building. */
  signal: AbortSignal;

  /** Length of `state().actions` when it opened: earlier actions belong to ended sessions. */
  since: number;

  /** Last derivation evaluated for its host: an edit that leaves it unchanged reaches nothing. */
  drv?: string;
}

/** A git tree of the workspace. */
export interface GitTree {
  repo: "consumer" | "dnf";

  /** As the feed names it. */
  label: "consumer" | "dnf/";
  path: string;
}

/** Trees a run checks, stages and discards: the consumer, then `dnf/` in codev. */
export function gitTrees(context: Pick<RunContext, "workspace" | "codev">): GitTree[] {
  const consumer: GitTree = { repo: "consumer", label: "consumer", path: context.workspace };
  if (!context.codev) return [consumer];
  return [consumer, { repo: "dnf", label: "dnf/", path: join(context.workspace, "dnf") }];
}

export interface RunContext extends EngineContext {
  params: RunParams;

  /** Present only under `--resume` (`params.resume`). */
  resume?: ResumeContext;

  /** Consumer root, also the working directory. */
  workspace: string;

  /** `dnf/.git` present: `dnf/` is updated and committed too. */
  codev: boolean;
  local: LocalHost;
  run: RunStore;

  /** Trees the AI may read (spec § analyse, outils `active`). */
  sources: SourceFiles;

  /** MCP endpoint of the run; started only when a level grants tools. */
  toolServer: ToolServer;
  flow: RunFlow;
  questions: QuestionQueue;

  /** Known errors met by the run, for the report (spec § Erreurs et réparations). */
  known: KnownErrors;

  /** Once closed, no AI tool is launched again (spec § Intégration IA). */
  ai: AiGate;

  /** Fold of the run so far: what the report reads, and what a prompt is built from. */
  state: () => PersistedState;

  /** MCP endpoint of the run, opened on the first call that needs it. */
  tools: AiToolSession;

  /** What the AI concluded, for the report (spec § analyse, Rapport). */
  analyses: AiAnalyses;

  /** Suggestion files, kept across runs (spec § analyse, Suggestions d'amélioration). */
  suggestionFiles: SuggestionFiles;

  /** What this run filed or met again, and whether the review is underway. */
  suggestions: AiSuggestions;

  /** Toplevel a repair rebuilt, by host: the wave serves it on its next pass. */
  repaired: Map<string, Validated>;

  /** Repair session under way, by host. */
  repairing: Map<string, RepairSession>;

  /** Repair subjects of the run, by host: one commit each, amended (spec § Règle de commit). */
  subjects: Map<string, RepairSubject>;

  /** One repair session at a time: a commit takes the whole tree. */
  repairTurn: Turn;

  /** `clock.now()` at the start of the run: `t` of every event counts from it. */
  startedAt: number;
}

export function emit(context: RunContext, event: EventInput): void {
  const t = Math.round(context.clock.now() - context.startedAt);
  context.events.emit({ ...event, t });
}

export function log(context: RunContext, level: Level, message: string, host?: string): void {
  emit(
    context,
    host === undefined ? { kind: "log", level, message } : { kind: "log", level, host, message },
  );
}

/** Closes the gate and says why: warning at the feed, note at the report. */
export function disableAi(context: RunContext, reason: string): void {
  if (!context.ai.close(reason)) return;
  log(context, "warn", `AI unavailable: ${reason}`);
  emit(context, { kind: "note", message: `AI unavailable: ${reason}` });
}

export const YES_NO: readonly AskOption[] = [
  { value: "yes", label: "yes" },
  { value: "no", label: "no" },
];

/** Waits for the answer; `ask.close` carries the decision into `state.json`. */
export function ask(
  context: RunContext,
  id: string,
  question: string,
  options: readonly AskOption[],
): Promise<string> {
  return context.questions.run(() => askHoldingQueue(context, id, question, options));
}

/** For a task already run by `context.questions`: deciding whether to ask is part of its turn. */
export async function askHoldingQueue(
  context: RunContext,
  id: string,
  question: string,
  options: readonly AskOption[],
): Promise<string> {
  emit(context, { kind: "ask", id, question, options: [...options] });
  const value = await context.events.answer(id, context.signal);
  if (!options.some((option) => option.value === value)) {
    throw new Error(`answer "${value}" is not an option of ${id}`);
  }
  emit(context, { kind: "ask.close", id, value });
  return value;
}
