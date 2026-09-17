// Deployment waves and current zone (spec § Vagues, § Étapes, sélection).
//
// Planned once at selection on every selected host, presence ignored: the
// execution drops unreachable hosts and empty waves.

import { fail, ok, type Result } from "../model/result.ts";
import { type FleetHost, type FleetZone, PROFILE } from "./fleet.ts";

/** Profiles not listed elsewhere in the order. */
export const OTHERS = "[others]";

/** Same rule as the generator (`assert_profile_list`): `:`-separated, no duplicate. */
export function parseProfileList(value: string, allowOthers: boolean): Result<string[]> {
  const items = value.split(":");
  const seen = new Set<string>();
  for (const item of items) {
    const valid = PROFILE.test(item) || (allowOthers && item === OTHERS);
    if (!valid || seen.has(item)) return fail(`invalid profile list "${value}"`);
    seen.add(item);
  }
  return ok(items);
}

/** Longest `ipPrefix` matching one of the local IPv4 addresses. */
export function currentZone(
  zones: readonly FleetZone[],
  addresses: readonly string[],
): string | undefined {
  let best: FleetZone | undefined;
  for (const zone of zones) {
    const prefix = zone.ipPrefix;
    if (prefix === undefined) continue;
    const hit = addresses.some((address) => address === prefix || address.startsWith(`${prefix}.`));
    if (hit && prefix.length > (best?.ipPrefix?.length ?? 0)) best = zone;
  }
  return best?.name;
}

export interface WavePlan {
  /** Selected hosts, in fleet order. */
  hosts: readonly FleetHost[];

  /** Parsed `--deployment-order`. */
  order: readonly string[];

  /** Zone whose waves go first; absent: waves by profile, all zones together. */
  currentZone?: string;
}

/**
 * Host names per wave, empty waves dropped. The first order element is the
 * head wave, all zones together. A profile neither listed nor covered by
 * `[others]` joins a last group.
 */
export function planWaves({ hosts, order, currentZone }: WavePlan): string[][] {
  const others = order.indexOf(OTHERS);
  const groupOf = (host: FleetHost): number => {
    const listed = order.indexOf(host.profile);
    if (listed >= 0) return listed;
    return others >= 0 ? others : order.length;
  };

  const groups = order.length + 1;
  const wave = (group: number, inZone?: (host: FleetHost) => boolean): string[] =>
    hosts
      .filter((host) => groupOf(host) === group && (inZone === undefined || inZone(host)))
      .map((host) => host.name);

  const waves: string[][] = [wave(0)];
  if (currentZone === undefined) {
    for (let group = 1; group < groups; group += 1) waves.push(wave(group));
  } else {
    for (let group = 1; group < groups; group += 1) {
      waves.push(wave(group, (host) => host.zone === currentZone));
    }
    for (let group = 1; group < groups; group += 1) {
      waves.push(wave(group, (host) => host.zone !== currentZone));
    }
  }
  return waves.filter((names) => names.length > 0);
}
