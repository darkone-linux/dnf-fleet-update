// Step 2, selection (spec § Étapes): fleet data, `--on`, current zone, wave plan.

import { fail, ok, type Result } from "../../model/result.ts";
import { hasPath, onHost } from "../commands/host.ts";
import { pathInfo } from "../commands/nix.ts";
import {
  type GeneratedFile,
  gitHead,
  gitStatus,
  justGenerate,
  readGenerated,
} from "../commands/workspace.ts";
import { ask, emit, log, type RunContext, YES_NO } from "../context.ts";
import { describeFailure, execute, succeeded } from "../exec.ts";
import { Fabric } from "../fabric.ts";
import { type FleetHost, parseFleet } from "../fleet.ts";
import { parseQuery, selectHosts } from "../query.ts";
import { type Restored, restore, type SavedState, sameRevisions } from "../resume.ts";
import { currentZone, parseProfileList, planWaves } from "../waves.ts";
import { endStep } from "./step.ts";

export interface Selection {
  /** In fleet order. */
  hosts: FleetHost[];

  /** Host names per wave, as planned (event `plan`). */
  waves: string[][];

  /** Zone gateways among the selected hosts: guarded when lost. */
  gateways: ReadonlySet<string>;

  /** Cache topology the run was planned on: zone caches, substituter names. */
  fabric: Fabric;

  /** Builder elected for each selected host (spec § Substituteurs), by host name. */
  builders: ReadonlyMap<string, string>;

  /** The selected host this process runs on: no ssh, no copy, no rollback timer. */
  local?: string;

  /** `--resume`: progress the host table starts from, per host. */
  restored?: ReadonlyMap<string, Restored>;
}

type Revisions = SavedState["revisions"];

/**
 * Revision of each repository once the update is done: recorded for the report
 * and for a later `--resume`. Unread revision is a warning, not a failure.
 */
async function readRevisions(context: RunContext): Promise<Revisions> {
  const { timeouts } = context.params;
  const repos: { repo: "dnf" | "consumer"; directory: string }[] = [
    { repo: "consumer", directory: context.workspace },
  ];
  if (context.codev) repos.push({ repo: "dnf", directory: `${context.workspace}/dnf` });

  const revisions: Revisions = {};
  for (const { repo, directory } of repos) {
    const execution = await execute(context, gitHead(directory, timeouts));
    const rev = execution.stdout[0]?.trim();
    if (!succeeded(execution.result) || !rev) {
      if (!context.signal.aborted) log(context, "warn", `${repo}: revision not read`);
      continue;
    }
    revisions[repo] = rev;
    emit(context, { kind: "revision", repo, rev });
  }
  return revisions;
}

/**
 * `--resume` skips the update, so `var/generated/` is regenerated here: any
 * change means the configuration moved since the saved run (spec § Étapes).
 */
async function regenerate(context: RunContext): Promise<string | undefined> {
  const { timeouts } = context.params;
  const generated = await execute(context, justGenerate(context.workspace, timeouts), {
    log: { phase: "select" },
  });
  if (!succeeded(generated.result)) return `just generate failed: ${describeFailure(generated)}`;

  const status = await execute(context, gitStatus(context.workspace, timeouts));
  if (!succeeded(status.result)) return `git status failed: ${describeFailure(status)}`;
  const changes = status.stdout.filter((line) => line.trim() !== "");
  return changes.length === 0
    ? undefined
    : `generated files changed (${changes.length}): configuration moved, start a new run`;
}

/** Built paths still in a store, under the same revisions: what needs no build again. */
async function reusable(
  context: RunContext,
  resume: { saved: SavedState },
  names: ReadonlySet<string>,
  revisions: Revisions,
  builders: ReadonlyMap<string, string>,
): Promise<Map<string, Restored>> {
  const { saved } = resume;
  const restored = new Map<string, Restored>();
  const same = sameRevisions(saved.revisions, revisions, context.codev);
  if (!same) {
    log(context, "warn", "revisions changed since the saved run: everything is built again");
    return restored;
  }

  // Asked of the store that holds the path — its builder, not systematically
  // the deployment machine (spec § État et reprise).
  const local = context.local.hostname();
  for (const host of saved.hosts) {
    if (!names.has(host.name) || host.path === undefined) continue;
    const { timeouts } = context.params;
    const builder = builders.get(host.name) ?? local;
    const spec =
      builder === local
        ? pathInfo(host.path, timeouts)
        : onHost({ host: builder, local: false }, hasPath(host.path, timeouts), timeouts);
    const execution = await execute(context, spec);
    if (context.signal.aborted) return restored;
    const entry = restore(host, succeeded(execution.result));
    if (entry !== undefined) restored.set(host.name, entry);
  }
  return restored;
}

/** `nix-instantiate --json` of a generated file, `unknown` until a schema accepts it. */
export async function readGeneratedJson(
  context: RunContext,
  file: GeneratedFile,
): Promise<Result<unknown>> {
  const spec = readGenerated(context.workspace, file, context.params.timeouts);
  const execution = await execute(context, spec);
  if (!succeeded(execution.result)) return fail(`${file}: ${describeFailure(execution)}`);
  try {
    return ok(JSON.parse(execution.stdout.join("\n")));
  } catch {
    return fail(`${file}: not JSON`);
  }
}

async function choose(context: RunContext): Promise<Selection | undefined> {
  const { params, resume } = context;
  const failed = (error: string) => {
    // Aborted `now`: the run end says it, no failure to report.
    if (!context.signal.aborted) log(context, "error", error);
    return undefined;
  };

  if (resume !== undefined) {
    log(context, "info", `resuming ${resume.saved.id}`);
    const stale = await regenerate(context);
    if (context.signal.aborted) return undefined;
    if (stale !== undefined) return failed(stale);
  }

  const revisions = await readRevisions(context);
  if (context.signal.aborted) return undefined;

  const hostsJson = await readGeneratedJson(context, "hosts.nix");
  if (!hostsJson.ok) return failed(hostsJson.error);
  const networkJson = await readGeneratedJson(context, "network.nix");
  if (!networkJson.ok) return failed(networkJson.error);
  const fleet = parseFleet(hostsJson.value, networkJson.value);
  if (!fleet.ok) return failed(fleet.error);

  let hosts = fleet.value.hosts;

  // A resume starts from what the saved run left; `--on` of this invocation
  // narrows that, the saved `--on` is already baked into it.
  if (resume !== undefined) {
    const left = new Set(resume.saved.hosts.map((host) => host.name));
    hosts = hosts.filter((host) => left.has(host.name));
  }
  const query = resume === undefined ? params.on : resume.filter;
  if (query !== undefined) {
    const terms = parseQuery(query);
    if (!terms.ok) throw new Error(`unchecked --on: ${terms.error}`);
    const selected = selectHosts(hosts, terms.value);
    for (const term of selected.unmatched) log(context, "warn", `--on: no host matches ${term}`);
    hosts = selected.hosts;
  }
  if (hosts.length === 0) return failed("no host selected");
  for (const host of hosts) {
    emit(context, { kind: "host.add", host: host.name, profile: host.profile, zone: host.zone });
  }

  // Election, once: the build delegates to it, the publication serves from it,
  // and a resume asks it whether the path is still there.
  const hostname = context.local.hostname();
  const fabric = new Fabric(fleet.value);
  const builders = new Map<string, string>();
  for (const host of hosts) {
    builders.set(host.name, params.distributedBuild ? fabric.builder(host, hostname) : hostname);
  }

  // Waves come from the saved plan: a resume keeps the order its run started
  // with, so no zone to detect either.
  let zone: string | undefined;
  if (params.currentZoneBefore && resume === undefined) {
    zone = currentZone(fleet.value.zones, context.local.addresses());
    if (zone !== undefined) {
      log(context, "info", `current zone: ${zone}`);
    } else {
      log(context, "warn", "current zone not found: waves by profile, all zones together");
      const question = "Current zone not found. Continue with waves by profile?";
      if (params.interactive && (await ask(context, "zone", question, YES_NO)) === "no") {
        context.flow.abort("after-wave");
      }
    }
  }

  const order = parseProfileList(params.deploymentOrder, true);
  if (!order.ok) throw new Error(`unchecked deployment order: ${order.error}`);
  const names = new Set(hosts.map((host) => host.name));
  const saved = resume?.saved.plan ?? [];
  const waves =
    saved.length === 0
      ? planWaves({ hosts, order: order.value, currentZone: zone })
      : saved
          .map((wave) => wave.filter((name) => names.has(name)))
          .filter((wave) => wave.length > 0);
  emit(context, { kind: "plan", waves });
  log(context, "ok", `${hosts.length} hosts selected, ${waves.length} waves`);

  let restored: Map<string, Restored> | undefined;
  if (resume !== undefined) {
    restored = await reusable(context, resume, names, revisions, builders);
    if (context.signal.aborted) return undefined;
    const build = hosts.length - restored.size;
    log(context, "info", `${restored.size} paths reused, ${build} to build`);
  }

  const gateways = fleet.value.zones
    .map((candidate) => candidate.gateway)
    .filter((name): name is string => name !== undefined && names.has(name));
  return {
    hosts,
    waves,
    gateways: new Set(gateways),
    fabric,
    builders,
    local: names.has(hostname) ? hostname : undefined,
    ...(restored === undefined ? {} : { restored }),
  };
}

/** `undefined`: the run stops (failure reported, or aborted `now`). */
export async function select(context: RunContext): Promise<Selection | undefined> {
  emit(context, { kind: "step.start", step: "select" });
  const selection = await choose(context);
  endStep(context, "select", selection !== undefined);
  return selection;
}
