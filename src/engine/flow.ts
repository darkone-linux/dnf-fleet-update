// Early ends of a run (spec § Interface, abandon; § Erreurs et réparations).
//
// `after wave`: the current wave, or step outside waves, finishes. `stop`:
// activations finish, nothing new starts. `now`: every command is killed.

import type { AbortMode } from "../model/events.ts";

/** `done`: nothing left to do before the report (`--build-only`, nothing built). */
export type Ending = "done" | "aborted" | "stop" | "rollback";

/** Who asked for an abort: the abort dialog, a `no` answer, a signal. */
export type AbortCause = "operator" | "answer" | "SIGTERM" | "SIGINT" | "SIGHUP";

/** The cause as the feed and the report say it. */
export function abortedBy(cause: AbortCause): string {
  switch (cause) {
    case "operator":
      return "by the operator";
    case "answer":
      return "on a no answer";
    case "SIGTERM":
    case "SIGINT":
    case "SIGHUP":
      return `by ${cause}`;
  }
}

/** Exit `1` of `stop` wins over exit `5` of an abort requested later. */
const RANK: Record<Ending, number> = { done: 0, aborted: 1, stop: 2, rollback: 3 };

export class RunFlow {
  private readonly nowController = new AbortController();
  private readonly haltController = new AbortController();
  private readonly pingListeners = new Set<() => void>();
  private readonly aiListeners = new Set<(question: string) => void>();
  private readonly abortListeners = new Set<(mode: AbortMode, cause: AbortCause) => void>();
  private current: Ending | undefined;
  private cause: AbortCause | undefined;

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

  /** First abort asked: the one that ended the run. */
  get abortCause(): AbortCause | undefined {
    return this.cause;
  }

  /** Also a `no` to a confirmation: resumable. */
  abort(mode: AbortMode, cause: AbortCause): void {
    this.end("aborted");
    this.cause ??= cause;
    for (const listener of this.abortListeners) listener(mode, cause);
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

  /** `a`: a free question typed by the operator (spec § Mode d'emploi). */
  requestAi(question: string): void {
    for (const listener of this.aiListeners) listener(question);
  }

  /** Returns the unsubscribe function. */
  onAi(listener: (question: string) => void): () => void {
    this.aiListeners.add(listener);
    return () => this.aiListeners.delete(listener);
  }

  /** Called before the signals fire. Returns the unsubscribe function. */
  onAbort(listener: (mode: AbortMode, cause: AbortCause) => void): () => void {
    this.abortListeners.add(listener);
    return () => this.abortListeners.delete(listener);
  }

  private end(kind: Ending): void {
    if (this.current === undefined || RANK[kind] > RANK[this.current]) this.current = kind;
  }
}
