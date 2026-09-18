// Step 6, report (spec § Rapport et codes de sortie): `report.md`, then the
// Matrix messages of `--send-report`.

import { fail, ok, type Result } from "../../model/result.ts";
import { readSecret } from "../commands/workspace.ts";
import { emit, log, type RunContext } from "../context.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import { parseNetwork } from "../fleet.ts";
import { homeserver, MATRIX_TOKEN, parseRooms, summaryMessage } from "../matrix.ts";
import { type Report, type ReportInput, renderReport } from "../report.ts";
import { readGeneratedJson } from "./select.ts";

export interface ReportOutcome {
  /** Short lines of `run.end`. */
  lines: string[];

  /** `false`: `--send-report` asked, a message did not reach its room (exit `3`). */
  sent: boolean;
}

interface Destination {
  homeserver: string;
  warnings: string;
  incidents: string;
}

/** Rooms of the alert bot and the client API they answer on. */
async function destination(context: RunContext): Promise<Result<Destination>> {
  const matrixJson = await readGeneratedJson(context, "matrix.nix");
  if (!matrixJson.ok) return fail(matrixJson.error);
  const rooms = parseRooms(matrixJson.value);
  if (!rooms.ok) return rooms;

  const networkJson = await readGeneratedJson(context, "network.nix");
  if (!networkJson.ok) return fail(networkJson.error);
  const network = parseNetwork(networkJson.value);
  if (!network.ok) return network;
  return ok({ ...rooms.value, homeserver: homeserver(network.value.domain) });
}

/** Token of the bot, decrypted for this process only: never logged, never recorded. */
async function readToken(context: RunContext): Promise<Result<string>> {
  const spec = readSecret(context.workspace, MATRIX_TOKEN, context.params.timeouts);
  const execution = await execute(context, spec);
  if (!succeeded(execution.result)) return fail(`${MATRIX_TOKEN}: ${describeFailure(execution)}`);
  const token = execution.stdout.join("").trim();
  return token === "" ? fail(`${MATRIX_TOKEN}: empty`) : ok(token);
}

/**
 * Warnings room on a run that went to its end, incidents room on a stop; the
 * critical hosts of the report travel on their own (spec § Rapport).
 */
async function sendMessages(
  context: RunContext,
  report: Report,
  input: ReportInput,
  error?: string,
): Promise<boolean> {
  const refuse = (reason: string) => {
    log(context, "error", `report not sent: ${reason}`);
    return false;
  };

  const rooms = await destination(context);
  if (!rooms.ok) return refuse(rooms.error);
  const token = await readToken(context);
  if (!token.ok) return refuse(token.error);

  const stopped = input.status === "failed";
  const summary = summaryMessage({
    runId: context.run.id,
    exitCode: input.exitCode,
    lines: report.lines,
    knownErrors: input.knownErrors,
    ...(stopped && error !== undefined ? { error } : {}),
  });
  const incident =
    report.incident === undefined ? undefined : `${summary}\n\n${report.incident.trimEnd()}`;
  const messages = stopped
    ? [{ room: rooms.value.incidents, text: incident ?? summary }]
    : [
        { room: rooms.value.warnings, text: summary },
        ...(incident === undefined ? [] : [{ room: rooms.value.incidents, text: incident }]),
      ];

  let delivered = true;
  for (const { room, text } of messages) {
    const result = await context.matrix.send(
      {
        homeserver: rooms.value.homeserver,
        room,
        token: token.value,
        text,
        timeoutMs: context.params.timeouts.commit * 1000,
      },
      context.signal,
    );
    if (!result.ok) delivered = refuse(`${room}: ${result.error}`);
  }
  if (delivered) log(context, "ok", `report sent (${messages.length} to Matrix)`);
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
