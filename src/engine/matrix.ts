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

  /** End-of-run AI synthesis, raw: trimmed here (spec § analyse, Rapport et Matrix). */
  summary?: readonly string[];
}

// An alert room is not a report: the synthesis is trimmed, `report.md` has it whole.
const SUMMARY_LINES = 6;
const SUMMARY_CHARS = 500;
const MORE = "(cut, full analysis in `report.md`)";

/** Head of the synthesis within both budgets; empty in, empty out. */
export function trimSummary(lines: readonly string[]): string[] {
  const text = lines.filter((line) => line.trim().length > 0);
  const first = text[0];
  if (first === undefined) return [];

  const kept: string[] = [];
  let chars = 0;
  let complete = true;
  for (const line of text) {
    if (kept.length === SUMMARY_LINES || chars + line.length > SUMMARY_CHARS) {
      complete = false;
      break;
    }
    kept.push(line);
    chars += line.length;
  }

  // One overlong paragraph: cut it rather than send nothing at all.
  if (kept.length === 0) kept.push(`${first.slice(0, SUMMARY_CHARS).trimEnd()}…`);
  return complete ? kept : [...kept, MORE];
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
  const summary = trimSummary(input.summary ?? []);
  if (summary.length > 0) parts.push("", "**AI summary**", "", ...summary);
  return parts.join("\n");
}
