// Matrix messages of a run (spec § Rapport): which room, and what it reads.
//
// Transport belongs to the framework (`just send-msg`): rooms, token and
// homeserver stay there, the tool owns the text.

import type { ExitCode } from "../model/exit-codes.ts";
import { capitalize } from "./report.ts";

/** Alert rooms of the framework, as `just send-msg` names them. */
export type AlertRoom = "warnings" | "incidents";

/** Exit codes of `just send-msg` (`dnf/just/scripts/send-msg.sh`). */
export const SEND_MSG = {
  /** No room, no token, missing program: the next room would fail the same way. */
  notConfigured: 10,
  refused: 11,
} as const;

export interface SummaryInput {
  exitCode: ExitCode;

  /** Bullets of the report: when, options, hosts, how the run ended. */
  facts: readonly string[];
  knownErrors: readonly string[];

  /** Last error of the feed: what ended the run, as the incidents room needs it. */
  error?: string;
}

/**
 * Summary sent to a room: the run, then what the report says in short. The
 * incidents message adds the error that ended the run, when there is one.
 */
export function summaryMessage(input: SummaryInput): string {
  const parts = [`**Fleet Update Report** (${input.exitCode})`];
  if (input.error !== undefined) parts.push("", `Error: ${input.error}`);
  parts.push("", ...input.facts.map((fact) => `- ${fact}`));
  if (input.knownErrors.length > 0) {
    const listed = input.knownErrors.map((message) => `- ${capitalize(message)}`);
    parts.push("", "Known errors:", ...listed);
  }
  return parts.join("\n");
}
