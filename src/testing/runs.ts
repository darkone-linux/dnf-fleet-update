// Whole runs on the simulated fleet: real options, engine, recorder and folds;
// fake clock, lock, store and commands.
//
// Every run is checked against the invariants below before a test sees it: a
// scenario asserts its outcome, never the bookkeeping shared by all runs.

import { parseCli, resolveParams } from "../cli/options.ts";
import { RunFlow } from "../engine/flow.ts";
import { runFleetUpdate } from "../engine/run.ts";
import type { Event, HostState } from "../model/events.ts";
import type { ExitCode } from "../model/exit-codes.ts";
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
  RecordingChannel,
} from "./fakes.ts";
import { ORIGIN_PATH, storePath } from "./fleet.ts";
import { SimFleet, type SimHook, type SimOptions } from "./sim.ts";

export interface RunCase extends Omit<SimOptions, "hooks"> {
  /** Default `--no-ui`. */
  argv?: string[];
  answers?: Record<string, string>;

  /** Built once the flow exists: a hook may abort the run. */
  hooks?: (flow: RunFlow) => SimHook[];

  /** Deployment host name; default `deployer`, outside the fleet. */
  hostname?: string;

  /** Default: an address of zone `ag`. */
  addresses?: string[];

  /** Fake time moved per idle round. */
  stepMs?: number;
}

export interface RunOutcome {
  exitCode: ExitCode;
  events: Event[];

  /** Undefined when the run was refused before its directory. */
  recorded: MemoryRunStore | undefined;
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

  const clock = new FakeClock();
  const flow = new RunFlow();
  const sim = new SimFleet(clock, { ...runCase, hooks: runCase.hooks?.(flow) });
  const events = new RecordingChannel(runCase.answers);
  const store = new MemoryDeploymentStore();
  const lock = new FakeLock();
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
  };
  const request = {
    workspace: "/ws",
    codev: runCase.codev ?? false,
    version: "0.0.0-test",
    resolve: (defaults: Parameters<typeof resolveParams>[1]) =>
      resolveParams(cli.options, defaults),
  };

  const exitCode = await drive(clock, runFleetUpdate(ports, request, flow), runCase.stepMs ?? 1000);
  const recorded = store.runs[0];
  const stream = events.events;
  const outcome: RunOutcome = {
    exitCode,
    events: stream,
    recorded,
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
    check(JSON.stringify(recorded.events) === JSON.stringify(events), "events.jsonl = the stream");
    const folded = events.reduce(persist, initialPersisted());
    check(
      JSON.stringify(recorded.state) === JSON.stringify(folded),
      "state.json = fold of the stream",
    );
    const status = end?.kind === "run.end" ? end.status : "none";
    check(
      recorded.report?.includes(`- Status: ${status} (exit ${exitCode})`) === true,
      "report.md written with the status",
    );
  }

  // Questions and steps close, unless everything was killed.
  if (!killed) {
    for (const event of events) {
      if (event.kind !== "ask") continue;
      const closed = events.some((other) => other.kind === "ask.close" && other.id === event.id);
      check(closed, `question ${event.id} closed`);
    }
    for (const [step, row] of Object.entries(recorded?.state?.steps ?? {})) {
      check(row.status !== "running", `step ${step} ended`);
    }
  }
  check(ui.ask === undefined && ui.end !== undefined, "interface: ended, no question left");

  // Alert silencing always lifted.
  for (const name of sim.hosts.keys()) {
    const maintenance = sim.commands.filter((c) => c.kind === "maintenance" && c.host === name);
    if (maintenance.length === 0) continue;
    check(maintenance.at(-1)?.detail === "off", `${name}: dnf-maintenance off last`);
  }

  // What the engine believes matches the host.
  for (const host of recorded?.state?.hosts ?? []) {
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
