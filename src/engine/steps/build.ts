// Step 3, build (spec § Étapes, § Exécution): one evaluation, then one build
// per host as soon as its derivation is known, presence pinged meanwhile.

import type { HostState } from "../../model/events.ts";
import { collect } from "../collect.ts";
import {
  buildDerivation,
  copyDerivation,
  dropBuildLinks,
  onHost,
  type Target,
} from "../commands/host.ts";
import { buildHost, evalHosts } from "../commands/nix.ts";
import { ask, emit, log, type RunContext, YES_NO } from "../context.ts";
import { decideFailure, type Hosts } from "../decisions.ts";
import { describeFailure, errorLines, execute, succeeded } from "../exec.ts";
import type { HostEntry, HostTable } from "../hosts.ts";
import { errorSummary, parseEvalJob, parseNixLog, STORE_PATH, stripAnsi } from "../nix-output.ts";
import type { CommandSpec } from "../ports.ts";
import type { Presence } from "../presence.ts";
import { endStep } from "./step.ts";

export interface BuildOutcome {
  /** Evaluation warnings, deduplicated, for the report. */
  warnings: string[];

  /** Hosts this run evaluated: `0` when a resume reused every path. */
  evaluated: number;

  /** `nix-eval-jobs` failed and hosts got no result: nothing to decide per host. */
  evaluationFailed: boolean;
}

const EVAL_WARNING = /^(evaluation )?warning:/;

/** Holds its closure, nothing left but activation: a resume counts it as built. */
const HOLDS_ITS_PATH: readonly HostState[] = ["built", "ready", "tested"];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

interface Job {
  drvPath: string;
  outPath: string;
}

interface Built {
  /** Printed by `--print-out-paths`; the evaluated output path otherwise. */
  path?: string;

  /** Set: the build failed, this is its reason. */
  note?: string;

  /** Error lines behind the reason, kept for the diagnosis of the host. */
  excerpt?: string[];
  durationMs: number;
}

/** One `nix build`, here or on a builder: its log to the host, its reason on failure. */
async function runBuild(context: RunContext, name: string, spec: CommandSpec): Promise<Built> {
  let lastError: string | undefined;
  let lastErrorLines: string[] | undefined;
  const output = (line: string) =>
    emit(context, { kind: "host.output", host: name, phase: "build", line });

  const execution = await execute(context, spec, {
    signal: context.flow.halt,
    onLine: ({ stream, line }) => {
      if (stream === "stdout") return;
      const entry = parseNixLog(line);
      switch (entry?.kind) {
        case undefined:
          return;
        case "activity":
        case "line":
        case "raw":
          return output(entry.text);
        case "phase":
          return output(`phase ${entry.phase}`);
        case "warning":
          return output(`warning: ${entry.message}`);
        case "error":
          lastError = errorSummary(entry.message);
          lastErrorLines = entry.message.split("\n");
          for (const text of entry.message.split("\n")) output(text);
          return;
      }
    },
  });
  const { durationMs } = execution.result;
  if (succeeded(execution.result)) {
    return {
      path: execution.stdout.find((line) => STORE_PATH.test(line.trim()))?.trim(),
      durationMs,
    };
  }
  return {
    note: lastError ?? describeFailure(execution),
    excerpt: lastErrorLines ?? errorLines(execution),
    durationMs,
  };
}

/**
 * Build on the elected builder (spec § Substituteurs et plomberie de build):
 * derivation copied over, built there, result left in its store for the
 * publication. `undefined`: the builder could not, and said why.
 */
async function delegate(
  context: RunContext,
  name: string,
  builder: string,
  job: Job,
): Promise<Built | undefined> {
  const { timeouts } = context.params;
  const give = (note: string): undefined => {
    log(context, "warn", `builder ${builder}: ${note}, building here`, name);
    return undefined;
  };

  const copied = await execute(context, copyDerivation(builder, job.drvPath, timeouts), {
    signal: context.flow.halt,
    onLine: ({ line }) => emit(context, { kind: "host.output", host: name, phase: "build", line }),
  });
  if (context.flow.halt.aborted) return undefined;
  if (!succeeded(copied.result)) {
    return give(`derivation not copied: ${describeFailure(copied)}`);
  }

  const target: Target = { host: builder, local: false };
  const built = await runBuild(
    context,
    name,
    onHost(target, buildDerivation(job.drvPath, name, timeouts), timeouts),
  );
  if (context.flow.halt.aborted || built.note === undefined) return built;
  return give(built.note);
}

async function buildOne(
  context: RunContext,
  hosts: HostTable,
  name: string,
  job: Job,
): Promise<void> {
  const entry = hosts.get(name);
  const here = context.local.hostname();
  let built: Built | undefined;

  // Auto-build on a host the last ping lost: the delegation would only spend
  // the copy timeout to fail (spec § Substituteurs). Presence unknown: delegate.
  if (entry.builder === name && entry.online === false) {
    log(context, "warn", "auto-build host offline, building here", name);
    entry.builder = here;
  }

  if (entry.builder !== here) {
    built = await delegate(context, name, entry.builder, job);
    if (context.flow.halt.aborted) return;

    // Whatever the builder failed on, the deployment machine takes over: no
    // host fails because of the delegation (spec § Erreurs et réparations).
    if (built === undefined) entry.builder = here;
  }
  built ??= await runBuild(
    context,
    name,
    buildHost(job.drvPath, context.run.outLink(name), context.params.timeouts),
  );

  // Halted: the build was cancelled, the host is left as it is.
  if (context.flow.halt.aborted) return;
  if (built.note === undefined) {
    hosts.set(name, "built", { path: built.path ?? job.outPath, builder: entry.builder });
    log(context, "ok", `build ok ${seconds(built.durationMs)}`, name);
  } else {
    hosts.set(name, "failed", { note: built.note });
    log(context, "error", `build failed: ${built.note}`, name);

    // Nothing was activated: the excerpt is all the diagnosis can hold.
    await collect(context, hosts, name, built.excerpt);
  }
}

async function evaluateAndBuild(context: RunContext, hosts: HostTable): Promise<BuildOutcome> {
  // `--resume`: a host whose built path was reused is already `built`.
  const names = hosts.all().flatMap((host) => (host.state === "pending" ? [host.name] : []));
  const total = names.length;
  const warnings = new Set<string>();
  const builds: Promise<void>[] = [];
  let done = 0;
  const settled = () => {
    done += 1;
    emit(context, { kind: "step.progress", step: "build", done, total });
  };

  // Nothing to evaluate: a resume where every path was reused.
  if (total === 0) return { warnings: [], evaluated: 0, evaluationFailed: false };

  for (const name of names) hosts.set(name, "building");
  log(context, "info", `evaluating ${total} hosts`);

  const spec = evalHosts(context.workspace, names, context.params.timeouts);
  const evaluation = await execute(context, spec, {
    log: { phase: "build" },
    signal: context.flow.halt,
    onLine: ({ stream, line }) => {
      if (stream === "stderr") {
        const text = stripAnsi(line).trim();
        if (EVAL_WARNING.test(text)) warnings.add(text);
        return;
      }
      const job = parseEvalJob(line);
      if (job.kind === "invalid" || !names.includes(job.host)) {
        log(context, "warn", `unexpected nix-eval-jobs output: ${line.slice(0, 80)}`);
        return;
      }
      if (hosts.get(job.host).state !== "building") return;
      if (job.kind === "error") {
        // Whole trace to the host log: the feed and the report carry its cause only.
        for (const text of job.message.split("\n")) {
          emit(context, { kind: "host.output", host: job.host, phase: "build", line: text });
        }
        const note = errorSummary(job.message);
        hosts.set(job.host, "failed", { note });
        log(context, "error", `evaluation failed: ${note}`, job.host);
        settled();
        return;
      }
      builds.push(buildOne(context, hosts, job.host, job).then(settled));
    },
  });

  const failed = !context.flow.halt.aborted && !succeeded(evaluation.result);
  if (failed) log(context, "error", `evaluation failed: ${describeFailure(evaluation)}`);
  await Promise.all(builds);

  // Still building once every build settled: no line, the evaluation stopped before it.
  let missing = false;
  if (!context.flow.halt.aborted) {
    for (const host of hosts.all()) {
      if (host.state !== "building") continue;
      missing = true;
      hosts.set(host.name, "failed", { note: "not evaluated" });
      if (!failed) log(context, "error", "evaluation failed: no result", host.name);
      settled();
    }
  }
  return { warnings: [...warnings], evaluated: total, evaluationFailed: failed && missing };
}

/** Failed hosts sharing a reason, in fleet order: one decision each. */
function byReason(failed: readonly HostEntry[]): Hosts[] {
  const groups = new Map<string | undefined, [string, ...string[]]>();
  for (const { name, note } of failed) {
    const group = groups.get(note);
    if (group) group.push(name);
    else groups.set(note, [name]);
  }
  return [...groups.values()];
}

/**
 * `undefined`: the run stops (aborted `now`). Failed hosts are decided at the
 * end of the build; the flow says whether the run goes on.
 */
export async function build(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
): Promise<BuildOutcome | undefined> {
  const { params, flow } = context;

  // `--resume` with every path reused: the build belongs to the run before.
  const toBuild = hosts.all().filter((host) => host.state === "pending").length;
  if (toBuild === 0) emit(context, { kind: "step.end", step: "build", status: "skipped" });
  else emit(context, { kind: "step.start", step: "build", total: toBuild });
  presence.track(hosts.all().map((host) => host.name));
  presence.start();

  const outcome = await evaluateAndBuild(context, hosts);
  if (context.signal.aborted) return undefined;

  const all = hosts.all();
  const built = all.filter((host) => host.state === "built").length;
  const failed = all.filter((host) => host.state === "failed");
  if (outcome.evaluated > 0 || failed.length > 0) {
    log(context, failed.length > 0 ? "warn" : "ok", `${built} builds ok, ${failed.length} failed`);
  }
  const { warnings } = outcome;
  if (warnings.length > 0) {
    const plural = warnings.length > 1 ? "s" : "";
    log(context, "warn", `${warnings.length} evaluation warning${plural} (logs/build.log)`);

    // One line each: a count alone says nothing of what to fix.
    for (const warning of warnings) log(context, "warn", warning);
  }

  // Nothing to deploy: one stop rather than a question per host. Failed as a
  // whole, the evaluation already said why.
  const deployable = all.filter((host) => HOLDS_ITS_PATH.includes(host.state)).length;
  if (outcome.evaluationFailed || deployable === 0) {
    if (!outcome.evaluationFailed) log(context, "error", "no host built");
    flow.stop("stop");
  }
  // `--build-only`: no test and no switch to protect, nothing to decide. Failed
  // hosts stay `failed`, with their reason, in the report.
  if (!params.buildOnly) {
    for (const group of byReason(failed)) await decideFailure(context, hosts, group);
  }
  if (toBuild > 0) endStep(context, "build", !flow.halt.aborted);

  // An abort after the step, or a stop: nothing left to confirm.
  if (flow.ending !== undefined) return outcome;

  // Activation step the build leads to; `undefined`: both skipped, no question
  // and the publication runs alone.
  const activation = params.skipTest ? (params.skipSwitch ? undefined : "switch") : "test";

  // Named with the publication: a `no` takes that one back too (`run.ts`).
  const next = `publish and ${activation}`;

  if (params.interactive && activation !== undefined) {
    const question = params.buildOnly
      ? `Build done. Continue with ${next}?`
      : `Build done. Start ${next}?`;
    if ((await ask(context, "build", question, YES_NO)) === "no") {
      if (params.buildOnly) flow.finish();
      else flow.abort("after-wave");
    }
  } else if (params.buildOnly) {
    flow.finish();
  }
  return outcome;
}

/**
 * End of run: every builder drops the roots it took for this run. Bounded
 * garbage anyway — one link per host built there, replaced by the next run.
 */
export async function clearBuildLinks(context: RunContext, hosts: HostTable): Promise<void> {
  const { timeouts } = context.params;
  const here = context.local.hostname();
  const built = new Map<string, string[]>();
  for (const host of hosts.all()) {
    if (host.builder === here || host.path === undefined) continue;
    built.set(host.builder, [...(built.get(host.builder) ?? []), host.name]);
  }

  for (const [builder, names] of built) {
    const target: Target = { host: builder, local: false };
    const spec = onHost(target, dropBuildLinks(names, timeouts), timeouts);
    const execution = await execute(context, spec);
    if (context.signal.aborted) return;
    if (!succeeded(execution.result)) {
      log(context, "warn", `builder ${builder}: build links left behind`);
    }
  }
}
