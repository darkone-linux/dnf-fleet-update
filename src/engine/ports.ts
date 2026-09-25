// Side-effect ports of the engine.
//
// Every effect outside the process goes through one of these: real adapters in
// `src/adapters/`, fakes in `src/testing/fakes.ts`. A step needing another
// effect extends this file first, so tests never run nix, ssh or a network.

import type { Event, RunInfo } from "../model/events.ts";
import type { PersistedState } from "../model/persist.ts";
import type { Result } from "../model/result.ts";

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

/** File name of a log, without extension; throws outside `RUN_FILE_NAME`. */
export function logFileName(name: LogName): string {
  const parts = name.host === undefined ? [name.phase] : [name.host, name.phase];
  for (const part of parts) {
    if (!RUN_FILE_NAME.test(part)) throw new Error(`unsafe log name: ${JSON.stringify(part)}`);
  }
  return parts.join(".");
}

/** One run directory: `var/deployments/<id>/` (spec § État et reprise). */
export interface RunStore {
  /** `<date>-<mode>`; also names the rollback units of the run. */
  readonly id: string;

  /** One line of `events.jsonl`. */
  appendEvent(event: Event): void;

  /** Replaces `state.json` atomically: an interrupted write leaves the previous one. */
  writeState(state: PersistedState): void;

  /** Throws on a name outside `RUN_FILE_NAME` (`logFileName`): names come validated. */
  appendLog(name: LogName, line: string): void;
  writeReport(markdown: string): void;

  /** `nix build --out-link` target: GC root of the host path while the run directory lives. */
  outLink(host: string): string;

  /** Tail of a log, newest kept: the error is at the bottom. Missing file: empty. */
  readLog(name: LogName, lines: number): Promise<Excerpt>;
}

/** Bounded slice of a text file, as an AI tool receives it (spec § analyse, Limites). */
export interface Excerpt {
  lines: string[];

  /** Lines left out; said to the reader, so it knows it holds a slice. */
  dropped: number;
}

/**
 * Read-only access to the trees the AI may read (spec § analyse, outils
 * `active`). Refuses what the **resolved** path puts outside its roots: a
 * symlink leading out is an escape, not a shortcut.
 */
export interface SourceFiles {
  /** Head of the file: a module is read from its header down. */
  read(path: string, lines: number): Promise<Result<Excerpt>>;

  /** Whole text of a source file, for an exact replacement; binary or over 1 MiB refused. */
  text(path: string): Promise<Result<string>>;

  /**
   * One level of a directory, sorted, `name/` for a sub-directory. `limit`
   * entries at most, the rest counted in `dropped`.
   */
  list(path: string, limit: number): Promise<Result<Excerpt>>;

  /**
   * Lines holding `pattern` — literal, case ignored — in the files under `path`
   * (or in that one file), as `<path>:<line>: <text>`, paths relative to the
   * workspace. `limit` matches at most, the rest counted in `dropped`.
   */
  search(pattern: string, path: string, limit: number): Promise<Result<Excerpt>>;

  /**
   * Whole file, created or replaced (spec § réparation). The caller has already
   * decided the path may be written; this refuses only what the disk refuses.
   */
  write(path: string, content: string): Promise<Result<void>>;
}

/** Last run directory, as `--resume` finds it (spec § État et reprise). */
export interface SavedRun {
  id: string;

  /** Raw `state.json`; absent when the directory holds none. Validated by `resume.ts`. */
  state?: string;
}

export interface DeploymentStore {
  /** Throws when the directory already exists: the lock makes that a bug. */
  create(mode: RunInfo["mode"]): RunStore;

  /** Newest run directory, whatever it left; `undefined` when there is none. */
  last(): SavedRun | undefined;
}

/** Who holds a busy lock (spec § Verrou): the file line, checked against `/proc`. */
export interface LockHolder {
  /** Diagnostic line of the lock file, empty when it holds none. */
  raw: string;

  /** Confirmed by `/proc/locks`; absent: nobody to stop. */
  pid?: number;

  /** `/proc/<pid>/cmdline`, arguments joined by spaces. */
  command?: string;

  /** Written by the holder, kept only when the file names the confirmed pid. */
  startedAt?: string;
}

export type LockAttempt = { kind: "acquired" } | { kind: "busy"; holder: LockHolder };

/** `var/deployments/current.lock` (spec § Verrou). */
export interface RunLock {
  /** Non-blocking. */
  acquire(): LockAttempt;

  /**
   * Signals the holder so the kernel releases the lock at its death; `false`
   * when the process is already gone.
   */
  stopHolder(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean;

  /** Also released by the kernel when the process dies. */
  release(): void;
}

/** Where the AI tools reach the run (spec § analyse, Transport). */
export interface ToolEndpoint {
  /** Loopback only, ephemeral port. */
  url: string;

  /** Bearer token of this run; a request without it is refused. */
  token: string;
}

/**
 * Local JSON endpoint the AI tools call. The body is opaque here: the port
 * carries messages, `ai/rpc.ts` gives them meaning.
 */
export interface ToolServer {
  /** New URL and token at every start. `undefined` from the handler: no reply is due. */
  start(handle: (message: unknown) => Promise<unknown | undefined>): Promise<ToolEndpoint>;

  /** Idempotent: stopping a server never started is not an error. */
  stop(): Promise<void>;
}

/** The deployment host. */
export interface LocalHost {
  /** Short name: the fleet host of the same name is deployed without ssh. */
  hostname(): string;

  /** IPv4 addresses, loopback excluded: current zone detection. */
  addresses(): string[];
}
