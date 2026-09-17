// Presence of the hosts (spec § Présence): pinged while their next wave has
// not started, at start, every `pingInterval`, on `p`, and before a wave.

import { ping } from "./commands/host.ts";
import type { RunContext } from "./context.ts";
import { execute, succeeded } from "./exec.ts";
import type { HostTable } from "./hosts.ts";

export class Presence {
  private readonly tracked = new Set<string>();
  private readonly stopped = new AbortController();
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private leave: (() => void) | undefined;

  constructor(
    private readonly context: RunContext,
    private readonly hosts: HostTable,
  ) {}

  track(names: Iterable<string>): void {
    for (const name of names) this.tracked.add(name);
  }

  /** Its wave started: reachability is now the job of the wave. */
  untrack(names: Iterable<string>): void {
    for (const name of names) this.tracked.delete(name);
  }

  /** Pings now; the deployment host answers without a ping. */
  async check(names: readonly string[]): Promise<void> {
    const signal = AbortSignal.any([this.stopped.signal, this.context.flow.halt]);
    await Promise.all(
      names.map(async (name) => {
        if (signal.aborted) return;
        if (this.hosts.get(name).local) {
          this.hosts.presence(name, true);
          return;
        }
        const { timeouts } = this.context.params;
        const execution = await execute(this.context, ping(name, timeouts), { signal });
        if (!signal.aborted) this.hosts.presence(name, succeeded(execution.result));
      }),
    );
  }

  /** First round at once, then every `pingInterval` or on `p`, until `stop` or a halt. */
  start(): void {
    this.leave = this.context.flow.onPing(() => this.wake?.());
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped.abort(new Error("presence stopped"));
    this.leave?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const signal = AbortSignal.any([this.stopped.signal, this.context.flow.halt]);
    while (!signal.aborted) {
      await this.check([...this.tracked]);
      const nap = new AbortController();
      this.wake = () => nap.abort(new Error("ping requested"));
      try {
        const napping = AbortSignal.any([signal, nap.signal]);
        await this.context.clock.sleep(this.context.params.pingInterval * 1000, napping);
      } catch {
        // Woken by `p`, or stopped: the loop condition tells.
      }
    }
  }
}
