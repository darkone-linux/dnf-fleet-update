// One host in a wave (spec § Exécution): copy, origin, activation, then a new
// connection that reads the result and cancels the rollback timer.

import { analyseHost } from "../ai/analysis.ts";
import { repairHost } from "../ai/repair.ts";
import { collect } from "./collect.ts";
import {
  activate,
  onHost,
  type Phase,
  parseOrigin,
  readOrigin,
  setProfile,
  type Target,
} from "./commands/host.ts";
import { emit, log, type RunContext } from "./context.ts";
import { serveHost } from "./copy.ts";
import { decideFailure, decideLost } from "./decisions.ts";
import {
  describeFailure,
  type Execution,
  errorLines,
  execute,
  type Failure,
  failureOf,
  succeeded,
} from "./exec.ts";
import type { HostTable } from "./hosts.ts";
import type { OutputLine } from "./ports.ts";
import type { Presence } from "./presence.ts";
import { repairUnits } from "./repair.ts";
import { revertHost } from "./rollback.ts";
import { settle, transportFailed } from "./settle.ts";

/** `switch-to-configuration`: activation done, some units failed. */
const UNITS_FAILED = 4;

async function failed(
  context: RunContext,
  hosts: HostTable,
  name: string,
  failure: Failure,
): Promise<void> {
  const { note, excerpt, known } = failure;
  hosts.set(name, "failed", { note });
  hosts.get(name).knownError = known;
  log(context, "error", note, name);

  // Collected before the question: the decision is taken on what the host says.
  await collect(context, hosts, name, excerpt);

  // Then the AI, if it may: after an activation (spec § Erreurs, parcours), or
  // because the signature table handed this failure to it.
  const entry = hosts.get(name);
  const handed = entry.activated !== undefined || entry.knownError?.fix.kind === "ai";
  if (handed && context.params.aiErrorAction !== "none") {
    await analyseHost(context, hosts, name);
  }
  const decision = await decideFailure(context, hosts, [name]);

  // Decided before a stop: a revert not started yet is a new operation.
  if (decision === "revert" && !context.flow.halt.aborted) await revertHost(context, hosts, name);
}

/** Before the activation of this phase: unreachable means lost, no timer to wait for. */
export async function failedBeforeActivation(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  name: string,
  failure: Failure,
): Promise<void> {
  await presence.check([name]);
  if (context.signal.aborted) return;
  if (hosts.get(name).online) return failed(context, hosts, name, failure);

  const { note, excerpt } = failure;
  hosts.get(name).lost = true;
  hosts.set(name, "failed", { note: `unreachable: ${note}` });
  log(context, "error", `unreachable: ${note}`, name);
  await collect(context, hosts, name, excerpt);
  await decideLost(context, hosts, name, false);
}

/** Result of `switch-to-configuration`, as the unit exit code carries it. */
async function concluded(
  context: RunContext,
  hosts: HostTable,
  name: string,
  phase: Phase,
  code: number,
  activation: Execution,
): Promise<void> {
  if (code === 0) {
    hosts.set(name, phase === "test" ? "tested" : "deployed");
    log(context, "ok", `${phase} ok`, name);
  } else if (code === UNITS_FAILED) {
    hosts.set(name, "error", { note: "some units failed" });
    log(context, "warn", `${phase}: some units failed`, name);

    // Names of the units: read by the report, then restarted once.
    const units = await collect(context, hosts, name, errorLines(activation));
    await repairUnits(context, hosts, name, units, phase);

    // Deterministic repair spent: the AI explains what is left, or why a
    // restart was enough (spec § analyse, Déclencheurs 2 et 3).
    const { params } = context;
    if (hosts.get(name).state === "error") {
      if (params.aiErrorAction !== "none") await analyseHost(context, hosts, name);

      // Then, and only at `repair`, a second session that may act on the units.
      await repairHost(context, hosts, name, phase === "test" ? "tested" : "deployed");
    } else if (params.aiAnalysis !== "none") {
      await analyseHost(context, hosts, name, { mark: false });
    }
  } else {
    const note = `${phase} failed: switch-to-configuration exit ${code}`;
    await failed(context, hosts, name, failureOf(activation, note));
  }
}

/**
 * Deploys a built (`test`) or tested (`switch`) host. Returns once the host
 * settled, its failure decided. A halt cancels what precedes the activation;
 * an activation started runs to its end.
 */
export async function deployHost(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  name: string,
  phase: Phase,
): Promise<void> {
  const { params, flow } = context;
  const { timeouts } = params;
  const host = hosts.get(name);
  const target: Target = { host: name, local: host.local };
  const path = host.path;
  if (path === undefined) throw new Error(`${name}: deployed without a built path`);
  const output =
    (outputPhase: string) =>
    ({ line }: OutputLine) =>
      emit(context, { kind: "host.output", host: name, phase: outputPhase, line });

  // `built`: the publication left this host behind, unreachable at the time
  // (spec § Publication). A `ready` or `tested` host already holds its closure.
  if (host.state === "built") {
    hosts.set(name, "copying");
    if (!host.local) {
      const served = { target, path, builder: host.builder };
      const copied = await serveHost(context, hosts.fabric, served, output("copy"));
      if (flow.halt.aborted) return;
      if (copied !== undefined) {
        return failedBeforeActivation(context, hosts, presence, name, copied);
      }
    }
  }

  let origin = host.origin;
  let read = false;
  if (origin === undefined) {
    const execution = await execute(context, onHost(target, readOrigin(timeouts), timeouts), {
      signal: flow.halt,
    });
    if (flow.halt.aborted) return;
    if (!succeeded(execution.result)) {
      const note = `origin not read: ${describeFailure(execution)}`;
      return failedBeforeActivation(context, hosts, presence, name, failureOf(execution, note));
    }
    const parsed = parseOrigin(execution.stdout.join("\n"));
    if (!parsed.ok) return failed(context, hosts, name, { note: parsed.error });
    origin = parsed.value;
    read = true;
  }
  hosts.set(name, phase === "test" ? "testing" : "switching", read ? { origin } : {});

  // From here the host changes: a forced rollback must undo this phase.
  host.activated = phase;
  if (phase === "switch") {
    const profile = await execute(context, onHost(target, setProfile(path, timeouts), timeouts));
    if (context.signal.aborted) return;
    if (!succeeded(profile.result)) {
      const note = `profile not set: ${describeFailure(profile)}`;
      return failedBeforeActivation(context, hosts, presence, name, failureOf(profile, note));
    }
  }

  const armed = !host.local && params.rollbackTimeout > 0;
  const activation = activate(
    path,
    phase,
    { runId: context.run.id, origin, rollbackAfter: armed ? params.rollbackTimeout : 0 },
    timeouts,
  );
  const run = await execute(context, onHost(target, activation, timeouts), {
    onLine: output(phase),
  });

  // Aborted `now`: the activation ends on the host, its timer brings it back.
  if (context.signal.aborted) return;

  if (host.local) {
    if (run.result.exitCode === null || run.result.timedOut) {
      return failed(
        context,
        hosts,
        name,
        failureOf(run, `${phase} failed: ${describeFailure(run)}`),
      );
    }
    return concluded(context, hosts, name, phase, run.result.exitCode, run);
  }

  const settled = await settle(context, target, phase, armed, transportFailed(run.result));
  switch (settled.kind) {
    case "aborted":
      return;
    case "result":
      return concluded(context, hosts, name, phase, settled.code, run);
    case "missing":
      return failed(
        context,
        hosts,
        name,
        failureOf(run, `${phase} did not run: ${describeFailure(run)}`),
      );
    case "failed":
      return failed(context, hosts, name, failureOf(run, settled.detail));
    case "lost":
      host.lost = true;
      hosts.presence(name, false);
      hosts.set(name, "failed", { note: `unreachable after ${phase}` });
      log(context, "error", `unreachable after ${phase}`, name);
      await decideLost(context, hosts, name, armed);
      return;
  }
}
