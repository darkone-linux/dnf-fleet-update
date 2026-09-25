// Flake sources a remote builder fetches from their origin (spec § Substituteurs
// et plomberie de build): a nixpkgs bump is ~200 MiB the derivation copy would
// otherwise push over the uplink of the deployment machine, once per builder.

import { type FlakeSource, fetchSources, onHost } from "./commands/host.ts";
import { derivationClosure, fixedSourcePath } from "./commands/nix.ts";
import { flakeMetadata } from "./commands/workspace.ts";
import { emit, log, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import { parseLockedSources, STORE_PATH } from "./nix-output.ts";

export interface SourceSeeder {
  /**
   * Resolves once `builder` holds the locked sources the closure of `drvPath`
   * needs, or failed to: a miss only means the derivation copy pushes them.
   * `host`: the host built there, whose log receives the fetch.
   */
  seed(builder: string, drvPath: string, host: string): Promise<void>;
}

/** Said once: the builders then receive every source from here, as before. */
function none(context: RunContext, reason: string): FlakeSource[] {
  log(context, "info", `flake sources left to the derivation copy: ${reason}`);
  return [];
}

/** Sources of the consumer lock, each with the store path it lands at. */
async function lockedSources(context: RunContext): Promise<FlakeSource[]> {
  const { timeouts } = context.params;
  const options = { signal: context.flow.halt };
  const metadata = await execute(context, flakeMetadata(context.workspace, timeouts), options);
  if (context.flow.halt.aborted) return [];
  if (!succeeded(metadata.result)) return none(context, describeFailure(metadata));
  let json: unknown;
  try {
    json = JSON.parse(metadata.stdout.join("\n"));
  } catch {
    return none(context, "flake metadata: not JSON");
  }
  const locked = parseLockedSources(json);
  if (!locked.ok) return none(context, locked.error);

  const resolved = await Promise.all(
    locked.value.map(async ({ ref, narHash }) => {
      const fixed = await execute(context, fixedSourcePath(narHash, timeouts), options);
      const path = fixed.stdout[0]?.trim() ?? "";
      return succeeded(fixed.result) && STORE_PATH.test(path) ? [{ ref, path }] : [];
    }),
  );
  return resolved.flat();
}

async function fetchOn(
  context: RunContext,
  builder: string,
  sources: readonly FlakeSource[],
  host: string,
): Promise<void> {
  const { timeouts } = context.params;
  const spec = onHost({ host: builder, local: false }, fetchSources(sources, timeouts), timeouts);
  const fetched = await execute(context, spec, {
    signal: context.flow.halt,
    onLine: ({ line }) => emit(context, { kind: "host.output", host, phase: "build", line }),
  });
  if (context.flow.halt.aborted || succeeded(fetched.result)) return;
  const note = describeFailure(fetched);
  log(context, "info", `builder ${builder}: flake sources not fetched, copied: ${note}`, host);
}

/** One per build step: the lock is read once, a source fetched once per builder. */
export function sourceSeeder(context: RunContext): SourceSeeder {
  let locked: Promise<FlakeSource[]> | undefined;

  // `<builder> <path>` -> its fetch, awaited by every host built there.
  const fetches = new Map<string, Promise<void>>();
  const key = (builder: string, source: FlakeSource) => `${builder} ${source.path}`;

  return {
    async seed(builder, drvPath, host) {
      locked ??= lockedSources(context);
      const sources = await locked;
      if (sources.length === 0 || context.flow.halt.aborted) return;

      const { timeouts } = context.params;
      const closure = await execute(context, derivationClosure(drvPath, timeouts), {
        signal: context.flow.halt,
      });
      if (context.flow.halt.aborted) return;
      if (!succeeded(closure.result)) {
        const note = describeFailure(closure);
        log(context, "info", `flake sources left to the derivation copy: ${note}`, host);
        return;
      }
      const paths = new Set(closure.stdout.map((line) => line.trim()));
      const needed = sources.filter((source) => paths.has(source.path));

      // Checked and set in one tick: two hosts of a builder share one fetch.
      const fresh = needed.filter((source) => !fetches.has(key(builder, source)));
      if (fresh.length > 0) {
        const fetch = fetchOn(context, builder, fresh, host);
        for (const source of fresh) fetches.set(key(builder, source), fetch);
      }
      await Promise.all(needed.map((source) => fetches.get(key(builder, source))));
    },
  };
}
