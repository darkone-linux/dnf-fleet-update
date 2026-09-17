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
import { ProcessRunner } from "./adapters/process.ts";
import { DirectoryStore } from "./adapters/store.ts";
import { HELP } from "./cli/help.ts";
import { parseCli, resolveParams } from "./cli/options.ts";
import { RunFlow } from "./engine/flow.ts";
import { type RunPorts, type RunRequest, runFleetUpdate } from "./engine/run.ts";
import type { RunControl, RunSource } from "./model/events.ts";
import { ExitCode } from "./model/exit-codes.ts";
import { textLines } from "./output/text.ts";
import { App } from "./ui/App.tsx";

function exitWith(message: string, code: ExitCode): never {
  console.error(`fleet-update: ${message}`);
  process.exit(code);
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

// Planned, not implemented yet: refused rather than silently skipped.
if (options.resume) exitWith("--resume: not implemented yet", ExitCode.InvalidOptions);
if (options.sendReport) exitWith("--send-report: not implemented yet", ExitCode.InvalidOptions);

// Workspace = cwd: the recipe and the systemd unit start in the consumer root.
const workspace = process.cwd();
const deployments = join(workspace, "var", "deployments");
const channel = new LiveChannel();
const flow = new RunFlow();
const ports: RunPorts = {
  commands: new ProcessRunner(),
  clock: new SystemClock(),
  events: channel,
  local: new SystemHost(),
  lock: new FlockLock(join(deployments, "current.lock")),
  store: new DirectoryStore(deployments),
};
const request: RunRequest = {
  workspace,
  codev: existsSync(join(workspace, "dnf", ".git")),
  version,
  resolve: (defaults) => resolveParams(options, defaults),
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
  process.exit(exitCode);
}

// `^C` is the abort dialog, not an exit: the interface owns the shutdown path.
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
const control: RunControl = {
  respond: (value) => channel.respond(value),
  abort: (mode) => flow.abort(mode),
  ping: () => flow.requestPing(),
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
      process.exit(exitCode);
    },
    (error: unknown) => {
      renderer.destroy();
      crash(error);
    },
  );
  return control;
};

createRoot(renderer).render(<App source={source} />);
