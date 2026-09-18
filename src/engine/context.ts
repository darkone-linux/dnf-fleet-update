// Run context of the steps: ports, parameters, run clock, questions.

import type { AskOption, Event, Level } from "../model/events.ts";
import type { RunParams } from "../model/params.ts";
import type { RunFlow } from "./flow.ts";
import type { KnownErrors } from "./known-errors.ts";
import type { EngineContext, LocalHost, MatrixSender, RunStore } from "./ports.ts";
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

  /** `--send-report` only: the alert bot rooms (spec § Rapport). */
  matrix: MatrixSender;
  flow: RunFlow;
  questions: QuestionQueue;

  /** Known errors met by the run, for the report (spec § Erreurs et réparations). */
  known: KnownErrors;

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
