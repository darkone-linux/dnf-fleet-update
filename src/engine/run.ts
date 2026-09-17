// Run orchestration (spec § Étapes): lock, parameters, prerequisites, the
// steps in order, early ends, report, exit code.

import { ExitCode } from "../model/exit-codes.ts";
import { DEFAULT_TIMEOUTS, type RunParams, runMode } from "../model/params.ts";
import type { Result } from "../model/result.ts";
import { gitStatus, readGenerated } from "./commands/workspace.ts";
import { type EventInput, emit, log, QuestionQueue, type RunContext } from "./context.ts";
import { describeFailure, execute, succeeded } from "./exec.ts";
import { type FleetDefaults, parseNetwork } from "./fleet.ts";
import type { RunFlow } from "./flow.ts";
import { HostTable } from "./hosts.ts";
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
import { renderReport } from "./report.ts";
import { rollbackFleet } from "./rollback.ts";
import { build } from "./steps/build.ts";
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

  /** Options resolved against `network.fleetUpdate` (exit `2` on failure). */
  resolve: (defaults: FleetDefaults) => Result<RunParams>;
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
  if (goOn() && !(await update(context))) progress.failed = !context.signal.aborted;
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
    if (goOn()) await testWaves(context, hosts, presence, selection);
    if (goOn()) await switchWaves(context, hosts, presence, selection);
  } finally {
    await presence.stop();
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

  const lock = ports.lock.acquire();
  if (lock.kind === "busy") {
    const holder = lock.holder === "" ? "" : `: ${lock.holder}`;
    return refuse(`another fleet-update run holds the lock${holder}`, ExitCode.Locked);
  }

  try {
    const defaults = await fleetDefaults(ports, request.workspace, flow.now);
    if (flow.now.aborted) {
      early(ports, startedAt, { kind: "run.end", status: "aborted", exitCode: ExitCode.Aborted });
      return ExitCode.Aborted;
    }
    if (!defaults.ok) return refuse(defaults.error, ExitCode.Failed);
    const params = request.resolve(defaults.value);
    if (!params.ok) return refuse(params.error, ExitCode.InvalidOptions);

    const mode = runMode(params.value);
    const run = ports.store.create(mode);
    const recorder = new Recorder(run);
    const context: RunContext = {
      commands: ports.commands,
      clock: ports.clock,
      events: recordedChannel(ports.events, recorder),
      signal: flow.now,
      flow,
      params: params.value,
      workspace: request.workspace,
      codev: request.codev,
      local: ports.local,
      run,
      questions: new QuestionQueue(),
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
    }

    const stopped = progress.failed || flow.ending === "stop" || flow.ending === "rollback";
    const aborted = flow.ending === "aborted" || flow.now.aborted;
    const status = stopped ? "failed" : aborted ? "aborted" : "done";
    const exitCode = stopped ? ExitCode.Failed : aborted ? ExitCode.Aborted : ExitCode.Ok;

    emit(context, { kind: "step.start", step: "report" });
    const report = renderReport({
      state: recorder.state,
      status,
      exitCode,
      durationMs: ports.clock.now() - startedAt,
      warnings: progress.warnings,
    });
    run.writeReport(report.markdown);
    emit(context, { kind: "step.end", step: "report", status: "ok" });
    emit(context, { kind: "run.end", status, exitCode, report: report.lines });
    return exitCode;
  } finally {
    ports.lock.release();
  }
}
