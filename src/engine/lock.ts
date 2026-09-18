// Taking the run lock (spec § Verrou).
//
// Busy: refused unattended (exit `4`). Interactively the holder is described,
// offered to be stopped, then the run it left offered to `--resume`.

import type { Level } from "../model/events.ts";
import { DEFAULT_TIMEOUTS } from "../model/params.ts";
import { type EventInput, YES_NO } from "./context.ts";
import type { Clock, EventChannel, LockHolder, RunLock } from "./ports.ts";

/** Between two attempts on the non-blocking lock, while the holder dies. */
const POLL_MS = 200;

export interface LockTakeover {
  lock: RunLock;
  events: EventChannel;
  clock: Clock;

  /** `clock.now()` at the start of the run: `t` of the events emitted here. */
  startedAt: number;

  /** `--no-ui` and `--non-interactive`, known before the parameters are resolved. */
  interactive: boolean;

  /** Abort `now`: the waits and the questions end. */
  signal: AbortSignal;

  /** Unfinished run left behind, offered once the holder is stopped. */
  canResume: () => boolean;
}

/** `busy`: the refusal is already in the stream, the caller only ends the run. */
export type LockOutcome =
  | { kind: "taken"; resume: boolean }
  | { kind: "busy" }
  | { kind: "aborted" };

export async function takeLock(env: LockTakeover): Promise<LockOutcome> {
  const attempt = env.lock.acquire();
  if (attempt.kind === "acquired") return { kind: "taken", resume: false };

  const { holder } = attempt;
  say(env, "error", `another fleet-update run holds the lock${describe(holder)}`);

  // Unattended, or a holder `/proc/locks` does not name: nobody to stop.
  const { pid } = holder;
  if (!env.interactive || pid === undefined) return { kind: "busy" };

  try {
    if ((await ask(env, "lock", `Stop pid ${pid} and take the lock?`)) === "no") {
      return { kind: "busy" };
    }
    if (!(await stopHolder(env, pid))) return { kind: "busy" };
    say(env, "ok", `lock taken from pid ${pid}`);

    if (!env.canResume()) return { kind: "taken", resume: false };
    const answer = await ask(env, "resume", "Resume the deployment it left?");
    return { kind: "taken", resume: answer === "yes" };
  } catch (error) {
    if (env.signal.aborted) return { kind: "aborted" };
    throw error;
  }
}

/** SIGTERM, SIGKILL after `killGrace`, then the lock: the kernel frees it at the death. */
async function stopHolder(env: LockTakeover, pid: number): Promise<boolean> {
  // Parameters are not resolved yet: the lock comes before `network.nix`.
  const grace = DEFAULT_TIMEOUTS.killGrace;

  say(env, "warn", `stopping pid ${pid} (SIGTERM)`);
  env.lock.stopHolder(pid, "SIGTERM");
  if (await waitFree(env, grace * 1000)) return true;

  say(env, "warn", `pid ${pid} still holding after ${grace}s (SIGKILL)`);
  env.lock.stopHolder(pid, "SIGKILL");
  if (await waitFree(env, grace * 1000)) return true;

  say(env, "error", `pid ${pid} still holds the lock`);
  return false;
}

/** Retries the non-blocking lock until the deadline; true once it is ours. */
async function waitFree(env: LockTakeover, graceMs: number): Promise<boolean> {
  const deadline = env.clock.now() + graceMs;
  for (;;) {
    if (env.lock.acquire().kind === "acquired") return true;
    if (env.clock.now() >= deadline) return false;
    await env.clock.sleep(POLL_MS, env.signal);
  }
}

/** Empty when the lock file says nothing readable about its holder. */
function describe(holder: LockHolder): string {
  if (holder.pid === undefined) return holder.raw === "" ? "" : `: ${holder.raw}`;

  const parts = [`pid ${holder.pid}`];
  if (holder.startedAt !== undefined) parts.push(`started ${holder.startedAt}`);
  if (holder.command !== undefined) parts.push(holder.command);
  return `: ${parts.join(", ")}`;
}

function emit(env: LockTakeover, event: EventInput): void {
  env.events.emit({ ...event, t: Math.round(env.clock.now() - env.startedAt) });
}

function say(env: LockTakeover, level: Level, message: string): void {
  emit(env, { kind: "log", level, message });
}

/** Before the run directory exists: asked and answered, nothing recorded. */
async function ask(env: LockTakeover, id: string, question: string): Promise<string> {
  emit(env, { kind: "ask", id, question, options: [...YES_NO] });
  const value = await env.events.answer(id, env.signal);
  if (!YES_NO.some((option) => option.value === value)) {
    throw new Error(`answer "${value}" is not an option of ${id}`);
  }
  emit(env, { kind: "ask.close", id, value });
  return value;
}
