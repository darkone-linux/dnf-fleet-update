// Passive tools reading the run directory (spec § analyse, `passive`): the
// logs `var/deployments/<run>/logs/` already holds.
//
// Tail, never head: the error of a build sits at the bottom.

import { z } from "zod";
import { renderWarnings, runWarnings } from "../warnings.ts";
import { defineTool, fromExcerpt, type RegisteredTool } from "./types.ts";

/** Phases written per host, as `recorder.ts` and the collection name them. */
const HOST_PHASES = [
  "build",
  "copy",
  "publish",
  "test",
  "switch",
  "rollback",
  "diag",
  "repair",
] as const;

/** Phases written for the run as a whole. */
const RUN_PHASES = ["update", "select", "build"] as const;

/** Beyond the built-in bound a tool call would fill the prompt on its own. */
const MAX_LINES = 1000;

const lineCount = z
  .number()
  .int()
  .min(1)
  .max(MAX_LINES)
  .optional()
  .describe("lines kept from the end of the log; defaults to the run's own bound");

const hostLog = defineTool({
  name: "host_log",
  level: "passive",
  description: `Tail of one host log of this run. Phases: ${HOST_PHASES.join(", ")}.`,
  input: z.strictObject({
    host: z.string().describe("host name, as deployment_state lists it"),
    phase: z.enum(HOST_PHASES),
    lines: lineCount,
  }),
  summary: (args) => `reads the ${args.phase} log of ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const lines = args.lines ?? context.params.ai.logLines;
    return fromExcerpt(await context.readLog({ host: host.name, phase: args.phase }, lines));
  },
});

const runLog = defineTool({
  name: "run_log",
  level: "passive",
  description: `Tail of one log of the run itself, not tied to a host. Phases: ${RUN_PHASES.join(", ")}.`,
  input: z.strictObject({ phase: z.enum(RUN_PHASES), lines: lineCount }),
  summary: (args) => `reads the ${args.phase} log of the run`,
  run: async (context, args) => {
    const lines = args.lines ?? context.params.ai.logLines;
    return fromExcerpt(await context.readLog({ phase: args.phase }, lines));
  },
});

const warnings = defineTool({
  name: "run_warnings",
  level: "passive",
  description:
    "Every warning of this run's logs, grouped by shape across hosts and phases, most frequent first: count, hosts, phases, one example as written. Read a log for the context of one.",
  input: z.strictObject({}),
  summary: () => "reads the warnings of the run",
  run: async (context) => {
    const groups = await runWarnings(context.logNames(), (name, lines) =>
      context.readLog(name, lines),
    );
    if (groups.length === 0) return { lines: ["no warning in this run's logs"] };
    return fromExcerpt(renderWarnings(groups));
  },
});

export const logTools: readonly RegisteredTool[] = [hostLog, runLog, warnings];
