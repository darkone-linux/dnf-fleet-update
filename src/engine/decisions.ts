// Decisions on failed and lost hosts (spec § Erreurs et réparations).
//
// Interactive: asked, one host at a time. Otherwise `exclude`, `revert` for an
// activated host, or `rollback` under `--stop-loss`. Once the run halts,
// nothing more is asked.

import type { AskOption } from "../model/events.ts";
import { askHoldingQueue, log, type RunContext } from "./context.ts";
import { type HostTable, rollbackTarget } from "./hosts.ts";

/** `revert` is carried out by the caller, outside the question queue. */
export type Decision = "exclude" | "revert" | "keep" | "stop" | "rollback";

const STOP: readonly AskOption[] = [
  { value: "stop", label: "stop", description: "start nothing more, leave hosts as they are" },
  { value: "rollback", label: "rollback", description: "stop, then bring activated hosts back" },
];

const OPTIONS: readonly AskOption[] = [
  { value: "exclude", label: "exclude", description: "go on without this host" },
  ...STOP,
];

/** Activated host still reachable: back to its origin, or kept as it is for inspection. */
const ACTIVATED_OPTIONS: readonly AskOption[] = [
  { value: "revert", label: "revert", description: "back to its origin, go on without it" },
  { value: "keep", label: "keep", description: "leave it as it is, go on without it" },
  ...STOP,
];

function apply(context: RunContext, hosts: HostTable, name: string, decision: Decision): void {
  switch (decision) {
    case "exclude":
    case "keep":
      hosts.set(name, "excluded", { note: hosts.get(name).note });
      log(context, "warn", decision === "keep" ? "excluded, left as it is" : "excluded", name);
      return;
    case "revert":
      log(context, "warn", "reverting to its origin", name);
      return;
    case "stop":
    case "rollback":
      context.flow.stop(decision);
      log(context, "error", decision === "stop" ? "run stopped" : "fleet rollback", name);
      return;
  }
}

/**
 * `rollback` offered only when a host can be brought back: otherwise it is a
 * `stop`. A single option left is applied without a question.
 */
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

    // Hosts change while the question waits its turn: offered options read now.
    const rollback = hosts.all().some(rollbackTarget);
    const options = question.options.filter((option) => rollback || option.value !== "rollback");
    const decision = !context.params.interactive
      ? unattended
      : options.length === 1
        ? (options[0]!.value as Decision)
        : ((await askHoldingQueue(context, question.id, question.text, options)) as Decision);
    apply(context, hosts, name, decision);
    return decision;
  });
}

/**
 * Host `failed` and still reachable: the rules of a lost host, without the
 * gateway guard; once activated, `revert` instead of `exclude`. `undefined`:
 * the run already halted, nothing decided.
 */
export function decideFailure(
  context: RunContext,
  hosts: HostTable,
  name: string,
): Promise<Decision | undefined> {
  const { note, activated } = hosts.get(name);
  const text = `${name} failed${note === undefined ? "" : `: ${note}`}`;
  const options = activated === undefined ? OPTIONS : ACTIVATED_OPTIONS;
  const goOn = activated === undefined ? "exclude" : "revert";
  const unattended = context.params.stopLoss ? "rollback" : goOn;
  return decide(context, hosts, name, { id: `failed-${name}`, text, options }, unattended);
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

  const options = STOP;
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
