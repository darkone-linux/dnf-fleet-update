// Copy of a closure to one host (spec § Exécution, § Rapport): retried, then
// counted — what the host substituted itself against what was pushed to it.

import { copyClosure } from "./commands/host.ts";
import { pathSizes } from "./commands/nix.ts";
import { emit, log, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import { parseCopyPath, parsePathSize } from "./nix-output.ts";
import type { OutputLine } from "./ports.ts";

/** Distinct paths, so a retried copy counts a path once. */
interface Tally {
  pulled: Set<string>;
  pushed: Set<string>;
}

function count(tally: Tally, line: string): void {
  const copied = parseCopyPath(line);
  if (copied !== undefined) tally[copied.direction].add(copied.path);
}

/** Keeps the `nix path-info` argv well under ARG_MAX on a fleet-sized closure. */
const CHUNK = 500;

/** Sum of the NAR sizes held locally; a chunk that fails just counts for nothing. */
async function volume(context: RunContext, paths: readonly string[]): Promise<number> {
  let total = 0;
  for (let index = 0; index < paths.length; index += CHUNK) {
    const [first, ...rest] = paths.slice(index, index + CHUNK);
    if (first === undefined) continue;
    const spec = pathSizes([first, ...rest], context.params.timeouts);
    const execution = await execute(context, spec, { signal: context.signal });
    for (const line of execution.stdout) total += parsePathSize(line) ?? 0;
  }
  return total;
}

/**
 * A `nix copy` killed loses the path in flight whole — nix has no partial
 * resume — and gives up on the paths after it. Retried at most twice: the
 * second run skips whatever is already valid (spec § Exécution).
 */
const ATTEMPTS = 3;

/**
 * Copies the closure, then emits the copy counters of the host. Returns the
 * failure note, `undefined` when the copy went through or a halt cut it.
 */
export async function copyToHost(
  context: RunContext,
  name: string,
  path: string,
  onLine: (line: OutputLine) => void,
): Promise<string | undefined> {
  const { params, flow } = context;
  const tally: Tally = { pulled: new Set(), pushed: new Set() };
  let note: string | undefined;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const execution = await execute(context, copyClosure(name, path, params.timeouts), {
      signal: flow.halt,
      onLine: (line) => {
        count(tally, line.line);
        onLine(line);
      },
    });
    if (flow.halt.aborted || succeeded(execution.result)) {
      note = undefined;
      break;
    }
    note = `copy failed: ${describeFailure(execution)}`;
    if (attempt < ATTEMPTS) log(context, "warn", `${note}, retrying`, name);
  }

  // Aborted `now`: the process is being killed, no time left to measure.
  if (!context.signal.aborted) await report(context, name, tally);
  return note;
}

async function report(context: RunContext, name: string, tally: Tally): Promise<void> {
  if (tally.pulled.size + tally.pushed.size === 0) return;
  const pushed = [...tally.pushed];
  const pushedBytes = await volume(context, pushed);
  emit(context, {
    kind: "host.copy",
    host: name,
    builder: context.local.hostname(),
    pulled: tally.pulled.size,
    pushed: pushed.length,
    pushedBytes,
  });
}
