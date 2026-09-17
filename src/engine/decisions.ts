// Decisions on failed and lost hosts (spec § Erreurs et réparations).
//
// Interactive: asked, one host at a time. Otherwise `exclude`, or `rollback`
// under `--stop-loss`. Once the run halts, nothing more is asked.

import type { AskOption } from "../model/events.ts";
import { askHoldingQueue, log, type RunContext } from "./context.ts";
import type { HostTable } from "./hosts.ts";

export type Decision = "exclude" | "stop" | "rollback";

const OPTIONS: readonly AskOption[] = [
  { value: "exclude", label: "exclude", description: "go on without this host" },
  { value: "stop", label: "stop", description: "start nothing more, leave hosts as they are" },
  { value: "rollback", label: "rollback", description: "stop, then bring activated hosts back" },
];

function apply(context: RunContext, hosts: HostTable, name: string, decision: Decision): void {
  switch (decision) {
    case "exclude":
      hosts.set(name, "excluded", { note: hosts.get(name).note });
      log(context, "warn", "excluded", name);
      return;
    case "stop":
    case "rollback":
      context.flow.stop(decision);
      log(context, "error", decision === "stop" ? "run stopped" : "fleet rollback", name);
      return;
  }
}

/**
 * Host `failed` and still reachable: the rules of a lost host, without the
 * gateway guard. `undefined`: the run already halted, nothing decided.
 */
export function decideFailure(
  context: RunContext,
  hosts: HostTable,
  name: string,
): Promise<Decision | undefined> {
  return context.questions.run(async () => {
    if (context.flow.halt.aborted) return undefined;
    const { params } = context;
    const note = hosts.get(name).note;
    const decision = params.interactive
      ? ((await askHoldingQueue(
          context,
          `failed-${name}`,
          `${name} failed${note === undefined ? "" : `: ${note}`}`,
          OPTIONS,
        )) as Decision)
      : params.stopLoss
        ? "rollback"
        : "exclude";
    apply(context, hosts, name, decision);
    return decision;
  });
}
