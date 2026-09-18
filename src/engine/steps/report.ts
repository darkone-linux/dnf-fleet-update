// Step 6, report (spec § Rapport et codes de sortie): `report.md`, then the
// Matrix messages of `--send-report`, sent by the framework recipe.

import { sendMessage } from "../commands/workspace.ts";
import { emit, log, type RunContext } from "../context.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import { type AlertRoom, SEND_MSG, summaryMessage } from "../matrix.ts";
import { type Report, type ReportInput, renderReport } from "../report.ts";

export interface ReportOutcome {
  /** Short lines of `run.end`. */
  lines: string[];

  /** `false`: `--send-report` asked, a message did not reach its room (exit `3`). */
  sent: boolean;
}

/**
 * Warnings room on a run that went to its end, incidents room on a stop; the
 * critical hosts of the report travel on their own (spec § Rapport).
 */
function messages(
  report: Report,
  input: ReportInput,
  error?: string,
): { room: AlertRoom; text: string }[] {
  const stopped = input.status === "failed";
  const summary = summaryMessage({
    exitCode: input.exitCode,
    facts: report.facts,
    knownErrors: input.knownErrors,
    ...(stopped && error !== undefined ? { error } : {}),
  });
  const incident =
    report.incident === undefined ? undefined : `${summary}\n\n${report.incident.trimEnd()}`;

  if (stopped) return [{ room: "incidents", text: incident ?? summary }];
  return [
    { room: "warnings", text: summary },
    ...(incident === undefined ? [] : [{ room: "incidents" as const, text: incident }]),
  ];
}

async function sendMessages(
  context: RunContext,
  report: Report,
  input: ReportInput,
  error?: string,
): Promise<boolean> {
  const { workspace, params } = context;
  let delivered = true;

  for (const { room, text } of messages(report, input, error)) {
    const spec = sendMessage(workspace, room, text, params.timeouts);
    const execution = await execute(context, spec, { signal: context.signal });
    if (succeeded(execution.result)) continue;

    delivered = false;
    log(context, "error", `report not sent: ${room}: ${describeFailure(execution)}`);

    // Nothing configured here: the other room would fail the same way.
    if (execution.result.exitCode === SEND_MSG.notConfigured) break;
  }
  if (delivered) log(context, "ok", "report sent to Matrix");
  return delivered;
}

/**
 * Writes `report.md`, then sends it under `--send-report`. `error`: last error
 * of the feed, title of the incidents message.
 */
export async function report(
  context: RunContext,
  input: ReportInput,
  error?: string,
): Promise<ReportOutcome> {
  emit(context, { kind: "step.start", step: "report" });
  const rendered = renderReport(input);
  context.run.writeReport(rendered.markdown);

  // Aborted `now`: the process is being killed, no time left for the network.
  const send = context.params.sendReport && !context.signal.aborted;
  const sent = send ? await sendMessages(context, rendered, input, error) : true;
  emit(context, { kind: "step.end", step: "report", status: sent ? "ok" : "error" });
  return { lines: rendered.lines, sent };
}
