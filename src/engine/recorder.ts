// Persistence of the event stream (spec § État et reprise): `events.jsonl`,
// `state.json` rewritten when the fold changes, host output into host logs.

import type { Event } from "../model/events.ts";
import { initialPersisted, type PersistedState, persist } from "../model/persist.ts";
import type { EventChannel, RunStore } from "./ports.ts";

/** Only `lastEventAt` moved: live output and narration, nothing to rewrite. */
function sameState(previous: PersistedState, next: PersistedState): boolean {
  // The fold rebuilds only what changed: identity per field is enough.
  return (Object.keys(next) as (keyof PersistedState)[]).every(
    (key) => key === "lastEventAt" || next[key] === previous[key],
  );
}

export class Recorder {
  private current: PersistedState = initialPersisted();

  constructor(private readonly run: RunStore) {}

  /** Fold of every event recorded so far: the report reads it. */
  get state(): PersistedState {
    return this.current;
  }

  record(event: Event): void {
    this.run.appendEvent(event);
    if (event.kind === "host.output") {
      this.run.appendLog({ host: event.host, phase: event.phase }, event.line);
    }

    const next = persist(this.current, event);
    const changed = !sameState(this.current, next);
    this.current = next;
    if (changed) this.run.writeState(next);
  }
}

/** Every event is on disk before a consumer sees it. */
export function recordedChannel(channel: EventChannel, recorder: Recorder): EventChannel {
  return {
    emit: (event) => {
      recorder.record(event);
      channel.emit(event);
    },
    answer: (id, signal) => channel.answer(id, signal),
  };
}
