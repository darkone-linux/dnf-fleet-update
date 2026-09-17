// Step 3, build (spec § Étapes, § Exécution): one evaluation, then one build
// per host as soon as its derivation is known, presence pinged meanwhile.

import { buildHost, evalHosts } from "../commands/nix.ts";
import { ask, emit, log, type RunContext, YES_NO } from "../context.ts";
import { decideFailure } from "../decisions.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import type { HostTable } from "../hosts.ts";
import { errorSummary, parseEvalJob, parseNixLog, STORE_PATH, stripAnsi } from "../nix-output.ts";
import type { Presence } from "../presence.ts";
import { endStep } from "./step.ts";

export interface BuildOutcome {
  /** Evaluation warnings, deduplicated, for the report. */
  warnings: string[];

  /** `nix-eval-jobs` failed and hosts got no result: nothing to decide per host. */
  evaluationFailed: boolean;
}

const EVAL_WARNING = /^(evaluation )?warning:/;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function buildOne(
  context: RunContext,
  hosts: HostTable,
  name: string,
  job: { drvPath: string; outPath: string },
): Promise<void> {
  let lastError: string | undefined;
  const output = (line: string) =>
    emit(context, { kind: "host.output", host: name, phase: "build", line });

  const spec = buildHost(job.drvPath, context.run.outLink(name), context.params.timeouts);
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
          for (const text of entry.message.split("\n")) output(text);
          return;
      }
    },
  });

  // Halted: the build was cancelled, the host is left as it is.
  if (context.flow.halt.aborted) return;
  if (succeeded(execution.result)) {
    const printed = execution.stdout.find((line) => STORE_PATH.test(line.trim()))?.trim();
    hosts.set(name, "built", { path: printed ?? job.outPath });
    log(context, "ok", `build ok ${seconds(execution.result.durationMs)}`, name);
  } else {
    const note = lastError ?? describeFailure(execution);
    hosts.set(name, "failed", { note });
    log(context, "error", `build failed: ${note}`, name);
  }
}

async function evaluateAndBuild(context: RunContext, hosts: HostTable): Promise<BuildOutcome> {
  const names = hosts.all().map((host) => host.name);
  const total = names.length;
  const warnings = new Set<string>();
  const builds: Promise<void>[] = [];
  let done = 0;
  const settled = () => {
    done += 1;
    emit(context, { kind: "step.progress", step: "build", done, total });
  };

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
  return { warnings: [...warnings], evaluationFailed: failed && missing };
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
  emit(context, { kind: "step.start", step: "build", total: hosts.all().length });
  presence.track(hosts.all().map((host) => host.name));
  presence.start();

  const outcome = await evaluateAndBuild(context, hosts);
  if (context.signal.aborted) return undefined;

  const all = hosts.all();
  const built = all.filter((host) => host.state === "built").length;
  const failed = all.filter((host) => host.state === "failed");
  log(context, failed.length > 0 ? "warn" : "ok", `${built} builds ok, ${failed.length} failed`);
  if (outcome.warnings.length > 0) {
    log(context, "warn", `${outcome.warnings.length} evaluation warnings (logs/build.log)`);
  }

  // Failed as a whole: its error already said, one stop rather than a question per host.
  if (outcome.evaluationFailed) flow.stop("stop");
  for (const host of failed) await decideFailure(context, hosts, host.name);
  endStep(context, "build", !flow.halt.aborted);

  // An abort after the step, or a stop: nothing left to confirm.
  if (flow.ending !== undefined) return outcome;

  if (built === 0) {
    log(context, "warn", "no host built: nothing to deploy");
    flow.finish();
  } else if (params.interactive) {
    const question = params.buildOnly
      ? "Build done. Continue with the test?"
      : "Build done. Start the test?";
    if ((await ask(context, "build", question, YES_NO)) === "no") {
      if (params.buildOnly) flow.finish();
      else flow.abort("after-wave");
    }
  } else if (params.buildOnly) {
    flow.finish();
  }
  return outcome;
}
