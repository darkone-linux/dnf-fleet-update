// Fleet data of the consumer: `var/generated/hosts.nix` and `network.nix`.
//
// Read as `nix-instantiate --eval --strict --json` output: `unknown` until
// these schemas accept it. Nothing consumer-specific is assumed.

import { z } from "zod";
import { TIMEOUT_KEYS, type Timeouts } from "../model/params.ts";
import { fail, ok, type Result } from "../model/result.ts";

/** Generator `RE_HOSTNAME`: also safe in argv, Nix strings and systemd unit names. */
export const HOSTNAME = /^[a-zA-Z][a-zA-Z0-9_-]{1,59}$/;

/** Generator `RE_PROFILE`. */
export const PROFILE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export interface FleetHost {
  name: string;
  profile: string;
  zone: string;
  ip?: string;
  vpnIp?: string;

  /** Absent: the architecture of the deployment host. */
  arch?: string;

  /** Colmena deployment tags, the `@tag` of `--on`. */
  tags: string[];
}

export interface FleetZone {
  name: string;
  ipPrefix?: string;
  gateway?: string;
}

/** One entry of `network.services`: a service, the host running it, its zone. */
export interface FleetService {
  name: string;
  host: string;
  zone: string;
}

/** `network.fleetUpdate`: only what the consumer declared. */
export interface FleetDefaults {
  deploymentOrder?: string;
  criticalProfiles?: string;
  timeouts: Partial<Timeouts>;
  pingInterval?: number;
}

export interface Fleet {
  hosts: FleetHost[];
  zones: FleetZone[];
  services: FleetService[];
  domain: string;
  defaults: FleetDefaults;
}

const hostSchema = z.object({
  hostname: z.string().regex(HOSTNAME),
  profile: z.string().regex(PROFILE),
  zone: z.string().min(1),
  ip: z.string().nullish(),
  vpnIp: z.string().nullish(),
  arch: z.string().nullish(),
  colmena: z
    .object({ deployment: z.object({ tags: z.array(z.string()).nullish() }).nullish() })
    .nullish(),
});

const seconds = z.number().int().positive();

const serviceSchema = z.object({
  name: z.string().min(1),
  host: z.string().regex(HOSTNAME),
  zone: z.string().min(1),
});

const networkSchema = z.object({
  domain: z.string().min(1),
  services: z.array(serviceSchema).nullish(),
  zones: z.record(
    z.string().min(1),
    z.object({
      ipPrefix: z.string().nullish(),
      gateway: z.object({ hostname: z.string().regex(HOSTNAME).nullish() }).nullish(),
    }),
  ),

  // Unknown timeout keys rejected: a typo must not silently fall back to a default.
  fleetUpdate: z
    .strictObject({
      deploymentOrder: z.string().nullish(),
      criticalProfiles: z.string().nullish(),
      timeouts: z.partialRecord(z.enum(TIMEOUT_KEYS), seconds).nullish(),
      pingInterval: seconds.nullish(),
    })
    .nullish(),
});

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

/** Hosts in `hosts.nix` order, which orders hosts inside a wave. */
export function parseHosts(json: unknown): Result<FleetHost[]> {
  const parsed = z.array(hostSchema).safeParse(json);
  if (!parsed.success) return fail(`hosts.nix: ${z.prettifyError(parsed.error)}`);

  const hosts = parsed.data.map((host) => ({
    name: host.hostname,
    profile: host.profile,
    zone: host.zone,
    ip: orUndefined(host.ip),
    vpnIp: orUndefined(host.vpnIp),
    arch: orUndefined(host.arch),
    tags: host.colmena?.deployment?.tags ?? [],
  }));

  const seen = new Set<string>();
  for (const host of hosts) {
    if (seen.has(host.name)) return fail(`hosts.nix: duplicate host ${host.name}`);
    seen.add(host.name);
  }
  return ok(hosts);
}

/** `network.nix` alone: the fleet defaults are needed before the hosts. */
export function parseNetwork(json: unknown): Result<Omit<Fleet, "hosts">> {
  const parsed = networkSchema.safeParse(json);
  if (!parsed.success) return fail(`network.nix: ${z.prettifyError(parsed.error)}`);
  const network = parsed.data;

  const declared = network.fleetUpdate;
  return ok({
    zones: Object.entries(network.zones).map(([name, zone]) => ({
      name,
      ipPrefix: orUndefined(zone.ipPrefix),
      gateway: orUndefined(zone.gateway?.hostname),
    })),
    services: (network.services ?? []).map((service) => ({
      name: service.name,
      host: service.host,
      zone: service.zone,
    })),
    domain: network.domain,
    defaults: {
      deploymentOrder: orUndefined(declared?.deploymentOrder),
      criticalProfiles: orUndefined(declared?.criticalProfiles),
      timeouts: declared?.timeouts ?? {},
      pingInterval: orUndefined(declared?.pingInterval),
    },
  });
}

/** Both files at once: every host zone must exist. */
export function parseFleet(hostsJson: unknown, networkJson: unknown): Result<Fleet> {
  const hosts = parseHosts(hostsJson);
  if (!hosts.ok) return hosts;
  const network = parseNetwork(networkJson);
  if (!network.ok) return network;

  const zoneNames = new Set(network.value.zones.map((zone) => zone.name));
  const stray = hosts.value.find((host) => !zoneNames.has(host.zone));
  if (stray) return fail(`hosts.nix: host ${stray.name} in unknown zone ${stray.zone}`);
  return ok({ hosts: hosts.value, ...network.value });
}
