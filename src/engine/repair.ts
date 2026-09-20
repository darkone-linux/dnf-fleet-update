// Deterministic repair of a host in `error` (spec § Erreurs et réparations).
//
// The units that did not start are restarted once, after a settle wait. All of
// them back up: the activation order is the likely culprit, not the
// configuration — the run goes on with the host, and the report says so.

import { readFailedUnits } from "./collect.ts";
import { onHost, type Phase, restartUnits, type Target } from "./commands/host.ts";
import { emit, log, type RunContext } from "./context.ts";
import { execute } from "./exec.ts";
import type { HostTable } from "./hosts.ts";

/** Said at the report and at the feed: the one thing a restart proves. */
const ORDERING = "units recovered after a restart: probable activation ordering issue";

/**
 * Restarts the failed units of a host left in `error`. Does nothing when the
 * run is halting: a repair is a new operation. The host ends `tested` or
 * `deployed` when nothing fails any more, `error` again otherwise.
 */
export async function repairUnits(
  context: RunContext,
  hosts: HostTable,
  name: string,
  units: readonly string[],
  phase: Phase,
): Promise<void> {
  const { params, flow } = context;
  const [first, ...rest] = units;
  if (first === undefined || flow.halt.aborted || flow.ending !== undefined) return;

  const host = hosts.get(name);
  hosts.set(name, "repairing", { note: `restarting ${units.join(", ")}` });
  log(context, "info", `restarting failed units in ${params.repair.settleSeconds}s`, name);
  await context.clock.sleep(params.repair.settleSeconds * 1000, context.signal);
  if (context.signal.aborted) return;

  const target: Target = { host: name, local: host.local };
  const spec = onHost(target, restartUnits([first, ...rest], params.timeouts), params.timeouts);
  await execute(context, spec, { log: { host: name, phase: "repair" } });
  if (context.signal.aborted) return;

  // Read back rather than trust the exit code: a unit may fail after its start.
  const failing = await readFailedUnits(context, host);
  const left = units.filter((unit) => failing.includes(unit));
  if (left.length > 0) {
    hosts.set(name, "error", { note: `units still failed after a restart: ${left.join(", ")}` });
    log(context, "warn", `units still failed after a restart: ${left.join(", ")}`, name);
    return;
  }

  hosts.set(name, phase === "test" ? "tested" : "deployed");
  log(context, "ok", ORDERING, name);
  emit(context, { kind: "note", host: name, message: ORDERING });
}
