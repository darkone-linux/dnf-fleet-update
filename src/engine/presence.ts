// Presence of the hosts (spec § Présence): pinged while their next wave has
// not started, each on its own period, on `p`, and before a wave. Probe starts
// are spaced: a burst trips the rate limit of the zone resolver.

import { ping } from "./commands/host.ts";
import type { RunContext } from "./context.ts";
import { describeFailure, type Execution, errorLines, execute, succeeded } from "./exec.ts";
import type { HostTable } from "./hosts.ts";

export class Presence {
  private readonly tracked = new Set<string>();

  /** Searches under way, per host: a second `check` joins them. */
  private readonly probing = new Map<string, Promise<void>>();

  /** `clock.now()` of the next periodic probe, per host; absent: due now. */
  private readonly due = new Map<string, number>();

  /** Probe starts queue here, `spacingMs` apart. */
  private spacing: Promise<unknown> = Promise.resolve();
  private lastStart: number | undefined;

  private readonly stopped = new AbortController();
  private readonly signal: AbortSignal;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private leave: (() => void) | undefined;

  constructor(
    private readonly context: RunContext,
    private readonly hosts: HostTable,
  ) {
    this.signal = AbortSignal.any([this.stopped.signal, context.flow.halt]);
  }

  track(names: Iterable<string>): void {
    for (const name of names) this.tracked.add(name);
    this.wake?.();
  }

  /** Its wave started: reachability is now the job of the wave. */
  untrack(names: Iterable<string>): void {
    for (const name of names) this.tracked.delete(name);
  }

  /** Probes now, until a verdict; the deployment host answers without a probe. */
  async check(names: readonly string[]): Promise<void> {
    await Promise.all(names.map((name) => this.probe(name)));
  }

  /** Every tracked host at once, then each on its period or on `p`, until `stop` or a halt. */
  start(): void {
    this.leave = this.context.flow.onPing(() => {
      this.due.clear();
      this.wake?.();
    });
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped.abort(new Error("presence stopped"));
    this.leave?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { clock, params } = this.context;
    while (!this.signal.aborted) {
      const now = clock.now();
      const idle = [...this.tracked].filter((name) => !this.probing.has(name));
      for (const name of idle) {
        if ((this.due.get(name) ?? now) > now) continue;

        // Settled, it has a new period: the loop looks again.
        this.probe(name).then(
          () => this.wake?.(),
          () => this.wake?.(),
        );
      }

      const waits = idle
        .filter((name) => !this.probing.has(name))
        .map((name) => (this.due.get(name) ?? now) - now);
      const nap = new AbortController();
      this.wake = () => nap.abort(new Error("presence woken"));
      await this.pause(waits.length > 0 ? Math.min(...waits) : params.pingInterval * 1000, nap);
    }
    await Promise.allSettled(this.probing.values());
  }

  private probe(name: string): Promise<void> {
    const running = this.probing.get(name);
    if (running !== undefined) return running;
    const search = this.search(name).finally(() => {
      this.probing.delete(name);
      this.due.set(name, this.context.clock.now() + this.period(name));
    });
    this.probing.set(name, search);
    return search;
  }

  /** A host that answered is watched less often than one never seen. */
  private period(name: string): number {
    const { pingInterval, presence } = this.context.params;
    const factor = this.hosts.get(name).online === true ? presence.onlineFactor : 1;
    return pingInterval * factor * 1000;
  }

  /**
   * One failed probe is no outage: `searching` until `attempts` failures in a
   * row, `pingInterval` apart. Offline already: one probe watches for its return.
   */
  private async search(name: string): Promise<void> {
    const { params } = this.context;
    const host = this.hosts.get(name);
    if (host.local) {
      this.hosts.presence(name, true);
      return;
    }

    const attempts = host.online === false ? 1 : params.presence.attempts;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1 && !(await this.pause(params.pingInterval * 1000))) return;
      if (!(await this.turn())) return;
      const spec = ping(name, params.timeouts);
      const execution = await execute(this.context, spec, { signal: this.signal });
      if (this.signal.aborted) return;
      if (succeeded(execution.result)) {
        this.hosts.presence(name, true);
        return;
      }
      const reason = this.record(name, `attempt ${attempt}/${attempts}`, execution);
      if (attempt < attempts) this.hosts.searching(name, attempt, reason);
    }
    this.hosts.presence(name, false);
  }

  /** Why a probe failed, kept in `<host>.presence.log`: the feed only says offline. */
  private record(name: string, label: string, execution: Execution): string {
    const log = { host: name, phase: "presence" };
    const reason = describeFailure(execution);
    this.context.run.appendLog(log, `${label}: ${reason}`);
    for (const line of errorLines(execution)) this.context.run.appendLog(log, `  ${line}`);
    return reason;
  }

  /** Waits its turn: probe starts `spacingMs` apart, in call order. `false`: stopped. */
  private turn(): Promise<boolean> {
    const { clock, params } = this.context;
    const mine = this.spacing.then(async () => {
      const last = this.lastStart;
      const wait = last === undefined ? 0 : last + params.presence.spacingMs - clock.now();
      if (wait > 0 && !(await this.pause(wait))) return false;
      this.lastStart = clock.now();
      return true;
    });
    this.spacing = mine;
    return mine;
  }

  /** `false` when stopped, or cut short by `also`. */
  private async pause(ms: number, also?: AbortController): Promise<boolean> {
    const signal = also === undefined ? this.signal : AbortSignal.any([this.signal, also.signal]);
    try {
      await this.context.clock.sleep(ms, signal);
      return true;
    } catch {
      return false;
    }
  }
}
