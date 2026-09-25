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
import { defineTool, Refused, type RegisteredTool, type ToolContext, ToolError } from "./types.ts";

/** A file the model rewrites whole: past this it is not editing, it is generating. */
const MAX_LINES = 2000;

/** What the commit gate of `dnf/` accepts as a scope. */
const COMMIT_SCOPE = /^[a-z0-9._,/-]+$/;

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

/** How many times `needle` occurs in `text`, overlaps not counted. */
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * The file as the edit leaves it: `content` whole, or `old` replaced by `new`
 * where it occurs exactly once (spec § réparation, Remplacement).
 */
async function edited(
  context: ToolContext,
  args: {
    path: string;
    content?: string | undefined;
    old?: string | undefined;
    new?: string | undefined;
  },
): Promise<string> {
  const whole = args.content !== undefined;
  const replacing = args.old !== undefined || args.new !== undefined;
  if (whole === replacing) throw new Refused("give either content, or old and new");
  if (args.content !== undefined) return args.content;
  if (args.old === undefined || args.new === undefined || args.old === "") {
    throw new Refused("a replacement needs a non-empty old and a new");
  }

  const text = await context.readSourceText(args.path);
  const found = occurrences(text, args.old);
  if (found !== 1) {
    throw new Refused(
      found === 0
        ? `old not found in ${args.path}: copy it exactly, whitespace included`
        : `old occurs ${found} times in ${args.path}: widen it until it is unique`,
    );
  }
  const replacement = args.new;
  return text.replace(args.old, () => replacement);
}

const editCode = defineTool({
  name: "edit_code",
  level: "repair",
  description:
    "Change a file of the deployment sources: replace one exact passage (old, new), or write the whole file (content) to create or redo it. Only while a host is under repair, only inside the project (and dnf/ in co-development), and never a lock, generated data or the fleet declaration. Returns the diff. Spends one of the host's repair attempts; the host is then rebuilt from it, and it alone.",
  input: z.strictObject({
    host: z
      .string()
      .describe("host under repair: the fix is attributed to it, and it alone is rebuilt"),
    path: z.string().describe("path of the file, relative to the deployment project"),
    old: z
      .string()
      .optional()
      .describe("exact passage to replace, whitespace included; it must occur once in the file"),
    new: z.string().optional().describe("what replaces old"),
    content: z
      .string()
      .optional()
      .describe("the complete new content of the file, instead of old and new"),
  }),
  summary: (args) => `edits ${args.path} for ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const label = `edit ${args.path}`;
    let content: string;
    try {
      content = await edited(context, args);
    } catch (error) {
      refuse(context, host.name, label, error instanceof Error ? error.message : String(error));
    }
    const lines = content.split("\n").length;
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
      diff = await context.writeSource(args.path, content);
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

const validate = defineTool({
  name: "validate",
  level: "repair",
  description:
    "Check an edit: runs the project's own clean-up, then re-evaluates and rebuilds this host alone. Costs no repair attempt, and changes nothing on the fleet — but the host is redeployed from what it builds, so call it once the code is right.",
  input: z.strictObject({
    host: z.string().describe("host under repair, the only one rebuilt"),
  }),
  summary: (args) => `validates the repair of ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const label = `validate ${host.name}`;
    if (context.halting()) refuse(context, host.name, label, "the run is stopping");
    if (host.state !== "ai-repairing") {
      refuse(context, host.name, label, `${host.name} is not under repair right now`);
    }

    const built = await context.rebuild(host.name);
    if (built.path === undefined) {
      const detail = built.note ?? "no result";
      context.record({ host: host.name, action: label, outcome: "failed", spends: false, detail });
      throw new ToolError(
        `${detail}${built.excerpt === undefined ? "" : `\n${built.excerpt.join("\n")}`}`,
      );
    }
    context.record({ host: host.name, action: label, outcome: "done", spends: false });
    return { lines: [`builds: ${built.path}`, `${host.name} will be redeployed from it`] };
  },
});

const commit = defineTool({
  name: "commit",
  level: "repair",
  description:
    "Commit what you edited, once validate has passed. The message is built for you as fix(<scope>): <subject>. In co-development dnf/ is committed first and the consumer lock realigned; dnf/ is a published framework, so its message names the module, never a host nor anything particular to this project. Costs no repair attempt.",
  input: z.strictObject({
    host: z.string().describe("host under repair"),
    scope: z
      .string()
      .regex(COMMIT_SCOPE)
      .describe("what the fix touches, lowercase, e.g. music or nginx; not the host in dnf/"),
    subject: z
      .string()
      .min(1)
      .describe("what the fix does, one line, imperative, no type and no scope"),
  }),
  summary: (args) => `commits the repair of ${args.host}`,
  run: async (context, args) => {
    const host = context.host(args.host);
    const label = `commit ${host.name}`;
    if (context.halting()) refuse(context, host.name, label, "the run is stopping");
    if (host.state !== "ai-repairing") {
      refuse(context, host.name, label, `${host.name} is not under repair right now`);
    }

    let written: string[];
    try {
      written = await context.commitRepair(host.name, args.scope, args.subject);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const outcome = error instanceof Refused ? "refused" : "failed";
      context.record({ host: host.name, action: label, outcome, spends: false, detail });
      throw error;
    }
    context.record({
      host: host.name,
      action: label,
      outcome: "done",
      spends: false,
      detail: written.join(", "),
    });
    return { lines: [`committed: ${written.join(", ")}`] };
  },
});

export const repairTools: readonly RegisteredTool[] = [serviceAction, editCode, validate, commit];
