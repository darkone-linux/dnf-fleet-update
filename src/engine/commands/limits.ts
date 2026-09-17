// Bounds of one command (spec § Délais): deadline, then kill grace.

import type { Timeouts } from "../../model/params.ts";
import type { CommandSpec } from "../ports.ts";

export type Limits = Pick<CommandSpec, "timeoutMs" | "killGraceMs">;

export function limits(seconds: number, timeouts: Timeouts): Limits {
  return { timeoutMs: seconds * 1000, killGraceMs: timeouts.killGrace * 1000 };
}

/**
 * Through `sudo`: `timeout` on the other side bounds `seconds` and escalates
 * itself, SIGTERM relayed by `sudo` included. The runner acts past it only;
 * SIGKILL on `sudo` after twice the grace, once `timeout` had its own.
 */
export function sudoLimits(seconds: number, timeouts: Timeouts): Limits {
  return {
    timeoutMs: (seconds + 2 * timeouts.killGrace) * 1000,
    killGraceMs: 2 * timeouts.killGrace * 1000,
  };
}
