// Step 1, update (spec § Étapes): flake inputs, `just clean`, one commit per
// repository, only when something changed.

import {
  flakeUpdate,
  gitAddAll,
  gitCommit,
  gitHead,
  gitStatus,
  justClean,
  realignDnfLock,
} from "../commands/workspace.ts";
import { emit, log, type RunContext } from "../context.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import type { CommandSpec } from "../ports.ts";
import { endStep } from "./step.ts";

interface Announce {
  /** Feed line before the command; absent: silent unless it fails. */
  start?: string;
  done?: string;
}

/** Stdout lines, or `undefined` once the failure is reported. */
async function run(
  context: RunContext,
  label: string,
  spec: CommandSpec,
  announce: Announce = {},
): Promise<string[] | undefined> {
  if (announce.start) log(context, "info", announce.start);
  const execution = await execute(context, spec, { log: { phase: "update" } });
  if (!succeeded(execution.result)) {
    // Aborted `now`: the run end says it, no failure to report.
    if (!context.signal.aborted) {
      log(context, "error", `${label} failed: ${describeFailure(execution)}`);
    }
    return undefined;
  }
  if (announce.done) log(context, "ok", announce.done);
  return execution.stdout;
}

async function commitChanges(
  context: RunContext,
  repo: "dnf" | "consumer",
  directory: string,
  message: string,
): Promise<boolean> {
  const { timeouts } = context.params;
  const name = repo === "dnf" ? "dnf/" : "consumer";

  const status = await run(context, `git status ${name}`, gitStatus(directory, timeouts));
  if (status === undefined) return false;
  if (status.every((line) => line.trim() === "")) {
    log(context, "info", `${name}: nothing to commit`);
    return true;
  }

  const added = await run(context, `git add ${name}`, gitAddAll(directory, timeouts));
  const committed =
    added && (await run(context, `git commit ${name}`, gitCommit(directory, message, timeouts)));
  const head =
    committed && (await run(context, `git rev-parse ${name}`, gitHead(directory, timeouts)));
  const rev = head?.[0]?.trim();
  if (!rev) return false;

  emit(context, { kind: "commit", repo, rev, message });
  log(context, "ok", `commit ${name} ${message}`);
  return true;
}

async function steps(context: RunContext): Promise<boolean> {
  const { params, workspace, codev } = context;
  const { timeouts } = params;
  const dnf = `${workspace}/dnf`;

  // Consumer first, while `dnf/` is still clean: nix refuses to write the lock
  // of a flake whose input is a dirty git tree (codev), silently.
  if (params.consumerFlake) {
    const updated = await run(context, "nix flake update", flakeUpdate(workspace, timeouts), {
      start: "nix flake update (consumer)",
      done: "consumer inputs updated",
    });
    if (!updated) return false;
  }
  if (codev && params.dnfFlake) {
    const updated = await run(context, "nix flake update dnf/", flakeUpdate(dnf, timeouts), {
      start: "nix flake update dnf/",
      done: "dnf/ inputs updated",
    });
    if (!updated) return false;
  }
  const cleaned = await run(context, "just clean", justClean(workspace, timeouts), {
    start: "just clean",
    done: "var/generated/ regenerated, tree formatted",
  });
  if (!cleaned) return false;

  if (codev) {
    if (!(await commitChanges(context, "dnf", dnf, params.dnfMessage))) return false;

    // Even under `--no-consumer-flake`: the consumer deploys the committed `dnf/`.
    const realigned = await run(
      context,
      "nix flake update dnf",
      realignDnfLock(workspace, timeouts),
    );
    if (!realigned) return false;
  }
  return commitChanges(context, "consumer", workspace, params.consumerMessage);
}

/** `false`: the run stops (failure reported, or aborted `now`). */
export async function update(context: RunContext): Promise<boolean> {
  emit(context, { kind: "step.start", step: "update" });
  const ok = await steps(context);
  endStep(context, "update", ok);
  return ok;
}
