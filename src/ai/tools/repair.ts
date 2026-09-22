// The one action tool (spec § réparation, L'outil d'action).
//
// Every guard refuses before the command is built, records a `refused` action
// and costs no attempt: a refusal is a signal to the model, not a run failure.

import { z } from "zod";
import {
  failedUnits,
  UNIT,
  UNIT_ACTIONS,
  type UnitAction,
  unitAction,
} from "../../engine/commands/host.ts";
import { spentAttempts } from "../../model/persist.ts";
import { defineTool, type RegisteredTool, type ToolContext, ToolError } from "./types.ts";

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

    const refuse = (reason: string): never => {
      context.record({ host: host.name, action: label, outcome: "refused", detail: reason });
      throw new ToolError(reason);
    };

    if (context.halting()) refuse("the run is stopping: no repair starts now");

    // The heart of it: a repair cannot reach a service the run never saw fall.
    const failed = host.diagnosis?.units ?? [];
    const stray = args.units.filter((unit) => !failed.includes(unit));
    if (stray.length > 0) {
      const known = failed.length > 0 ? failed.join(", ") : "none";
      refuse(`not failed on ${host.name}: ${stray.join(", ")} (failed units: ${known})`);
    }

    const spent = spentAttempts(context.state(), host.name);
    const budget = context.params.repair.aiAttempts;
    if (spent >= budget) refuse(`${budget} repair attempts already spent on ${host.name}`);

    const question = `${label} on ${host.name}?`;
    if (!(await context.confirm(`repair-${host.name}-${spent + 1}`, question))) {
      refuse("the operator declined this action");
    }

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

export const repairTools: readonly RegisteredTool[] = [serviceAction];
