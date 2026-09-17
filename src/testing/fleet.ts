// Synthetic fleet of the engine tests: generator-shaped JSON, private and
// documentation address ranges only.

import { parseFleet } from "../engine/fleet.ts";
import type { Selection } from "../engine/steps/select.ts";
import type { CommandScript } from "./fakes.ts";

/**
 * Default order, zone `ag` current: `hcs` → `gw-ag` → `srv-ag` → `pc-ag` →
 * `gw-cp` → `lt-cp`.
 */
export const HOSTS_JSON = [
  { hostname: "hcs", profile: "hcs", zone: "www", ip: "203.0.113.10" },
  {
    hostname: "gw-ag",
    profile: "gateway",
    zone: "ag",
    ip: "10.1.0.1",
    colmena: { deployment: { tags: ["zone-ag"] } },
  },
  {
    hostname: "srv-ag",
    profile: "server",
    zone: "ag",
    ip: "10.1.0.2",
    colmena: { deployment: { tags: ["zone-ag"] } },
  },
  {
    hostname: "pc-ag",
    profile: "desktop",
    zone: "ag",
    ip: "10.1.0.3",
    colmena: { deployment: { tags: ["zone-ag"] } },
  },
  { hostname: "gw-cp", profile: "gateway", zone: "cp", ip: "10.2.0.1" },
  { hostname: "lt-cp", profile: "laptop", zone: "cp", ip: null },
];

export const NETWORK_JSON = {
  domain: "example.org",
  zones: {
    www: { ipPrefix: null, gateway: { hostname: "hcs" } },
    ag: { ipPrefix: "10.1", gateway: { hostname: "gw-ag" } },
    cp: { ipPrefix: "10.2", gateway: { hostname: "gw-cp" } },
  },
};

/** `nix-instantiate` of `var/generated/` in workspace `/ws`. */
export function generatedScripts(
  hosts: unknown = HOSTS_JSON,
  network: unknown = NETWORK_JSON,
): CommandScript[] {
  const read = (file: string, value: unknown): CommandScript => ({
    match: ["nix-instantiate", "--eval", "--strict", "--json", `/ws/var/generated/${file}`],
    output: [{ stream: "stdout", line: JSON.stringify(value) }],
  });
  return [read("hosts.nix", hosts), read("network.nix", network)];
}

/** Selection of the whole synthetic fleet from zone `ag`, as the select step returns it. */
export function fleetSelection(local?: string): Selection {
  const fleet = parseFleet(HOSTS_JSON, NETWORK_JSON);
  if (!fleet.ok) throw new Error(fleet.error);
  return {
    hosts: fleet.value.hosts,
    waves: [["hcs"], ["gw-ag"], ["srv-ag"], ["pc-ag"], ["gw-cp"], ["lt-cp"]],
    gateways: new Set(["hcs", "gw-ag", "gw-cp"]),
    local,
  };
}

/** Store path of a synthetic toplevel: 32 base-32 characters, then the name. */
export function storePath(name: string, suffix = ""): string {
  const hash = [...name.padEnd(32, "0")].map((c) => (/[0-9a-z]/.test(c) ? c : "0")).join("");
  return `/nix/store/${hash.slice(0, 32)}-nixos-system-${name}${suffix}`;
}

/** `nix-eval-jobs` line of a host that evaluates. */
export function evalLine(name: string): string {
  return JSON.stringify({
    attr: name,
    drvPath: storePath(name, ".drv"),
    outputs: { out: storePath(name) },
  });
}
