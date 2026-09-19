// Hosts of a run as the engine drives them: every state change goes through
// the transition table and becomes a `host.state` event.

import type { HostOrigin, HostState } from "../model/events.ts";
import { canTransition } from "../model/transitions.ts";
import type { Phase } from "./commands/host.ts";
import { emit, type RunContext } from "./context.ts";
import type { Fabric } from "./fabric.ts";
import type { Selection } from "./steps/select.ts";

export interface HostEntry {
  name: string;
  profile: string;
  zone: string;
  state: HostState;

  /** Last ping answer; undefined until the first one, unreachable for the waves. */
  online?: boolean;

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

  /** Cache topology of the run: read by the copy counters and the publication. */
  readonly fabric: Fabric;

  constructor(
    private readonly context: RunContext,
    selection: Selection,
  ) {
    this.fabric = selection.fabric;
    for (const host of selection.hosts) {
      // `--resume`: progress of the saved run, not a transition — the table
      // starts where that run stopped (spec § État et reprise).
      const restored = selection.restored?.get(host.name);
      this.entries.set(host.name, {
        name: host.name,
        profile: host.profile,
        zone: host.zone,
        state: restored?.state ?? "pending",
        ...(restored?.path === undefined ? {} : { path: restored.path }),
        ...(restored?.origin === undefined ? {} : { origin: restored.origin }),
        gateway: selection.gateways.has(host.name),
        local: host.name === selection.local,
        lost: false,
      });
    }

    // Emitted once the table stands: the stream shows what was restored.
    for (const entry of this.entries.values()) {
      if (entry.state === "pending") continue;
      emit(this.context, {
        kind: "host.state",
        host: entry.name,
        state: entry.state,
        ...(entry.path === undefined ? {} : { path: entry.path }),
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
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

  /** Emits the first answer, then only a change. */
  presence(name: string, online: boolean): void {
    const entry = this.get(name);
    if (entry.online === online) return;
    entry.online = online;
    emit(this.context, { kind: "host.presence", host: name, online });
  }
}
