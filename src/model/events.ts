// Engine -> interface contract.
//
// One JSON object per line (JSONL). The same stream feeds the TUI, the text
// output of `--no-ui` and `state.json` (a fold of the stream), so it is the
// only coupling point between engine and interface.

import type { ExitCode } from "./exit-codes.ts";
import type { RunParams } from "./params.ts";

/** The 6 steps of the procedure, in order. Presence runs inside `build`. */
export const STEPS = ["update", "select", "build", "test", "switch", "report"] as const;

export type StepId = (typeof STEPS)[number];

/**
 * How a step ended: `skipped` already done elsewhere (`--resume`), `aborted`
 * cut by an abort `now`, `omitted` ruled out by the options (`--build-only`).
 */
export type StepEndStatus = "ok" | "error" | "skipped" | "aborted" | "omitted";

export const STEP_LABELS: Record<StepId, string> = {
  update: "Update",
  select: "Select",
  build: "Build",
  test: "Test",
  switch: "Switch",
  report: "Report",
};

/**
 * Host progress (spec § État et reprise). Presence is separate: `host.presence`.
 * Active states (`building`, `copying`, `testing`, `switching`) carry a spinner.
 *
 * - `error`: activation done, at least one unit failed;
 * - `failed`: any other failure;
 * - `reverted`: rolled back on purpose to its origin.
 */
export type HostState =
  | "pending"
  | "building"
  | "built"
  | "copying"
  | "testing"
  | "tested"
  | "switching"
  | "deployed"
  | "error"
  | "failed"
  | "reverted"
  | "excluded";

/** Configuration a host ran before its first activation of the run: every rollback target. */
export interface HostOrigin {
  /** `/run/current-system`, resolved. */
  system: string;

  /** Target of the system profile, resolved. */
  profile: string;
}

export type Level = "info" | "ok" | "warn" | "error";

export interface RunInfo {
  version: string;
  selection: string;
  mode: "full" | "partial" | "resume";
  codev: boolean;
  aiModel: string;
  maxParallel: number;

  /** Absent from the recorded scenarios. */
  params?: RunParams;
}

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * `t` is a millisecond offset from the start of the run, not a wall clock: the
 * replayer derives its pacing from it and the report derives durations.
 */
interface Base {
  t: number;
}

export type Event =
  | (Base & { kind: "run.start"; run: RunInfo })
  | (Base & { kind: "commit"; repo: "dnf" | "consumer"; rev: string; message: string })

  // Waves as planned at selection, presence ignored.
  | (Base & { kind: "plan"; waves: string[][] })
  | (Base & { kind: "host.add"; host: string; profile: string; zone: string })
  | (Base & { kind: "host.presence"; host: string; online: boolean })
  | (Base & { kind: "step.start"; step: StepId; total?: number })
  | (Base & { kind: "step.progress"; step: StepId; done: number; total: number })
  | (Base & { kind: "step.end"; step: StepId; status: StepEndStatus })
  | (Base & { kind: "wave.start"; index: number; total: number; hosts: string[] })
  | (Base & {
      kind: "host.state";
      host: string;
      state: HostState;
      note?: string;

      /** Toplevel store path, on `built`. */
      path?: string;

      /** On the first activation of the run. */
      origin?: HostOrigin;

      /** On `excluded`: known before the run (consumer known issue), hidden from the table. */
      known?: boolean;
    })
  | (Base & { kind: "host.output"; host: string; phase: string; line: string })
  | (Base & { kind: "log"; host?: string; level: Level; message: string })

  // AI answers stream: `ai` opens the block, `ai.line` appends, `ai.end` closes
  // it. `detail` on `ai` is the one-shot form, already complete.
  | (Base & { kind: "ai"; id?: string; message: string; detail?: string[] })
  | (Base & { kind: "ai.line"; id?: string; line: string })
  | (Base & { kind: "ai.end"; id?: string })
  | (Base & { kind: "ask"; id: string; question: string; options: AskOption[] })
  | (Base & { kind: "ask.close"; id: string; value: string })
  | (Base & {
      kind: "run.end";
      status: "done" | "failed" | "aborted";
      exitCode: ExitCode;
      report?: string[];
    });

export type EventKind = Event["kind"];

/** Active states drive the spinner and the active region; everything else is settled. */
const ACTIVE: ReadonlySet<HostState> = new Set<HostState>([
  "building",
  "copying",
  "testing",
  "switching",
]);

export function isActive(state: HostState): boolean {
  return ACTIVE.has(state);
}

/** Parses one JSONL line. Throws on malformed input: a broken stream must not render. */
export function parseEvent(line: string): Event {
  const value = JSON.parse(line) as Event;
  if (typeof value?.kind !== "string" || typeof value?.t !== "number") {
    throw new Error(`invalid event: ${line}`);
  }
  return value;
}

/** `after-wave`: the current wave, or step outside waves, finishes. `now`: every command is killed. */
export type AbortMode = "after-wave" | "now";

/**
 * Interface end of a run. A consumer acts through it and never imports the
 * engine: `main.tsx` binds the engine, `testing/mock.tsx` a recorded scenario.
 */
export interface RunControl {
  /** Answers the pending `ask` with one of its option values. */
  respond: (value: string) => void;

  /** `^C` dialog; the run still ends with its `run.end`. */
  abort: (mode: AbortMode) => void;

  /** `p`: pings the tracked hosts now. */
  ping: () => void;
}

/** Starts a run that delivers its events, in order, to `emit`. */
export type RunSource = (emit: (event: Event) => void) => RunControl;
