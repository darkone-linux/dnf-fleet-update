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
  "publish",
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

  /** Step 4 skipped: the switch goes wave by wave, nothing proved beforehand. */
  skipTest: boolean;

  /** Step 5 skipped: the run stops on what the test left, without asking. */
  skipSwitch: boolean;

  /** False (`--no-distributed-build`): every closure built on the deployment machine. */
  distributedBuild: boolean;
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

/** Built-in defaults of the options (spec § Options), last in the resolution order. */
export const DEFAULTS = {
  deploymentOrder: "hcs:gateway:server:[others]:laptop",
  criticalProfiles: "hcs:gateway:server",
  dnfMessage: "chore(update): regular flake upgrade",
  aiModel: "claude:opus@high",
  aiAnalysis: "none",
  aiErrorAction: "analysis",
  maxParallel: 10,
  rollbackTimeout: 600,
  pingInterval: 15,
} as const;

/** Spec § Délais, seconds. */
export const DEFAULT_TIMEOUTS: Timeouts = {
  flakeUpdate: 120,
  clean: 60,
  commit: 60,
  eval: 1200,
  build: 10_800,
  publish: 3600,
  copy: 3600,
  activation: 300,
  ssh: 30,
  ping: 5,
  matrix: 30,
  killGrace: 10,
};

/** `run.start` mode and `var/deployments/<date>-<mode>/` suffix. */
export function runMode(params: RunParams): "full" | "partial" | "resume" {
  if (params.resume) return "resume";
  return params.on === undefined ? "full" : "partial";
}
