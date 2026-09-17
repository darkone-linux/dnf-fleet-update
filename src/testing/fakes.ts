// Test doubles for the engine ports (`src/engine/ports.ts`).
//
// Deterministic by construction: no process, no timer, no network. Strict too:
// an unscripted command or an unanswered question fails the test, never passes.

import {
  type Clock,
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
  type DeploymentStore,
  type EngineContext,
  type EventChannel,
  type LocalHost,
  type LockAttempt,
  type LogName,
  logFileName,
  type OutputLine,
  type RunLock,
  type RunOptions,
  type RunStore,
} from "../engine/ports.ts";
import type { Event, RunInfo } from "../model/events.ts";
import type { PersistedState } from "../model/persist.ts";

/** Reply for the first command whose argv starts with `match`. */
export interface CommandScript {
  match: readonly string[];
  output?: readonly OutputLine[];
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
}

export class FakeCommands implements CommandRunner {
  readonly calls: CommandSpec[] = [];

  constructor(private readonly scripts: readonly CommandScript[] = []) {}

  async run(spec: CommandSpec, options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push(spec);
    const script = this.scripts.find((candidate) =>
      candidate.match.every((arg, index) => spec.argv[index] === arg),
    );
    if (!script) throw new Error(`unscripted command: ${spec.argv.join(" ")}`);

    for (const line of script.output ?? []) options.onLine?.(line);
    const timedOut = script.timedOut ?? false;
    return {
      exitCode: timedOut ? null : (script.exitCode ?? 0),
      signal: timedOut ? "SIGKILL" : null,
      timedOut,
      durationMs: script.durationMs ?? 0,
    };
  }
}

interface Sleeper {
  at: number;
  resolve: () => void;
}

/** Time moves only through `advance`: a ten-minute rollback wait takes no real time. */
export class FakeClock implements Clock {
  private current = 0;
  private sleepers: Sleeper[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const sleeper: Sleeper = { at: this.current + ms, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((other) => other !== sleeper);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** Releases every sleeper due by the new time, earliest first. */
  advance(ms: number): void {
    this.current += ms;
    const due = this.sleepers.filter((sleeper) => sleeper.at <= this.current);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper.at > this.current);
    for (const sleeper of due.sort((a, b) => a.at - b.at)) sleeper.resolve();
  }
}

/** Records the stream; answers come from a fixed table keyed by `ask` id. */
export class RecordingChannel implements EventChannel {
  readonly events: Event[] = [];

  constructor(private readonly answers: Readonly<Record<string, string>> = {}) {}

  emit(event: Event): void {
    this.events.push(event);
  }

  answer(id: string): Promise<string> {
    const value = this.answers[id];
    return value === undefined
      ? Promise.reject(new Error(`unanswered question: ${id}`))
      : Promise.resolve(value);
  }
}

/** Run directory in memory; logs keyed like their file names, `<host>.<phase>` or `<phase>`. */
export class MemoryRunStore implements RunStore {
  readonly events: Event[] = [];
  readonly logs = new Map<string, string[]>();
  state: PersistedState | undefined;
  report: string | undefined;

  constructor(readonly id: string) {}

  appendEvent(event: Event): void {
    this.events.push(event);
  }

  writeState(state: PersistedState): void {
    this.state = structuredClone(state);
  }

  appendLog(name: LogName, line: string): void {
    const key = logFileName(name);
    this.logs.set(key, [...(this.logs.get(key) ?? []), line]);
  }

  writeReport(markdown: string): void {
    this.report = markdown;
  }

  outLink(host: string): string {
    return `/deployments/${this.id}/gcroots/${host}`;
  }
}

/** Every run starts at the same date: a second run of the same mode is refused, like on disk. */
export class MemoryDeploymentStore implements DeploymentStore {
  readonly runs: MemoryRunStore[] = [];

  create(mode: RunInfo["mode"]): MemoryRunStore {
    const id = `20260917T020000Z-${mode}`;
    if (this.runs.some((run) => run.id === id)) throw new Error(`run exists: ${id}`);
    const run = new MemoryRunStore(id);
    this.runs.push(run);
    return run;
  }
}

/** Free unless a holder is given: then always busy. */
export class FakeLock implements RunLock {
  held = false;

  constructor(private readonly holder?: string) {}

  acquire(): LockAttempt {
    if (this.holder !== undefined) return { kind: "busy", holder: this.holder };
    if (this.held) throw new Error("lock already held by this process");
    this.held = true;
    return { kind: "acquired" };
  }

  release(): void {
    this.held = false;
  }
}

export class FakeLocalHost implements LocalHost {
  constructor(
    private readonly name: string,
    private readonly ipv4: readonly string[] = [],
  ) {}

  hostname(): string {
    return this.name;
  }

  addresses(): string[] {
    return [...this.ipv4];
  }
}

export interface FakeContext extends EngineContext {
  commands: FakeCommands;
  clock: FakeClock;
  events: RecordingChannel;
  abort: AbortController;
}

/** A full context of fakes; the test keeps typed handles to script and inspect them. */
export function fakeContext(
  options: { commands?: CommandScript[]; answers?: Record<string, string> } = {},
): FakeContext {
  const abort = new AbortController();
  return {
    commands: new FakeCommands(options.commands),
    clock: new FakeClock(),
    events: new RecordingChannel(options.answers),
    signal: abort.signal,
    abort,
  };
}
