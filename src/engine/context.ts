// Run context of the steps: ports, parameters, run clock, questions.

import type { AskOption, Event, Level } from "../model/events.ts";
import type { RunParams } from "../model/params.ts";
import type { RunFlow } from "./flow.ts";
import type { KnownErrors } from "./known-errors.ts";
import type { EngineContext, LocalHost, RunStore } from "./ports.ts";
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
  flow: RunFlow;
  questions: QuestionQueue;

  /** Known errors met by the run, for the report (spec § Erreurs et réparations). */
  known: KnownErrors;

  /** Once closed, no AI tool is launched again (spec § Intégration IA). */
  ai: AiGate;

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
