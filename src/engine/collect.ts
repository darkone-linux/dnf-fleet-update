// Deterministic collection on a failed host (spec § Erreurs et réparations):
// what the host could not start, and the error that got it there.
//
// Runs before the decision, so the question is asked on what the host says.
// Full output in `logs/<host>.diag`; units and excerpt in `host.diagnosis`,
// which feeds the report, the incidents message and the AI analysis.

import {
  failedUnits,
  onHost,
  parseFailedUnits,
  systemStatus,
  type Target,
  unitJournal,
} from "./commands/host.ts";
import { emit, log, type RunContext } from "./context.ts";
import { execute } from "./exec.ts";
import type { HostEntry, HostTable } from "./hosts.ts";

/** Log of the run directory holding the collection of one host. */
const DIAG = "diag";

/** Wave the host belongs to, in seconds: the journal window of its units. */
function since(context: RunContext, host: HostEntry): number {
  const startedAt = host.waveStartedAt ?? context.startedAt;
  return (context.clock.now() - startedAt) / 1000;
}

/** Failed units of the host, their journals appended to the collection log. */
async function units(context: RunContext, host: HostEntry): Promise<string[]> {
  const { timeouts, diagnostics } = context.params;
  const target: Target = { host: host.name, local: host.local };
  const options = { log: { host: host.name, phase: DIAG } };

  // Non-zero on a degraded system: the state is what the log keeps, not the code.
  await execute(context, onHost(target, systemStatus(timeouts), timeouts), options);
  const listed = await execute(context, onHost(target, failedUnits(timeouts), timeouts), options);
  const names = parseFailedUnits(listed.stdout.join("\n"));

  const window = since(context, host);
  for (const unit of names) {
    if (context.signal.aborted) break;
    const journal = unitJournal(unit, window, diagnostics.journalLines, timeouts);
    await execute(context, onHost(target, journal, timeouts), options);
  }
  return names;
}

/**
 * Collects what a failed host can still tell. Units only once it was activated
 * and answers: before that it has nothing to show. Returns the failed units,
 * which the restart of the units reads.
 */
export async function collect(
  context: RunContext,
  hosts: HostTable,
  name: string,
  excerpt?: readonly string[],
): Promise<string[]> {
  const host = hosts.get(name);
  const reachable = host.activated !== undefined && host.online !== false && !host.lost;
  const found = reachable && !context.signal.aborted ? await units(context, host) : [];
  if (found.length > 0) log(context, "warn", `units failed: ${found.join(", ")}`, name);

  const kept = excerpt?.slice(-context.params.diagnostics.excerptLines) ?? [];
  if (found.length === 0 && kept.length === 0) return found;
  emit(context, {
    kind: "host.diagnosis",
    host: name,
    units: found,
    ...(kept.length === 0 ? {} : { excerpt: kept }),
  });
  return found;
}
