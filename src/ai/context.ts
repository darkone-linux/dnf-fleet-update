// `ToolContext` over a run: the narrow face the tools are given.
//
// Every effect a tool may have passes through here, so a tool written later
// cannot widen its own reach — it has no other handle on the run.

import { type HostCommand, onHost as place } from "../engine/commands/host.ts";
import { log, type RunContext } from "../engine/context.ts";
import { describeFailure, execute, succeeded } from "../engine/exec.ts";
import type { Excerpt, LogName } from "../engine/ports.ts";
import type { PersistedHost, PersistedState } from "../model/persist.ts";
import { confine, readableRoots } from "./paths.ts";
import { type ToolContext, ToolError } from "./tools/types.ts";

/** Log of the run holding every AI call, questions and tool calls alike. */
const AI_LOG: LogName = { phase: "ai" };

/** Output of a command handed to a tool: bounded like a log, tail kept. */
function bounded(lines: readonly string[], keep: number): Excerpt {
  const kept = lines.slice(-keep);
  return { lines: [...kept], dropped: lines.length - kept.length };
}

export function toolContext(context: RunContext, state: () => PersistedState): ToolContext {
  const roots = readableRoots(context.workspace);

  const hostOf = (name: string): PersistedHost => {
    const host = state().hosts.find((candidate) => candidate.name === name);
    if (host === undefined) throw new ToolError(`unknown host: ${name}`);
    return host;
  };

  const runOnHost = async (name: string, command: HostCommand): Promise<Excerpt> => {
    const host = hostOf(name);
    const target = { host: host.name, local: host.name === context.local.hostname() };
    const spec = place(target, command, context.params.timeouts);
    const execution = await execute(context, spec, { log: { host: host.name, phase: "ai" } });
    if (!succeeded(execution.result)) {
      throw new ToolError(`${name}: ${describeFailure(execution)}`);
    }
    return bounded(execution.stdout, context.params.ai.logLines);
  };

  return {
    params: context.params,
    codev: context.codev,
    state,
    host: hostOf,
    readLog: (name, lines) => context.run.readLog(name, lines),

    async readSource(path, lines) {
      const target = confine(roots, path);
      if (!target.ok) throw new ToolError(target.error);
      const read = await context.sources.read(target.value, lines);
      if (!read.ok) throw new ToolError(read.error);
      return read.value;
    },

    onHost: runOnHost,

    trace(message) {
      log(context, "info", `AI ${message}`);
      context.run.appendLog(AI_LOG, message);
    },
  };
}
