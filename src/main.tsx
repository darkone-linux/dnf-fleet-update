// Entry point and composition root: options, real ports, the engine bound to
// the interface or, under `--no-ui`, to the text output.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { z } from "zod";
import { LiveChannel } from "./adapters/channel.ts";
import { SystemClock } from "./adapters/clock.ts";
import { SystemHost } from "./adapters/localhost.ts";
import { FlockLock } from "./adapters/lock.ts";
import { LoopbackToolServer } from "./adapters/mcp.ts";
import { ProcessRunner } from "./adapters/process.ts";
import { DirectorySources } from "./adapters/sources.ts";
import { DirectoryStore } from "./adapters/store.ts";
import { DirectorySuggestions } from "./adapters/suggestions.ts";
import { readableRoots, unwalked } from "./ai/paths.ts";
import { SUGGESTIONS_DIR } from "./ai/suggestions.ts";
import { HELP } from "./cli/help.ts";
import {
  AI_CONTEXT_FILE,
  hostAiContext,
  interactively,
  parseCli,
  resolveParams,
  resumeParams,
} from "./cli/options.ts";
import { RunFlow } from "./engine/flow.ts";
import { type RunPorts, type RunRequest, runFleetUpdate } from "./engine/run.ts";
import type { RunControl, RunSource } from "./model/events.ts";
import { ExitCode } from "./model/exit-codes.ts";
import type { RunParams } from "./model/params.ts";
import { textLines } from "./output/text.ts";
import { App } from "./ui/App.tsx";

// Set once the run has its directory: printed last, so the path is at hand
// when the interface closes.
let runDirectory: string | undefined;

function leave(code: number): never {
  if (runDirectory !== undefined) console.log(`report and logs: ${runDirectory}`);
  process.exit(code);
}

/** `undefined` when the file is absent or unreadable: a default, never a failure. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function exitWith(message: string, code: ExitCode): never {
  console.error(`fleet-update: ${message}`);
  return leave(code);
}

// Packaged next to `src/`: resolved from this file, never from the cwd.
const packageJson: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const { version } = z.object({ version: z.string() }).parse(packageJson);

const command = parseCli(process.argv.slice(2));
if (command.kind === "help") {
  console.log(HELP);
  process.exit(ExitCode.Ok);
}
if (command.kind === "version") {
  console.log(version);
  process.exit(ExitCode.Ok);
}
if (command.kind === "invalid") exitWith(`${command.error} (see --help)`, ExitCode.InvalidOptions);
const { options } = command;

// Workspace = cwd: the recipe and the systemd unit start in the consumer root.
const workspace = process.cwd();
const deployments = join(workspace, "var", "deployments");
const channel = new LiveChannel();
const flow = new RunFlow();
const store = new DirectoryStore(deployments);
const ports: RunPorts = {
  commands: new ProcessRunner(),
  clock: new SystemClock(),
  events: channel,
  local: new SystemHost(),
  lock: new FlockLock(join(deployments, "current.lock")),

  // `dnf/` too: a store path outside codev, readable either way.
  sources: new DirectorySources(readableRoots(workspace), unwalked),
  suggestions: new DirectorySuggestions(join(workspace, SUGGESTIONS_DIR)),
  toolServer: new LoopbackToolServer(),
  store: {
    create: (mode) => {
      const run = store.create(mode);
      runDirectory = join(deployments, run.id);
      return run;
    },
    last: () => store.last(),
  },
};
// Interactive or unattended alike; `--resume` keeps its saved context instead.
const host = { aiContext: hostAiContext(readIfPresent(AI_CONTEXT_FILE)) };
const request: RunRequest = {
  workspace,
  codev: existsSync(join(workspace, "dnf", ".git")),
  version,
  interactive: interactively(options),
  resolve: (defaults) => resolveParams(options, defaults, host),
  resume: options.resume,

  // Resuming: the saved parameters lead, the options this run accepts override.
  resumeFrom: (saved: RunParams) => resumeParams(saved, options),
};

// SIGTERM (unit stop or timeout), SIGINT (`^C` under `--no-ui`), SIGHUP
// (terminal gone): abort now, exit once the run has ended.
let signalled = false;
let ended: ExitCode | undefined;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (ended !== undefined) process.exit(ended);
    signalled = true;
    flow.abort("now");
  });
}

const crash = (error: unknown): never =>
  exitWith(error instanceof Error ? error.message : String(error), ExitCode.Failed);

if (options.noUi) {
  channel.subscribe((event) => {
    for (const line of textLines(event)) console.log(line);
  });
  const exitCode = await runFleetUpdate(ports, request, flow).catch(crash);
  leave(exitCode);
}

// `^C` is the abort dialog, not an exit: the interface owns the shutdown path.
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
const control: RunControl = {
  respond: (value) => channel.respond(value),
  abort: (mode) => flow.abort(mode),
  ping: () => flow.requestPing(),
  askAi: (question) => flow.requestAi(question),
};

// Module scope: a stable identity, so the interface starts the run once.
const source: RunSource = (emit) => {
  channel.subscribe(emit);
  runFleetUpdate(ports, request, flow).then(
    (exitCode) => {
      ended = exitCode;

      // A signal destroyed the renderer: nobody is left to press `q`.
      if (!signalled) return;
      renderer.destroy();
      leave(exitCode);
    },
    (error: unknown) => {
      renderer.destroy();
      crash(error);
    },
  );
  return control;
};

// `onQuit`: the path is printed after the interface has released the terminal.
createRoot(renderer).render(
  <App
    source={source}
    onQuit={(exitCode) => {
      renderer.destroy();
      leave(exitCode);
    }}
  />,
);
