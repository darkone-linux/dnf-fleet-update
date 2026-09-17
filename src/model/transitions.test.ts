// Transition table against the spec rows, and every recorded scenario against the table.

import { describe, expect, test } from "bun:test";
import { listScenarios, loadScenario } from "../testing/replay.ts";
import type { HostState } from "./events.ts";
import { canTransition, isTerminal } from "./transitions.ts";

type Path = readonly HostState[];

function follows(path: Path): boolean {
  return path.slice(1).every((to, index) => canTransition(path[index]!, to));
}

describe("spec rows", () => {
  const legal: Record<string, Path[]> = {
    build: [
      ["pending", "building", "built"],
      ["pending", "building", "failed"],
    ],
    test: [
      ["built", "copying", "testing", "tested"],
      ["built", "copying", "testing", "error"],
      ["built", "copying", "testing", "failed"],
      ["built", "copying", "failed"],
    ],
    switch: [
      ["tested", "switching", "deployed"],
      ["tested", "switching", "error"],
      ["tested", "switching", "failed"],
    ],
    "units restarted": [
      ["error", "tested"],
      ["error", "deployed"],
    ],
    "forced rollback": [
      ["tested", "reverted"],
      ["error", "reverted"],
      ["deployed", "reverted"],
      ["failed", "reverted"],
      ["deployed", "failed"],
    ],
  };

  for (const [row, paths] of Object.entries(legal)) {
    test(row, () => {
      for (const path of paths) expect(follows(path)).toBe(true);
    });
  }

  test("any state but deployed and reverted can be excluded", () => {
    const states: HostState[] = [
      "pending",
      "building",
      "built",
      "copying",
      "testing",
      "tested",
      "switching",
      "error",
      "failed",
    ];
    for (const state of states) expect(canTransition(state, "excluded")).toBe(true);
    expect(canTransition("deployed", "excluded")).toBe(false);
    expect(canTransition("reverted", "excluded")).toBe(false);
  });
});

test("steps cannot be skipped", () => {
  expect(canTransition("pending", "copying")).toBe(false);
  expect(canTransition("built", "testing")).toBe(false);
  expect(canTransition("tested", "deployed")).toBe(false);
  expect(canTransition("built", "switching")).toBe(false);
});

test("only reverted and excluded are terminal", () => {
  expect(isTerminal("reverted")).toBe(true);
  expect(isTerminal("excluded")).toBe(true);
  expect(isTerminal("failed")).toBe(false);
  expect(isTerminal("error")).toBe(false);

  // A deployed host can still be rolled back by a stop-loss.
  expect(isTerminal("deployed")).toBe(false);
});

test("every recorded scenario follows the legal transitions", () => {
  const illegal: string[] = [];
  for (const name of listScenarios()) {
    const current = new Map<string, HostState>();
    for (const event of loadScenario(name)) {
      if (event.kind === "host.add") current.set(event.host, "pending");
      if (event.kind !== "host.state") continue;

      const from = current.get(event.host);
      if (from === undefined || (from !== event.state && !canTransition(from, event.state))) {
        illegal.push(`${name} t=${event.t} ${event.host}: ${from} -> ${event.state}`);
      }
      current.set(event.host, event.state);
    }
  }
  expect(illegal).toEqual([]);
});
