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

function decide(
  context: RunContext,
  hosts: HostTable,
  name: string,
  question: { id: string; text: string; options: readonly AskOption[] },
  unattended: Decision,
  before?: () => Promise<void>,
): Promise<Decision | undefined> {
  return context.questions.run(async () => {
    if (context.flow.halt.aborted) return undefined;
    await before?.();
    const decision = context.params.interactive
      ? ((await askHoldingQueue(context, question.id, question.text, question.options)) as Decision)
      : unattended;
    apply(context, hosts, name, decision);
    return decision;
  });
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
  const note = hosts.get(name).note;
  const text = `${name} failed${note === undefined ? "" : `: ${note}`}`;
  const unattended = context.params.stopLoss ? "rollback" : "exclude";
  return decide(context, hosts, name, { id: `failed-${name}`, text, options: OPTIONS }, unattended);
}

/**
 * Host unreachable after its wave started. Gateway guard: its automatic
 * rollback waited for when a timer is about to fire, then `stop` or
 * `rollback`, never `exclude`.
 */
export function decideLost(
  context: RunContext,
  hosts: HostTable,
  name: string,
  rollbackPending: boolean,
): Promise<Decision | undefined> {
  const { params } = context;
  const text = `${name} unreachable`;
  if (!hosts.get(name).gateway) {
    const unattended = params.stopLoss ? "rollback" : "exclude";
    return decide(context, hosts, name, { id: `lost-${name}`, text, options: OPTIONS }, unattended);
  }

  const options = OPTIONS.filter((option) => option.value !== "exclude");
  const waitRollback = async () => {
    if (!rollbackPending) return;
    log(context, "warn", "gateway lost: waiting for its automatic rollback", name);

    // Attempts stopped `ssh` seconds before the timer; the rollback takes up to `activation`.
    const { ssh, activation } = params.timeouts;
    await context.clock.sleep((ssh + activation) * 1000, context.signal);
  };
  const unattended = params.stopLoss ? "rollback" : "stop";
  return decide(
    context,
    hosts,
    name,
    { id: `lost-${name}`, text, options },
    unattended,
    waitRollback,
  );
}
