// Legal host progress transitions (spec § État et reprise).
//
// Guard of the engine: a transition outside this table is a programmer error.
// Retries and rebuilds are not specified yet (spec § Erreurs et réparations).

import type { HostState } from "./events.ts";

const NEXT: Record<HostState, readonly HostState[]> = {
  pending: ["building", "excluded"],
  building: ["built", "failed", "excluded"],
  built: ["copying", "excluded"],
  // `switching`: `--skip-test`, the copy leads straight to the activation.
  copying: ["testing", "switching", "failed", "excluded"],
  testing: ["tested", "error", "failed", "excluded"],

  // `reverted`, `failed` from an activated host: forced rollback and its failure.
  tested: ["switching", "reverted", "failed", "excluded"],
  switching: ["deployed", "error", "failed", "excluded"],
  deployed: ["reverted", "failed"],

  // Units restarted: back to the state the activation aimed at.
  error: ["tested", "deployed", "reverted", "failed", "excluded"],
  failed: ["reverted", "excluded"],
  reverted: [],
  excluded: [],
};

export function canTransition(from: HostState, to: HostState): boolean {
  return NEXT[from].includes(to);
}

/** No transition leaves these. */
export function isTerminal(state: HostState): boolean {
  return NEXT[state].length === 0;
}
