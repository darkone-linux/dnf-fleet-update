// AI repair of one host (spec § réparation, Le parcours).
//
// Second session of a failed host: the analysis is written, this one may act.
// It never blocks a deployment — a repair that fails, times out or spends its
// attempts leaves the host where the deterministic repair left it.

import { readFailedUnits } from "../engine/collect.ts";
import {
  gitAddAll,
  gitCleanUntracked,
  gitDiscard,
  gitStagedPatch,
  gitStatus,
} from "../engine/commands/workspace.ts";
import {
  emit,
  type GitTree,
  gitTrees,
  log,
  type RunContext,
  type Validated,
} from "../engine/context.ts";
import { describeFailure, type ExecOptions, execute, succeeded } from "../engine/exec.ts";
import type { HostTable } from "../engine/hosts.ts";
import type { HostState } from "../model/events.ts";
import { isEdit, isValidate, spentAttempts } from "../model/persist.ts";
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

  const { state: previous, note } = hosts.get(name);
  hosts.set(name, "ai-repairing", { note });
  try {
    const { committed, validated } = await actingSession(context, hosts, name, {
      summary: `repairing ${name}`,
      session: "repair",
      prompt: (analysis) =>
        repairPrompt(context.state(), persisted, analysis, context.params.aiContext),
    });
    if (quiet(context)) return;

    // Committed in this session: the host holds a new toplevel, and its wave
    // serves it again. Never an uncommitted one (spec § Règle de commit).
    if (committed !== undefined) {
      hosts.set(name, "built", { path: committed.path });

      // A later session compares its `validate` with what the host now runs.
      hosts.get(name).drv = committed.drv;
      log(context, "info", "rebuilt by an AI repair, deploying it again", name);
      return;
    }
    if (validated) log(context, "warn", "validated but not committed: not redeployed", name);

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
  try {
    const { committed } = await actingSession(context, hosts, name, {
      summary: `repairing the build of ${group.hosts.join(", ")}`,
      session: "build-repair",
      prompt: (analysis) =>
        buildRepairPrompt(
          context.state(),
          persisted,
          group.hosts,
          analysis,
          context.params.aiContext,
        ),
      group: group.hosts,
    });
    if (committed === undefined) return false;

    // `drv` left as built: the alignment skips a failed host whose derivation held.
    log(context, "ok", "build fixed and committed by an AI repair", name);
    return true;
  } finally {
    // A host never ends in repair: back to its failure, reason kept.
    for (const [host, note] of notes) {
      if (hosts.get(host).state === "ai-repairing") hosts.set(host, "failed", { note });
    }
  }
}

interface ActingQuestion {
  summary: string;
  session: "repair" | "build-repair";

  /** Built at its turn, from the analysis this host's own session wrote. */
  prompt: (analysis: readonly string[]) => string;

  /** Every host of a build group: what the review names. */
  group?: readonly string[];
}

/** What an acting session left, read before it is forgotten. */
interface SessionOutcome {
  /** Toplevel validated, then committed: the only one a redeploy takes. */
  committed?: Validated;

  /** A toplevel validated in the session, committed or not. */
  validated: boolean;
}

/**
 * One acting session on `name` (spec § réparation): registered for the tools,
 * told the attempts its host has left, its answer kept for the review, its
 * uncommitted edits discarded once it is over.
 */
async function actingSession(
  context: RunContext,
  hosts: HostTable,
  name: string,
  question: ActingQuestion,
): Promise<SessionOutcome> {
  const session = new AbortController();
  const since = context.state().actions.length;
  const { drv } = hosts.get(name);
  context.repairing.set(name, {
    signal: session.signal,
    since,
    ...(drv === undefined ? {} : { drv }),
  });

  // Actions of this session alone: what a previous round validated is spent.
  forget(context, name);
  try {
    const analysis = context.analyses.all().findLast((entry) => entry.host === name);
    const answer = await ask(context, {
      id: `repair-${name}`,
      summary: question.summary,
      prompt: question.prompt(analysis?.lines ?? []),
      session: question.session,
      attempts: context.params.repair.aiAttempts - spentAttempts(context.state(), name),
    });
    context.analyses.addRepair(answer, name, question.group);

    // Session over: a validation still building ends with it (spec § J10, Délai).
    session.abort();
    await discardUncommitted(context, name, since);
    const committed = context.subjects.get(name)?.validated;
    return {
      ...(committed === undefined ? {} : { committed }),
      validated: context.repaired.has(name),
    };
  } finally {
    session.abort();
    context.repairing.delete(name);
    forget(context, name);
  }
}

/** What a session validated and committed is read once: a later one starts from nothing. */
function forget(context: RunContext, name: string): void {
  context.repaired.delete(name);
  const subject = context.subjects.get(name);
  if (subject !== undefined) subject.validated = undefined;
}

/** Past an abort `now`: a tree left dirty would stop the next run. */
const CLEANUP: ExecOptions = { signal: null };

/**
 * Patch of a tree's uncommitted repair, `logs/<host>.<repo>.patch`: the human
 * finishing the fix starts from it (`git apply`). Its path; `undefined` when
 * none was kept, said with why.
 */
async function keepPatch(
  context: RunContext,
  name: string,
  tree: GitTree,
): Promise<string | undefined> {
  const { timeouts } = context.params;
  const lost = (why: string): undefined => {
    log(context, "warn", `${tree.label}: no patch kept: ${why}`, name);
    return undefined;
  };

  // Staged first: a file the repair created is part of the patch.
  const staged = await execute(context, gitAddAll(tree.path, timeouts), CLEANUP);
  if (!succeeded(staged.result)) return lost(describeFailure(staged));
  const patch = await execute(context, gitStagedPatch(tree.path, timeouts), CLEANUP);
  if (!succeeded(patch.result)) return lost(describeFailure(patch));
  if (patch.stdout.length === 0) return undefined;
  try {
    return context.run.writePatch(name, tree.repo, patch.stdout);
  } catch (error) {
    return lost(error instanceof Error ? error.message : String(error));
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
        (isEdit(action) || isValidate(action)),
    );
  if (!touched) return;

  const { timeouts } = context.params;
  for (const tree of gitTrees(context)) {
    const status = await execute(context, gitStatus(tree.path, timeouts), CLEANUP);
    if (!succeeded(status.result) || status.stdout.length === 0) continue;
    const kept = await keepPatch(context, name, tree);

    // Clean before the run's first edit (`edit_code` checks it): untracked is ours.
    const reset = await execute(context, gitDiscard(tree.path, timeouts), CLEANUP);
    const removed = await execute(context, gitCleanUntracked(tree.path, timeouts), CLEANUP);
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
