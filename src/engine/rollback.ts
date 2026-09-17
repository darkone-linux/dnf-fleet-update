// Forced rollback of the fleet (spec § Erreurs et réparations, `rollback`):
// activated hosts back to their origin, waves in reverse order. A session
// dropped by the rollback itself is settled like an activation.

import type { HostOrigin } from "../model/events.ts";
import { canTransition } from "../model/transitions.ts";
import { onHost, type Phase, rollbackNow } from "./commands/host.ts";
import { emit, log, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import type { HostEntry, HostTable } from "./hosts.ts";
import { pool } from "./pool.ts";
import { settle, transportFailed } from "./settle.ts";
import type { Selection } from "./steps/select.ts";

/** Why it failed; `undefined` once back at its origin, or aborted `now`. */
async function reactivateOrigin(
  context: RunContext,
  host: HostEntry,
  origin: HostOrigin,
  activated: Phase,
): Promise<string | undefined> {
  const { timeouts } = context.params;
  const command = rollbackNow(context.run.id, origin, activated, timeouts);
  const target = { host: host.name, local: host.local };
  const execution = await execute(context, onHost(target, command, timeouts), {
    onLine: ({ line }) =>
      emit(context, { kind: "host.output", host: host.name, phase: "rollback", line }),
  });
  if (context.signal.aborted || succeeded(execution.result)) return undefined;
  if (host.local || !transportFailed(execution.result)) {
    return `rollback failed: ${describeFailure(execution)}`;
  }

  // Session dropped, a gateway restarting its network: the result file tells.
  const settled = await settle(context, target, "rollback", false, true);
  switch (settled.kind) {
    case "aborted":
      return undefined;
    case "result":
      return settled.code === 0 ? undefined : `rollback failed: exit ${settled.code}`;
    case "missing":
      return `rollback did not run: ${describeFailure(execution)}`;
    case "failed":
      return settled.detail;
    case "lost":
      return "unreachable after rollback";
  }
}

/**
 * Back to its origin: `reverted`, reason kept. On failure the host ends
 * `failed`, both reasons in its note.
 */
export async function revertHost(
  context: RunContext,
  hosts: HostTable,
  name: string,
): Promise<void> {
  const host = hosts.get(name);
  const { origin, activated, note } = host;
  if (origin === undefined || activated === undefined) return;
  const failure = await reactivateOrigin(context, host, origin, activated);
  if (context.signal.aborted) return;

  if (failure === undefined) {
    hosts.set(name, "reverted", note === undefined ? {} : { note });
    log(context, "ok", "rolled back to its origin", name);
    return;
  }
  if (host.state === "failed")
    hosts.note(name, note === undefined ? failure : `${note}; ${failure}`);
  else hosts.set(name, "failed", { note: failure });
  log(context, "error", failure, name);
}

/** Head and gateways last: access to the other hosts depends on them. */
export async function rollbackFleet(
  context: RunContext,
  hosts: HostTable,
  selection: Selection,
): Promise<void> {
  // Lost hosts: left to their automatic rollback.
  const target = (name: string) => {
    const host = hosts.get(name);
    return host.activated !== undefined && !host.lost && canTransition(host.state, "reverted");
  };
  const waves = [...selection.waves]
    .reverse()
    .map((wave) => wave.filter(target))
    .filter((wave) => wave.length > 0);
  const count = waves.flat().length;
  if (count === 0) {
    log(context, "info", "nothing to roll back");
    return;
  }

  log(context, "warn", `rolling back ${count} hosts`);
  for (const wave of waves) {
    await pool(wave, context.params.maxParallel, context.signal, (name) =>
      revertHost(context, hosts, name),
    );
  }
}
