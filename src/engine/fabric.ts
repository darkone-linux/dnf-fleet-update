// Cache fabric of the fleet (spec § Substituteurs et plomberie de build).
//
// Answers two questions the run keeps asking: which host caches a zone, and
// what a substituter URL seen in `nix copy` output actually is.

import type { Fleet, FleetHost } from "./fleet.ts";

/** Services a substituter URL can belong to; anything else is not a fleet cache. */
const CACHES = ["harmonia", "nix-cache"] as const;

/** Host feature opting a host into building its own closure. */
export const AUTO_BUILD = "auto-build";

export class Fabric {
  private readonly byZone = new Map<string, string>();
  private readonly hosts: readonly FleetHost[];
  private readonly caches = new Map<string, string[]>();
  private globalCache: string | undefined;

  constructor(fleet: Fleet) {
    this.hosts = fleet.hosts;
    for (const service of fleet.services) {
      if (service.name === "harmonia") {
        this.byZone.set(service.zone, service.host);
        if (service.global) this.globalCache ??= service.host;
      }
      if (!CACHES.some((name) => name === service.name)) continue;
      this.caches.set(service.host, [...(this.caches.get(service.host) ?? []), service.name]);
    }
  }

  /** Host running `harmonia` in that zone; `undefined` when the zone has none. */
  harmonia(zone: string): string | undefined {
    return this.byZone.get(zone);
  }

  /**
   * Builder elected for `host` (spec § Substituteurs et plomberie de build):
   * itself under `auto-build`, else the harmonia of its zone, else the `global`
   * harmonia, else `local`, the deployment machine. A builder must be able to
   * serve what it builds, so it is a harmonia host — its store is the cache of
   * its zone by construction.
   *
   * Pure, topology only: a builder unreachable or in failure falls back to the
   * deployment machine at build time.
   */
  builder(host: FleetHost, local: string): string {
    if (host.features.includes(AUTO_BUILD)) return host.name;
    const elected = this.byZone.get(host.zone) ?? this.globalCache;
    const builder = this.hosts.find((candidate) => candidate.name === elected);

    // Undeclared architecture is the deployment host's: two undeclared match.
    if (builder === undefined || builder.arch !== host.arch) return local;
    return builder.name;
  }

  /**
   * Plain name of a substituter URL, as the report prints it: `harmonia ag`
   * when the host it resolves to runs exactly one cache service, its name when
   * it runs both, else the host part of the URL (`cache.nixos.org`).
   */
  substituter(url: string): string {
    const address = hostOf(url);
    const host = this.hosts.find(
      (candidate) =>
        candidate.ip === address ||
        candidate.vpnIp === address ||
        candidate.name === address ||
        candidate.name === address.split(".")[0],
    );
    if (host === undefined) return address;
    const services = this.caches.get(host.name) ?? [];
    return services.length === 1 ? `${services[0]} ${host.zone}` : host.name;
  }
}

/** Host part of a substituter URL; the URL itself when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
