// Whole runs on the simulated fleet: real options, engine, recorder and folds;
// fake clock, lock, store and commands.
//
// Every run is checked against the invariants below before a test sees it: a
// scenario asserts its outcome, never the bookkeeping shared by all runs.

import { interactively, parseCli, resolveParams, resumeParams } from "../cli/options.ts";
import { RunFlow } from "../engine/flow.ts";
import type { LockHolder } from "../engine/ports.ts";
import { runFleetUpdate } from "../engine/run.ts";
import type { Event, HostState } from "../model/events.ts";
import { ExitCode } from "../model/exit-codes.ts";
import type { RunParams } from "../model/params.ts";
import { type HostStatus, initialPersisted, persist } from "../model/persist.ts";
import { initialState, type RunState, reduce } from "../model/state.ts";
import {
  drive,
  FakeClock,
  FakeLocalHost,
  FakeLock,
  feed,
  MemoryDeploymentStore,
  type MemoryRunStore,
  MemorySources,
  RecordingChannel,
} from "./fakes.ts";
import { ORIGIN_PATH, storePath } from "./fleet.ts";
import { SimFleet, type SimHook, type SimOptions } from "./sim.ts";

/** An answer, or what happens instead while the question stays open (an abort). */
export type Answer = string | ((flow: RunFlow) => void);

export interface RunCase extends Omit<SimOptions, "hooks"> {
  /** Default `--no-ui`. */
  argv?: string[];
  answers?: Record<string, Answer>;

  /** Built once the flow exists: a hook may abort the run. */
  hooks?: (flow: RunFlow) => SimHook[];

  /** Deployment host name; default `deployer`, outside the fleet. */
  hostname?: string;

  /** Default: an address of zone `ag`. */
  addresses?: string[];
  codev?: boolean;

  /** Files the AI may read, by the path its tool asks for. */
  sources?: Record<string, string[]>;

  /** Lock busy at the start: the takeover belongs to the run (spec § Verrou). */
  lock?: { holder: LockHolder; diesOn?: readonly ("SIGTERM" | "SIGKILL")[] };

  /** Fake time moved per idle round. */
  stepMs?: number;

  /**
   * `--resume` of a previous run: its store, simulated fleet and clock carry
   * over, so the new run finds the `state.json` the first one left. Fleet
   * options (`behaviours`, `hooks`) stay those of that run: a behaviour that
   * changes between them is a closure the test flips.
   */
  after?: RunOutcome;
}

export interface RunOutcome {
  exitCode: ExitCode;
  events: Event[];

  /** Undefined when the run was refused before its directory. */
  recorded: MemoryRunStore | undefined;

  /** Every run directory, the resumed ones included. */
  store: MemoryDeploymentStore;
  sim: SimFleet;
  clock: FakeClock;
  flow: RunFlow;

  /** Interface fold of the stream. */
  ui: RunState;
  states: Record<string, HostState>;

  /** `state.json` statuses. */
  statuses: Record<string, HostStatus>;
  feed: string[];
}

export async function simulateRun(runCase: RunCase = {}): Promise<RunOutcome> {
  const cli = parseCli(runCase.argv ?? ["--no-ui"]);
  if (cli.kind !== "run") throw new Error(`argv: ${JSON.stringify(cli)}`);

  const previous = runCase.after;
  const clock = previous?.clock ?? new FakeClock();
  const flow = new RunFlow();
  const sim = previous?.sim ?? new SimFleet(clock, { ...runCase, hooks: runCase.hooks?.(flow) });
  const events = new OpenQuestions(flow, runCase.answers);
  const store = previous?.store ?? new MemoryDeploymentStore();
  const lock = new FakeLock(runCase.lock?.holder, runCase.lock?.diesOn);
  const ports = {
    commands: sim,
    clock,
    events,
    local: new FakeLocalHost(
      runCase.hostname ?? runCase.local ?? "deployer",
      runCase.addresses ?? ["10.1.0.50"],
    ),
    lock,
    store,
    sources: new MemorySources(runCase.sources),
  };
  const request = {
    workspace: "/ws",
    codev: runCase.codev ?? false,
    version: "0.0.0-test",
    interactive: interactively(cli.options),
    resolve: (defaults: Parameters<typeof resolveParams>[1]) =>
      resolveParams(cli.options, defaults),
    resume: cli.options.resume,
    resumeFrom: (saved: RunParams) => resumeParams(saved, cli.options),
  };

  // Directories the previous runs left: this run's own is the next one, and
  // there is none when it was refused before creating it.
  const before = store.runs.length;
  const exitCode = await drive(clock, runFleetUpdate(ports, request, flow), runCase.stepMs ?? 1000);
  const recorded = store.runs[before];
  const stream = events.events;
  const outcome: RunOutcome = {
    exitCode,
    events: stream,
    recorded,
    store,
    sim,
    clock,
    flow,
    ui: stream.reduce(reduce, initialState()),
    states: {},
    statuses: {},
    feed: feed(stream),
  };
  for (const host of recorded?.state?.hosts ?? []) {
    outcome.states[host.name] = host.state;
    outcome.statuses[host.name] = host.status;
  }

  const violations = invariants(outcome, lock);
  if (violations.length > 0) {
    throw new Error(
      `run inconsistent:\n- ${violations.join("\n- ")}\nfeed:\n${outcome.feed.join("\n")}`,
    );
  }
  return outcome;
}

/** A function answer runs, then the question waits for the run to be killed. */
class OpenQuestions extends RecordingChannel {
  constructor(
    private readonly flow: RunFlow,
    private readonly script: Readonly<Record<string, Answer>> = {},
  ) {
    super();
  }

  override answer(id: string, signal?: AbortSignal): Promise<string> {
    const answer = this.script[id];
    if (typeof answer === "string") return Promise.resolve(answer);
    if (answer === undefined) return Promise.reject(new Error(`unanswered question: ${id}`));
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      answer(this.flow);
    });
  }
}

/** Bookkeeping every run must keep, whatever its scenario. */
function invariants(outcome: RunOutcome, lock: FakeLock): string[] {
  const { events, recorded, exitCode, sim, flow, ui } = outcome;
  const violations: string[] = [];
  const check = (holds: boolean, message: string) => {
    if (!holds) violations.push(message);
  };
  const killed = flow.now.aborted;

  const ends = events.filter((event) => event.kind === "run.end");
  const end = events.at(-1);
  check(ends.length === 1, `${ends.length} run.end events`);
  check(end?.kind === "run.end" && end.exitCode === exitCode, "run.end last, with the exit code");
  check(!lock.held, "lock released");

  if (recorded !== undefined) {
    // From `run.start`: what a takeover of the lock said came before the
    // directory existed, so it is in the stream and nowhere else.
    const started = events.slice(events.findIndex((event) => event.kind === "run.start"));
    check(JSON.stringify(recorded.events) === JSON.stringify(started), "events.jsonl = the stream");
    const folded = started.reduce(persist, initialPersisted());
    check(
      JSON.stringify(recorded.state) === JSON.stringify(folded),
      "state.json = fold of the stream",
    );
    const status = end?.kind === "run.end" ? end.status : "none";

    // `report.md` is written before the send: exit `3` is the delivery, not the run.
    const reported = exitCode === ExitCode.ReportNotSent ? ExitCode.Ok : exitCode;
    check(
      recorded.report?.includes(`- Status: ${status} (exit ${reported})`) === true,
      "report.md written with the status",
    );
  }

  // Questions close, unless everything was killed; steps always do.
  if (!killed) {
    for (const event of events) {
      if (event.kind !== "ask") continue;
      const closed = events.some((other) => other.kind === "ask.close" && other.id === event.id);
      check(closed, `question ${event.id} closed`);
    }
  }
  for (const [step, row] of Object.entries(recorded?.state?.steps ?? {})) {
    check(row.status !== "running", `step ${step} ended`);
    check(killed || row.status !== "aborted", `step ${step} aborted without a kill`);
  }
  check(ui.ask === undefined && ui.end !== undefined, "interface: ended, no question left");
  for (const host of recorded?.state?.hosts ?? []) {
    const shown = ui.hosts.find((row) => row.name === host.name);
    check(
      shown?.state === host.state && shown.online === host.online,
      `${host.name}: interface and state.json agree`,
    );
  }

  // Alert silencing always lifted.
  for (const name of sim.hosts.keys()) {
    const maintenance = sim.commands.filter((c) => c.kind === "maintenance" && c.host === name);
    if (maintenance.length === 0) continue;
    check(maintenance.at(-1)?.detail === "off", `${name}: dnf-maintenance off last`);
  }

  // What the engine believes matches the host; killed commands left it unknown.
  for (const host of killed ? [] : (recorded?.state?.hosts ?? [])) {
    const side = sim.hosts.get(host.name);
    if (side === undefined) continue;
    const target = storePath(host.name);
    switch (host.state) {
      case "deployed":
        check(side.system === target && side.profile === target, `${host.name}: deployed`);
        check(side.timers.size === 0, `${host.name}: deployed, no rollback timer left`);
        break;
      case "tested":
      case "error":
        check(side.system === target, `${host.name}: runs the new system`);
        check(side.timers.size === 0, `${host.name}: settled, no rollback timer left`);
        break;
      case "reverted":
        check(side.system === ORIGIN_PATH, `${host.name}: back to its origin`);
        break;
      case "pending":
      case "building":
      case "built":
        check(
          side.system === ORIGIN_PATH && !side.history.some((line) => /^(test|switch) /.test(line)),
          `${host.name}: never activated`,
        );
        break;
      default:
        break;
    }
  }
  return violations;
}
