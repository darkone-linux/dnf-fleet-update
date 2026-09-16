// Entry point and composition root: binds a run source to the interface.
//
// Today the source is a recorded scenario; the engine binds to the same
// `RunSource`, and `--no-ui` swaps the interface for the text output.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { listScenarios, startReplay } from "./engine/replay.ts";
import type { RunSource } from "./model/events.ts";
import { ExitCode } from "./model/exit-codes.ts";
import { App } from "./ui/App.tsx";

const args = process.argv.slice(2);

if (args.includes("--list") || args.includes("-l")) {
  console.log(listScenarios().join("\n"));
  process.exit(ExitCode.Ok);
}

const scenario = args.find((arg) => !arg.startsWith("-")) ?? "nominal";
const speed = Number(args.find((arg) => arg.startsWith("--speed="))?.slice(8) ?? 2);

if (!listScenarios().includes(scenario)) {
  console.error(`unknown scenario: ${scenario}`);
  console.error(`available: ${listScenarios().join(", ")}`);
  process.exit(ExitCode.InvalidOptions);
}

// Ctrl-C is the abort dialog, not an exit: the interface owns the shutdown path.
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });

// Module scope: a stable identity, so the interface starts the run once.
const source: RunSource = (emit) => startReplay(scenario, speed, emit);

createRoot(renderer).render(<App source={source} />);
