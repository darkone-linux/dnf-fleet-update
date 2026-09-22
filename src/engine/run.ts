// Run orchestration (spec § Étapes): lock, parameters, prerequisites, the
// steps in order, early ends, report, exit code.

import type { Event } from "../model/events.ts";
import { ExitCode } from "../model/exit-codes.ts";
import { DEFAULT_TIMEOUTS, type RunParams, runMode } from "../model/params.ts";
import { fail, ok, type Result } from "../model/result.ts";
import { gitStatus, readGenerated } from "./commands/workspace.ts";
import { AiGate, type EventInput, emit, log, QuestionQueue, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import { type FleetDefaults, parseNetwork } from "./fleet.ts";
import type { RunFlow } from "./flow.ts";
import { HostTable } from "./hosts.ts";
import { KnownErrors } from "./known-errors.ts";
import { takeLock } from "./lock.ts";
import type {
  Clock,
  CommandRunner,
  DeploymentStore,
  EventChannel,
  LocalHost,
  RunLock,
} from "./ports.ts";
import { Presence } from "./presence.ts";
import { Recorder, recordedChannel } from "./recorder.ts";
import { parseSavedState, type SavedState } from "./resume.ts";
import { rollbackFleet } from "./rollback.ts";
import { build, clearBuildLinks } from "./steps/build.ts";
import { publish } from "./steps/publish.ts";
import { report } from "./steps/report.ts";
import { select } from "./steps/select.ts";
import { update } from "./steps/update.ts";
import { switchWaves, testWaves } from "./steps/waves.ts";

export interface RunPorts {
  commands: CommandRunner;
  clock: Clock;
  events: EventChannel;
  local: LocalHost;
  lock: RunLock;
  store: DeploymentStore;
}

export interface RunRequest {
  /** Consumer root, also the working directory. */
  workspace: string;
  codev: boolean;
  version: string;

  /** Decided by `--no-ui` and `--non-interactive`, before the parameters exist. */
  interactive: boolean;

  /** Options resolved against `network.fleetUpdate` (exit `2` on failure). */
  resolve: (defaults: FleetDefaults) => Result<RunParams>;

  /** `--resume` asked for; taking the lock from a holder may add it. */
  resume: boolean;

  /**
   * The saved parameters, overridden by the options a resume accepts
   * (spec § État et reprise).
   */
  resumeFrom: (saved: RunParams) => Result<{ params: RunParams; filter?: string }>;
}

/** Last error of the feed: what ended the run, title of the incidents message. */
class ErrorTrail implements EventChannel {
  last: string | undefined;

  constructor(private readonly inner: EventChannel) {}

  emit(event: Event): void {
    if (event.kind === "log" && event.level === "error") {
      this.last = event.host === undefined ? event.message : `${event.host}: ${event.message}`;
    }
    this.inner.emit(event);
  }

  answer(id: string, signal?: AbortSignal): Promise<string> {
    return this.inner.answer(id, signal);
  }
}

/** Last run read and validated, or the reason to refuse the resume (exit `2`). */
function lastRun(ports: RunPorts): Result<SavedState> {
  const last = ports.store.last();
  if (last === undefined) return fail("no deployment to resume");
  if (last.state === undefined) return fail(`${last.id}: no state.json to resume from`);
  const parsed = parseSavedState(last.id, last.state);
  if (!parsed.ok) return fail(`${last.id}: ${parsed.error}`);
  if (parsed.value.hosts.length === 0)
    return fail(`${last.id}: no unfinished deployment to resume`);
  return parsed;
}

/** Before the run directory exists: to the consumers only, nothing recorded. */
function early(ports: RunPorts, startedAt: number, event: EventInput): void {
  ports.events.emit({ ...event, t: Math.round(ports.clock.now() - startedAt) });
}

/** Declared before the update: the parameters hold for the whole run. */
async function fleetDefaults(
  ports: RunPorts,
  workspace: string,
  signal: AbortSignal,
): Promise<Result<FleetDefaults>> {
  const spec = readGenerated(workspace, "network.nix", DEFAULT_TIMEOUTS);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await ports.commands.run(spec, {
    signal,
    onLine: (line) => (line.stream === "stdout" ? stdout : stderr).push(line.line),
  });
  if (!succeeded(result)) {
    return { ok: false, error: `network.nix: ${describeFailure({ result, stdout, stderr })}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout.join("\n"));
  } catch {
    return { ok: false, error: "network.nix: not JSON" };
  }
  const network = parseNetwork(json);
  return network.ok ? { ok: true, value: network.value.defaults } : network;
}

/** Consumer, and `dnf/` in codev: only the update may land in the commits. */
async function cleanTrees(context: RunContext): Promise<boolean> {
  const repos = [{ name: "consumer", directory: context.workspace }];
  if (context.codev) repos.push({ name: "dnf/", directory: `${context.workspace}/dnf` });

  for (const { name, directory } of repos) {
    const status = await execute(context, gitStatus(directory, context.params.timeouts));
    if (!succeeded(status.result)) {
      log(context, "error", `git status ${name} failed: ${describeFailure(status)}`);
      return false;
    }
    const changes = status.stdout.filter((line) => line.trim() !== "");
    if (changes.length > 0) {
      log(context, "error", `${name}: uncommitted changes (${changes.length}), commit them first`);
      return false;
    }
  }
  return true;
}

interface Progress {
  failed: boolean;
  hosts?: HostTable;
  warnings: readonly string[];
}

async function steps(context: RunContext, progress: Progress) {
  const { flow } = context;
  const goOn = () => !progress.failed && flow.ending === undefined && !context.signal.aborted;

  if (!(await cleanTrees(context))) progress.failed = true;
  if (goOn() && !context.params.resume && !(await update(context))) {
    progress.failed = !context.signal.aborted;
  }
  if (!goOn()) return;

  const selection = await select(context);
  if (selection === undefined) {
    progress.failed = !context.signal.aborted;
    return;
  }
  if (!goOn()) return;

  const hosts = new HostTable(context, selection);
  progress.hosts = hosts;
  const presence = new Presence(context, hosts);
  try {
    const built = await build(context, hosts, presence);
    progress.warnings = built?.warnings ?? [];
    // No `--build-only` guard: the build ended the flow, and a `yes` taking it
    // back takes back the publication with it.
    if (goOn()) await publish(context, hosts, presence);
    if (goOn() && !context.params.skipTest) await testWaves(context, hosts, presence, selection);
    if (goOn() && !context.params.skipSwitch)
      await switchWaves(context, hosts, presence, selection);
  } finally {
    await presence.stop();

    // Roots the builders took for this run, dropped whatever ended it.
    if (!context.signal.aborted) await clearBuildLinks(context, hosts);
  }
  if (flow.ending === "rollback" && !context.signal.aborted) {
    await rollbackFleet(context, hosts, selection);
  }
}

/**
 * Whole run. Resolves with the exit code once `run.end` is emitted; rejects
 * only when the run directory cannot be written.
 */
export async function runFleetUpdate(
  ports: RunPorts,
  request: RunRequest,
  flow: RunFlow,
): Promise<ExitCode> {
  const startedAt = ports.clock.now();
  const refuse = (message: string, exitCode: ExitCode) => {
    early(ports, startedAt, { kind: "log", level: "error", message });
    early(ports, startedAt, { kind: "run.end", status: "failed", exitCode });
    return exitCode;
  };

  // Interactive takeover of a busy lock (spec § Verrou): its refusals and its
  // questions are already in the stream, only the end of the run is left.
  const taken = await takeLock({
    lock: ports.lock,
    events: ports.events,
    clock: ports.clock,
    startedAt,
    interactive: request.interactive,
    signal: flow.now,
    canResume: () => !request.resume && lastRun(ports).ok,
  });
  if (taken.kind === "busy") {
    early(ports, startedAt, { kind: "run.end", status: "failed", exitCode: ExitCode.Locked });
    return ExitCode.Locked;
  }

  try {
    if (taken.kind === "aborted") {
      early(ports, startedAt, { kind: "run.end", status: "aborted", exitCode: ExitCode.Aborted });
      return ExitCode.Aborted;
    }
    const resume = request.resume || taken.resume;

    // `--resume` takes its parameters from the saved run, so `network.nix` is
    // not read again: the resumed run keeps the settings it started with.
    let saved: SavedState | undefined;
    let filter: string | undefined;
    let params: Result<RunParams>;
    if (!resume) {
      const defaults = await fleetDefaults(ports, request.workspace, flow.now);
      if (flow.now.aborted) {
        early(ports, startedAt, { kind: "run.end", status: "aborted", exitCode: ExitCode.Aborted });
        return ExitCode.Aborted;
      }
      if (!defaults.ok) return refuse(defaults.error, ExitCode.Failed);
      params = request.resolve(defaults.value);
    } else {
      const last = lastRun(ports);
      if (!last.ok) return refuse(last.error, ExitCode.InvalidOptions);
      saved = last.value;
      const resumed = request.resumeFrom(saved.params);
      params = resumed.ok ? ok(resumed.value.params) : resumed;
      filter = resumed.ok ? resumed.value.filter : undefined;
    }
    if (!params.ok) return refuse(params.error, ExitCode.InvalidOptions);

    const mode = runMode(params.value);
    const run = ports.store.create(mode);
    const recorder = new Recorder(run);
    const errors = new ErrorTrail(recordedChannel(ports.events, recorder));
    const context: RunContext = {
      commands: ports.commands,
      clock: ports.clock,
      events: errors,
      signal: flow.now,
      flow,
      params: params.value,
      ...(saved === undefined
        ? {}
        : { resume: { saved, ...(filter === undefined ? {} : { filter }) } }),
      workspace: request.workspace,
      codev: request.codev,
      local: ports.local,
      run,
      questions: new QuestionQueue(),
      known: new KnownErrors(),
      ai: new AiGate(),
      startedAt,
    };
    emit(context, {
      kind: "run.start",
      run: {
        version: request.version,
        selection: params.value.on ?? "all",
        mode,
        codev: request.codev,
        aiModel: params.value.aiModel,
        maxParallel: params.value.maxParallel,
        params: params.value,
      },
    });

    // `--resume`: the update belongs to the run being picked up.
    if (params.value.resume) {
      emit(context, { kind: "step.end", step: "update", status: "skipped" });
    }

    // Steps that will not run, said before the build starts. Only `--build-only`
    // can be taken back, by a `yes` to the question that follows the build.
    const { buildOnly, skipTest, skipSwitch } = params.value;
    const omitted = {
      publish: buildOnly,
      test: buildOnly || skipTest,
      switch: buildOnly || skipSwitch,
    };
    for (const step of ["publish", "test", "switch"] as const) {
      if (omitted[step]) emit(context, { kind: "step.end", step, status: "omitted" });
    }

    // `^C`, a signal or a `no` answer: said before the commands are killed.
    const leaveAborts = flow.onAbort((mode) => {
      const message = mode === "now" ? "aborting now" : "aborting after the current step or wave";
      log(context, "warn", message);
    });
    const progress: Progress = { failed: false, warnings: [] };
    try {
      await steps(context, progress);
    } catch (error) {
      // Aborted `now`: a command refused to start, not a bug.
      if (!flow.now.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        log(context, "error", `internal error: ${message}`);
        progress.failed = true;
      }
    } finally {
      leaveAborts();
    }

    // Cut by `now`, or by an internal error: the step never ended on its own.
    const cut = recorder.state.currentStep;
    if (cut !== undefined && recorder.state.steps[cut].status === "running") {
      const status = flow.now.aborted ? "aborted" : "error";
      emit(context, { kind: "step.end", step: cut, status });
    }

    const stopped = progress.failed || flow.ending === "stop" || flow.ending === "rollback";
    const aborted = flow.ending === "aborted" || flow.now.aborted;
    const status = stopped ? "failed" : aborted ? "aborted" : "done";
    const exitCode = stopped ? ExitCode.Failed : aborted ? ExitCode.Aborted : ExitCode.Ok;

    const rendered = await report(
      context,
      {
        runId: run.id,
        state: recorder.state,
        status,
        exitCode,
        durationMs: ports.clock.now() - startedAt,
        warnings: progress.warnings,
        knownErrors: context.known.all(),
        zonesWithoutCache: progress.hosts?.zonesWithoutCache() ?? [],
      },
      errors.last,
    );

    // Run finished, report not delivered: exit `3`. A worse code keeps its say.
    const code = rendered.sent || exitCode !== ExitCode.Ok ? exitCode : ExitCode.ReportNotSent;
    emit(context, { kind: "run.end", status, exitCode: code, report: rendered.lines });
    return code;
  } finally {
    ports.lock.release();
  }
}
