// Engine -> interface contract.
//
// One JSON object per line (JSONL). The same stream feeds the TUI, the text
// output of `--no-ui` and `state.json` (a fold of the stream), so it is the
// only coupling point between engine and interface.

/** The 7 steps of the procedure, in order. */
export const STEPS = ["update", "select", "probe", "build", "test", "switch", "report"] as const;

export type StepId = (typeof STEPS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  update: "Update",
  select: "Select",
  probe: "Probe",
  build: "Build",
  test: "Test",
  switch: "Switch",
  report: "Report",
};

/**
 * Host states as displayed. Active states (`building`, `copying`, `testing`,
 * `switching`) carry a spinner; the others carry a glyph.
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
  | "failed"
  | "offline"
  | "excluded";

/** Split of `failed`: a service that did not start reads differently from the rest. */
export type FailureKind = "service" | "other";

export type Level = "info" | "ok" | "warn" | "error";

export interface RunInfo {
  version: string;
  selection: string;
  mode: "full" | "partial" | "resume";
  codev: boolean;
  aiModel: string;
  maxParallel: number;
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
  | (Base & { kind: "host.add"; host: string; profile: string; zone: string })
  | (Base & { kind: "step.start"; step: StepId; total?: number })
  | (Base & { kind: "step.progress"; step: StepId; done: number; total: number })
  | (Base & { kind: "step.end"; step: StepId; status: "ok" | "error" | "skipped" })
  | (Base & { kind: "wave.start"; index: number; total: number; hosts: string[] })
  | (Base & {
      kind: "host.state";
      host: string;
      state: HostState;
      failure?: FailureKind;
      note?: string;
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
      exitCode: number;
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
