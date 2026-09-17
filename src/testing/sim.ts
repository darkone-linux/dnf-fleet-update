// Simulated workspace and fleet for whole runs on fakes.
//
// One `CommandRunner` answers every command of a run from per-host behaviour
// and keeps what a real host would: current system, profile, result files,
// rollback timers firing on the fake clock. No argv script per test.

import type { Phase } from "../engine/commands/host.ts";
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
  OutputLine,
  RunOptions,
} from "../engine/ports.ts";
import type { FakeClock } from "./fakes.ts";
import { HOSTS_JSON, NETWORK_JSON, ORIGIN_PATH, storePath } from "./fleet.ts";

export interface HostBehaviour {
  /** Answers ping and ssh; a function reads the fake clock (ms). Default: always. */
  reachable?: boolean | ((now: number) => boolean);
  evalError?: string;
  buildError?: string;
  copyExit?: number;

  /** Exit code of `switch-to-configuration` per phase. Default `0`. */
  activation?: Partial<Record<Phase, number>>;

  /** Unreachable from its activation of this phase until its rollback timer fires. */
  dropsOn?: Phase;
  rollbackExit?: number;
}

export type SimKind =
  | "status"
  | "add"
  | "commit"
  | "rev-parse"
  | "flake-update"
  | "realign"
  | "clean"
  | "generated"
  | "eval"
  | "build"
  | "ping"
  | "copy"
  | "maintenance"
  | "origin"
  | "profile"
  | "activate"
  | "settle"
  | "rollback";

export interface SimCommand {
  kind: SimKind;
  host?: string;
  phase?: Phase;

  /** Repository, `on`/`off`, timer delay, profile path: per kind. */
  detail?: string;
  at: number;
}

/** Runs when a matching command starts; a `gate` then holds it, like a slow command. */
export interface SimHook {
  kind: SimKind;
  host?: string;
  phase?: Phase;
  run?: (command: SimCommand) => void;
  gate?: Promise<void>;
  once?: boolean;
}

export interface HostSide {
  system: string;
  profile: string;
  results: Map<Phase, number>;
  timers: Map<Phase, number>;
  dropped: boolean;

  /** What happened on the host, in order: `test <path>`, `timer fired test`… */
  history: string[];
}

export interface SimOptions {
  behaviours?: Record<string, HostBehaviour>;
  hooks?: SimHook[];

  /** The deployment host, when it is part of the fleet: commands run without ssh. */
  local?: string;
  codev?: boolean;

  /** Uncommitted changes before the run. */
  dirty?: { consumer?: boolean; dnf?: boolean };

  /** What the update changes, hence what gets committed. Default: nothing. */
  updates?: { consumer?: boolean; dnf?: boolean };
  hostsJson?: unknown;
  networkJson?: unknown;
  evalWarnings?: string[];
}

const WORKSPACE = "/ws";

type Repo = "consumer" | "dnf";

const ok = (durationMs = 0): CommandResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs,
});

const exit = (exitCode: number): CommandResult => ({ ...ok(), exitCode });

const PHASE_OF_RESULT = /fleet-update-[a-zA-Z0-9_-]+-(test|switch)\.rc/;
const ACTIVATED_PHASE = /switch-to-configuration'? (test|switch)/;
const ON_ACTIVE = /--on-active=(\d+)/;

export class SimFleet implements CommandRunner {
  readonly commands: SimCommand[] = [];
  readonly hosts = new Map<string, HostSide>();
  readonly commits: { repo: Repo; message: string }[] = [];
  private readonly pending = { consumer: false, dnf: false };
  private readonly used = new Set<SimHook>();

  constructor(
    private readonly clock: FakeClock,
    private readonly options: SimOptions = {},
  ) {
    const hostsJson = (options.hostsJson ?? HOSTS_JSON) as { hostname: string }[];
    for (const { hostname } of hostsJson) {
      this.hosts.set(hostname, {
        system: ORIGIN_PATH,
        profile: ORIGIN_PATH,
        results: new Map(),
        timers: new Map(),
        dropped: false,
        history: [],
      });
    }
    this.pending.consumer = options.dirty?.consumer ?? false;
    this.pending.dnf = options.dirty?.dnf ?? false;
  }

  host(name: string): HostSide {
    const side = this.hosts.get(name);
    if (!side) throw new Error(`simulated fleet has no host ${name}`);
    return side;
  }

  /** Commands of one kind, optionally on one host. */
  count(kind: SimKind, host?: string): number {
    return this.commands.filter((c) => c.kind === kind && (host === undefined || c.host === host))
      .length;
  }

  /** Fires the rollback timers due at the current fake time. */
  tick(): void {
    const now = this.clock.now();
    for (const [name, side] of this.hosts) {
      for (const [phase, at] of [...side.timers]) {
        if (at > now) continue;
        side.timers.delete(phase);
        this.revert(name, phase);
        side.dropped = false;
        side.history.push(`timer fired ${phase}`);
      }
    }
  }

  async run(spec: CommandSpec, options: RunOptions = {}): Promise<CommandResult> {
    const { signal, onLine } = options;
    signal?.throwIfAborted();
    this.tick();
    const command = this.classify(spec);
    this.commands.push(command);

    const lines: OutputLine[] = [];
    const out = (line: string) => lines.push({ stream: "stdout", line });
    const err = (line: string) => lines.push({ stream: "stderr", line });
    const result = this.answer(command, spec, out, err);

    let gate: Promise<void> | undefined;
    for (const hook of this.hooks(command)) {
      hook.run?.(command);
      gate ??= hook.gate;
    }
    for (const line of lines) onLine?.(line);
    if (gate !== undefined && !signal?.aborted) {
      const aborted = new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([gate, aborted]);
    }
    if (signal?.aborted)
      return { exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: 0 };
    return result;
  }

  private hooks(command: SimCommand): SimHook[] {
    const matching = (this.options.hooks ?? []).filter(
      (hook) =>
        !this.used.has(hook) &&
        hook.kind === command.kind &&
        (hook.host === undefined || hook.host === command.host) &&
        (hook.phase === undefined || hook.phase === command.phase),
    );
    for (const hook of matching) if (hook.once) this.used.add(hook);
    return matching;
  }

  private behaviour(name: string): HostBehaviour {
    return this.options.behaviours?.[name] ?? {};
  }

  private reachable(name: string): boolean {
    const side = this.host(name);
    const { reachable = true } = this.behaviour(name);
    const up = typeof reachable === "function" ? reachable(this.clock.now()) : reachable;
    return up && !side.dropped;
  }

  private revert(name: string, phase: Phase): void {
    const side = this.host(name);
    if (phase === "switch") side.profile = ORIGIN_PATH;
    side.system = ORIGIN_PATH;
  }

  private classify(spec: CommandSpec): SimCommand {
    const argv = spec.argv;
    const at = this.clock.now();
    const [program] = argv;
    const joined = argv.join(" ");

    if (program === "git") {
      const repo = argv[2] === `${WORKSPACE}/dnf` ? "dnf" : "consumer";
      const verb = argv[3];
      if (verb === "status") return { kind: "status", detail: repo, at };
      if (verb === "add") return { kind: "add", detail: repo, at };
      if (verb === "commit") return { kind: "commit", detail: repo, at };
      if (verb === "rev-parse") return { kind: "rev-parse", detail: repo, at };
    }
    if (program === "nix" && argv[1] === "flake") {
      if (argv[3] === "dnf") return { kind: "realign", at };
      return {
        kind: "flake-update",
        detail: spec.cwd === `${WORKSPACE}/dnf` ? "dnf" : "consumer",
        at,
      };
    }
    if (program === "just" && argv[1] === "clean") return { kind: "clean", at };
    if (program === "nix-instantiate") return { kind: "generated", detail: argv.at(-1), at };
    if (program === "nix-eval-jobs") return { kind: "eval", at };
    if (program === "nix" && argv[1] === "build") {
      const host = /-nixos-system-([a-zA-Z0-9_-]+)\.drv\^\*$/.exec(argv[2] ?? "")?.[1];
      return { kind: "build", host, at };
    }
    if (program === "ping") return { kind: "ping", host: argv.at(-1), at };

    const copyTarget = /ssh-ng:\/\/nix@([a-zA-Z0-9_-]+)/.exec(joined);
    if (copyTarget) return { kind: "copy", host: copyTarget[1], at };

    // Host-side command: through ssh, or on the deployment host itself.
    const sshTarget = argv.find((arg) => arg.startsWith("nix@"));
    const host = sshTarget?.slice(4) ?? this.options.local;
    const inner = sshTarget === undefined ? joined : (argv.at(-1) ?? "");
    if (host === undefined) throw new Error(`unsimulated command: ${joined}`);

    if (inner.includes("dnf-maintenance")) {
      return {
        kind: "maintenance",
        host,
        detail: inner.includes("dnf-maintenance on") ? "on" : "off",
        at,
      };
    }
    if (inner.includes("readlink")) return { kind: "origin", host, at };
    if (inner.includes("[ -f")) {
      const phase = PHASE_OF_RESULT.exec(inner)?.[1] as Phase | undefined;
      return {
        kind: "settle",
        host,
        phase,
        detail: inner.includes("systemctl stop") ? "armed" : "",
        at,
      };
    }
    if (inner.includes("rc=$?")) {
      const phase = ACTIVATED_PHASE.exec(inner)?.[1] as Phase | undefined;
      return { kind: "activate", host, phase, detail: ON_ACTIVE.exec(inner)?.[1], at };
    }
    if (inner.includes("systemd-run")) {
      const phase = ACTIVATED_PHASE.exec(inner)?.[1] as Phase | undefined;
      return { kind: "rollback", host, phase, at };
    }
    if (inner.includes("nix-env")) {
      const path = /\/nix\/store\/[0-9a-z]{32}-[a-zA-Z0-9+._?=-]+/.exec(
        inner.split("--set")[1] ?? "",
      )?.[0];
      return { kind: "profile", host, detail: path, at };
    }
    throw new Error(`unsimulated command: ${joined}`);
  }

  private answer(
    command: SimCommand,
    spec: CommandSpec,
    out: (line: string) => void,
    err: (line: string) => void,
  ): CommandResult {
    switch (command.kind) {
      case "status":
        if (this.pending[command.detail as Repo]) out(" M flake.lock");
        return ok();
      case "add":
        return ok();
      case "commit": {
        const repo = command.detail as Repo;
        const message = spec.argv[spec.argv.indexOf("-m") + 1] ?? "";
        this.commits.push({ repo, message });
        this.pending[repo] = false;
        return ok();
      }
      case "rev-parse":
        out(
          `${command.detail === "dnf" ? "d" : "c"}${String(this.commits.length).padStart(39, "0")}`,
        );
        return ok();
      case "flake-update":
        if (this.options.updates?.[command.detail as Repo])
          this.pending[command.detail as Repo] = true;
        return ok();
      case "realign":
        // The consumer lock follows every `dnf/` commit.
        if (this.commits.some((commit) => commit.repo === "dnf")) this.pending.consumer = true;
        return ok();
      case "clean":
        return ok();
      case "generated": {
        const file = command.detail ?? "";
        if (file.endsWith("/hosts.nix")) out(JSON.stringify(this.options.hostsJson ?? HOSTS_JSON));
        else if (file.endsWith("/network.nix")) {
          out(JSON.stringify(this.options.networkJson ?? NETWORK_JSON));
        } else return exit(1);
        return ok();
      }
      case "eval":
        return this.evaluate(spec, out, err);
      case "build":
        return this.build(command.host ?? "", out, err);
      case "ping":
        return exit(this.reachable(command.host ?? "") ? 0 : 1);
      default:
        return this.onHost(command, err, out);
    }
  }

  private evaluate(spec: CommandSpec, out: (line: string) => void, err: (line: string) => void) {
    const select = spec.argv[spec.argv.indexOf("--select") + 1] ?? "";
    const names = [...select.matchAll(/"([a-zA-Z0-9_-]+)"/g)].map((match) => match[1] ?? "");
    for (const warning of this.options.evalWarnings ?? []) err(`evaluation warning: ${warning}`);
    for (const name of names) {
      const error = this.behaviour(name).evalError;
      if (error !== undefined) {
        out(JSON.stringify({ attr: name, error }));
        continue;
      }
      out(
        JSON.stringify({
          attr: name,
          drvPath: storePath(name, ".drv"),
          outputs: { out: storePath(name) },
        }),
      );
    }
    return ok();
  }

  private build(name: string, out: (line: string) => void, err: (line: string) => void) {
    const error = this.behaviour(name).buildError;
    if (error !== undefined) {
      err(`@nix ${JSON.stringify({ action: "msg", level: 0, msg: `error: ${error}` })}`);
      return exit(1);
    }
    out(storePath(name));
    return ok(1000);
  }

  private onHost(
    command: SimCommand,
    err: (line: string) => void,
    out: (line: string) => void,
  ): CommandResult {
    const name = command.host ?? "";
    const side = this.host(name);
    const behaviour = this.behaviour(name);
    const local = name === this.options.local;
    if (!local && !this.reachable(name)) {
      err(`ssh: connect to host ${name} port 22: No route to host`);
      return exit(command.kind === "copy" ? 1 : 255);
    }

    switch (command.kind) {
      case "copy":
        return exit(behaviour.copyExit ?? 0);
      case "maintenance":
        return ok();
      case "origin":
        out(side.system);
        out(side.profile);
        return ok();
      case "profile":
        side.profile = command.detail ?? side.profile;
        side.history.push("profile set");
        return ok();
      case "activate": {
        const phase = command.phase;
        if (phase === undefined) throw new Error(`activation without phase on ${name}`);
        const code = behaviour.activation?.[phase] ?? 0;
        const target = storePath(name);
        if (code === 0 || code === 4) side.system = target;
        side.history.push(`${phase} ${code}`);
        if (command.detail !== undefined) {
          side.timers.set(phase, this.clock.now() + Number(command.detail) * 1000);
          side.history.push(`timer armed ${phase}`);
        }
        side.results.set(phase, code);
        if (behaviour.dropsOn === phase) {
          side.dropped = true;
          return exit(255);
        }
        return exit(code);
      }
      case "settle": {
        const phase = command.phase;
        if (phase === undefined) throw new Error(`settle without phase on ${name}`);
        const code = side.results.get(phase);
        if (code === undefined) return exit(3);
        out(String(code));
        if (command.detail === "armed" && side.timers.delete(phase)) {
          side.history.push(`timer cancelled ${phase}`);
        }
        return ok();
      }
      case "rollback": {
        const phase = command.phase;
        if (phase === undefined) throw new Error(`rollback without phase on ${name}`);
        const code = behaviour.rollbackExit ?? 0;
        if (code === 0) this.revert(name, phase);
        side.history.push(`rollback ${phase} ${code}`);
        return exit(code);
      }
      default:
        throw new Error(`unsimulated host command: ${command.kind}`);
    }
  }
}
