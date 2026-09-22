// Steps 4 and 5, test then switch by waves (spec § Étapes, § Vagues, § Présence).

import type { HostState } from "../../model/events.ts";
import { COMMAND_NOT_FOUND, maintenance, onHost, type Phase } from "../commands/host.ts";
import { ask, emit, log, type RunContext, YES_NO } from "../context.ts";
import { deployHost } from "../deploy.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import type { HostTable } from "../hosts.ts";
import { pool } from "../pool.ts";
import type { Presence } from "../presence.ts";
import type { Selection } from "./select.ts";
import { endStep } from "./step.ts";

/** Best effort: absent command ignored, failure a warning (spec § Exécution, alertes). */
async function silence(
  context: RunContext,
  hosts: HostTable,
  members: readonly string[],
  on: boolean,
): Promise<void> {
  const { timeouts } = context.params;
  await Promise.all(
    members.map(async (name) => {
      if (on && context.flow.halt.aborted) return;
      const target = { host: name, local: hosts.get(name).local };

      // `off` even after an abort: bounded by its timeout only.
      const execution = await execute(
        context,
        onHost(target, maintenance(on, timeouts), timeouts),
        {
          signal: on ? context.flow.halt : null,
        },
      );
      const { exitCode } = execution.result;
      if (succeeded(execution.result) || exitCode === COMMAND_NOT_FOUND) return;
      if (on && context.flow.halt.aborted) return;
      const state = on ? "on" : "off";
      log(context, "warn", `dnf-maintenance ${state} failed: ${describeFailure(execution)}`, name);
    }),
  );
}

async function runWave(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  phase: Phase,
  wave: { index: number; total: number; members: string[] },
): Promise<void> {
  const { members } = wave;
  presence.untrack(members);
  emit(context, { kind: "wave.start", index: wave.index, total: wave.total, hosts: members });
  for (const name of members) hosts.get(name).waveStartedAt = context.clock.now();
  await silence(context, hosts, members, true);
  try {
    // A repair that edited the code rebuilds its host alone and leaves it
    // `built`: the wave serves it once more (spec § réparation, Le
    // redéploiement). Bounded by the attempts the tools already count.
    let round = members;
    for (let pass = 0; pass <= context.params.repair.aiAttempts && round.length > 0; pass += 1) {
      await pool(round, context.params.maxParallel, context.flow.halt, (name) =>
        deployHost(context, hosts, presence, name, phase),
      );
      if (context.flow.halt.aborted) break;
      round = members.filter((name) => hosts.get(name).state === "built");
      if (round.length > 0) log(context, "info", `repaired, deploying again: ${round.join(", ")}`);
    }
  } finally {
    await silence(context, hosts, members, false);
  }
}

/**
 * Opens the step, then runs the waves in plan order; offline hosts join the
 * next wave of the step (spec § Présence). `false`: no host to work on, the
 * step is closed as skipped (`--resume`).
 */
async function waves(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  selection: Selection,
  phase: Phase,
): Promise<boolean> {
  const { flow } = context;
  const from = startingStates(context, phase);
  const eligible = (name: string) => from.includes(hosts.get(name).state);
  const ready = hosts.all().filter((host) => eligible(host.name));
  if (ready.length === 0) {
    log(context, "info", `no ${from[0]} host: nothing to ${phase}`);
    emit(context, { kind: "step.end", step: phase, status: "skipped" });
    return false;
  }
  presence.track(ready.map((host) => host.name));

  // Empty waves are dropped at execution (spec § Vagues): the count only holds
  // the waves that can still run, so the last one reaches the total.
  const ahead = (position: number) =>
    selection.waves
      .slice(position)
      .filter((names) => names.some((name) => eligible(name) && hosts.get(name).online !== false))
      .length;

  emit(context, { kind: "step.start", step: phase, total: ahead(0) });

  let ran = 0;
  let carried: string[] = [];
  for (const [position, planned] of selection.waves.entries()) {
    if (flow.ending !== undefined) break;
    const candidates = [...carried, ...planned].filter(eligible);
    if (candidates.length > 0) {
      await presence.check(candidates);
      if (flow.halt.aborted) break;
      const members = candidates.filter((name) => hosts.get(name).online);
      carried = candidates.filter((name) => !hosts.get(name).online);
      if (carried.length > 0)
        log(context, "warn", `offline, retried next wave: ${carried.join(", ")}`);
      if (members.length > 0) {
        ran += 1;
        await runWave(context, hosts, presence, phase, {
          index: ran,
          total: ran + ahead(position + 1),
          members,
        });
      }
    }
    emit(context, {
      kind: "step.progress",
      step: phase,
      done: ran,
      total: ran + ahead(position + 1),
    });
  }

  const left = carried.filter(eligible);
  presence.untrack(left);
  if (left.length > 0 && !flow.halt.aborted) log(context, "warn", leftBehind(context, phase, left));
  return true;
}

/**
 * States a host may hold to enter the step. `built` alongside `ready`: the
 * publication left that host behind, and its wave serves it (spec § Publication).
 */
function startingStates(context: RunContext, phase: Phase): HostState[] {
  return phase === "test" || context.params.skipTest ? ["ready", "built"] : ["tested"];
}

/** Hosts the step could not reach: where they are left says what to do with them. */
function leftBehind(context: RunContext, phase: Phase, hosts: readonly string[]): string {
  const outcome =
    phase === "test" ? "not tested" : context.params.skipTest ? "not switched" : "left in test";
  return `offline, ${outcome}: ${hosts.join(", ")}`;
}

export async function testWaves(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  selection: Selection,
): Promise<void> {
  const ran = await waves(context, hosts, presence, selection, "test");
  if (ran) endStep(context, "test", !context.flow.halt.aborted);
}

/**
 * Every tested host at once (spec § Étapes): the test proved the configuration
 * on each of them, wave order protects nothing more. `--max-parallel` still
 * caps the hosts activated together.
 */
async function switchAtOnce(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  candidates: readonly string[],
): Promise<void> {
  const { flow } = context;
  emit(context, { kind: "step.start", step: "switch", total: candidates.length });
  presence.track(candidates);
  await presence.check(candidates);
  presence.untrack(candidates);
  if (flow.halt.aborted) return;

  const members = candidates.filter((name) => hosts.get(name).online);
  const left = candidates.filter((name) => !hosts.get(name).online);
  if (left.length > 0) log(context, "warn", leftBehind(context, "switch", left));
  if (members.length === 0) return;

  log(context, "info", `switching ${members.length} tested hosts`);
  for (const name of members) hosts.get(name).waveStartedAt = context.clock.now();
  let done = 0;
  await silence(context, hosts, members, true);
  try {
    await pool(members, context.params.maxParallel, flow.halt, async (name) => {
      await deployHost(context, hosts, presence, name, "switch");
      done += 1;
      emit(context, { kind: "step.progress", step: "switch", done, total: candidates.length });
    });
  } finally {
    await silence(context, hosts, members, false);
  }
}

/**
 * Hosts left by the test, or by the build under `--skip-test`; a host in
 * `error` stays where it is (spec § État et reprise). Waves only protect an
 * untested configuration: with a test behind it, the switch goes at once.
 */
export async function switchWaves(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  selection: Selection,
): Promise<void> {
  const { params, flow } = context;
  const from = startingStates(context, "switch");
  const ready = hosts.all().filter((host) => from.includes(host.state));
  if (ready.length === 0) {
    log(context, "warn", `no ${from[0]} host: nothing to switch`);
    emit(context, { kind: "step.end", step: "switch", status: "skipped" });
    flow.finish();
    return;
  }

  // `--skip-test`: the build already asked, nothing happened since.
  if (params.interactive && !params.skipTest) {
    const question = `Test done. Switch ${ready.length} tested hosts?`;
    if ((await ask(context, "switch", question, YES_NO)) === "no") {
      flow.abort("after-wave");
      return;
    }
  }

  if (params.skipTest) await waves(context, hosts, presence, selection, "switch");
  else
    await switchAtOnce(
      context,
      hosts,
      presence,
      ready.map((host) => host.name),
    );
  endStep(context, "switch", !flow.halt.aborted);
}
