// Prompts handed to the AI tools (spec § analyse, Prompts).
//
// Built from the fold of `state.json`, never from the engine: the report reads
// the same source, so the two can never disagree. English, like every string
// the tool prints.

import type { PersistedHost, PersistedState } from "../model/persist.ts";
import type { ToolLevel } from "./tools/types.ts";

const ROLE = [
  "You are diagnosing a NixOS fleet deployment run by fleet-update.",
  "You are read-only: you observe and explain, you never change anything.",
];

const CONDUCT = [
  "Ground every claim in what the tools return. Say plainly when you do not know.",
  "You have no shell and no SSH. The tools listed to you are all you have;",
  "there is no other way to reach the hosts or the sources, and asking for one is a dead end.",
];

const SHAPE = [
  "Answer in plain prose, no headings and no bullet lists.",
  "Lead with the most likely cause in one sentence, then the evidence for it,",
  "then what a human should check next. Six sentences at most.",
];

/** Without a tool the AI has only the prompt: it is told so, to stop it asking. */
const NO_TOOLS = [
  "You have no tools in this run: answer from the context below alone,",
  "and say what you would need to be sure.",
];

export function systemPrompt(level: ToolLevel | undefined): string {
  const tools = level === undefined ? NO_TOOLS : CONDUCT;
  return [...ROLE, "", ...tools, "", ...SHAPE].join("\n");
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

/**
 * Analysis of one failed host. The seed carries what the engine already knows;
 * anything beyond it the AI fetches through its tools.
 */
export function hostPrompt(state: PersistedState, host: PersistedHost): string {
  return [
    ...runSeed(state),
    "",
    ...hostSeed(host),
    "",
    `Explain why ${host.name} failed, and what to check next.`,
  ].join("\n");
}

/** End of run: what is worth saying about the whole deployment. */
export function runPrompt(state: PersistedState): string {
  const troubled = state.hosts.filter(
    (host) => host.status !== "deployed" && host.status !== "tested",
  );
  const lines = troubled.map(
    (host) => `- ${host.name}: ${host.status}${host.note === undefined ? "" : ` (${host.note})`}`,
  );
  return [
    ...runSeed(state),
    "",
    ...(lines.length > 0
      ? ["Hosts that did not reach the new generation:", ...lines]
      : ["Every host reached the new generation."]),
    "",
    "Summarise this run for the operator: what happened, what needs attention.",
    "Three sentences at most.",
  ].join("\n");
}

/** Free question of the operator (`a`): same context, their words. */
export function freePrompt(state: PersistedState, question: string): string {
  return [...runSeed(state), "", `The operator asks: ${question}`].join("\n");
}
