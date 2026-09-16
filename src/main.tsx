// Mockup entry point: replays a recorded scenario in the real interface.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { listScenarios } from "./engine/replay.ts";
import { App } from "./ui/App.tsx";

const args = process.argv.slice(2);

if (args.includes("--list") || args.includes("-l")) {
  console.log(listScenarios().join("\n"));
  process.exit(0);
}

const scenario = args.find((arg) => !arg.startsWith("-")) ?? "nominal";
const speed = Number(args.find((arg) => arg.startsWith("--speed="))?.slice(8) ?? 2);

if (!listScenarios().includes(scenario)) {
  console.error(`unknown scenario: ${scenario}`);
  console.error(`available: ${listScenarios().join(", ")}`);
  process.exit(2);
}

// Ctrl-C is the abort dialog, not an exit: the interface owns the shutdown path.
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });

createRoot(renderer).render(<App scenario={scenario} speed={speed} />);
