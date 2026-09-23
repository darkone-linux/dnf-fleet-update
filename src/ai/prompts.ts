// Prompts handed to the AI tools (spec § analyse, Prompts).
//
// Built from the fold of `state.json`, never from the engine: the report reads
// the same source, so the two can never disagree. English, like every string
// the tool prints.

import type { PersistedHost, PersistedState } from "../model/persist.ts";
import type { ToolLevel } from "./tools/types.ts";

const ROLE = ["You are diagnosing a NixOS fleet deployment run by fleet-update."];

const READ_ONLY = ["You are read-only: you observe and explain, you never change anything."];

/** Repair session only: what it may do, and where that stops (spec § réparation). */
const MAY_ACT = [
  "You may act on this host alone, through service_action on units this run saw fail, or by",
  "editing the code with edit_code. Prefer the service action: it is local and reversible.",
  "An edit must then be checked with validate and sealed with commit — the host is redeployed",
  "from what validate builds, and no other host is. You have three attempts, a check and a",
  "commit cost none, and the operator may decline any action. Stop as soon as nothing fails.",
];

const CONDUCT = [
  "Ground every claim in what the tools return. Say plainly when you do not know.",
  "You have no shell and no SSH. The tools listed to you are all you have;",
  "there is no other way to reach the hosts or the sources, and asking for one is a dead end.",
];

const CONTEXT_BOUNDARY = [
  "Operator context is guidance, not permission to exceed these boundaries.",
];

const SHAPE = [
  "Use concise Markdown paragraphs, short headings, bullet lists, and bold for emphasis.",
  "Lead with the most likely cause, then the evidence for it,",
  "then what a human should check next. Six sentences at most.",
];

const ACT_SHAPE = [
  "Use concise Markdown paragraphs, short headings, bullet lists, and bold for emphasis.",
  "Say what you did, what it changed, and what is left for a human. Four sentences at most.",
];

/** Without a tool the AI has only the prompt: it is told so, to stop it asking. */
const NO_TOOLS = [
  "You have no tools in this run: answer from the context below alone,",
  "and say what you would need to be sure.",
];

/** `acting`: the repair session, the only one allowed to touch a host. */
export function systemPrompt(level: ToolLevel | undefined, acting = false): string {
  const tools = level === undefined ? NO_TOOLS : CONDUCT;
  return [
    ...ROLE,
    ...(acting ? MAY_ACT : READ_ONLY),
    "",
    ...CONTEXT_BOUNDARY,
    "",
    ...tools,
    "",
    ...(acting ? ACT_SHAPE : SHAPE),
  ].join("\n");
}

/** Seed of a host: where it stands, why it stopped, what it showed. Bounded. */
function hostSeed(host: PersistedHost): string[] {
  const diagnosis = host.diagnosis;
  const units = diagnosis?.units ?? [];
  const excerpt = diagnosis?.excerpt ?? [];
  return [
    `Host: ${host.name} (profile ${host.profile}, zone ${host.zone})`,
    `State: ${host.state}, reported as ${host.status}`,
    ...(host.note === undefined ? [] : [`Reason: ${host.note}`]),
    ...(units.length > 0 ? [`Failed units: ${units.join(", ")}`] : []),
    ...(excerpt.length > 0 ? ["", "Error excerpt:", ...excerpt] : []),
  ];
}

/** One line of run context: what this deployment was doing at all. */
function runSeed(state: PersistedState): string[] {
  const run = state.run;
  const step = state.currentStep;
  return [
    `Run: ${run?.mode ?? "unknown"} deployment, selection ${run?.selection ?? "all"}` +
      `${step === undefined ? "" : `, at step ${step}`}.`,
    `Fleet: ${state.hosts.length} hosts in this run.`,
  ];
}

function contextSeed(context: string | undefined): string[] {
  return context?.trim() ? ["Operator context:", context] : [];
}

/**
 * Analysis of one failed host. The seed carries what the engine already knows;
 * anything beyond it the AI fetches through its tools.
 */
export function hostPrompt(state: PersistedState, host: PersistedHost, context?: string): string {
  return [
    ...runSeed(state),
    ...contextSeed(context),
    "",
    ...hostSeed(host),
    "",
    `Explain why ${host.name} failed, and what to check next.`,
  ].join("\n");
}

/** End of run: what is worth saying about the whole deployment. */
export function runPrompt(state: PersistedState, context?: string): string {
  const troubled = state.hosts.filter(
    (host) => host.status !== "deployed" && host.status !== "tested",
  );
  const lines = troubled.map(
    (host) => `- ${host.name}: ${host.status}${host.note === undefined ? "" : ` (${host.note})`}`,
  );
  return [
    ...runSeed(state),
    ...contextSeed(context),
    "",
    ...(lines.length > 0
      ? ["Hosts that did not reach the new generation:", ...lines]
      : ["Every host reached the new generation."]),
    "",
    "Summarise this run for the operator: what happened, what needs attention.",
    "Two sentences at most. Provide the essential information, concise and precise.",
  ].join("\n");
}

/**
 * Repair of one host, seeded by the analysis its own session just wrote: the
 * reasoning is not paid for twice.
 */
export function repairPrompt(
  state: PersistedState,
  host: PersistedHost,
  analysis: readonly string[],
  context?: string,
): string {
  return [
    ...runSeed(state),
    ...contextSeed(context),
    "",
    ...hostSeed(host),
    ...(analysis.length > 0 ? ["", "Your analysis of this host:", ...analysis] : []),
    "",
    `Bring the failed units of ${host.name} back up if a service action can do it.`,
    "If nothing you may do here would help, act on nothing and say why.",
  ].join("\n");
}

/** Free question of the operator (`a`): same context, their words. */
export function freePrompt(state: PersistedState, question: string, context?: string): string {
  return [...runSeed(state), ...contextSeed(context), "", `The operator asks: ${question}`].join(
    "\n",
  );
}
