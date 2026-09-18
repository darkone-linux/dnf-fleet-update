// Command line → run parameters (spec § Options, § État et reprise).
//
// Invalid input is data (`invalid`): the entry point exits `2`. Resolution
// order: option > `network.fleetUpdate` > built-in default.

import { parseArgs } from "node:util";
import type { FleetDefaults } from "../engine/fleet.ts";
import { parseQuery } from "../engine/query.ts";
import { parseProfileList } from "../engine/waves.ts";
import {
  AI_ANALYSIS,
  AI_ERROR_ACTION,
  type AiAnalysis,
  type AiErrorAction,
  DEFAULT_TIMEOUTS,
  DEFAULTS,
  type RunParams,
} from "../model/params.ts";
import { fail, ok, type Result } from "../model/result.ts";

/** As given on the command line: `undefined` or `false` when absent. */
export interface CliOptions {
  on?: string;
  deploymentOrder?: string;
  criticalProfiles?: string;
  noCurrentZoneBefore: boolean;
  noDnfFlake: boolean;
  noConsumerFlake: boolean;
  dnfMessage?: string;
  consumerMessage?: string;
  buildOnly: boolean;
  skipTest: boolean;
  skipSwitch: boolean;
  resume: boolean;
  nonInteractive: boolean;
  stopLoss: boolean;
  noUi: boolean;
  sendReport: boolean;
  aiModel?: string;
  aiAnalysis?: AiAnalysis;
  aiErrorAction?: AiErrorAction;
  maxParallel?: number;
  rollbackTimeout?: number;
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; options: CliOptions }
  | { kind: "invalid"; error: string };

export interface AiModel {
  tool: "claude" | "opencode";
  model?: string;
  effort?: string;
}

/** Model and effort are handed over as is: the AI tool reports what it rejects. */
export function parseAiModel(value: string): Result<AiModel> {
  const match = /^(claude|opencode)(?::([^@\s]+))?(?:@([a-zA-Z0-9_-]+))?$/.exec(value);
  if (!match) return fail(`--ai-model: expected <tool>[:<model>][@<effort>], got "${value}"`);
  return ok({ tool: match[1] as AiModel["tool"], model: match[2], effort: match[3] });
}

const flag = { type: "boolean" } as const;
const text = { type: "string" } as const;

const OPTIONS = {
  on: text,
  "deployment-order": text,
  "critical-profiles": text,
  "no-current-zone-before": flag,
  "no-dnf-flake": flag,
  "no-consumer-flake": flag,
  "dnf-message": text,
  "consumer-message": text,
  "build-only": flag,
  "skip-test": flag,
  "skip-switch": flag,
  resume: flag,
  "non-interactive": flag,
  "stop-loss": flag,
  "no-ui": flag,
  "send-report": flag,
  "ai-model": text,
  "ai-analysis": text,
  "ai-error-action": text,
  "max-parallel": text,
  "rollback-timeout": text,
} as const;

function integer(name: string, value: string | undefined, min: number): Result<number | undefined> {
  if (value === undefined) return ok(undefined);
  if (!/^\d+$/.test(value) || Number(value) < min) {
    return fail(`--${name}: expected an integer >= ${min}, got "${value}"`);
  }
  return ok(Number(value));
}

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): Result<T | undefined> {
  const found = allowed.find((candidate) => candidate === value);
  if (value === undefined || found !== undefined) return ok(found);
  return fail(`--${name}: expected ${allowed.join("|")}, got "${value}"`);
}

function checkMessage(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" || value.includes("\n")
    ? `--${name}: expected one non-empty line`
    : undefined;
}

export function parseCli(argv: readonly string[]): CliCommand {
  const invalid = (error: string): CliCommand => ({ kind: "invalid", error });

  if (argv.includes("--help")) return { kind: "help" };
  if (argv.includes("--version")) return { kind: "version" };

  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    // `node:util` reports unknown options and missing values by throwing.
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0) return invalid(`unexpected argument: ${positionals[0]}`);

  if (values.on !== undefined) {
    const query = parseQuery(values.on);
    if (!query.ok) return invalid(query.error);
  }
  for (const [name, allowOthers] of [
    ["deployment-order", true],
    ["critical-profiles", false],
  ] as const) {
    const value = values[name];
    const list = value === undefined ? ok([]) : parseProfileList(value, allowOthers);
    if (!list.ok) return invalid(`--${name}: ${list.error}`);
  }
  if (values["ai-model"] !== undefined) {
    const model = parseAiModel(values["ai-model"]);
    if (!model.ok) return invalid(model.error);
  }
  for (const name of ["dnf-message", "consumer-message"] as const) {
    const error = checkMessage(name, values[name]);
    if (error) return invalid(error);
  }

  const aiAnalysis = oneOf("ai-analysis", values["ai-analysis"], AI_ANALYSIS);
  if (!aiAnalysis.ok) return invalid(aiAnalysis.error);
  const aiErrorAction = oneOf("ai-error-action", values["ai-error-action"], AI_ERROR_ACTION);
  if (!aiErrorAction.ok) return invalid(aiErrorAction.error);
  const maxParallel = integer("max-parallel", values["max-parallel"], 1);
  if (!maxParallel.ok) return invalid(maxParallel.error);
  const rollbackTimeout = integer("rollback-timeout", values["rollback-timeout"], 0);
  if (!rollbackTimeout.ok) return invalid(rollbackTimeout.error);

  return {
    kind: "run",
    options: {
      on: values.on,
      deploymentOrder: values["deployment-order"],
      criticalProfiles: values["critical-profiles"],
      noCurrentZoneBefore: values["no-current-zone-before"] ?? false,
      noDnfFlake: values["no-dnf-flake"] ?? false,
      noConsumerFlake: values["no-consumer-flake"] ?? false,
      dnfMessage: values["dnf-message"],
      consumerMessage: values["consumer-message"],
      buildOnly: values["build-only"] ?? false,
      skipTest: values["skip-test"] ?? false,
      skipSwitch: values["skip-switch"] ?? false,
      resume: values.resume ?? false,
      nonInteractive: values["non-interactive"] ?? false,
      stopLoss: values["stop-loss"] ?? false,
      noUi: values["no-ui"] ?? false,
      sendReport: values["send-report"] ?? false,
      aiModel: values["ai-model"],
      aiAnalysis: aiAnalysis.value,
      aiErrorAction: aiErrorAction.value,
      maxParallel: maxParallel.value,
      rollbackTimeout: rollbackTimeout.value,
    },
  };
}

/** Confirmations asked; `--no-ui` forces them off, whatever the terminal. */
export const interactively = (options: CliOptions): boolean =>
  !options.nonInteractive && !options.noUi;

/** Parameters of a new run. Fleet defaults are outside data: checked again. */
export function resolveParams(options: CliOptions, fleet: FleetDefaults): Result<RunParams> {
  const deploymentOrder =
    options.deploymentOrder ?? fleet.deploymentOrder ?? DEFAULTS.deploymentOrder;
  const criticalProfiles =
    options.criticalProfiles ?? fleet.criticalProfiles ?? DEFAULTS.criticalProfiles;

  const order = parseProfileList(deploymentOrder, true);
  if (!order.ok) return fail(`network.fleetUpdate.deploymentOrder: ${order.error}`);
  const critical = parseProfileList(criticalProfiles, false);
  if (!critical.ok) return fail(`network.fleetUpdate.criticalProfiles: ${critical.error}`);

  return ok({
    on: options.on,
    deploymentOrder,
    criticalProfiles,
    currentZoneBefore: !options.noCurrentZoneBefore,
    dnfFlake: !options.noDnfFlake,
    consumerFlake: !options.noConsumerFlake,
    dnfMessage: options.dnfMessage ?? DEFAULTS.dnfMessage,
    consumerMessage:
      options.consumerMessage ??
      (options.on === undefined ? "chore(update): full fleet" : `chore(update): ${options.on}`),
    buildOnly: options.buildOnly,
    skipTest: options.skipTest,
    skipSwitch: options.skipSwitch,
    resume: false,
    interactive: interactively(options),
    stopLoss: options.stopLoss,
    ui: !options.noUi,
    sendReport: options.sendReport,
    aiModel: options.aiModel ?? DEFAULTS.aiModel,
    aiAnalysis: options.aiAnalysis ?? DEFAULTS.aiAnalysis,
    aiErrorAction: options.aiErrorAction ?? DEFAULTS.aiErrorAction,
    maxParallel: options.maxParallel ?? DEFAULTS.maxParallel,
    rollbackTimeout: options.rollbackTimeout ?? DEFAULTS.rollbackTimeout,
    timeouts: { ...DEFAULT_TIMEOUTS, ...fleet.timeouts },
    pingInterval: fleet.pingInterval ?? DEFAULTS.pingInterval,
  });
}

export interface Resumed {
  params: RunParams;

  /** `--on` of the resume: filters the remaining hosts, the saved selection stays. */
  filter?: string;
}

/**
 * Parameters of a resumed run: the saved ones, overridden by the options
 * `--resume` accepts. Valued options override only when given; flags describe
 * this invocation (terminal or timer), so they always come from it.
 */
export function resumeParams(saved: RunParams, options: CliOptions): Result<Resumed> {
  const refused = [
    options.deploymentOrder !== undefined && "--deployment-order",
    options.criticalProfiles !== undefined && "--critical-profiles",
    options.noCurrentZoneBefore && "--no-current-zone-before",
    options.noDnfFlake && "--no-dnf-flake",
    options.noConsumerFlake && "--no-consumer-flake",
    options.dnfMessage !== undefined && "--dnf-message",
    options.consumerMessage !== undefined && "--consumer-message",
  ].filter((name): name is string => name !== false);
  if (refused.length > 0) return fail(`--resume does not accept ${refused.join(", ")}`);

  return ok({
    params: {
      ...saved,
      resume: true,
      buildOnly: options.buildOnly,
      skipTest: options.skipTest,
      skipSwitch: options.skipSwitch,
      interactive: interactively(options),
      stopLoss: options.stopLoss,
      ui: !options.noUi,
      sendReport: options.sendReport,
      aiModel: options.aiModel ?? saved.aiModel,
      aiAnalysis: options.aiAnalysis ?? saved.aiAnalysis,
      aiErrorAction: options.aiErrorAction ?? saved.aiErrorAction,
      maxParallel: options.maxParallel ?? saved.maxParallel,
      rollbackTimeout: options.rollbackTimeout ?? saved.rollbackTimeout,
    },
    filter: options.on,
  });
}
