// One AI question, one streamed answer (spec § Intégration IA, § Réponses de
// l'IA): `ai` opens the block, `ai.line` carries each line of the answer,
// `ai.end` closes it — whatever the outcome, so no block stays open.

import { disableAi, emit, log, type RunContext } from "../engine/context.ts";
import { errorLines, execute, succeeded } from "../engine/exec.ts";
import { parseAiModel } from "./model.ts";
import { type AiTools, aiCommand } from "./providers.ts";

export interface AiQuestion {
  /** Names the block: `ai.line` and `ai.end` carry it back. */
  id: string;

  /** Title of the block, rendered as `AI <summary>`. */
  summary: string;
  prompt: string;

  /** MCP endpoint and published names; absent: the tool answers without tools. */
  tools?: AiTools;

  /** Replaces the tool's own system prompt (spec § analyse, Prompts). */
  system?: string;
}

/**
 * Asks the tool and streams its answer. Rejects nothing: a failure is a feed
 * line, never an exception — the run goes on without an answer. Returns the
 * answer lines, empty when there is none.
 *
 * `signal` replaces the run's own: the end of the run cuts a pending answer,
 * so nothing is emitted after `run.end`.
 */
export async function askAi(
  context: RunContext,
  question: AiQuestion,
  signal?: AbortSignal,
): Promise<string[]> {
  const { id, summary, prompt } = question;
  if (!context.ai.open) return [];

  const target = parseAiModel(context.params.aiModel);
  if (!target.ok) {
    disableAi(context, target.error);
    return [];
  }

  const spec = aiCommand(
    target.value,
    {
      prompt,
      ...(question.system === undefined ? {} : { system: question.system }),
      ...(question.tools === undefined ? {} : { tools: question.tools }),
    },
    context.params.ai,
    context.params.timeouts,
  );
  emit(context, { kind: "ai", id, message: summary });
  try {
    const execution = await execute(context, spec, {
      ...(signal === undefined ? {} : { signal }),
      log: { phase: "ai" },
      onLine: (line) => {
        if (line.stream === "stdout") emit(context, { kind: "ai.line", id, line: line.line });
      },
    });
    if (succeeded(execution.result)) return execution.stdout;

    // A bad question or a transient refusal is not a reason to drop the AI for
    // the whole run: said here, the gate stays open (spec § analyse, à revoir).
    log(context, "error", `AI ${target.value.tool}: ${reasonOf(execution)}`);
    return [];
  } catch {
    // `CommandRunner` rejects only when the program cannot start: no PATH
    // entry, nothing to retry. Definitive for this run.
    disableAi(context, `${target.value.tool} could not be started`);
    return [];
  } finally {
    emit(context, { kind: "ai.end", id });
  }
}

function reasonOf(execution: Parameters<typeof errorLines>[0]): string {
  if (execution.result.timedOut) return "timed out";
  const last = errorLines(execution).at(-1);

  // `claude --max-budget-usd`, enforced under a subscription too: said plainly.
  if (last?.includes("Exceeded USD budget") === true) return "budget exhausted";
  return last ?? `exit ${execution.result.exitCode}`;
}
