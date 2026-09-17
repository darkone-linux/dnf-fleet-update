// Reconnection after a command kept running by `systemd-run --wait` (spec §
// Exécution, retour arrière automatique): reads its result file, stops the
// rollback timer of an activation.

import {
  onHost,
  type ResultName,
  SETTLE_PENDING,
  settleResult,
  type Target,
} from "./commands/host.ts";
import type { RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import type { CommandResult } from "./ports.ts";

/** `ssh` could not connect, or lost the session. */
const SSH_FAILURE = 255;

/** `timeout` expired on the command it bounds. */
const TIMEOUT_EXPIRED = 124;

/** The session, not the command, failed: the result may still come. */
export function transportFailed(result: CommandResult): boolean {
  return (
    result.timedOut ||
    result.exitCode === null ||
    result.exitCode === SSH_FAILURE ||
    result.exitCode === TIMEOUT_EXPIRED
  );
}

export type Settled =
  | { kind: "result"; code: number }

  /** The session ended normally, no result file: the command never ran. */
  | { kind: "missing" }
  | { kind: "failed"; detail: string }
  | { kind: "lost" }
  | { kind: "aborted" };

/**
 * Attempts until the timer expiry minus `ssh` when armed, else during
 * `activation`, one every `pingInterval`. `dropped`: the session of the
 * command itself failed, a missing result may still come.
 */
export async function settle(
  context: RunContext,
  target: Target,
  name: ResultName,
  armed: boolean,
  dropped: boolean,
): Promise<Settled> {
  const { params, clock } = context;
  const { timeouts } = params;
  const window = armed ? params.rollbackTimeout - timeouts.ssh : timeouts.activation;
  const deadline = clock.now() + Math.max(0, window) * 1000;
  const command = settleResult(context.run.id, name, armed, timeouts);
  const label = name === "rollback" ? "rollback" : "activation";

  for (;;) {
    const attempt = await execute(context, onHost(target, command, timeouts));
    if (context.signal.aborted) return { kind: "aborted" };
    if (succeeded(attempt.result)) {
      const code = Number(attempt.stdout[0]?.trim());
      if (Number.isInteger(code)) return { kind: "result", code };
      return { kind: "failed", detail: `unreadable ${label} result: ${attempt.stdout[0]}` };
    }

    const pending = attempt.result.exitCode === SETTLE_PENDING;
    if (pending && !dropped) return { kind: "missing" };
    if (!pending && !transportFailed(attempt.result)) {
      const what = armed ? "rollback timer not cancelled" : `${label} result not read`;
      return { kind: "failed", detail: `${what}: ${describeFailure(attempt)}` };
    }

    const left = deadline - clock.now();
    if (left <= 0) return { kind: "lost" };
    try {
      await clock.sleep(Math.min(params.pingInterval * 1000, left), context.signal);
    } catch {
      return { kind: "aborted" };
    }
  }
}
