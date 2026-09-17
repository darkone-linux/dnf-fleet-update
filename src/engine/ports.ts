// Side-effect ports of the engine.
//
// Every effect outside the process goes through one of these: real adapters in
// `src/adapters/`, fakes in `src/testing/fakes.ts`. A step needing another
// effect extends this file first, so tests never run nix, ssh or a network.

import type { Event, RunInfo } from "../model/events.ts";
import type { PersistedState } from "../model/persist.ts";

/** One external program: nix, ssh, git, just, ping. */
export interface CommandSpec {
  /** Program then arguments, verbatim: no shell, so a host name cannot inject. */
  argv: readonly [string, ...string[]];
  cwd?: string;

  /** Merged over the engine's own environment. */
  env?: Readonly<Record<string, string>>;
  stdin?: string;

  /** Past it the process group gets SIGTERM (spec § Délais): every command is bounded. */
  timeoutMs: number;

  /** SIGTERM (deadline or abort) to SIGKILL of the process group. */
  killGraceMs: number;
}

export interface OutputLine {
  stream: "stdout" | "stderr";
  line: string;
}

export interface CommandResult {
  /** `null` when a signal ended the process. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  /** Per line, as it comes: feeds host logs and the active region. */
  onLine?: (line: OutputLine) => void;

  /** Kills the process tree: abort `now`, SIGTERM. */
  signal?: AbortSignal;
}

export interface CommandRunner {
  /**
   * Resolves on every exit, failures included: a non-zero code is data for the
   * step. Rejects only when the program cannot start at all.
   */
  run(spec: CommandSpec, options?: RunOptions): Promise<CommandResult>;
}

/** The fold never reads a clock: the engine stamps `t` from this one. */
export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;

  /** Rejects with `signal.reason` once aborted: retry and rollback waits stay interruptible. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Engine end of the event stream; `RunControl` is the interface end. */
export interface EventChannel {
  emit(event: Event): void;

  /** Answer to the `ask` event `id`. Unused under `--non-interactive`: nothing is asked. */
  answer(id: string, signal?: AbortSignal): Promise<string>;
}

/** Everything a step receives. */
export interface EngineContext {
  commands: CommandRunner;
  clock: Clock;
  events: EventChannel;

  /** Abort `now` (`^C`) or SIGTERM: every pending command and wait ends. */
  signal: AbortSignal;
}

/** Host and phase in run file names: no path separator, no hidden file. */
export const RUN_FILE_NAME = /^[a-zA-Z0-9_-]+$/;

/** Host log (`<host>.<phase>`), or run log without host (`<phase>`). */
export interface LogName {
  host?: string;
  phase: string;
}

/** One run directory: `var/deployments/<id>/` (spec § État et reprise). */
export interface RunStore {
  /** `<date>-<mode>`; also names the rollback units of the run. */
  readonly id: string;

  /** One line of `events.jsonl`. */
  appendEvent(event: Event): void;

  /** Replaces `state.json` atomically: an interrupted write leaves the previous one. */
  writeState(state: PersistedState): void;

  /** Throws on a name outside `RUN_FILE_NAME`: names come validated. */
  appendLog(name: LogName, line: string): void;
  writeReport(markdown: string): void;

  /** `nix build --out-link` target: GC root of the host path while the run directory lives. */
  outLink(host: string): string;
}

export interface DeploymentStore {
  /** Throws when the directory already exists: the lock makes that a bug. */
  create(mode: RunInfo["mode"]): RunStore;
}

export type LockAttempt = { kind: "acquired" } | { kind: "busy"; holder: string };

/** `var/deployments/current.lock` (spec § Verrou). */
export interface RunLock {
  /** Non-blocking. `holder`: diagnostic content written by the holder, possibly empty. */
  acquire(): LockAttempt;

  /** Also released by the kernel when the process dies. */
  release(): void;
}

/** The deployment host. */
export interface LocalHost {
  /** Short name: the fleet host of the same name is deployed without ssh. */
  hostname(): string;

  /** IPv4 addresses, loopback excluded: current zone detection. */
  addresses(): string[];
}
