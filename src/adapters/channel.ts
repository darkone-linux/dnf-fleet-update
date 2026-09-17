// Real `EventChannel`: the engine and its consumer in one process. Events go to
// the interface or the text output; answers come back from `RunControl`.

import type { EventChannel } from "../engine/ports.ts";
import type { Event } from "../model/events.ts";

interface Pending {
  id: string;
  resolve: (value: string) => void;
}

export class LiveChannel implements EventChannel {
  private listener: ((event: Event) => void) | undefined;
  private pending: Pending | undefined;

  /** One consumer, subscribed before the run starts: nothing is buffered. */
  subscribe(listener: (event: Event) => void): void {
    this.listener = listener;
  }

  emit(event: Event): void {
    this.listener?.(event);
  }

  /** Rejects with `signal.reason` once aborted. One question at a time (`QuestionQueue`). */
  answer(id: string, signal?: AbortSignal): Promise<string> {
    if (this.pending !== undefined) {
      return Promise.reject(new Error(`question ${id} asked while ${this.pending.id} is pending`));
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        this.pending = undefined;
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          this.pending = undefined;
          resolve(value);
        },
      };
    });
  }

  /** `RunControl.respond`: without a pending question, a late key press, ignored. */
  respond(value: string): void {
    this.pending?.resolve(value);
  }
}
