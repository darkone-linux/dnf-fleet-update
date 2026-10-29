// `ToolContext` over a run: the narrow face the tools are given.
//
// Every effect a tool may have passes through here, so a tool written later
// cannot widen its own reach — it has no other handle on the run.

import { join } from "node:path";
import { type HostCommand, onHost as place } from "../engine/commands/host.ts";
import {
  gitAddAll,
  gitCommit,
  gitDiff,
  gitHead,
  gitStatus,
  realignDnfLock,
} from "../engine/commands/workspace.ts";
import { ask, emit, log, type RepairSubject, type RunContext } from "../engine/context.ts";
import { describeFailure, execute, succeeded } from "../engine/exec.ts";
import type { Excerpt, LogName } from "../engine/ports.ts";
import { rebuildHost } from "../engine/steps/build.ts";
import { aiLabel } from "../model/ai-labels.ts";
import type { AskOption } from "../model/events.ts";
import type { PersistedHost, PersistedState } from "../model/persist.ts";
import { confine, readableRoots, repoOf, writable } from "./paths.ts";
import { markSeen, parseSuggestion, renderSuggestion, suggestionPath } from "./suggestions.ts";
import { Refused, type ToolContext, ToolError } from "./tools/types.ts";

type Repo = "dnf" | "consumer";

/** Log of the run holding every AI call, questions and tool calls alike. */
const AI_LOG: LogName = { phase: "ai" };

/**
 * Form the gate of `dnf/` demands: one line, `<type>(<scope>): <subject>`, 80
 * characters. The scope names what the fix touches, as a human writes it.
 */
export function commitMessage(scope: string, subject: string): string {
  const one = subject.replace(/\s+/g, " ").trim();
  const head = `fix(${scope}): `;
  if (one === "") throw new ToolError("commit: an empty subject");
  return `${head}${one}`.slice(0, 80);
}

/** First fleet host a message names as a whole word; host names are `[a-z0-9-]`. */
export function namedHost(message: string, hosts: readonly string[]): string | undefined {
  const words = message.toLowerCase().split(/[^a-z0-9-]+/);
  return hosts.find((host) => words.includes(host.toLowerCase()));
}

/** Labels say what happens, not what was asked (spec mère § Interface). */
const CONFIRM: readonly AskOption[] = [
  { value: "apply", label: "apply", description: "run it on the host" },
  { value: "skip", label: "skip", description: "leave the unit as it is" },
];

/** Output of a command handed to a tool: bounded like a log, tail kept. */
function bounded(lines: readonly string[], keep: number): Excerpt {
  const kept = lines.slice(-keep);
  return { lines: [...kept], dropped: lines.length - kept.length };
}

/** `true`: the tree holds changes to commit. */
async function dirty(context: RunContext, repo: string): Promise<boolean> {
  const execution = await execute(context, gitStatus(repo, context.params.timeouts));
  if (!succeeded(execution.result)) throw new ToolError(`${repo}: ${describeFailure(execution)}`);
  return execution.stdout.length > 0;
}

/** Full revision of HEAD. */
async function headOf(context: RunContext, repo: Repo, directory: string): Promise<string> {
  const head = await execute(context, gitHead(directory, context.params.timeouts));
  const rev = head.stdout[0]?.trim();
  if (!succeeded(head.result) || !rev) throw new ToolError(`${repo}: revision not read`);
  return rev;
}

/**
 * Commits the tree for one repair subject (spec § réparation, Règle de commit):
 * its first commit, or that commit amended while it is still HEAD. Hooks run:
 * `--no-verify` is never passed. Returns the short revision, as said to the AI.
 */
async function commitTree(
  context: RunContext,
  subject: { name: string; revs: RepairSubject["revs"] },
  repo: Repo,
  directory: string,
  message: string,
): Promise<string> {
  const { timeouts } = context.params;
  const previous = subject.revs[repo];
  const amend = previous !== undefined && (await headOf(context, repo, directory)) === previous;

  // Another repair committed on top: rewriting it is not this fix's to do.
  if (previous !== undefined && !amend) {
    const note = `fix of ${subject.name} split over two ${repo} commits: another repair committed on top`;
    emit(context, { kind: "note", host: subject.name, message: note });
  }

  const commit = gitCommit(directory, message, timeouts, amend);
  for (const spec of [gitAddAll(directory, timeouts), commit]) {
    const execution = await execute(context, spec);
    if (!succeeded(execution.result)) {
      throw new ToolError(`${repo}: ${describeFailure(execution)}`);
    }
  }
  const rev = await headOf(context, repo, directory);
  subject.revs[repo] = rev;
  const amends = amend ? { amends: previous } : {};
  emit(context, { kind: "commit", repo, rev, message, subject: subject.name, ...amends });
  return `${rev.slice(0, 7)}${amend ? " (amended)" : ""}`;
}

export function toolContext(context: RunContext, state: () => PersistedState): ToolContext {
  const roots = readableRoots(context.workspace);

  // Once per tree: after the first edit the tree is dirty by our own doing.
  const clean = new Set<string>();

  const requireClean = async (repo: string): Promise<void> => {
    if (clean.has(repo)) return;
    const execution = await execute(context, gitStatus(repo, context.params.timeouts));
    if (!succeeded(execution.result)) {
      throw new ToolError(`${repo}: ${describeFailure(execution)}`);
    }
    if (execution.stdout.length > 0) {
      throw new ToolError(`${repo} is not clean: a repair commit must carry only the fix`);
    }
    clean.add(repo);
  };

  // Filed by the end-of-run review alone: a host analysis explains, it does not file.
  const reviewing = (): void => {
    if (!context.suggestions.reviewing) {
      throw new Refused("suggestions are filed by the end-of-run review only");
    }
  };

  const confined = (path: string): string => {
    const target = confine(roots, path);
    if (!target.ok) throw new ToolError(target.error);
    return target.value;
  };

  const hostOf = (name: string): PersistedHost => {
    const host = state().hosts.find((candidate) => candidate.name === name);
    if (host === undefined) throw new ToolError(`unknown host: ${name}`);
    return host;
  };

  const runOnHost = async (name: string, command: HostCommand): Promise<Excerpt> => {
    const host = hostOf(name);
    const target = { host: host.name, local: host.name === context.local.hostname() };
    const spec = place(target, command, context.params.timeouts);
    const execution = await execute(context, spec, { log: { host: host.name, phase: "ai" } });
    if (!succeeded(execution.result)) {
      throw new ToolError(`${name}: ${describeFailure(execution)}`);
    }
    return bounded(execution.stdout, context.params.ai.logLines);
  };

  return {
    params: context.params,
    codev: context.codev,
    state,
    host: hostOf,
    readLog: (name, lines) => context.run.readLog(name, lines),
    logNames: () => context.run.logNames(),

    async readSourceText(path) {
      const read = await context.sources.text(confined(path));
      if (!read.ok) throw new ToolError(read.error);
      return read.value;
    },

    async readSource(path, lines) {
      const read = await context.sources.read(confined(path), lines);
      if (!read.ok) throw new ToolError(read.error);
      return read.value;
    },

    async listSource(path, limit) {
      const listed = await context.sources.list(confined(path), limit);
      if (!listed.ok) throw new ToolError(listed.error);
      return listed.value;
    },

    async searchSource(pattern, path, limit) {
      const found = await context.sources.search(pattern, confined(path), limit);
      if (!found.ok) throw new ToolError(found.error);
      return found.value;
    },

    async writeSource(path, content) {
      const target = writable(roots, path, context.codev);
      if (!target.ok) throw new ToolError(target.error);

      const repo = repoOf(roots, target.value);
      await requireClean(repo);
      const written = await context.sources.write(target.value, content);
      if (!written.ok) throw new ToolError(written.error);

      // A commit alone never says what the AI believed it was fixing.
      const diff = await execute(context, gitDiff(repo, target.value, context.params.timeouts));
      for (const line of diff.stdout) context.run.appendLog(AI_LOG, line);
      return bounded(diff.stdout, context.params.ai.sourceLines).lines;
    },

    onHost: runOnHost,

    async commitRepair(name, scope, subject) {
      hostOf(name);
      const { timeouts } = context.params;
      const repairs = context.subjects.get(name) ?? { revs: {} };
      context.subjects.set(name, repairs);
      const target = { name, revs: repairs.revs };
      const message = commitMessage(scope, subject);
      const dnf = join(context.workspace, "dnf");
      const framework = context.codev && (await dirty(context, dnf));

      // `dnf/` is published: nothing of this consumer belongs in its history.
      const named = framework
        ? namedHost(
            message,
            state().hosts.map((h) => h.name),
          )
        : undefined;
      if (named !== undefined) {
        throw new Refused(`dnf/ is published: its commit may not name the host ${named}`);
      }

      // Consumer last: nix refuses to write the lock of a flake whose input is
      // a dirty git tree, and it does so in silence (`steps/update.ts`).
      const written: string[] = [];
      if (framework) {
        written.push(`dnf ${await commitTree(context, target, "dnf", dnf, message)}`);
        const realigned = await execute(context, realignDnfLock(context.workspace, timeouts));
        if (!succeeded(realigned.result)) {
          throw new ToolError(`lock not realigned: ${describeFailure(realigned)}`);
        }
      }
      if (await dirty(context, context.workspace)) {
        const rev = await commitTree(context, target, "consumer", context.workspace, message);
        written.push(`consumer ${rev}`);
      }
      if (written.length === 0) throw new ToolError("nothing to commit: no tree changed");

      // What was validated is what is committed: the commit guard saw no edit since.
      const validated = context.repaired.get(name);
      if (validated !== undefined) repairs.path = validated;

      // Committed: what the trees now hold is no longer what the run started from.
      clean.clear();
      return written;
    },

    async rebuild(name) {
      const host = hostOf(name);
      const session = context.repairing.get(host.name);
      const target = {
        name: host.name,
        builder: host.builder ?? context.local.hostname(),
        ...(host.online === undefined ? {} : { online: host.online }),
      };
      const built = await rebuildHost(context, target, session);

      // Session over meanwhile: its path would be taken by the next one for its own.
      if (session?.signal.aborted === true) return { note: "repair session ended" };
      if (built.path !== undefined) context.repaired.set(host.name, built.path);
      return built;
    },

    async knownSuggestions() {
      reviewing();
      const files = await context.suggestionFiles.list();
      return files.map((file) => parseSuggestion(file.slug, file.text));
    },

    async suggest(slug, title, body) {
      reviewing();
      const path = suggestionPath(slug);
      if (context.suggestions.has(slug)) return `${path}: already filed or seen by this run`;

      const known = await context.suggestionFiles.read(slug);
      const runId = context.run.id;
      const text =
        known === undefined ? renderSuggestion(title, body, runId) : markSeen(known, runId);
      const written = await context.suggestionFiles.write(slug, text);
      if (!written.ok) throw new ToolError(written.error);

      const { title: filedTitle, status, runs } = parseSuggestion(slug, text);
      const fresh = known === undefined;
      context.suggestions.add({ slug, title: filedTitle, status, runs, fresh });
      if (fresh) return `filed: ${path}`;
      return status === "ignored"
        ? `${path}: ignored by the operator; marked seen, nothing else`
        : `${path}: known already, marked seen (${runs} runs); its text is kept`;
    },

    halting: () => context.flow.halt.aborted || context.flow.ending !== undefined,

    async confirm(id, question) {
      // Unattended: an action on a service is less than `repairUnits` already
      // does without a witness (spec § réparation, Confirmation).
      if (!context.params.interactive) return true;
      return (await ask(context, id, question, CONFIRM)) === "apply";
    },

    record(entry) {
      emit(context, {
        kind: "ai.action",
        ...(entry.host === undefined ? {} : { host: entry.host }),
        action: entry.action,
        outcome: entry.outcome,
        ...(entry.spends === undefined ? {} : { spends: entry.spends }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      });
      const detail = entry.detail === undefined ? "" : `: ${entry.detail}`;
      const level = entry.outcome === "done" ? "ok" : "warn";
      log(context, level, `${entry.action}: ${entry.outcome}${detail}`, entry.host);
    },

    trace(message) {
      log(context, "info", aiLabel(message));
      context.run.appendLog(AI_LOG, message);
    },
  };
}
