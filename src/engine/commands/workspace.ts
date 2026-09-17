// Commands on the consumer workspace: git, flake inputs, `just`, generated data.

import type { Timeouts } from "../../model/params.ts";
import type { CommandSpec } from "../ports.ts";

const ms = (seconds: number) => seconds * 1000;

export type GeneratedFile = "hosts.nix" | "network.nix" | "matrix.nix";

export function gitStatus(repo: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["git", "-C", repo, "status", "--porcelain"], timeoutMs: ms(timeouts.commit) };
}

export function gitHead(repo: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["git", "-C", repo, "rev-parse", "HEAD"], timeoutMs: ms(timeouts.commit) };
}

/** Clean tree checked beforehand: only the update lands in the commit. */
export function gitAddAll(repo: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["git", "-C", repo, "add", "--all"], timeoutMs: ms(timeouts.commit) };
}

export function gitCommit(repo: string, message: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["git", "-C", repo, "commit", "-m", message], timeoutMs: ms(timeouts.commit) };
}

export function flakeUpdate(repo: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["nix", "flake", "update"], cwd: repo, timeoutMs: ms(timeouts.flakeUpdate) };
}

/** Codev: the consumer lock follows `dnf/` HEAD, even under `--no-consumer-flake`. */
export function realignDnfLock(workspace: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["nix", "flake", "update", "dnf"],
    cwd: workspace,
    timeoutMs: ms(timeouts.commit),
  };
}

export function justClean(workspace: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["just", "clean"],
    cwd: workspace,
    env: { QUIET: "1" },
    timeoutMs: ms(timeouts.clean),
  };
}

export function justGenerate(workspace: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["just", "generate"],
    cwd: workspace,
    env: { QUIET: "1" },
    timeoutMs: ms(timeouts.commit),
  };
}

/** JSON on stdout, validated by `fleet.ts`. */
export function readGenerated(
  workspace: string,
  file: GeneratedFile,
  timeouts: Timeouts,
): CommandSpec {
  return {
    argv: ["nix-instantiate", "--eval", "--strict", "--json", `${workspace}/var/generated/${file}`],
    timeoutMs: ms(timeouts.commit),
  };
}
