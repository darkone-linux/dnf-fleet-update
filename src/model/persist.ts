// Fold of the event stream into `state.json` (spec § État et reprise).
//
// Pure, like the interface fold, but keeps only what `--resume` and the report
// need: no feed, no live output.

import {
  type Event,
  type HostOrigin,
  type HostState,
  type RunInfo,
  STEPS,
  type StepId,
} from "./events.ts";
import type { ExitCode } from "./exit-codes.ts";
import { endedStep, type StepStatus } from "./state.ts";

/** Bumped on any change a previous reader cannot load. */
export const PERSIST_SCHEMA = 1;

/** Per-host line of the report and of `state.json`. */
export type HostStatus =
  | "deployed"
  | "tested"
  | "error"
  | "failed"
  | "reverted"
  | "offline"
  | "excluded"
  | "remaining";

export interface PersistedHost {
  name: string;
  profile: string;
  zone: string;
  state: HostState;

  /** Last ping answer; absent until the first one. */
  online?: boolean;
  status: HostStatus;
  note?: string;
  path?: string;
  origin?: HostOrigin;
  known?: boolean;
}

/** `t` in milliseconds since the run start, like the stream. */
export interface PersistedStep {
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface PersistedWave {
  step: StepId;
  index: number;
  total: number;
  hosts: string[];
  startedAt: number;
}

export interface PersistedState {
  schema: typeof PERSIST_SCHEMA;
  run?: RunInfo;
  commits: { repo: "dnf" | "consumer"; rev: string; message: string }[];
  plan: string[][];
  steps: Record<StepId, PersistedStep>;

  /** Last `step.start`: where `--resume` picks up. */
  currentStep?: StepId;
  waves: PersistedWave[];
  hosts: PersistedHost[];

  /** Every closed question: decisions of the run, AI actions included. */
  answers: { id: string; value: string; t: number }[];
  end?: { status: "done" | "failed" | "aborted"; exitCode: ExitCode };

  /** `t` of the last event folded. */
  lastEventAt: number;
}

export function initialPersisted(): PersistedState {
  const steps = {} as Record<StepId, PersistedStep>;
  for (const step of STEPS) steps[step] = { status: "todo" };
  return {
    schema: PERSIST_SCHEMA,
    commits: [],
    plan: [],
    steps,
    waves: [],
    hosts: [],
    answers: [],
    lastEventAt: 0,
  };
}

/**
 * Snapshot status: a built host unreachable or never pinged reads as offline, a tested one
 * as tested (left in `test`).
 */
export function hostStatus(host: Pick<PersistedHost, "state" | "online">): HostStatus {
  switch (host.state) {
    case "deployed":
    case "error":
    case "failed":
    case "reverted":
    case "excluded":
    case "tested":
      return host.state;
    case "built":
      return host.online ? "remaining" : "offline";
    case "pending":
    case "building":
    case "copying":
    case "testing":
    case "switching":
      return "remaining";
  }
}

function patchHost(
  state: PersistedState,
  name: string,
  patch: Partial<PersistedHost>,
): PersistedHost[] {
  return state.hosts.map((host) => {
    if (host.name !== name) return host;
    const next = { ...host, ...patch };
    return { ...next, status: hostStatus(next) };
  });
}

/** Applies one event. Unknown kinds are ignored, as in the interface fold. */
export function persist(previous: PersistedState, event: Event): PersistedState {
  const state = { ...previous, lastEventAt: event.t };

  switch (event.kind) {
    case "run.start":
      return { ...state, run: event.run };

    case "commit":
      return {
        ...state,
        commits: [...state.commits, { repo: event.repo, rev: event.rev, message: event.message }],
      };

    case "plan":
      return { ...state, plan: event.waves };

    case "step.start":
      return {
        ...state,
        currentStep: event.step,
        steps: { ...state.steps, [event.step]: { status: "running", startedAt: event.t } },
      };

    case "step.end": {
      const step = state.steps[event.step];
      return {
        ...state,
        steps: {
          ...state.steps,
          [event.step]: { ...step, status: endedStep(event.status), endedAt: event.t },
        },
      };
    }

    // Waves belong to the step running when they start.
    case "wave.start":
      if (state.currentStep === undefined) return state;
      return {
        ...state,
        waves: [
          ...state.waves,
          {
            step: state.currentStep,
            index: event.index,
            total: event.total,
            hosts: event.hosts,
            startedAt: event.t,
          },
        ],
      };

    case "host.add": {
      const host = {
        name: event.host,
        profile: event.profile,
        zone: event.zone,
        state: "pending" as const,
      };
      return { ...state, hosts: [...state.hosts, { ...host, status: hostStatus(host) }] };
    }

    case "host.presence":
      return { ...state, hosts: patchHost(state, event.host, { online: event.online }) };

    case "host.state": {
      const patch: Partial<PersistedHost> = {
        state: event.state,
        note: event.note,
        known: event.known,
      };
      if (event.path !== undefined) patch.path = event.path;
      if (event.origin !== undefined) patch.origin = event.origin;
      return { ...state, hosts: patchHost(state, event.host, patch) };
    }

    case "ask.close":
      return {
        ...state,
        answers: [...state.answers, { id: event.id, value: event.value, t: event.t }],
      };

    case "run.end":
      return { ...state, end: { status: event.status, exitCode: event.exitCode } };

    // Live output and narration: logs of `var/deployments/`, not state.
    case "step.progress":
    case "host.output":
    case "log":
    case "ai":
    case "ai.line":
    case "ai.end":
    case "ask":
      return state;

    default:
      return previous;
  }
}
