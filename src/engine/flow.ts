// Early ends of a run (spec § Interface, abandon; § Erreurs et réparations).
//
// `after wave`: the current wave, or step outside waves, finishes. `stop`:
// activations finish, nothing new starts. `now`: every command is killed.

import type { AbortMode } from "../model/events.ts";

/** `done`: nothing left to do before the report (`--build-only`, nothing built). */
export type Ending = "done" | "aborted" | "stop" | "rollback";

/** Exit `1` of `stop` wins over exit `5` of an abort requested later. */
const RANK: Record<Ending, number> = { done: 0, aborted: 1, stop: 2, rollback: 3 };

export class RunFlow {
  private readonly nowController = new AbortController();
  private readonly haltController = new AbortController();
  private readonly pingListeners = new Set<() => void>();
  private current: Ending | undefined;

  /** Abort `now`, SIGTERM: every command and wait ends at once. */
  get now(): AbortSignal {
    return this.nowController.signal;
  }

  /** `now`, `stop` or `rollback`: builds, copies, pings and waits end; activations do not. */
  get halt(): AbortSignal {
    return this.haltController.signal;
  }

  /** Set: no new step, no new wave. */
  get ending(): Ending | undefined {
    return this.current;
  }

  /** Also a `no` to a confirmation: resumable. */
  abort(mode: AbortMode): void {
    this.end("aborted");
    if (mode === "now") {
      this.haltController.abort(new Error("run aborted"));
      this.nowController.abort(new Error("run aborted"));
    }
  }

  /** The run has nothing more to do: straight to the report. */
  finish(): void {
    this.end("done");
  }

  /** Decision on a lost or failed host. */
  stop(kind: "stop" | "rollback"): void {
    this.end(kind);
    this.haltController.abort(new Error(`run ${kind}`));
  }

  /** `p`: ping the tracked hosts now. */
  requestPing(): void {
    for (const listener of this.pingListeners) listener();
  }

  /** Returns the unsubscribe function. */
  onPing(listener: () => void): () => void {
    this.pingListeners.add(listener);
    return () => this.pingListeners.delete(listener);
  }

  private end(kind: Ending): void {
    if (this.current === undefined || RANK[kind] > RANK[this.current]) this.current = kind;
  }
}
