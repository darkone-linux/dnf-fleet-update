// Central build commands (spec § Exécution): one evaluation, one build per host.

import type { Timeouts } from "../../model/params.ts";
import { HOSTNAME } from "../fleet.ts";
import { STORE_PATH } from "../nix-output.ts";
import type { CommandSpec } from "../ports.ts";
import { limits } from "./limits.ts";

/** Measured peak: 5.9 GB per worker, 50 s for 14 hosts (spec § Exécution). */
export const EVAL_WORKERS = 4;
export const EVAL_MAX_MEMORY_MB = 4096;

/** Only the selected hosts: `nixosConfigurations` also holds ISO and SD images. */
export function selectExpression(hosts: readonly string[]): string {
  for (const host of hosts) {
    if (!HOSTNAME.test(host)) throw new Error(`unsafe host: ${JSON.stringify(host)}`);
  }
  const names = hosts.map((host) => `"${host}"`).join(" ");
  return (
    "cfgs: builtins.listToAttrs (map (name: { inherit name; " +
    `value = cfgs.\${name}.config.system.build.toplevel; }) [ ${names} ])`
  );
}

/** One JSON line per host on stdout, parsed by `parseEvalJob`. */
export function evalHosts(
  workspace: string,
  hosts: readonly string[],
  timeouts: Timeouts,
): CommandSpec {
  return {
    argv: [
      "nix-eval-jobs",
      "--flake",
      `${workspace}#nixosConfigurations`,
      "--select",
      selectExpression(hosts),
      "--workers",
      String(EVAL_WORKERS),
      "--max-memory-size",
      String(EVAL_MAX_MEMORY_MB),
    ],
    ...limits(timeouts.eval, timeouts),
  };
}

/**
 * No re-evaluation: the derivation of the evaluation. `outLink` in the run
 * directory keeps the closure from the garbage collector until resume.
 */
export function buildHost(drvPath: string, outLink: string, timeouts: Timeouts): CommandSpec {
  if (!STORE_PATH.test(drvPath)) throw new Error(`unsafe derivation: ${JSON.stringify(drvPath)}`);
  return {
    argv: [
      "nix",
      "build",
      `${drvPath}^*`,
      "--log-format",
      "internal-json",
      "--out-link",
      outLink,
      "--print-out-paths",
    ],
    ...limits(timeouts.build, timeouts),
  };
}

/** NAR size of each path, `<path> <bytes>` per line: the volume of the copy counters. */
export function pathSizes(paths: readonly [string, ...string[]], timeouts: Timeouts): CommandSpec {
  for (const path of paths) {
    if (!STORE_PATH.test(path)) throw new Error(`unsafe store path: ${JSON.stringify(path)}`);
  }
  return {
    argv: ["nix", "path-info", "--size", ...paths],
    ...limits(timeouts.commit, timeouts),
  };
}

/** Exit `0`: the path is still in the store (`--resume`). */
export function pathInfo(path: string, timeouts: Timeouts): CommandSpec {
  return { argv: ["nix", "path-info", path], ...limits(timeouts.commit, timeouts) };
}
