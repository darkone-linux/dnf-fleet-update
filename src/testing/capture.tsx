// Deterministic frame capture, without a terminal.
//
// Renders the real interface into a test buffer and prints the exact cells.
// Replaces reading ANSI out of a pty, where unchanged cells are never repainted
// and neighbouring text looks glued.

// Set before the UI imports: it freezes the spinners so a frame can settle.
process.env.FLEET_CAPTURE = "1";

import { testRender } from "@opentui/react/test-utils";
import { ExitCode } from "../model/exit-codes.ts";
import { App } from "../ui/App.tsx";
import { listScenarios, loadScenario } from "./replay.ts";

interface Options {
  scenario: string;
  at: number;
  cols: number;
  rows: number;
  view: "main" | "logs";
  selected: number;
  spans: boolean;
}

function parse(argv: string[]): Options {
  const flag = (name: string, fallback: string): string =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

  return {
    scenario: argv.find((arg) => !arg.startsWith("-")) ?? "nominal",
    at: Number(flag("at", "999999")),
    cols: Number(flag("cols", "150")),
    rows: Number(flag("rows", "44")),
    view: flag("view", "main") === "logs" ? "logs" : "main",
    selected: Number(flag("selected", "0")),
    spans: argv.includes("--spans"),
  };
}

const options = parse(process.argv.slice(2));

if (!listScenarios().includes(options.scenario)) {
  console.error(`unknown scenario: ${options.scenario}`);
  console.error(`available: ${listScenarios().join(", ")}`);
  process.exit(ExitCode.InvalidOptions);
}

// Everything up to `at` is folded synchronously: no timers, no flake.
const events = loadScenario(options.scenario).filter((event) => event.t <= options.at);

// `testRender` turns React's act() environment on itself, so clearing the flag
// loses the race. Our updates come from the synchronous preload above, never
// from act(), and the warning would head every capture: filter that one line.
const forward = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("was not wrapped in act")) return;
  forward(...args);
};

const setup = await testRender(
  <App preload={events} initialView={options.view} initialSelected={options.selected} />,
  { width: options.cols, height: options.rows },
);

await setup.waitForVisualIdle();

if (options.spans) {
  // Colour check: one line per span, with its foreground, background and attributes.
  const frame = setup.captureSpans();
  for (const [row, line] of frame.lines.entries()) {
    for (const span of line.spans) {
      if (!span.text.trim()) continue;
      console.log(
        `${String(row).padStart(3)}  fg ${hex(span.fg)}  bg ${hex(span.bg)}  a${span.attributes}  ${JSON.stringify(span.text)}`,
      );
    }
  }
} else {
  console.log(setup.captureCharFrame());
}

setup.renderer.destroy();
process.exit(ExitCode.Ok);

/** `toInts` is the documented 0..255 accessor; the getters are normalised floats. */
function hex(color: { toInts: () => [number, number, number, number] } | undefined): string {
  if (!color) return "-------";
  const [r, g, b] = color.toInts();
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}
