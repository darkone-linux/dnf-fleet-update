// Failed builds handed to the AI (spec § réparation, J10): one group per
// reason, before the build step decides anything.

import { analyseGroup, quiet } from "../ai/analysis.ts";
import { repairGroup } from "../ai/repair.ts";
import type { RunContext } from "./context.ts";
import type { HostEntry, HostTable } from "./hosts.ts";

/** Hosts broken by the same failure: one session for all of them. */
export interface BuildGroup {
  hosts: string[];

  /** Host whose own build met the failure: its log holds the whole trace. */
  representative: string;
}

/** A known `stop` or `exclude` decides on its own: the deterministic comes first. */
function eligible(host: HostEntry): boolean {
  const fix = host.knownError?.fix.kind;
  return (
    host.state === "failed" && host.buildCause !== undefined && fix !== "stop" && fix !== "exclude"
  );
}

/** Failures the code may hold the cause of, grouped by reason, in fleet order. */
export function buildGroups(hosts: readonly HostEntry[]): BuildGroup[] {
  const byReason = new Map<string | undefined, HostEntry[]>();
  for (const host of hosts.filter(eligible)) {
    byReason.set(host.note, [...(byReason.get(host.note) ?? []), host]);
  }
  return [...byReason.values()].flatMap((members) => {
    const [first] = members;
    if (first === undefined) return [];
    const own = members.find(
      (host) => host.buildCause?.kind !== "derivation" || host.buildCause.own,
    );
    return [{ hosts: members.map((host) => host.name), representative: (own ?? first).name }];
  });
}

/**
 * End of the build, `--ai-error-action` ≠ `none`: each group analysed, then
 * repaired at `repair`, one after the other. Never blocks the build: the
 * decision follows as before. `true`: at least one fix was committed.
 */
export async function handOffBuilds(context: RunContext, hosts: HostTable): Promise<boolean> {
  if (context.params.aiErrorAction === "none") return false;
  let fixed = false;
  for (const group of buildGroups(hosts.all())) {
    if (quiet(context)) return fixed;
    await analyseGroup(context, hosts, group);
    if (await repairGroup(context, hosts, group)) fixed = true;
  }
  return fixed;
}
