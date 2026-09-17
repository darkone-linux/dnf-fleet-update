// Forced rollback of the fleet (spec § Erreurs et réparations, `rollback`):
// activated hosts back to their origin, waves in reverse order.

import { canTransition } from "../model/transitions.ts";
import { onHost, rollbackNow } from "./commands/host.ts";
import { emit, log, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import type { HostTable } from "./hosts.ts";
import { pool } from "./pool.ts";
import type { Selection } from "./steps/select.ts";

async function rollbackHost(context: RunContext, hosts: HostTable, name: string): Promise<void> {
  const host = hosts.get(name);
  const { origin, activated } = host;
  if (origin === undefined || activated === undefined) return;

  const command = rollbackNow(origin, activated, context.params.timeouts);
  const target = { host: name, local: host.local };
  const execution = await execute(context, onHost(target, command, context.params.timeouts), {
    onLine: ({ line }) =>
      emit(context, { kind: "host.output", host: name, phase: "rollback", line }),
  });
  if (context.signal.aborted) return;

  if (succeeded(execution.result)) {
    hosts.set(name, "reverted");
    log(context, "ok", "rolled back to its origin", name);
    return;
  }
  const note = `rollback failed: ${describeFailure(execution)}`;
  if (host.state !== "failed") hosts.set(name, "failed", { note });
  log(context, "error", note, name);
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
      rollbackHost(context, hosts, name),
    );
  }
}
