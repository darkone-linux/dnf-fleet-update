// Matrix messages of a run (spec § Rapport): rooms of the alert bot, and the
// text each room receives. Pure: the sending is a port.

import { z } from "zod";
import type { ExitCode } from "../model/exit-codes.ts";
import { fail, ok, type Result } from "../model/result.ts";

/** Key of `usr/secrets/secrets.yaml` holding the bot token, as the alert bot writes it. */
export const MATRIX_TOKEN = "alertmanager-matrix-token";

export interface MatrixRooms {
  warnings: string;
  incidents: string;
}

// `var/generated/matrix.nix`, written by `just configure-alert-bot`: not merged
// into `network.nix`, so it is read on its own.
const roomsSchema = z.object({
  matrix: z.object({
    warningsRoom: z.string().min(1),
    incidentsRoom: z.string().min(1),
  }),
});

export function parseRooms(json: unknown): Result<MatrixRooms> {
  const parsed = roomsSchema.safeParse(json);
  if (!parsed.success) return fail(`matrix.nix: ${z.prettifyError(parsed.error)}`);
  const { warningsRoom, incidentsRoom } = parsed.data.matrix;
  return ok({ warnings: warningsRoom, incidents: incidentsRoom });
}

/** Client API through the public vhost, like the alert bot setup. */
export const homeserver = (domain: string) => `https://matrix.${domain}`;

export interface SummaryInput {
  runId: string;
  exitCode: ExitCode;

  /** Short lines of the report: hosts, duration, how the run ended. */
  lines: readonly string[];
  knownErrors: readonly string[];

  /** Last error of the feed: what ended the run, as the incidents room needs it. */
  error?: string;
}

/**
 * Summary sent to a room: the run, then what the report says in short. The
 * incidents message adds the error that ended the run, when there is one.
 */
export function summaryMessage(input: SummaryInput): string {
  const parts = [`**fleet-update ${input.runId}** — exit ${input.exitCode}`];
  if (input.error !== undefined) parts.push("", `error: ${input.error}`);
  parts.push("", ...input.lines.map((line) => `- ${line}`));
  if (input.knownErrors.length > 0) {
    parts.push("", "Known errors:", ...input.knownErrors.map((message) => `- ${message}`));
  }
  return parts.join("\n");
}
