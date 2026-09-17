// Fold of the event stream into the state the interface renders.
//
// Pure and synchronous: the engine will write the same fold to `state.json`,
// and `--resume` restores a run by replaying it.

import {
  type AskOption,
  type Event,
  type HostOrigin,
  type HostState,
  isActive,
  type Level,
  type RunInfo,
  STEP_LABELS,
  STEPS,
  type StepId,
} from "./events.ts";

export type StepStatus = "todo" | "running" | "done" | "error" | "skipped";

export interface StepRow {
  status: StepStatus;
  done: number;
  total: number;
}

export interface HostRow {
  name: string;
  profile: string;
  zone: string;
  state: HostState;

  /** Last ping answer: every host starts unreachable. */
  online: boolean;
  note?: string;
  path?: string;
  origin?: HostOrigin;

  /** Exclusion known before the run: hidden from the table. */
  known?: boolean;

  /** Phase and last output line: the active region, not the feed. */
  phase?: string;
  lastLine?: string;

  /** Per-phase output, opened from the host table. Stands in for `var/deployments/`. */
  logs: { phase: string; line: string }[];
}

export interface FeedItem {
  id: number;
  t: number;

  /** `step` is a heading, `ai` a block, `log` a plain line. */
  kind: "log" | "ai" | "step";
  level: Level;
  host?: string;
  message: string;

  /** AI blocks only. */
  aiId?: string;
  detail?: string[];
  streaming?: boolean;
}

export interface Ask {
  id: string;
  question: string;
  options: AskOption[];
}

export interface RunEnd {
  status: "done" | "failed" | "aborted";
  exitCode: number;
  report: string[];
}

export interface RunState {
  run?: RunInfo;
  steps: Record<StepId, StepRow>;
  hosts: HostRow[];
  feed: FeedItem[];
  wave?: { index: number; total: number };
  ask?: Ask;
  end?: RunEnd;
}

export function initialState(): RunState {
  const steps = {} as Record<StepId, StepRow>;
  for (const step of STEPS) {
    steps[step] = { status: "todo", done: 0, total: 0 };
  }
  return { steps, hosts: [], feed: [] };
}

let feedSeq = 0;

function pushFeed(state: RunState, item: Omit<FeedItem, "id">): FeedItem[] {
  return [...state.feed, { ...item, id: ++feedSeq }];
}

function patchHost(state: RunState, name: string, patch: Partial<HostRow>): HostRow[] {
  return state.hosts.map((host) => (host.name === name ? { ...host, ...patch } : host));
}

/** Targets the named AI block, or the last one opened when the stream omits the id. */
function patchAi(
  state: RunState,
  id: string | undefined,
  patch: (item: FeedItem) => FeedItem,
): FeedItem[] {
  for (let index = state.feed.length - 1; index >= 0; index -= 1) {
    const item = state.feed[index]!;
    if (item.kind !== "ai") continue;
    if (id && item.aiId !== id) continue;
    const next = [...state.feed];
    next[index] = patch(item);
    return next;
  }
  return state.feed;
}

/** Applies one event. Unknown kinds are ignored: a newer engine must not break an older UI. */
export function reduce(state: RunState, event: Event): RunState {
  switch (event.kind) {
    case "run.start":
      return { ...state, run: event.run };

    // Persisted by `persist.ts`; the interface shows the matching `log` lines.
    case "commit":
    case "plan":
      return state;

    case "host.add":
      return {
        ...state,
        hosts: [
          ...state.hosts,
          {
            name: event.host,
            profile: event.profile,
            zone: event.zone,
            state: "pending",
            online: false,
            logs: [],
          },
        ],
      };

    case "step.start":
      return {
        ...state,
        steps: {
          ...state.steps,
          [event.step]: { status: "running", done: 0, total: event.total ?? 0 },
        },

        // Heading in the feed: marks where a step begins in the scrollback.
        feed: pushFeed(state, {
          t: event.t,
          kind: "step",
          level: "info",
          message: STEP_LABELS[event.step],
        }),
      };

    case "step.progress":
      return {
        ...state,
        steps: {
          ...state.steps,
          [event.step]: { status: "running", done: event.done, total: event.total },
        },
      };

    case "step.end": {
      const previous = state.steps[event.step];
      const status: StepStatus =
        event.status === "ok" ? "done" : event.status === "skipped" ? "skipped" : "error";
      return {
        ...state,
        steps: { ...state.steps, [event.step]: { ...previous, status } },
      };
    }

    case "wave.start":
      return {
        ...state,
        wave: { index: event.index, total: event.total },
        feed: pushFeed(state, {
          t: event.t,
          kind: "log",
          level: "info",
          message: `wave ${event.index}/${event.total}: ${event.hosts.join(", ")}`,
        }),
      };

    case "host.presence":
      return { ...state, hosts: patchHost(state, event.host, { online: event.online }) };

    case "host.state": {
      const patch: Partial<HostRow> = { state: event.state, note: event.note, known: event.known };

      // Set once, carried by later states.
      if (event.path !== undefined) patch.path = event.path;
      if (event.origin !== undefined) patch.origin = event.origin;

      // A settled host keeps no live line: the active region must empty itself.
      if (!isActive(event.state)) {
        patch.phase = undefined;
        patch.lastLine = undefined;
      }
      return { ...state, hosts: patchHost(state, event.host, patch) };
    }

    case "host.output": {
      const host = state.hosts.find((candidate) => candidate.name === event.host);
      if (!host) return state;
      return {
        ...state,
        hosts: patchHost(state, event.host, {
          phase: event.phase,
          lastLine: event.line,
          logs: [...host.logs, { phase: event.phase, line: event.line }],
        }),
      };
    }

    case "log":
      return {
        ...state,
        feed: pushFeed(state, {
          t: event.t,
          kind: "log",
          level: event.level,
          host: event.host,
          message: event.message,
        }),
      };

    case "ai":
      return {
        ...state,
        feed: pushFeed(state, {
          t: event.t,
          kind: "ai",
          level: "info",
          message: event.message,
          aiId: event.id,
          detail: event.detail ?? [],

          // One-shot answers arrive complete; a streamed one opens empty.
          streaming: event.detail === undefined,
        }),
      };

    case "ai.line":
      return {
        ...state,
        feed: patchAi(state, event.id, (item) => ({
          ...item,
          detail: [...(item.detail ?? []), event.line],
        })),
      };

    case "ai.end":
      return {
        ...state,
        feed: patchAi(state, event.id, (item) => ({ ...item, streaming: false })),
      };

    case "ask":
      return {
        ...state,
        ask: { id: event.id, question: event.question, options: event.options },
      };

    case "ask.close":
      return state.ask?.id === event.id ? { ...state, ask: undefined } : state;

    case "run.end":
      return {
        ...state,
        end: { status: event.status, exitCode: event.exitCode, report: event.report ?? [] },
      };

    default:
      return state;
  }
}

export function activeHosts(state: RunState): HostRow[] {
  return state.hosts.filter((host) => isActive(host.state));
}

const hidden = (host: HostRow): boolean => host.state === "excluded" && host.known === true;

/** Exclusions known before the run are hidden, only counted in the table title. */
export function visibleHosts(state: RunState): HostRow[] {
  return state.hosts.filter((host) => !hidden(host));
}

/** Hidden exclusions: the `M excluded` of the table title. */
export function excludedCount(state: RunState): number {
  return state.hosts.filter(hidden).length;
}

/** Progress state, or `offline` when unreachable. */
export type ShownState = HostState | "offline";

/** Spec § États affichés: exclusion > failure > error > presence > progress. */
export function shownState(host: HostRow): ShownState {
  if (host.state === "excluded" || host.state === "failed" || host.state === "error") {
    return host.state;
  }
  return host.online ? host.state : "offline";
}
