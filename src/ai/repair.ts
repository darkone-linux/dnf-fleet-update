// AI repair of one host (spec § réparation, Le parcours).
//
// Second session of a failed host: the analysis is written, this one may act.
// It never blocks a deployment — a repair that fails, times out or spends its
// attempts leaves the host where the deterministic repair left it.

import { join } from "node:path";
import { readFailedUnits } from "../engine/collect.ts";
import {
  gitAddAll,
  gitCleanUntracked,
  gitDiscard,
  gitStagedPatch,
  gitStatus,
} from "../engine/commands/workspace.ts";
import { emit, log, type RunContext } from "../engine/context.ts";
import { execute, succeeded } from "../engine/exec.ts";
import type { HostTable } from "../engine/hosts.ts";
import type { HostState } from "../model/events.ts";
import { ask, quiet } from "./analysis.ts";
import { buildRepairPrompt, repairPrompt } from "./prompts.ts";

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

  // Nothing the action tool could touch: a session here would be paid for nothing.
  if ((persisted?.diagnosis?.units ?? []).length === 0) return;

  // One session at a time: a commit takes the whole tree (spec § Règle de commit).
  await context.repairTurn(() => repairSession(context, hosts, name, recovered));
}

async function repairSession(
  context: RunContext,
  hosts: HostTable,
  name: string,
  recovered: HostState,
): Promise<void> {
  // Its turn came: the run may be leaving by now, the diagnosis may have grown.
  const persisted = context.state().hosts.find((candidate) => candidate.name === name);
  if (quiet(context) || persisted === undefined) return;
  const units = persisted.diagnosis?.units ?? [];

  const { state: previous, note, drv } = hosts.get(name);
  hosts.set(name, "ai-repairing", { note });
  const session = new AbortController();
  context.repairing.set(name, { signal: session.signal, ...(drv === undefined ? {} : { drv }) });

  // Actions of this session alone: what a previous round validated is spent.
  const before = context.state().actions.length;
  forget(context, name);
  try {
    const analysis = context.analyses.all().findLast((entry) => entry.host === name);
    const answer = await ask(context, {
      id: `repair-${name}`,
      summary: `repairing ${name}`,
      prompt: repairPrompt(
        context.state(),
        persisted,
        analysis?.lines ?? [],
        context.params.aiContext,
      ),
      session: "repair",
    });
    context.analyses.addRepair(answer, name);

    // Session over: a validation still building ends with it (spec § J10, Délai).
    session.abort();
    await discardUncommitted(context, name, before);
    if (quiet(context)) return;

    // Committed in this session: the host holds a new toplevel, and its wave
    // serves it again. Never an uncommitted one (spec § Règle de commit).
    const committed = context.subjects.get(name)?.path;
    if (committed !== undefined) {
      hosts.set(name, "built", { path: committed });
      log(context, "info", "rebuilt by an AI repair, deploying it again", name);
      return;
    }
    if (context.repaired.has(name)) {
      log(context, "warn", "validated but not committed: not redeployed", name);
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
    session.abort();
    context.repairing.delete(name);
    forget(context, name);

    // Aborted, or the session threw: a host never ends in repair.
    if (hosts.get(name).state === "ai-repairing") hosts.set(name, previous, { note });
  }
}

/**
 * Repair of a failed build (spec § réparation, J10): one session for the group,
 * through the host whose own build met the failure. `true`: a fix was
 * committed. The group goes back to `failed` whatever it did — a committed fix
 * reaches the hosts by the alignment, never by this session.
 */
export async function repairGroup(
  context: RunContext,
  hosts: HostTable,
  group: { hosts: readonly string[]; representative: string },
): Promise<boolean> {
  if (context.params.aiErrorAction !== "repair" || quiet(context)) return false;

  // One session at a time: a commit takes the whole tree (spec § Règle de commit).
  return context.repairTurn(() => groupSession(context, hosts, group));
}

async function groupSession(
  context: RunContext,
  hosts: HostTable,
  group: { hosts: readonly string[]; representative: string },
): Promise<boolean> {
  const name = group.representative;
  const persisted = context.state().hosts.find((candidate) => candidate.name === name);
  if (quiet(context) || persisted === undefined) return false;

  const notes = new Map(group.hosts.map((host) => [host, hosts.get(host).note]));
  for (const [host, note] of notes) hosts.set(host, "ai-repairing", { note });
  const session = new AbortController();
  const { drv } = hosts.get(name);
  context.repairing.set(name, { signal: session.signal, ...(drv === undefined ? {} : { drv }) });
  const before = context.state().actions.length;
  forget(context, name);
  try {
    const analysis = context.analyses.all().findLast((entry) => entry.host === name);
    const answer = await ask(context, {
      id: `repair-${name}`,
      summary: `repairing the build of ${group.hosts.join(", ")}`,
      prompt: buildRepairPrompt(
        context.state(),
        persisted,
        group.hosts,
        analysis?.lines ?? [],
        context.params.aiContext,
      ),
      session: "build-repair",
    });
    context.analyses.addRepair(answer, name, group.hosts);

    // Session over: a validation still building ends with it (spec § J10, Délai).
    session.abort();
    await discardUncommitted(context, name, before);
    const fixed = context.subjects.get(name)?.path !== undefined;
    if (fixed) log(context, "ok", "build fixed and committed by an AI repair", name);
    return fixed;
  } finally {
    session.abort();
    context.repairing.delete(name);
    forget(context, name);

    // A host never ends in repair: back to its failure, reason kept.
    for (const [host, note] of notes) {
      if (hosts.get(host).state === "ai-repairing") hosts.set(host, "failed", { note });
    }
  }
}

/** What a session validated and committed is read once: a later one starts from nothing. */
function forget(context: RunContext, name: string): void {
  context.repaired.delete(name);
  const subject = context.subjects.get(name);
  if (subject !== undefined) subject.path = undefined;
}

/**
 * Patch of a tree's uncommitted repair, `logs/<host>.<tree>.patch`: the human
 * finishing the fix starts from it (`git apply`). Its path, or `undefined`.
 */
async function keepPatch(
  context: RunContext,
  name: string,
  tree: { file: string; path: string },
): Promise<string | undefined> {
  const { timeouts } = context.params;

  // Staged first: a file the repair created is part of the patch.
  const staged = await execute(context, gitAddAll(tree.path, timeouts));
  if (!succeeded(staged.result)) return undefined;
  const patch = await execute(context, gitStagedPatch(tree.path, timeouts));
  if (!succeeded(patch.result) || patch.stdout.length === 0) return undefined;
  try {
    return context.run.writePatch(name, tree.file, patch.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Trees back to HEAD after a session that edited or validated (spec § Règle de
 * commit): an uncommitted edit is no fix, and a dirty tree stops the next run.
 * The diff of every edit stays in `logs/ai.log`, the whole in a patch.
 */
async function discardUncommitted(context: RunContext, name: string, since: number): Promise<void> {
  const touched = context
    .state()
    .actions.slice(since)
    .some(
      (action) =>
        action.host === name &&
        action.outcome !== "refused" &&
        (action.action.startsWith("edit ") || action.action.startsWith("validate ")),
    );
  if (!touched) return;

  const { timeouts } = context.params;
  const trees = [
    { label: "consumer", file: "consumer", path: context.workspace },
    ...(context.codev
      ? [{ label: "dnf/", file: "dnf", path: join(context.workspace, "dnf") }]
      : []),
  ];
  for (const tree of trees) {
    const status = await execute(context, gitStatus(tree.path, timeouts));
    if (!succeeded(status.result) || status.stdout.length === 0) continue;
    const kept = await keepPatch(context, name, tree);

    // Clean before the run's first edit (`edit_code` checks it): untracked is ours.
    const reset = await execute(context, gitDiscard(tree.path, timeouts));
    const removed = await execute(context, gitCleanUntracked(tree.path, timeouts));
    if (succeeded(reset.result) && succeeded(removed.result)) {
      const where = kept === undefined ? "" : `, kept in ${kept}`;
      log(context, "warn", `${tree.label}: uncommitted repair edits discarded${where}`, name);
    } else {
      log(context, "error", `${tree.label}: uncommitted repair edits left, tree dirty`, name);
    }
  }
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
