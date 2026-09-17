// Hosts of a run as the engine drives them: every state change goes through
// the transition table and becomes a `host.state` event.

import type { HostOrigin, HostState } from "../model/events.ts";
import { canTransition } from "../model/transitions.ts";
import type { Phase } from "./commands/host.ts";
import { emit, type RunContext } from "./context.ts";
import type { Selection } from "./steps/select.ts";

export interface HostEntry {
  name: string;
  profile: string;
  zone: string;
  state: HostState;
  online: boolean;

  /** Guarded when lost: never excluded (spec § Erreurs et réparations). */
  gateway: boolean;

  /** The deployment host itself: no ssh, no copy, no rollback timer. */
  local: boolean;
  note?: string;
  path?: string;
  origin?: HostOrigin;

  /** Last activation started: the phase a forced rollback undoes. */
  activated?: Phase;

  /** Unreachable after its wave started: left to its automatic rollback. */
  lost: boolean;
}

/** Activated during the run, reachable, not reverted yet: what a forced rollback brings back. */
export function rollbackTarget(host: HostEntry): boolean {
  return host.activated !== undefined && !host.lost && canTransition(host.state, "reverted");
}

export interface StateDetail {
  note?: string;
  path?: string;
  origin?: HostOrigin;
}

export class HostTable {
  private readonly entries = new Map<string, HostEntry>();

  constructor(
    private readonly context: RunContext,
    selection: Selection,
  ) {
    for (const host of selection.hosts) {
      this.entries.set(host.name, {
        name: host.name,
        profile: host.profile,
        zone: host.zone,
        state: "pending",
        online: false,
        gateway: selection.gateways.has(host.name),
        local: host.name === selection.local,
        lost: false,
      });
    }
  }

  get(name: string): HostEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`unknown host: ${name}`);
    return entry;
  }

  all(): HostEntry[] {
    return [...this.entries.values()];
  }

  /** Throws on a transition outside the table: an engine bug, not a host failure. */
  set(name: string, state: HostState, detail: StateDetail = {}): void {
    const entry = this.get(name);
    if (!canTransition(entry.state, state)) {
      throw new Error(`illegal transition of ${name}: ${entry.state} -> ${state}`);
    }
    entry.state = state;
    entry.note = detail.note;
    if (detail.path !== undefined) entry.path = detail.path;
    if (detail.origin !== undefined) entry.origin = detail.origin;

    const { note, path, origin } = detail;
    emit(this.context, {
      kind: "host.state",
      host: name,
      state,
      ...(note === undefined ? {} : { note }),
      ...(path === undefined ? {} : { path }),
      ...(origin === undefined ? {} : { origin }),
    });
  }

  /** Same state, reason completed: a failed host whose revert failed too. */
  note(name: string, note: string): void {
    const entry = this.get(name);
    entry.note = note;
    emit(this.context, { kind: "host.state", host: name, state: entry.state, note });
  }

  /** Emits only a change: every host starts unreachable. */
  presence(name: string, online: boolean): void {
    const entry = this.get(name);
    if (entry.online === online) return;
    entry.online = online;
    emit(this.context, { kind: "host.presence", host: name, online });
  }
}
