// Passive tools reading the run itself (spec § analyse, `passive`): the fold
// of `state.json`, and what the deterministic collection brought back.
//
// Nothing new is started on the fleet here: everything already happened.

import { z } from "zod";
import type { PersistedState } from "../../model/persist.ts";
import { defineTool, type RegisteredTool } from "./types.ts";

/** The fold as the model reads it: one line per host, the run above them. */
export function describeState(state: PersistedState): string[] {
  const lines: string[] = [];
  const run = state.run;
  if (run !== undefined) {
    lines.push(`run: ${run.mode}, selection ${run.selection}, codev ${run.codev}`);
  }

  const steps = Object.entries(state.steps)
    .filter(([, step]) => step.status !== "todo")
    .map(([id, step]) => `${id} ${step.status}`);
  if (steps.length > 0) lines.push(`steps: ${steps.join(", ")}`);

  const wave = state.waves.at(-1);
  if (wave !== undefined) {
    lines.push(`last wave: ${wave.step} ${wave.index}/${wave.total} (${wave.hosts.join(", ")})`);
  }

  lines.push(`hosts (${state.hosts.length}):`);
  for (const host of state.hosts) {
    const parts = [host.name, host.profile, host.zone, host.state, host.status];
    if (host.online === false) parts.push("offline");
    if (host.note !== undefined) parts.push(`reason: ${host.note}`);
    lines.push(`  ${parts.join(" | ")}`);
  }

  if (state.notes.length > 0) {
    lines.push("notes:");
    for (const note of state.notes) {
      lines.push(`  ${note.host === undefined ? "" : `${note.host}: `}${note.message}`);
    }
  }
  return lines;
}

const deploymentState = defineTool({
  name: "deployment_state",
  level: "passive",
  description:
    "State of the running deployment: hosts with their profile, zone, progress and failure reason, the steps, the last wave and the report notes.",
  input: z.strictObject({}),
  summary: () => "reads the deployment state",
  run: (context) => Promise.resolve({ lines: describeState(context.state()) }),
});

const hostDiagnosis = defineTool({
  name: "host_diagnosis",
  level: "passive",
  description:
    "What the deterministic collection found on a failed host: the units it could not start, and the error lines of the command that failed.",
  input: z.strictObject({ host: z.string().describe("host name, as deployment_state lists it") }),
  summary: (args) => `reads the diagnosis of ${args.host}`,
  run: (context, args) => {
    const host = context.host(args.host);

    // State first, whatever was collected: a host with nothing to show still
    // says where it stands.
    const header = [
      `${host.name}: ${host.state} (${host.status})`,
      ...(host.note === undefined ? [] : [`reason: ${host.note}`]),
    ];
    const diagnosis = host.diagnosis;
    if (diagnosis === undefined) {
      return Promise.resolve({ lines: [...header, "nothing was collected on this host"] });
    }
    const excerpt = diagnosis.excerpt ?? [];
    return Promise.resolve({
      lines: [
        ...header,
        ...(diagnosis.units.length > 0
          ? [`failed units: ${diagnosis.units.join(", ")}`]
          : ["no failed unit"]),
        ...(excerpt.length > 0 ? ["error excerpt:", ...excerpt] : []),
      ],
    });
  },
});

export const stateTools: readonly RegisteredTool[] = [deploymentState, hostDiagnosis];
