// AI repair of one host (spec § réparation, Le parcours).
//
// Second session of a failed host: the analysis is written, this one may act.
// It never blocks a deployment — a repair that fails, times out or spends its
// attempts leaves the host where the deterministic repair left it.

import { readFailedUnits } from "../engine/collect.ts";
import { emit, log, type RunContext } from "../engine/context.ts";
import type { HostTable } from "../engine/hosts.ts";
import type { HostState } from "../model/events.ts";
import { ask, quiet } from "./analysis.ts";
import { repairPrompt } from "./prompts.ts";

/**
 * Hands one host to the AI with the action tool published, in `ai-repairing`.
 * `recovered`: where it lands when nothing is failed any more — what the
 * activation aimed at. It goes back where it came from otherwise; a host never
 * ends in repair.
 */
export async function repairHost(
  context: RunContext,
  hosts: HostTable,
  name: string,
  recovered: HostState,
): Promise<void> {
  if (context.params.aiErrorAction !== "repair" || quiet(context)) return;
  const persisted = context.state().hosts.find((candidate) => candidate.name === name);
  const units = persisted?.diagnosis?.units ?? [];

  // Nothing the action tool could touch: a session here would be paid for nothing.
  if (persisted === undefined || units.length === 0) return;

  const { state: previous, note } = hosts.get(name);
  hosts.set(name, "ai-repairing", { note });
  try {
    // Actions of this session alone: an edit of a previous round is spent.
    const before = context.state().actions.length;
    const analysis = context.analyses.all().findLast((entry) => entry.host === name);
    await ask(context, {
      id: `repair-${name}`,
      summary: `repairing ${name}`,
      prompt: repairPrompt(
        context.state(),
        persisted,
        analysis?.lines ?? [],
        context.params.aiContext,
      ),
      acting: true,
    });
    if (quiet(context)) return;

    // Code repaired and validated: the host holds a new toplevel, and its wave
    // serves it again. Consumed here, so a later round starts from nothing.
    const rebuilt = context.repaired.get(name);
    context.repaired.delete(name);

    // A validation without an edit of this session rebuilt the same sources:
    // redeploying it would spend a wave to change nothing.
    if (rebuilt !== undefined && edited(context, name, before)) {
      hosts.set(name, "built", { path: rebuilt });
      log(context, "info", "rebuilt by an AI repair, deploying it again", name);
      return;
    }

    // Read back rather than trust the session: the tool may have acted, or not.
    const left = await readFailedUnits(context, hosts.get(name));
    const still = units.filter((unit) => left.includes(unit));
    if (still.length > 0) {
      const reason = `units still failed after an AI repair: ${still.join(", ")}`;
      hosts.set(name, previous, { note: reason });
      log(context, "warn", reason, name);
      return;
    }
    recover(context, hosts, name, recovered);
  } finally {
    // Aborted, or the session threw: a host never ends in repair.
    if (hosts.get(name).state === "ai-repairing") hosts.set(name, previous, { note });
  }
}

/** `true`: this session actually changed a file of the sources for that host. */
function edited(context: RunContext, name: string, since: number): boolean {
  return context
    .state()
    .actions.slice(since)
    .some(
      (action) =>
        action.host === name && action.outcome === "done" && action.action.startsWith("edit "),
    );
}

/** Recovered: the host rejoins the run, and the report says what it took. */
function recover(context: RunContext, hosts: HostTable, name: string, recovered: HostState): void {
  const done = context
    .state()
    .actions.filter((action) => action.host === name && action.outcome === "done")
    .map((action) => action.action);
  hosts.set(name, recovered);

  const message = `recovered by an AI repair: ${done.length > 0 ? done.join(", ") : "no action"}`;
  log(context, "ok", "AI repair recovered the host", name);
  emit(context, { kind: "note", host: name, message });
}
