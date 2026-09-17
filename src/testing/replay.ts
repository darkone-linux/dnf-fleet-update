// Scenario replayer: the engine stand-in of the mockup.
//
// Emits a recorded stream with its original pacing, so the interface is built
// against the real contract and not against a live deployment.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent, type RunControl } from "../model/events.ts";
import { ExitCode } from "../model/exit-codes.ts";

const SCENARIO_DIR = fileURLToPath(new URL("../../mock/scenarios/", import.meta.url));

/** Longest pause honoured between two events: a recorded lull must not stall iteration. */
const MAX_GAP_MS = 800;

export function listScenarios(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.replace(/\.jsonl$/, ""))
    .sort();
}

export function loadScenario(name: string): Event[] {
  const path = `${SCENARIO_DIR}${name}.jsonl`;
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map(parseEvent);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plays `name` into `emit`. Stops on every `ask` until `respond` is called:
 * the mockup must exercise the interactive path, not fake it.
 */
export function startReplay(name: string, speed: number, emit: (event: Event) => void): RunControl {
  const events = loadScenario(name);
  let stopped = false;
  let previous = 0;
  let resume: ((value: string) => void) | null = null;

  const run = async () => {
    for (const event of events) {
      if (stopped) return;
      await sleep(Math.min(MAX_GAP_MS, Math.max(0, event.t - previous) / speed));
      if (stopped) return;
      previous = event.t;
      emit(event);

      if (event.kind === "ask") {
        const answer = await new Promise<string>((resolve) => {
          resume = resolve;
        });
        resume = null;
        if (stopped) return;
        emit({ t: event.t, kind: "ask.close", id: event.id, value: answer });
      }
    }
  };

  void run();

  return {
    respond: (value) => resume?.(value),

    // A recording cannot finish its wave: both modes end the replay at once.
    abort: (mode) => {
      if (stopped) return;
      stopped = true;
      resume?.("");
      const message = mode === "now" ? "aborting now" : "aborting after current wave";
      emit({ t: previous, kind: "log", level: "warn", message });
      emit({ t: previous, kind: "run.end", status: "aborted", exitCode: ExitCode.Aborted });
    },

    // Presence is recorded: nothing to ping.
    ping: () => {},
  };
}
