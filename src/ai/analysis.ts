// AI analysis of a failure (spec § analyse, Déclencheurs).
//
// Never blocks a deployment: an analysis that fails, times out or spends its
// budget leaves the host exactly where it was, and the run goes on.

import type { RunContext } from "../engine/context.ts";
import type { HostTable } from "../engine/hosts.ts";
import {
  buildPrompt,
  freePrompt,
  hostPrompt,
  type RepairConclusion,
  runPrompt,
  suggestionsPrompt,
  systemPrompt,
} from "./prompts.ts";
import { type AiTools, forSession } from "./providers.ts";
import { askAi } from "./session.ts";
import { toolLevel } from "./tools/registry.ts";
import { ACTING, type SessionKind } from "./tools/types.ts";
import { runWarnings } from "./warnings.ts";

/** What the AI concluded, kept for the report (spec § Rapport et Matrix). */
export interface Analysis {
  /** Absent on the end-of-run summary. */
  host?: string;

  /** A failed build: every host it broke, `host` the one whose log was read. */
  hosts?: string[];
  lines: string[];
}

const entry = (lines: readonly string[], host?: string, hosts?: readonly string[]): Analysis => ({
  ...(host === undefined ? {} : { host }),
  ...(hosts === undefined ? {} : { hosts: [...hosts] }),
  lines: [...lines],
});

/** Collected by the run, like the known errors it met. */
export class AiAnalyses {
  private readonly entries: Analysis[] = [];
  private readonly repaired: RepairConclusion[] = [];

  add(lines: readonly string[], host?: string, hosts?: readonly string[]): void {
    if (lines.length > 0) this.entries.push(entry(lines, host, hosts));
  }

  all(): readonly Analysis[] {
    return this.entries;
  }

  /** What a repair session said it did and left for a human: read by the review. */
  addRepair(lines: readonly string[], host: string, hosts?: readonly string[]): void {
    if (lines.length === 0) return;
    this.repaired.push({
      host,
      ...(hosts === undefined ? {} : { hosts: [...hosts] }),
      lines: [...lines],
    });
  }

  repairs(): readonly RepairConclusion[] {
    return this.repaired;
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

  /** Default `analysis`; `repair` and `build-repair` alone are told they may act (spec § réparation). */
  session?: SessionKind;
}

/** One session with the tools of the run's level attached, when there are any. */
export async function ask(
  context: RunContext,
  question: AiQuestion,
  signal?: AbortSignal,
): Promise<string[]> {
  const { id, summary, prompt, session = "analysis" } = question;
  const { ai } = context.params;
  const run: AiTools | undefined = await context.tools.start(context, context.state);
  const tools = run === undefined ? undefined : forSession(run, session);
  return askAi(
    context,
    {
      id,
      summary,
      prompt,
      system: systemPrompt(toolLevel(context.params), session, context.params.repair.aiAttempts),

      // A repair rebuilds inside its session: `validate` outlasts an answer.
      timeoutSeconds: ACTING.includes(session) ? ai.repairTimeoutSeconds : ai.timeoutSeconds,
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
 * Analysis of a failed build (spec § réparation, J10): one session for every
 * host the failure broke, read through the host whose own build met it. All
 * of them `ai-analysing` meanwhile, back to `failed` with their reason after.
 */
export async function analyseGroup(
  context: RunContext,
  hosts: HostTable,
  group: { hosts: readonly string[]; representative: string },
): Promise<void> {
  if (quiet(context)) return;
  const persisted = context.state().hosts.find((host) => host.name === group.representative);
  if (persisted === undefined) return;

  const notes = new Map(group.hosts.map((name) => [name, hosts.get(name).note]));
  for (const [name, note] of notes) hosts.set(name, "ai-analysing", { note });
  try {
    const answer = await ask(context, {
      id: `analysis-${group.representative}`,
      summary: `analysing the build of ${group.hosts.join(", ")}`,
      prompt: buildPrompt(context.state(), persisted, group.hosts, context.params.aiContext),
    });
    context.analyses.add(answer, group.representative, group.hosts);
  } finally {
    for (const [name, note] of notes) {
      if (hosts.get(name).state === "ai-analysing") hosts.set(name, "failed", { note });
    }
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

/**
 * End of run, `--ai-analysis active`: the warnings, and what the repairs left
 * undone, reviewed for improvements filed as suggestions (spec § Suggestions
 * d'amélioration). Nothing to review, nothing paid for.
 */
export async function reviewRun(context: RunContext): Promise<void> {
  if (context.params.aiAnalysis !== "active" || quiet(context)) return;
  const groups = await runWarnings(context.run.logNames(), (name, lines) =>
    context.run.readLog(name, lines),
  );
  const repairs = context.analyses.repairs();
  if (groups.length === 0 && repairs.length === 0) return;

  context.suggestions.reviewing = true;
  try {
    await ask(context, {
      id: "suggestions",
      summary: "reviewing the run for improvements",
      prompt: suggestionsPrompt(context.state(), repairs, context.params.aiContext),
      session: "suggestions",
    });
  } finally {
    context.suggestions.reviewing = false;
  }
}
