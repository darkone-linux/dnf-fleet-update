// One AI question, one streamed answer (spec § Intégration IA, § Réponses de
// l'IA): `ai` opens the block, `ai.line` carries each line of the answer,
// `ai.end` closes it — whatever the outcome, so no block stays open.

import { disableAi, emit, log, type RunContext } from "../engine/context.ts";
import { errorLines, execute, succeeded } from "../engine/exec.ts";
import { parseAiModel } from "./model.ts";
import { aiCommand } from "./providers.ts";

export interface AiQuestion {
  /** Names the block: `ai.line` and `ai.end` carry it back. */
  id: string;

  /** Title of the block, rendered as `AI <summary>`. */
  summary: string;
  prompt: string;
}

/**
 * Asks the tool and streams its answer. Rejects nothing: a failure is a feed
 * line, never an exception — the run goes on without an answer. Returns the
 * answer lines, empty when there is none.
 */
export async function askAi(context: RunContext, question: AiQuestion): Promise<string[]> {
  const { id, summary, prompt } = question;
  if (!context.ai.open) return [];

  const target = parseAiModel(context.params.aiModel);
  if (!target.ok) {
    disableAi(context, target.error);
    return [];
  }

  const spec = aiCommand(target.value, prompt, context.params.ai, context.params.timeouts);
  emit(context, { kind: "ai", id, message: summary });
  try {
    const execution = await execute(context, spec, {
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
  return errorLines(execution).at(-1) ?? `exit ${execution.result.exitCode}`;
}
