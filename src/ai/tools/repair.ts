// The action tools (spec § réparation): a service, and the code behind it.
//
// Every guard refuses before anything changes, records a `refused` action and
// costs no attempt: a refusal is a signal to the model, not a run failure.

import { z } from "zod";
import {
  failedUnits,
  UNIT,
  UNIT_ACTIONS,
  type UnitAction,
  unitAction,
} from "../../engine/commands/host.ts";
import { type PersistedHost, spentAttempts } from "../../model/persist.ts";
import { defineTool, type RegisteredTool, type ToolContext, ToolError } from "./types.ts";

/** A file the model rewrites whole: past this it is not editing, it is generating. */
const MAX_LINES = 2000;

/** Refused, recorded, thrown: the three always go together, and cost no attempt. */
function refuse(context: ToolContext, host: string, action: string, reason: string): never {
  context.record({ host, action, outcome: "refused", detail: reason });
  throw new ToolError(reason);
}

/**
 * What every action tool checks before it changes anything (spec § réparation):
 * the run is not leaving, the host is the one under repair, an attempt is left,
 * and the operator agrees.
 */
async function allowed(context: ToolContext, host: PersistedHost, label: string): Promise<void> {
  const no = (reason: string): never => refuse(context, host.name, label, reason);
  if (context.halting()) no("the run is stopping: no repair starts now");

  // The parcours is structural, not a prompt: only the repair session acts.
  if (host.state !== "ai-repairing") {
    no(`${host.name} is not under repair right now (state ${host.state})`);
  }
  const spent = spentAttempts(context.state(), host.name);
  const budget = context.params.repair.aiAttempts;
  if (spent >= budget) no(`${budget} repair attempts already spent on ${host.name}`);

  if (!(await context.confirm(`repair-${host.name}-${spent + 1}`, `${label} on ${host.name}?`))) {
    no("the operator declined this action");
  }
}

/** Feed line of a call: `restarts nginx.service on nlt`. */
const VERB: Record<UnitAction, string> = {
  start: "starts",
  stop: "stops",
  restart: "restarts",
  "reset-failed": "resets",
};

const serviceAction = defineTool({
  name: "service_action",
  level: "repair",
  description:
    "Act on units of a host with systemctl: start, stop, restart or reset-failed. Only units this run saw fail are allowed, and each accepted call spends one of the host's repair attempts. Returns what the command printed, then the units still failed.",
  input: z.strictObject({
    host: z.string().describe("host name, as deployment_state lists it"),
    units: z
      .array(z.string().regex(UNIT))
      .min(1)
      .describe("units to act on; each one must be a unit host_diagnosis reported as failed"),
    action: z.enum(UNIT_ACTIONS).describe("what to do with those units"),
  }),
  summary: (args) => `${VERB[args.action]} ${args.units.join(", ")} on ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const label = `${args.action} ${args.units.join(", ")}`;

    // The heart of it: a repair cannot reach a service the run never saw fall.
    const failed = host.diagnosis?.units ?? [];
    const stray = args.units.filter((unit) => !failed.includes(unit));
    if (stray.length > 0) {
      const known = failed.length > 0 ? failed.join(", ") : "none";
      refuse(
        context,
        host.name,
        label,
        `not failed on ${host.name}: ${stray.join(", ")} (failed units: ${known})`,
      );
    }
    await allowed(context, host, label);
    return act(context, host.name, args, label);
  },
});

async function act(
  context: ToolContext,
  name: string,
  args: { units: string[]; action: UnitAction },
  label: string,
) {
  const { timeouts } = context.params;
  let output: readonly string[];
  try {
    output = (await context.onHost(name, unitAction(args.action, args.units, timeouts))).lines;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.record({ host: name, action: label, outcome: "failed", detail });
    throw error;
  }
  context.record({ host: name, action: label, outcome: "done" });

  // Read back rather than trust the exit code: a unit may fail after its start.
  const left = await context.onHost(name, failedUnits(timeouts));
  return {
    lines: [...output, "", "failed units now:", ...(left.lines.length > 0 ? left.lines : ["none"])],
  };
}

const editCode = defineTool({
  name: "edit_code",
  level: "repair",
  description:
    "Replace a file of the deployment sources, whole. Only while a host is under repair, only inside the project (and dnf/ in co-development), and never a lock, generated data or the fleet declaration. Returns the diff. Spends one of the host's repair attempts; the host is then rebuilt from it, and it alone.",
  input: z.strictObject({
    host: z
      .string()
      .describe("host under repair: the fix is attributed to it, and it alone is rebuilt"),
    path: z.string().describe("path of the file, relative to the deployment project"),
    content: z.string().describe("the complete new content of the file"),
  }),
  summary: (args) => `edits ${args.path} for ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const label = `edit ${args.path}`;
    const lines = args.content.split("\n").length;
    if (lines > MAX_LINES) {
      refuse(
        context,
        host.name,
        label,
        `${args.path}: ${lines} lines, over the ${MAX_LINES} a whole rewrite may carry`,
      );
    }
    await allowed(context, host, label);

    let diff: string[];
    try {
      diff = await context.writeSource(args.path, args.content);
    } catch (error) {
      refuse(context, host.name, label, error instanceof Error ? error.message : String(error));
    }
    context.record({ host: host.name, action: label, outcome: "done" });
    return {
      lines:
        diff.length > 0
          ? ["written, diff:", ...diff]
          : ["written; the file already read exactly this"],
    };
  },
});

export const repairTools: readonly RegisteredTool[] = [serviceAction, editCode];
