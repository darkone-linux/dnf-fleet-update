// Presence of the hosts (spec § Présence): pinged while their next wave has
// not started, at start, every `pingInterval`, on `p`, and before a wave.

import { ping } from "./commands/host.ts";
import type { RunContext } from "./context.ts";
import { execute, succeeded } from "./exec.ts";
import type { HostTable } from "./hosts.ts";

/** Failed probes in a row before a reachable or unknown host reads offline. */
export const PROBE_ATTEMPTS = 3;

export class Presence {
  private readonly tracked = new Set<string>();

  /** Probes under way, per host: a second `check` joins them. */
  private readonly probing = new Map<string, Promise<void>>();
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

  /** Probes now, until a verdict; the deployment host answers without a probe. */
  async check(names: readonly string[]): Promise<void> {
    const signal = AbortSignal.any([this.stopped.signal, this.context.flow.halt]);
    await Promise.all(names.map((name) => this.probe(name, signal)));
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

  private probe(name: string, signal: AbortSignal): Promise<void> {
    const running = this.probing.get(name);
    if (running !== undefined) return running;
    const probe = this.attempts(name, signal).finally(() => this.probing.delete(name));
    this.probing.set(name, probe);
    return probe;
  }

  /**
   * One failed probe is no outage: `searching` until `PROBE_ATTEMPTS` failures
   * in a row. Offline already: one probe watches for its return.
   */
  private async attempts(name: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const host = this.hosts.get(name);
    if (host.local) {
      this.hosts.presence(name, true);
      return;
    }

    const attempts = host.online === false ? 1 : PROBE_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const spec = ping(name, this.context.params.timeouts);
      const execution = await execute(this.context, spec, { signal });
      if (signal.aborted) return;
      if (succeeded(execution.result)) {
        this.hosts.presence(name, true);
        return;
      }
      if (attempt < attempts) this.hosts.searching(name, attempt);
    }
    this.hosts.presence(name, false);
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
