// Commands on the consumer workspace: git, flake inputs, `just`, generated data.

import type { Timeouts } from "../../model/params.ts";
import type { AlertRoom } from "../matrix.ts";
import type { CommandSpec } from "../ports.ts";
import { limits } from "./limits.ts";

export type GeneratedFile = "hosts.nix" | "network.nix" | "matrix.nix";

export function gitStatus(repo: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["git", "-C", repo, "status", "--porcelain"],
    ...limits(timeouts.commit, timeouts),
  };
}

export function gitHead(repo: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["git", "-C", repo, "rev-parse", "HEAD"], ...limits(timeouts.commit, timeouts) };
}

/** Clean tree checked beforehand: only the update lands in the commit. */
export function gitAddAll(repo: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["git", "-C", repo, "add", "--all"], ...limits(timeouts.commit, timeouts) };
}

export function gitCommit(repo: string, message: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["git", "-C", repo, "commit", "-m", message],
    ...limits(timeouts.commit, timeouts),
  };
}

/** `--refresh`: the fetch cache of nix (`tarball-ttl`) hides newer revisions. */
export function flakeUpdate(repo: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["nix", "flake", "update", "--refresh"],
    cwd: repo,
    ...limits(timeouts.flakeUpdate, timeouts),
  };
}

/** Codev: the consumer lock follows `dnf/` HEAD, even under `--no-consumer-flake`. */
export function realignDnfLock(workspace: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["nix", "flake", "update", "dnf"],
    cwd: workspace,
    ...limits(timeouts.commit, timeouts),
  };
}

export function justClean(workspace: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["just", "clean"],
    cwd: workspace,
    env: { QUIET: "1" },
    ...limits(timeouts.clean, timeouts),
  };
}

export function justGenerate(workspace: string, timeouts: Timeouts): CommandSpec {
  return {
    argv: ["just", "generate"],
    cwd: workspace,
    env: { QUIET: "1" },
    ...limits(timeouts.commit, timeouts),
  };
}

/**
 * One message to an alert room (spec § Rapport), body on stdin: the framework
 * owns the rooms and the token, the tool owns the text.
 */
export function sendMessage(
  workspace: string,
  room: AlertRoom,
  text: string,
  timeouts: Timeouts,
): CommandSpec {
  return {
    argv: ["just", "send-msg", room],
    cwd: workspace,
    stdin: text,
    ...limits(timeouts.matrix, timeouts),
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
    ...limits(timeouts.commit, timeouts),
  };
}
