// Decisions on failed and lost hosts (spec § Erreurs et réparations).
//
// Interactive: asked, one question at a time, hosts failed for the same reason
// together. Otherwise `exclude`, `revert` for an activated host, or `rollback`
// under `--stop-loss`. Once the run halts, nothing more is asked.

import type { AskOption, Level } from "../model/events.ts";
import { askHoldingQueue, log, type RunContext } from "./context.ts";
import { type HostEntry, type HostTable, rollbackTarget } from "./hosts.ts";

/** `revert` is carried out by the caller, outside the question queue. */
export type Decision = "exclude" | "revert" | "keep" | "stop" | "rollback";

/**
 * Decision a recognised trap takes by itself (spec § Erreurs et réparations),
 * question or not: a deterministic answer comes before asking. `goOn` is what
 * losing this host alone means here — `revert` once it was activated.
 * `undefined`: nothing decided — `retry` is spent, `ai` belongs to the AI.
 */
function byTable(host: HostEntry, goOn: Decision): Decision | undefined {
  const fix = host.knownError?.fix;
  switch (fix?.kind) {
    case "exclude":
      return goOn;
    case "stop":
      return "stop";
    default:
      return undefined;
  }
}

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

/** At least one host: several share the reason of the first. */
export type Hosts = readonly [string, ...string[]];

function apply(context: RunContext, hosts: HostTable, names: Hosts, decision: Decision): void {
  const say = (level: Level, message: string) => {
    if (names.length === 1) log(context, level, message, names[0]);
    else log(context, level, `${message}: ${names.join(", ")}`);
  };
  switch (decision) {
    case "exclude":
    case "keep":
      for (const name of names) hosts.set(name, "excluded", { note: hosts.get(name).note });
      say("warn", decision === "keep" ? "excluded, left as it is" : "excluded");
      return;
    case "revert":
      say("warn", "reverting to its origin");
      return;
    case "stop":
    case "rollback":
      context.flow.stop(decision);
      say("error", decision === "stop" ? "run stopped" : "fleet rollback");
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
  names: Hosts,
  question: { id: string; text: string; options: readonly AskOption[] },
  unattended: Decision,

  /** Taken without asking, interactive or not: the table already knows. */
  forced?: Decision,
  before?: () => Promise<void>,
): Promise<Decision | undefined> {
  return context.questions.run(async () => {
    if (context.flow.halt.aborted) return undefined;
    await before?.();

    // Hosts change while the question waits its turn: offered options read now.
    const rollback = hosts.all().some(rollbackTarget);
    const options = question.options.filter((option) => rollback || option.value !== "rollback");

    if (forced !== undefined) {
      log(context, "warn", `known error decides: ${forced}`);
      apply(context, hosts, names, forced);
      return forced;
    }

    const decision = !context.params.interactive
      ? unattended
      : options.length === 1
        ? (options[0]!.value as Decision)
        : ((await askHoldingQueue(context, question.id, question.text, options)) as Decision);
    apply(context, hosts, names, decision);
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
  names: Hosts,
): Promise<Decision | undefined> {
  const [first] = names;
  const { note, activated } = hosts.get(first);
  const reason = note === undefined ? "" : `: ${note}`;
  const text =
    names.length === 1
      ? `${first} failed${reason}`
      : `${names.length} hosts failed${reason} (${names.join(", ")})`;
  const options = activated === undefined ? OPTIONS : ACTIVATED_OPTIONS;
  const goOn: Decision = activated === undefined ? "exclude" : "revert";
  const unattended = context.params.stopLoss ? "rollback" : goOn;
  const id = `failed-${names.join("+")}`;
  const forced = byTable(hosts.get(first), goOn);
  return decide(context, hosts, names, { id, text, options }, unattended, forced);
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
    // No table decision on a lost host: nothing of its own was read.
    return decide(
      context,
      hosts,
      [name],
      { id: `lost-${name}`, text, options: OPTIONS },
      unattended,
    );
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
    [name],
    { id: `lost-${name}`, text, options },
    unattended,
    undefined,
    waitRollback,
  );
}
