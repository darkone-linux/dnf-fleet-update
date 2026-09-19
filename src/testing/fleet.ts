// Synthetic fleet of the engine tests: generator-shaped JSON, private and
// documentation address ranges only.

import { Fabric } from "../engine/fabric.ts";
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

  // One harmonia per LAN zone: `gfx`-like in `ag`, the gateway in `cp`, which
  // also serves the whole fleet over the tailnet (`global`).
  services: [
    { name: "harmonia", host: "srv-ag", zone: "ag" },
    { name: "nix-cache", host: "gw-ag", zone: "ag" },
    { name: "harmonia", host: "gw-cp", zone: "cp", global: true },
    { name: "nix-cache", host: "gw-cp", zone: "cp" },
  ],
  zones: {
    www: { ipPrefix: null, gateway: { hostname: "hcs" } },
    ag: { ipPrefix: "10.1", gateway: { hostname: "gw-ag" } },
    cp: { ipPrefix: "10.2", gateway: { hostname: "gw-cp" } },
  },
};

/** Revision the synthetic consumer sits on (`git rev-parse HEAD`). */
export const CONSUMER_REV = "c".repeat(40);

/** `nix-instantiate` of `var/generated/` in workspace `/ws`. */
export function generatedScripts(
  hosts: unknown = HOSTS_JSON,
  network: unknown = NETWORK_JSON,
): CommandScript[] {
  const read = (file: string, value: unknown): CommandScript => ({
    match: ["nix-instantiate", "--eval", "--strict", "--json", `/ws/var/generated/${file}`],
    output: [{ stream: "stdout", line: JSON.stringify(value) }],
  });
  // Revision read by the select step, for the report and a later `--resume`.
  const head: CommandScript = {
    match: ["git", "-C", "/ws", "rev-parse", "HEAD"],
    output: [{ stream: "stdout", line: CONSUMER_REV }],
  };
  return [read("hosts.nix", hosts), read("network.nix", network), head];
}

/**
 * Selection of the whole synthetic fleet from zone `ag`, as the select step
 * returns it. Deployment machine `deployer` unless it is one of the hosts.
 */
export function fleetSelection(local?: string): Selection {
  const fleet = parseFleet(HOSTS_JSON, NETWORK_JSON);
  if (!fleet.ok) throw new Error(fleet.error);
  const fabric = new Fabric(fleet.value);
  const deployer = local ?? "deployer";
  return {
    fabric,
    builders: new Map(fleet.value.hosts.map((host) => [host.name, fabric.builder(host, deployer)])),
    hosts: fleet.value.hosts,
    waves: [["hcs"], ["gw-ag"], ["srv-ag"], ["pc-ag"], ["gw-cp"], ["lt-cp"]],
    gateways: new Set(["hcs", "gw-ag", "gw-cp"]),
    local,
  };
}

/** The same selection with every closure built here (`--no-distributed-build`). */
export function centralSelection(local?: string): Selection {
  const selection = fleetSelection(local);
  const here = local ?? "deployer";
  return {
    ...selection,
    builders: new Map(selection.hosts.map((host) => [host.name, here])),
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

/** Toplevel every synthetic host runs before the run. */
export const ORIGIN_PATH = storePath("origin");

/** Remote command on `host` whose host-side part contains `word`. */
export const remote =
  (host: string, word: string) =>
  (argv: readonly string[]): boolean =>
    argv.includes(`nix@${host}`) && (argv.at(-1) ?? "").includes(word);

/** Command on any host containing `word`. */
export const anywhere = (word: string) => (argv: readonly string[]) =>
  argv.join(" ").includes(word);

export const pingOf = (host: string, exitCode: number, once = false): CommandScript => ({
  match: ["ping", "-c", "1", "-W", "5", host],
  exitCode,
  once,
});

/** Hosts that answer and deploy: placed last, after the scripts of a test case. */
export const HAPPY_HOSTS: CommandScript[] = [
  { match: ["ping"] },

  // A freshly built path sits in no cache: the pull fails and the push follows.
  { match: anywhere("--max-jobs 0"), exitCode: 1 },

  // Delegated build on the elected builder, then the root it drops at the end.
  { match: anywhere(".drv^*") },
  { match: anywhere("rm -f") },
  { match: anywhere("dnf-maintenance") },
  { match: anywhere("ssh-ng://") },
  {
    match: anywhere("readlink"),
    output: [ORIGIN_PATH, ORIGIN_PATH].map((line) => ({ stream: "stdout", line })),
  },
  { match: anywhere("nix-env") },
  { match: anywhere("rc=$?") },
  { match: anywhere("[ -f"), output: [{ stream: "stdout", line: "0" }] },
];
