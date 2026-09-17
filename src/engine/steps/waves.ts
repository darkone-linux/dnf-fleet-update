// Steps 4 and 5, test then switch by waves (spec § Étapes, § Vagues, § Présence).

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
  await silence(context, hosts, members, true);
  try {
    await pool(members, context.params.maxParallel, context.flow.halt, (name) =>
      deployHost(context, hosts, presence, name, phase),
    );
  } finally {
    await silence(context, hosts, members, false);
  }
}

/** Waves in plan order; offline hosts join the next wave of the step (spec § Présence). */
async function waves(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  selection: Selection,
  phase: Phase,
): Promise<void> {
  const { flow } = context;
  const from = phase === "test" ? "built" : "tested";
  const eligible = (name: string) => hosts.get(name).state === from;
  const total = selection.waves.length;
  presence.track(hosts.all().flatMap((host) => (eligible(host.name) ? [host.name] : [])));

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
        await runWave(context, hosts, presence, phase, { index: position + 1, total, members });
      }
    }
    emit(context, { kind: "step.progress", step: phase, done: position + 1, total });
  }

  const left = carried.filter(eligible);
  presence.untrack(left);
  if (left.length > 0 && !flow.halt.aborted) {
    const outcome = phase === "test" ? "not tested" : "left in test";
    log(context, "warn", `offline, ${outcome}: ${left.join(", ")}`);
  }
}

export async function testWaves(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  selection: Selection,
): Promise<void> {
  emit(context, { kind: "step.start", step: "test", total: selection.waves.length });
  await waves(context, hosts, presence, selection, "test");
  endStep(context, "test", !context.flow.halt.aborted);
}

/** Tested hosts only: a host in `error` stays in test (spec § État et reprise). */
export async function switchWaves(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  selection: Selection,
): Promise<void> {
  const { params, flow } = context;
  const tested = hosts.all().filter((host) => host.state === "tested");
  if (tested.length === 0) {
    log(context, "warn", "no tested host: nothing to switch");
    emit(context, { kind: "step.end", step: "switch", status: "skipped" });
    flow.finish();
    return;
  }
  if (params.interactive) {
    const question = `Test done. Switch ${tested.length} tested hosts?`;
    if ((await ask(context, "switch", question, YES_NO)) === "no") {
      flow.abort("after-wave");
      return;
    }
  }

  emit(context, { kind: "step.start", step: "switch", total: selection.waves.length });
  await waves(context, hosts, presence, selection, "switch");
  endStep(context, "switch", !flow.halt.aborted);
}
