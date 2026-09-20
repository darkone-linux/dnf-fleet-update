// Step 4, publication (spec § Publication): every reachable host ends holding
// its closure, so the waves that follow ask nothing of the network but `ssh`.
//
// Nothing is activated here, so nothing needs protecting: zones run in
// parallel, each capped by `--max-parallel`.

import { emit, log, type RunContext } from "../context.ts";
import { serveHost } from "../copy.ts";
import { failedBeforeActivation } from "../deploy.ts";
import type { HostEntry, HostTable } from "../hosts.ts";
import { pool } from "../pool.ts";
import type { Presence } from "../presence.ts";
import { endStep } from "./step.ts";

/** Serves one host. `true`: it failed, its decision already taken. */
async function serve(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  host: HostEntry,
): Promise<boolean> {
  const { name, path } = host;
  if (path === undefined) throw new Error(`${name}: published without a built path`);
  hosts.set(name, "copying");

  // The deployment host built it: nothing to move.
  if (host.local) {
    hosts.set(name, "ready");
    return false;
  }
  const failure = await serveHost(
    context,
    hosts.fabric,
    { target: { host: name, local: false }, path, builder: host.builder },
    ({ line }) => emit(context, { kind: "host.output", host: name, phase: "publish", line }),
  );
  if (context.flow.halt.aborted) return true;
  if (failure === undefined) {
    hosts.set(name, "ready");
    return false;
  }
  await failedBeforeActivation(context, hosts, presence, name, failure);
  return true;
}

/**
 * One zone. Its cache is served first when it is not the store the closure
 * comes from: without that order no host of the zone finds the path and all of
 * them get pushed to — N crossings of the slow link instead of one.
 */
async function publishZone(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
  zone: string,
  members: readonly HostEntry[],
  done: () => void,
): Promise<void> {
  const { flow, params } = context;
  const cache = hosts.fabric.harmonia(zone);
  const seed = members.find((host) => host.name === cache);
  const rest = seed === undefined ? members : members.filter((host) => host !== seed);

  if (seed !== undefined) {
    const failed = await serve(context, hosts, presence, seed);
    done();
    if (flow.halt.aborted) return;

    // Degraded, never fatal: the zone is still deployed, host by host.
    if (failed) log(context, "warn", `zone ${zone}: cache not seeded, its hosts pay one by one`);
  }
  await pool(
    rest.map((host) => host.name),
    params.maxParallel,
    flow.halt,
    async (name) => {
      await serve(context, hosts, presence, hosts.get(name));
      done();
    },
  );
}

export async function publish(
  context: RunContext,
  hosts: HostTable,
  presence: Presence,
): Promise<void> {
  const { flow } = context;
  const candidates = hosts.all().filter((host) => host.state === "built");
  if (candidates.length === 0) {
    log(context, "info", "no built host: nothing to publish");
    emit(context, { kind: "step.end", step: "publish", status: "skipped" });
    return;
  }

  const names = candidates.map((host) => host.name);
  presence.track(names);
  await presence.check(names);
  presence.untrack(names);
  if (flow.halt.aborted) return;

  // An unreachable host stays `built`: its wave serves it if it comes back
  // (spec § Publication). The invariant only ever covers reachable hosts.
  const reachable = candidates.filter((host) => host.local || host.online);
  const left = candidates.filter((host) => !reachable.includes(host));
  if (left.length > 0) {
    log(
      context,
      "warn",
      `offline, served before their wave: ${left.map((h) => h.name).join(", ")}`,
    );
  }

  // Degraded, never fatal (spec § Publication): a zone whose cache misses the
  // publication pays one crossing per host instead of one.
  for (const host of left) {
    if (hosts.fabric.harmonia(host.zone) !== host.name) continue;
    log(context, "warn", `zone ${host.zone}: cache offline, its hosts pay one by one`);
  }
  emit(context, { kind: "step.start", step: "publish", total: reachable.length });

  const zones = new Map<string, HostEntry[]>();
  for (const host of reachable) zones.set(host.zone, [...(zones.get(host.zone) ?? []), host]);

  let served = 0;
  const done = () => {
    served += 1;
    emit(context, {
      kind: "step.progress",
      step: "publish",
      done: served,
      total: reachable.length,
    });
  };
  await Promise.all(
    [...zones].map(([zone, members]) => publishZone(context, hosts, presence, zone, members, done)),
  );
  endStep(context, "publish", !flow.halt.aborted);
}
