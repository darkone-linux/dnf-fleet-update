// Warnings of a run, grouped (spec § analyse, `run_warnings`).
//
// What the suggestions session starts from: fifty logs read once here rather
// than by the model, the same warning on ten hosts counted once.

import type { Excerpt, LogName } from "../engine/ports.ts";

/** A line worth a look: nix, activation and journal all say it with one of these. */
const WARNING = /\b(warning|deprecated|obsolete|renamed)\b/i;

/** The AI's own logs: its answers quote the warnings they discuss. */
const AI_PHASE = "ai";

/** Lines read per log, from its end. */
export const WARNING_LOG_LINES = 5000;

/** Groups handed back at most, the rest counted. */
const MAX_GROUPS = 80;

/** Raw example of a group: one line of the answer, past this it is cut. */
const EXAMPLE_CHARS = 200;

/** `sept. 24 22:07:17 gfx systemd[1]: ` and `2026-09-24T22:07:17-02:00 gfx …: ` */
const JOURNAL_PREFIX = /^(\S+ +\d{1,2} \d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\S+) \S+ /;

/** Store and NAR hashes: nix base32, 32 characters and more. */
const HASH = /[0-9a-z]{32,}/g;

export interface WarningGroup {
  /** First line met, as written. */
  example: string;
  count: number;
  hosts: string[];
  phases: string[];
}

export interface WarningLog {
  name: LogName;
  lines: readonly string[];
}

/** Shape shared by the lines of one group: dates, hashes and numbers masked. */
export function warningShape(line: string): string {
  return line.trim().replace(JOURNAL_PREFIX, "").replace(HASH, "…").replace(/\d+/g, "#");
}

/** Groups by shape, most frequent first; ties by example, for a stable answer. */
export function groupWarnings(logs: readonly WarningLog[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const { name, lines } of logs) {
    if (name.phase === AI_PHASE) continue;
    for (const line of lines) {
      if (!WARNING.test(line)) continue;
      const shape = warningShape(line);
      const group = groups.get(shape) ?? { example: line.trim(), count: 0, hosts: [], phases: [] };
      group.count += 1;
      if (name.host !== undefined && !group.hosts.includes(name.host)) group.hosts.push(name.host);
      if (!group.phases.includes(name.phase)) group.phases.push(name.phase);
      groups.set(shape, group);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.example.localeCompare(b.example),
  );
}

/** One line per group: `3× gfx, nlt (test, diag): <example>`. */
export function renderWarnings(groups: readonly WarningGroup[]): Excerpt {
  const kept = groups.slice(0, MAX_GROUPS).map((group) => {
    const where = group.hosts.length > 0 ? group.hosts.join(", ") : "run";
    const example = group.example.slice(0, EXAMPLE_CHARS);
    return `${group.count}× ${where} (${group.phases.join(", ")}): ${example}`;
  });
  return { lines: kept, dropped: groups.length - kept.length };
}

/** Every log of the run but the AI's, read from its end, grouped. */
export async function runWarnings(
  names: readonly LogName[],
  read: (name: LogName, lines: number) => Promise<Excerpt>,
): Promise<WarningGroup[]> {
  const logs: WarningLog[] = [];
  for (const name of names) {
    if (name.phase === AI_PHASE) continue;
    logs.push({ name, lines: (await read(name, WARNING_LOG_LINES)).lines });
  }
  return groupWarnings(logs);
}
