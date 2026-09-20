// Copy of a closure to one host (spec § Exécution, § Rapport): retried, then
// counted — what the host substituted itself against what was pushed to it.

import type { PullSource } from "../model/events.ts";
import { copyClosure, onHost, pullClosure, type Target } from "./commands/host.ts";
import { pathSizes } from "./commands/nix.ts";
import { emit, log, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import type { Fabric } from "./fabric.ts";
import { RETRY_ATTEMPTS } from "./known-errors.ts";
import { parseCopyPath, parsePathSize } from "./nix-output.ts";
import type { OutputLine } from "./ports.ts";

/** Distinct paths, so a retried copy counts a path once. */
interface Tally {
  /** Substituter name (§ Fabric) -> paths it served. */
  pulled: Map<string, Set<string>>;
  pushed: Set<string>;
}

function count(tally: Tally, fabric: Fabric, line: string): void {
  const copied = parseCopyPath(line);
  if (copied === undefined) return;
  if (copied.direction === "pushed") {
    tally.pushed.add(copied.path);
    return;
  }
  const source = fabric.substituter(copied.store);
  const paths = tally.pulled.get(source) ?? new Set<string>();
  paths.add(copied.path);
  tally.pulled.set(source, paths);
}

/** Biggest source first, then by name: the report reads top-down. */
function sources(tally: Tally): PullSource[] {
  return [...tally.pulled]
    .map(([source, paths]) => ({ source, paths: paths.size }))
    .sort((a, b) => b.paths - a.paths || a.source.localeCompare(b.source));
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

async function push(
  context: RunContext,
  name: string,
  path: string,
  from: string | undefined,
  onLine: (line: OutputLine) => void,
): Promise<string | undefined> {
  const { params, flow } = context;
  let note: string | undefined;

  // A `nix copy` killed loses the path in flight whole — nix has no partial
  // resume — and gives up on the paths after it. Retried at most twice: the
  // second run skips whatever is already valid (spec § Exécution).
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const execution = await execute(context, copyClosure(name, path, params.timeouts, from), {
      signal: flow.halt,
      onLine,
    });
    if (flow.halt.aborted || succeeded(execution.result)) return undefined;
    note = `copy failed: ${describeFailure(execution)}`;
    if (attempt < RETRY_ATTEMPTS) log(context, "warn", `${note}, retrying`, name);
  }
  return note;
}

export interface Served {
  /** Host to serve, and whether it is the deployment machine itself. */
  target: Target;

  /** Toplevel to put in its store. */
  path: string;

  /** Store holding it: a push comes from there when it is not the local one. */
  builder: string;
}

/**
 * Puts the closure on the host: pulled by the host from its own substituters
 * first, pushed from the store that holds it when nothing can serve it (spec
 * § Publication). Emits the copy counters of the host. Returns the failure
 * note, `undefined` when the host holds the closure or a halt cut the work.
 */
export async function serveHost(
  context: RunContext,
  fabric: Fabric,
  served: Served,
  onLine: (line: OutputLine) => void,
): Promise<string | undefined> {
  const { params, flow } = context;
  const { target, path, builder } = served;
  const tally: Tally = { pulled: new Map(), pushed: new Set() };
  const watch = (line: OutputLine) => {
    count(tally, fabric, line.line);
    onLine(line);
  };
  const pull = () =>
    execute(context, onHost(target, pullClosure(path, params.timeouts), params.timeouts), {
      signal: flow.halt,
      onLine: watch,
    });

  // A freshly built path sits in no cache: a failed pull is the ordinary case,
  // not an incident, and the push behind it is the fallback, not a repair.
  let note: string | undefined;
  if (!succeeded((await pull()).result) && !flow.halt.aborted) {
    const from = builder === context.local.hostname() ? undefined : builder;
    note = await push(context, target.host, path, from, watch);

    // Roots what the push landed: same command, instant from the local store.
    if (note === undefined && !flow.halt.aborted) await pull();
  }

  // Aborted `now`: the process is being killed, no time left to measure.
  if (!context.signal.aborted) await report(context, served, tally);
  return note;
}

async function report(context: RunContext, served: Served, tally: Tally): Promise<void> {
  if (tally.pulled.size + tally.pushed.size === 0) return;
  const pushed = [...tally.pushed];
  const pushedBytes = await volume(context, pushed);
  emit(context, {
    kind: "host.copy",
    host: served.target.host,
    builder: served.builder,
    pulled: sources(tally),
    pushed: pushed.length,
    pushedBytes,
  });
}
