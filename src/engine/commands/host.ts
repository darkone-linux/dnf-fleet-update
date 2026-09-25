// Commands run on fleet hosts (spec § Exécution): identity, activation, rollback.
//
// Host-side commands are built as plain argv, then placed: through `ssh` as
// `nix` for a remote host, directly for the deployment host itself.

import type { HostOrigin } from "../../model/events.ts";
import type { Timeouts } from "../../model/params.ts";
import { fail, ok, type Result } from "../../model/result.ts";
import { HOSTNAME } from "../fleet.ts";
import { GITHUB_REF, STORE_PATH } from "../nix-output.ts";
import type { CommandSpec } from "../ports.ts";
import { limits, sudoLimits } from "./limits.ts";
import { shellJoin, shellQuote } from "./shell.ts";

export const SYSTEM_PROFILE = "/nix/var/nix/profiles/system";

/** Run directory name, reused in systemd unit names. */
const RUN_ID = /^[a-zA-Z0-9_-]+$/;

export type Phase = "test" | "switch";

export interface Target {
  host: string;

  /** The deployment host itself: no ssh, no copy. */
  local: boolean;
}

/** What to run on a host, before it is placed. */
export interface HostCommand {
  argv: readonly [string, ...string[]];
  root: boolean;

  /** Longest run, enforced on the host side by `timeout`. */
  seconds: number;
}

function assertSafe(label: string, value: string, pattern: RegExp): void {
  // Values come validated from fleet data and nix output: a miss is a bug.
  if (!pattern.test(value)) throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`);
}

/** `timeout` escalates to SIGKILL itself: the tool only ever sends SIGTERM through sudo. */
const bounded = (seconds: number, timeouts: Timeouts): string[] => [
  "timeout",
  `--kill-after=${timeouts.killGrace}`,
  String(seconds),
];

/** Login shell of `nix`, then the command with its arguments untouched. */
const LOGIN_SHELL = ["/bin/sh", "-lc", 'exec "$0" "$@"'] as const;

/**
 * Deploy identity: `sudo -n -u nix -H timeout …` (spec § Exécution), through
 * the login shell of `nix` for its PATH — `nix copy` resolves `ssh` there, and
 * a `~/.local/bin/ssh` of the caller is unreadable to `nix`. `exec "$0" "$@"`
 * where `sudo -i` would let that shell expand `$` and quotes of the command.
 */
export function asNix(argv: readonly string[], seconds: number, timeouts: Timeouts): CommandSpec {
  return {
    argv: [
      "sudo",
      "-n",
      "-u",
      "nix",
      "-H",
      "--",
      ...LOGIN_SHELL,
      ...bounded(seconds, timeouts),
      ...argv,
    ],
    ...sudoLimits(seconds, timeouts),
  };
}

const sshOptions = (timeouts: Timeouts) => [
  "-o",
  "BatchMode=yes",
  "-o",
  `ConnectTimeout=${timeouts.ssh}`,
];

export function onHost(target: Target, command: HostCommand, timeouts: Timeouts): CommandSpec {
  assertSafe("host", target.host, HOSTNAME);
  const inner = [
    ...(command.root ? ["sudo", "-n"] : []),
    ...bounded(command.seconds, timeouts),
    ...command.argv,
  ];

  if (target.local) {
    const [program, ...args] = inner as [string, ...string[]];
    return { argv: [program, ...args], ...sudoLimits(command.seconds, timeouts) };
  }
  const ssh = ["ssh", ...sshOptions(timeouts), `nix@${target.host}`, shellJoin(inner)];
  return asNix(ssh, command.seconds + timeouts.ssh, timeouts);
}

/**
 * `-W`: seconds to wait for an answer. Two probes, exit `0` as soon as either
 * answers: one packet lost inter-zone is not an outage. Default 1 s interval,
 * no `-i`: iputils parses it with the locale, `fr_FR` rejects `0.3`.
 */
export function ping(host: string, timeouts: Timeouts): CommandSpec {
  assertSafe("host", host, HOSTNAME);
  return {
    argv: ["ping", "-c", "2", "-W", String(timeouts.ping), host],
    ...limits(timeouts.ping + timeouts.killGrace, timeouts),
  };
}

/** `sudo` resets the environment: the ssh options travel through `env`. */
const sshEnv = (timeouts: Timeouts) => `NIX_SSHOPTS=${sshOptions(timeouts).join(" ")}`;

/**
 * `nix copy` of a built closure, substitutes fetched by the host itself.
 * `--no-check-sigs` like colmena: paths built here carry no signature, and the
 * host daemon drops the check only when the client asks for it, trusted user
 * or not.
 *
 * `from`: the builder holding the closure, when it is not the local store
 * (spec § Exécution, « depuis le store qui détient le chemin »).
 */
export function copyClosure(
  host: string,
  path: string,
  timeouts: Timeouts,
  from?: string,
): CommandSpec {
  assertSafe("host", host, HOSTNAME);
  assertSafe("store path", path, STORE_PATH);
  if (from !== undefined) assertSafe("host", from, HOSTNAME);

  const source = from === undefined ? [] : ["--from", `ssh-ng://nix@${from}`];
  return asNix(
    [
      "env",
      sshEnv(timeouts),
      "nix",
      "copy",
      "--substitute-on-destination",
      "--no-check-sigs",
      ...source,
      "--to",
      `ssh-ng://nix@${host}`,
      path,
    ],
    timeouts.copy,
    timeouts,
  );
}

/**
 * Derivation closure to an elected builder (spec § Substituteurs et plomberie
 * de build): `--derivation` copies the `.drv` and its inputs, never its
 * outputs — they are what the builder is about to produce.
 */
export function copyDerivation(builder: string, drvPath: string, timeouts: Timeouts): CommandSpec {
  assertSafe("host", builder, HOSTNAME);
  assertSafe("derivation", drvPath, STORE_PATH);
  return asNix(
    [
      "env",
      sshEnv(timeouts),
      "nix",
      "copy",
      "--derivation",
      "--no-check-sigs",
      "--to",
      `ssh-ng://nix@${builder}`,
      drvPath,
    ],
    timeouts.copy,
    timeouts,
  );
}

/**
 * GC root of a published closure, in the home of `nix`. One per host, replaced
 * by the next publication: the fleet collects garbage daily, and between the
 * publication and its wave nothing else holds the path.
 */
const PUBLISHED_LINK = "$HOME/.local/state/fleet-update/current";

/**
 * Substitutes the closure on the host itself (spec § Publication).
 * `--max-jobs 0` substitutes or fails, never compiles: without it a laptop
 * missing one path starts building a kernel.
 */
export function pullClosure(path: string, timeouts: Timeouts): HostCommand {
  assertSafe("store path", path, STORE_PATH);
  const script = [
    `mkdir -p "$(dirname "${PUBLISHED_LINK}")"`,
    `${shellJoin(["nix", "build", path, "--max-jobs", "0", "--out-link"])} "${PUBLISHED_LINK}"`,
  ].join(" && ");
  return { argv: ["sh", "-c", script], root: false, seconds: timeouts.publish };
}

/** A locked flake source, and the store path its `narHash` fixes. */
export interface FlakeSource {
  ref: string;
  path: string;
}

/**
 * Flake sources fetched by a builder from their origin (spec § Substituteurs
 * et plomberie de build). A path it holds already costs no download: `nix
 * flake prefetch` alone would fetch it again on a cold fetcher cache.
 */
export function fetchSources(sources: readonly FlakeSource[], timeouts: Timeouts): HostCommand {
  const script = sources
    .map(({ ref, path }) => {
      assertSafe("store path", path, STORE_PATH);
      assertSafe("flake reference", ref, GITHUB_REF);
      const held = `${shellJoin(["nix", "path-info", path])} >/dev/null 2>&1`;
      return `{ ${held} || ${shellJoin(["nix", "flake", "prefetch", ref])}; }`;
    })
    .join(" && ");
  return { argv: ["sh", "-c", script], root: false, seconds: timeouts.copy };
}

/**
 * GC roots of a delegated build, in the home of `nix`: one link per host built
 * here, replaced by the next run and dropped at the end of this one. The
 * deployment machine cannot root a path it does not have (spec § Exécution).
 */
const BUILD_LINKS = "$HOME/.local/state/fleet-update/build";

/**
 * Build of one host's closure on its elected builder, from the derivation
 * copied beforehand: no re-evaluation, so the output path is the one the
 * central evaluation named.
 */
export function buildDerivation(drvPath: string, host: string, timeouts: Timeouts): HostCommand {
  assertSafe("derivation", drvPath, STORE_PATH);
  assertSafe("host", host, HOSTNAME);
  const build = shellJoin([
    "nix",
    "build",
    `${drvPath}^*`,
    "--log-format",
    "internal-json",
    "--print-out-paths",
    "--out-link",
  ]);
  const script = [`mkdir -p "${BUILD_LINKS}"`, `${build} "${BUILD_LINKS}/${host}"`].join(" && ");
  return { argv: ["sh", "-c", script], root: false, seconds: timeouts.build };
}

/** End of run: a builder keeps no root of what it built for others. */
export function dropBuildLinks(hosts: readonly string[], timeouts: Timeouts): HostCommand {
  for (const host of hosts) assertSafe("host", host, HOSTNAME);
  const links = hosts.map((host) => `"${BUILD_LINKS}/${host}"`).join(" ");
  return { argv: ["sh", "-c", `rm -f ${links}`], root: false, seconds: timeouts.ssh };
}

/** Exit `0`: the store of that host holds the path (`--resume`). */
export function hasPath(path: string, timeouts: Timeouts): HostCommand {
  assertSafe("store path", path, STORE_PATH);
  return { argv: ["nix", "path-info", path], root: false, seconds: timeouts.ssh };
}

/** Unit names come from `systemctl` output: never a shell metacharacter. */
/** Also the shape an AI tool must match before a unit name reaches argv. */
export const UNIT = /^[a-zA-Z0-9@:_.\\-]+$/;

/** System state and failed unit count (spec § Erreurs et réparations): read by a human. */
export function systemStatus(timeouts: Timeouts): HostCommand {
  return { argv: ["systemctl", "status", "--no-pager"], root: false, seconds: timeouts.ssh };
}

/** One failed unit per line, name first: `--plain --no-legend` drops the decorations. */
export function failedUnits(timeouts: Timeouts): HostCommand {
  return {
    argv: ["systemctl", "list-units", "--failed", "--plain", "--no-legend", "--no-pager"],
    root: false,
    seconds: timeouts.ssh,
  };
}

/** Names of `systemctl list-units --failed`; anything else on the line is dropped. */
export function parseFailedUnits(stdout: string): string[] {
  const units: string[] = [];
  for (const line of stdout.split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (name?.includes(".") && UNIT.test(name)) units.push(name);
  }
  return units;
}

/** What may be done to a unit, deterministically or by the AI (spec § réparation). */
export const UNIT_ACTIONS = ["start", "stop", "restart", "reset-failed"] as const;

export type UnitAction = (typeof UNIT_ACTIONS)[number];

/** `systemctl <action> <units>`: every name matched against `UNIT` before argv. */
export function unitAction(
  action: UnitAction,
  units: readonly string[],
  timeouts: Timeouts,
): HostCommand {
  const [first, ...rest] = units;
  if (first === undefined) throw new Error(`${action} without a unit`);
  for (const unit of units) assertSafe("unit", unit, UNIT);
  return {
    argv: ["systemctl", action, first, ...rest],
    root: true,
    seconds: timeouts.activation,
  };
}

/**
 * Failed units back up, together and in one go: their own dependencies order
 * them, which is exactly what a restart is meant to settle.
 */
export function restartUnits(units: readonly string[], timeouts: Timeouts): HostCommand {
  return unitAction("restart", units, timeouts);
}

/**
 * Journal of one failed unit since its wave started. Root: the deploy user
 * reads no system journal. `--since=-<n>s`: a relative span, the engine holds
 * no wall clock.
 */
export function unitJournal(
  unit: string,
  since: number,
  lines: number,
  timeouts: Timeouts,
): HostCommand {
  assertSafe("unit", unit, UNIT);
  return {
    argv: [
      "journalctl",
      "-u",
      unit,
      "--no-pager",
      "-n",
      String(lines),
      `--since=-${Math.max(1, Math.round(since))}s`,
    ],
    root: true,
    seconds: timeouts.ssh,
  };
}

/** Two lines: `/run/current-system`, then the system profile target. */
export function readOrigin(timeouts: Timeouts): HostCommand {
  return {
    argv: ["readlink", "-f", "/run/current-system", SYSTEM_PROFILE],
    root: false,
    seconds: timeouts.ssh,
  };
}

export function parseOrigin(stdout: string): Result<HostOrigin> {
  const [system, profile, ...rest] = stdout.trim().split("\n");
  if (system === undefined || profile === undefined || rest.length > 0) {
    return fail(`origin: expected two paths, got ${JSON.stringify(stdout)}`);
  }
  if (!STORE_PATH.test(system) || !STORE_PATH.test(profile)) {
    return fail(`origin: not store paths: ${system}, ${profile}`);
  }
  return ok({ system, profile });
}

/** Switch only, before its activation. */
export function setProfile(path: string, timeouts: Timeouts): HostCommand {
  assertSafe("store path", path, STORE_PATH);
  return {
    argv: ["nix-env", "-p", SYSTEM_PROFILE, "--set", path],
    root: true,
    seconds: timeouts.ssh,
  };
}

export function rollbackUnit(runId: string, phase: Phase): string {
  assertSafe("run id", runId, RUN_ID);
  return `fleet-update-rollback-${runId}-${phase}`;
}

/**
 * Reactivates the origin: `test` after a test; after a switch, profile set back
 * then `switch`. Binaries of the origin itself: a transient unit has no PATH
 * the tool can rely on.
 */
export function rollbackScript(origin: HostOrigin, phase: Phase): string {
  assertSafe("store path", origin.system, STORE_PATH);
  assertSafe("store path", origin.profile, STORE_PATH);
  if (phase === "test") return shellJoin([`${origin.system}/bin/switch-to-configuration`, "test"]);
  return [
    shellJoin([`${origin.system}/sw/bin/nix-env`, "-p", SYSTEM_PROFILE, "--set", origin.profile]),
    shellJoin([`${origin.profile}/bin/switch-to-configuration`, "switch"]),
  ].join(" && ");
}

/** Command whose exit code a host keeps: an activation, or a forced rollback. */
export type ResultName = Phase | "rollback";

/** Exit code kept on the host for a reconnection after a dropped session. */
export function resultFile(runId: string, name: ResultName): string {
  assertSafe("run id", runId, RUN_ID);
  return `/run/fleet-update-${runId}-${name}.rc`;
}

export interface Activation {
  runId: string;
  origin: HostOrigin;

  /** Seconds before the rollback timer fires; `0` arms nothing (disabled, deployment host). */
  rollbackAfter: number;
}

const SYSTEMD_RUN = ["systemd-run", "--wait", "--pipe", "--collect"] as const;

/**
 * `systemd-run --wait --pipe --collect` survives a dropped ssh session. The
 * unit arms the rollback timer whatever the result, then writes the result
 * file: once it exists, the timer does too.
 */
export function activate(
  path: string,
  phase: Phase,
  activation: Activation,
  timeouts: Timeouts,
): HostCommand {
  assertSafe("store path", path, STORE_PATH);
  const { runId, origin, rollbackAfter } = activation;

  const timer =
    rollbackAfter === 0
      ? []
      : [
          shellJoin([
            `${path}/sw/bin/systemd-run`,
            `--on-active=${rollbackAfter}`,
            `--unit=${rollbackUnit(runId, phase)}`,
            "/bin/sh",
            "-c",
            rollbackScript(origin, phase),
          ]),
        ];
  const script = [
    `${shellQuote(`${path}/bin/switch-to-configuration`)} ${phase}`,
    "rc=$?",
    ...timer,
    `echo "$rc" > ${shellQuote(resultFile(runId, phase))}`,
    'exit "$rc"',
  ].join("\n");
  return {
    argv: [...SYSTEMD_RUN, "/bin/sh", "-c", script],
    root: true,
    seconds: timeouts.activation,
  };
}

/** Exit code of `settleActivation` while the result file is missing. */
export const SETTLE_PENDING = 3;

/**
 * New connection after an activation or a forced rollback: prints its exit
 * code, then stops the rollback timer of the activation when one was armed.
 * Exit `SETTLE_PENDING`: no result yet.
 */
export function settleResult(
  runId: string,
  name: ResultName,
  armed: boolean,
  timeouts: Timeouts,
): HostCommand {
  const file = shellQuote(resultFile(runId, name));
  const lines = [`[ -f ${file} ] || exit ${SETTLE_PENDING}`, `cat ${file}`];
  if (armed) {
    if (name === "rollback") throw new Error("a forced rollback arms no timer");
    lines.push(shellJoin(["systemctl", "stop", `${rollbackUnit(runId, name)}.timer`]));
  }
  return { argv: ["sh", "-c", lines.join(" && ")], root: true, seconds: timeouts.ssh };
}

/**
 * Forced rollback (spec § Exécution): the same reactivation, at once, under
 * `systemd-run`, its result kept like an activation's.
 */
export function rollbackNow(
  runId: string,
  origin: HostOrigin,
  phase: Phase,
  timeouts: Timeouts,
): HostCommand {
  const script = [
    rollbackScript(origin, phase),
    "rc=$?",
    `echo "$rc" > ${shellQuote(resultFile(runId, "rollback"))}`,
    'exit "$rc"',
  ].join("\n");
  return {
    argv: [...SYSTEMD_RUN, "/bin/sh", "-c", script],
    root: true,
    seconds: timeouts.activation,
  };
}

/**
 * Alert silencing flag. Exit `COMMAND_NOT_FOUND` from `timeout`: command
 * absent, the host is not monitored.
 */
export function maintenance(on: boolean, timeouts: Timeouts): HostCommand {
  return { argv: ["dnf-maintenance", on ? "on" : "off"], root: true, seconds: timeouts.ssh };
}

export const COMMAND_NOT_FOUND = 127;
