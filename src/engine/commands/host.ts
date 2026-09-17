// Commands run on fleet hosts (spec § Exécution): identity, activation, rollback.
//
// Host-side commands are built as plain argv, then placed: through `ssh` as
// `nix` for a remote host, directly for the deployment host itself.

import type { HostOrigin } from "../../model/events.ts";
import type { Timeouts } from "../../model/params.ts";
import { fail, ok, type Result } from "../../model/result.ts";
import { HOSTNAME } from "../fleet.ts";
import { STORE_PATH } from "../nix-output.ts";
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

/** Deploy identity: `sudo -n -u nix -H timeout …` (spec § Exécution). */
export function asNix(argv: readonly string[], seconds: number, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["sudo", "-n", "-u", "nix", "-H", ...bounded(seconds, timeouts), ...argv],
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

/** `-W`: seconds to wait for the answer. */
export function ping(host: string, timeouts: Timeouts): CommandSpec {
  assertSafe("host", host, HOSTNAME);
  return {
    argv: ["ping", "-c", "1", "-W", String(timeouts.ping), host],
    ...limits(timeouts.ping + timeouts.killGrace, timeouts),
  };
}

/** `nix copy` of a built closure, substitutes fetched by the host itself. */
export function copyClosure(host: string, path: string, timeouts: Timeouts): CommandSpec {
  assertSafe("host", host, HOSTNAME);
  assertSafe("store path", path, STORE_PATH);

  // `sudo` resets the environment: the ssh options travel through `env`.
  const sshOpts = `NIX_SSHOPTS=${sshOptions(timeouts).join(" ")}`;
  return asNix(
    [
      "env",
      sshOpts,
      "nix",
      "copy",
      "--substitute-on-destination",
      "--to",
      `ssh-ng://nix@${host}`,
      path,
    ],
    timeouts.copy,
    timeouts,
  );
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

export interface Rollback {
  runId: string;
  origin: HostOrigin;

  /** Seconds before the timer fires; `0` arms nothing. */
  after: number;
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

/**
 * `systemd-run --wait --pipe --collect` survives a dropped ssh session. With a
 * rollback, the same unit arms the timer on exit whatever the activation result.
 */
export function activate(
  path: string,
  phase: Phase,
  rollback: Rollback | undefined,
  timeouts: Timeouts,
): HostCommand {
  assertSafe("store path", path, STORE_PATH);
  const run = ["systemd-run", "--wait", "--pipe", "--collect"] as const;
  const switchTo = `${path}/bin/switch-to-configuration`;

  if (rollback === undefined || rollback.after === 0) {
    return { argv: [...run, switchTo, phase], root: true, seconds: timeouts.activation };
  }

  const timer = shellJoin([
    `${path}/sw/bin/systemd-run`,
    `--on-active=${rollback.after}`,
    `--unit=${rollbackUnit(rollback.runId, phase)}`,
    "/bin/sh",
    "-c",
    rollbackScript(rollback.origin, phase),
  ]);
  const script = [`${shellQuote(switchTo)} ${phase}`, "rc=$?", timer, 'exit "$rc"'].join("\n");
  return { argv: [...run, "/bin/sh", "-c", script], root: true, seconds: timeouts.activation };
}

/** A new ssh connection made it: the host is reachable, the rollback is dropped. */
export function cancelRollback(runId: string, phase: Phase, timeouts: Timeouts): HostCommand {
  return {
    argv: ["systemctl", "stop", `${rollbackUnit(runId, phase)}.timer`],
    root: true,
    seconds: timeouts.ssh,
  };
}

/**
 * Alert silencing flag. Exit `127` from `timeout`: command absent, the host is
 * not monitored.
 */
export function maintenance(on: boolean, timeouts: Timeouts): HostCommand {
  return { argv: ["dnf-maintenance", on ? "on" : "off"], root: true, seconds: timeouts.ssh };
}
