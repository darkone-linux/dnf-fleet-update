// Development entry point: replays a recorded scenario in the real interface.
//
// Outside the published command line (spec § Maquette): `just mock`,
// `just scenarios`.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { RunSource } from "../model/events.ts";
import { ExitCode } from "../model/exit-codes.ts";
import { App } from "../ui/App.tsx";
import { listScenarios, startReplay } from "./replay.ts";

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
