// Resolved run parameters (spec § Options, § Délais).
//
// Carried by `run.start`, kept in `state.json`: `--resume` restores them and
// overrides only the options it accepts.

/** Keys of `network.fleetUpdate.timeouts`. */
export const TIMEOUT_KEYS = [
  "flakeUpdate",
  "clean",
  "commit",
  "eval",
  "build",
  "copy",
  "activation",
  "ssh",
  "ping",
  "matrix",
  "killGrace",
] as const;

export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

/** Seconds per operation. */
export type Timeouts = Record<TimeoutKey, number>;

export const AI_ANALYSIS = ["none", "passive", "active"] as const;

export type AiAnalysis = (typeof AI_ANALYSIS)[number];

export const AI_ERROR_ACTION = ["none", "analysis", "repair"] as const;

export type AiErrorAction = (typeof AI_ERROR_ACTION)[number];

export interface RunParams {
  /** Raw `--on` query; absent: the whole fleet. */
  on?: string;
  deploymentOrder: string;
  criticalProfiles: string;
  currentZoneBefore: boolean;
  dnfFlake: boolean;
  consumerFlake: boolean;
  dnfMessage: string;
  consumerMessage: string;
  buildOnly: boolean;
  resume: boolean;
  interactive: boolean;
  stopLoss: boolean;
  ui: boolean;
  sendReport: boolean;

  /** Raw `<tool>[:<model>][@<effort>]`, handed to the AI tool as is. */
  aiModel: string;
  aiAnalysis: AiAnalysis;
  aiErrorAction: AiErrorAction;
  maxParallel: number;

  /** Seconds; `0` disables the automatic rollback. */
  rollbackTimeout: number;
  timeouts: Timeouts;

  /** Seconds between two pings of the tracked hosts. */
  pingInterval: number;
}
