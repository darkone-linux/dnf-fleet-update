// Live reads on a fleet host, read-only (spec § analyse, outils `active`).
//
// Through the commands the steps already use: identity `nix`, delays of
// § Délais, argv arrays. A unit name is matched against `UNIT` before it ever
// reaches argv.

import { z } from "zod";
import {
  failedUnits,
  JOURNAL_SCOPES,
  systemStatus,
  UNIT,
  unitJournal,
} from "../../engine/commands/host.ts";
import type { PersistedState } from "../../model/persist.ts";
import { defineTool, fromExcerpt, type RegisteredTool } from "./types.ts";

/** Journal window: since the wave of the host started, as the collection does. */
function waveWindow(state: PersistedState, host: string): number {
  const wave = state.waves.findLast((candidate) => candidate.hosts.includes(host));
  const startedAt = wave?.startedAt ?? 0;
  return Math.max(1, Math.round((state.lastEventAt - startedAt) / 1000));
}

const hostUnits = defineTool({
  name: "host_units",
  level: "active",
  description:
    "Ask a host what it is running right now: systemctl status, then the units it reports as failed. Read-only.",
  input: z.strictObject({ host: z.string().describe("host name, as deployment_state lists it") }),
  summary: (args) => `asks ${args.host} for its failed units`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const { timeouts } = context.params;
    const status = await context.onHost(host.name, systemStatus(timeouts));
    const failed = await context.onHost(host.name, failedUnits(timeouts));
    return { lines: [...status.lines, "", "failed units:", ...failed.lines] };
  },
});

const hostJournal = defineTool({
  name: "host_journal",
  level: "active",
  description:
    "Journal of one unit on a host, since its deployment wave started. Read-only. A user unit (one a home-manager-<login>.service starts, for instance) logs to its user's manager: ask with scope user.",
  input: z.strictObject({
    host: z.string().describe("host name, as deployment_state lists it"),
    unit: z.string().regex(UNIT).describe("unit name, e.g. nginx.service"),
    scope: z
      .enum(JOURNAL_SCOPES)
      .optional()
      .describe("system (default) or user: a user unit, whatever user runs it"),
    lines: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("journal lines kept; defaults to the run's own bound"),
  }),
  summary: (args) =>
    `reads the journal of ${args.scope === "user" ? "user unit " : ""}${args.unit} on ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const { timeouts, ai } = context.params;
    const window = waveWindow(context.state(), host.name);
    const lines = args.lines ?? ai.logLines;
    const command = unitJournal(args.unit, window, lines, timeouts, args.scope);
    return fromExcerpt(await context.onHost(host.name, command));
  },
});

export const hostTools: readonly RegisteredTool[] = [hostUnits, hostJournal];
