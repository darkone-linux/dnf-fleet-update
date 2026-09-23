// AI analysis of a failure (spec § analyse, Déclencheurs).
//
// Never blocks a deployment: an analysis that fails, times out or spends its
// budget leaves the host exactly where it was, and the run goes on.

import type { RunContext } from "../engine/context.ts";
import type { HostTable } from "../engine/hosts.ts";
import { freePrompt, hostPrompt, runPrompt, systemPrompt } from "./prompts.ts";
import type { AiTools } from "./providers.ts";
import { askAi } from "./session.ts";
import { toolLevel } from "./tools/registry.ts";

/** What the AI concluded, kept for the report (spec § Rapport et Matrix). */
export interface Analysis {
  /** Absent on the end-of-run summary. */
  host?: string;
  lines: string[];
}

/** Collected by the run, like the known errors it met. */
export class AiAnalyses {
  private readonly entries: Analysis[] = [];

  add(lines: readonly string[], host?: string): void {
    if (lines.length === 0) return;
    this.entries.push({ ...(host === undefined ? {} : { host }), lines: [...lines] });
  }

  all(): readonly Analysis[] {
    return this.entries;
  }
}

/** Nothing is asked once the run is halting: an analysis is a new operation. */
export function quiet(context: RunContext): boolean {
  return !context.ai.open || context.flow.halt.aborted || context.signal.aborted;
}

export interface AiQuestion {
  id: string;
  summary: string;
  prompt: string;

  /** The repair session: the only one told it may act (spec § réparation). */
  acting?: boolean;
}

/** One session with the tools of the run's level attached, when there are any. */
export async function ask(
  context: RunContext,
  question: AiQuestion,
  signal?: AbortSignal,
): Promise<string[]> {
  const { id, summary, prompt, acting } = question;
  const tools: AiTools | undefined = await context.tools.start(context, context.state);
  return askAi(
    context,
    {
      id,
      summary,
      prompt,
      system: systemPrompt(toolLevel(context.params), acting ?? false),
      ...(tools === undefined ? {} : { tools }),
    },
    signal,
  );
}

export interface AnalyseOptions {
  /**
   * `false`: the host keeps its state. A recovered host is explained, not
   * judged — and `tested` / `deployed` have no way back from `ai-analysing`.
   */
  mark?: boolean;
}

/**
 * Analysis of one host, between the deterministic collection and the question
 * that decides its fate. Marked `ai-analysing` meanwhile, and back where it
 * came from: an analysis repairs nothing. Whether the options allow it at all
 * is the caller's call — the two triggers read different ones.
 */
export async function analyseHost(
  context: RunContext,
  hosts: HostTable,
  name: string,
  options: AnalyseOptions = {},
): Promise<void> {
  if (quiet(context)) return;
  const persisted = context.state().hosts.find((candidate) => candidate.name === name);
  if (persisted === undefined) return;

  // Kept across both transitions: `set` takes the reason from its detail, and
  // losing it would lose why the host stopped.
  const { state: previous, note } = hosts.get(name);
  const mark = options.mark ?? true;
  if (mark) hosts.set(name, "ai-analysing", { note });
  try {
    const answer = await ask(context, {
      id: `analysis-${name}`,
      summary: `analysing ${name}`,
      prompt: hostPrompt(context.state(), persisted, context.params.aiContext),
    });
    context.analyses.add(answer, name);
  } finally {
    if (mark && hosts.get(name).state === "ai-analysing") hosts.set(name, previous, { note });
  }
}

/**
 * Free question of the operator (`a`). Answered whatever `--ai-analysis` says,
 * with the tools of the current level and no more (spec § Déclencheurs): `none`
 * removes the tools and the automatic analysis, not the conversation.
 */
export async function analyseFree(
  context: RunContext,
  id: string,
  question: string,
  signal?: AbortSignal,
): Promise<void> {
  await ask(
    context,
    {
      id,
      summary: question,
      prompt: freePrompt(context.state(), question, context.params.aiContext),
    },
    signal,
  );
}

/** End of run, `--ai-analysis` ≠ `none`: the summary the report carries. */
export async function analyseRun(context: RunContext): Promise<void> {
  if (context.params.aiAnalysis === "none" || quiet(context)) return;
  const answer = await ask(context, {
    id: "analysis-run",
    summary: "summarising the run",
    prompt: runPrompt(context.state(), context.params.aiContext),
  });
  context.analyses.add(answer);
}
