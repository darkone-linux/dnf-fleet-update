// Legal host progress transitions (spec § État et reprise).
//
// Guard of the engine: a transition outside this table is a programmer error.
// Retries and rebuilds are not specified yet (spec § Erreurs et réparations).

import type { HostState } from "./events.ts";

const NEXT: Record<HostState, readonly HostState[]> = {
  pending: ["building", "excluded"],
  building: ["built", "failed", "excluded"],
  built: ["copying", "excluded"],

  // `testing`/`switching`: a host served just before its wave activates without
  // passing through `ready` — publication left it behind, unreachable.
  copying: ["ready", "testing", "switching", "failed", "excluded"],

  // `switching`: `--skip-test`, the wave activates straight from `ready`.
  ready: ["testing", "switching", "failed", "excluded"],
  testing: ["tested", "error", "failed", "excluded"],

  // `reverted`, `failed` from an activated host: forced rollback and its failure.
  tested: ["switching", "reverted", "failed", "excluded"],
  switching: ["deployed", "error", "failed", "excluded"],
  deployed: ["reverted", "failed"],

  // Units restarted: back to the state the activation aimed at.
  error: [
    "repairing",
    "ai-analysing",
    "ai-repairing",
    "tested",
    "deployed",
    "reverted",
    "failed",
    "excluded",
  ],
  failed: ["repairing", "ai-analysing", "ai-repairing", "reverted", "excluded"],

  // Deterministic first, the AI after it (spec § Erreurs et réparations).
  repairing: [
    "ai-analysing",
    "ai-repairing",
    "tested",
    "deployed",
    "error",
    "failed",
    "reverted",
    "excluded",
  ],

  // An analysis alone repairs nothing: the host goes back where it failed.
  "ai-analysing": ["ai-repairing", "error", "failed", "reverted", "excluded"],
  // `built`: a repair edited the code and rebuilt this host alone; its wave
  // serves it once more (spec § réparation, Le redéploiement).
  "ai-repairing": ["built", "tested", "deployed", "error", "failed", "reverted", "excluded"],
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
