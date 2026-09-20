// Simulated workspace and fleet for whole runs on fakes.
//
// One `CommandRunner` answers every command of a run from per-host behaviour
// and keeps what a real host would: current system, profile, result files,
// rollback timers firing on the fake clock. No argv script per test.

import type { Phase } from "../engine/commands/host.ts";
import { parseFleet } from "../engine/fleet.ts";
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

  /** Units `systemctl` reports as failed, once the host has been activated. */
  failedUnits?: string[];

  /** Unreachable from its activation of this phase until its rollback timer fires. */
  dropsOn?: Phase;
  rollbackExit?: number;

  /** The session of a forced rollback drops; the result file is written all the same. */
  rollbackDrops?: boolean;
}

export type SimKind =
  | "status"
  | "add"
  | "commit"
  | "rev-parse"
  | "flake-update"
  | "realign"
  | "clean"
  | "generate"
  | "path-info"
  | "path-size"
  | "generated"
  | "send-msg"
  | "eval"
  | "build"
  | "ping"
  | "copy"
  | "derivation"
  | "drop-links"
  | "pull"
  | "maintenance"
  | "origin"
  | "profile"
  | "system-status"
  | "failed-units"
  | "journal"
  | "activate"
  | "settle"
  | "rollback";

export interface SimCommand {
  kind: SimKind;
  host?: string;
  phase?: Phase;

  /** Repository, `on`/`off`, timer delay, profile path, builder: per kind. */
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
  /** Result files by name: `test`, `switch`, `rollback`. */
  results: Map<string, number>;
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

  /** Uncommitted changes before the run. */
  dirty?: { consumer?: boolean; dnf?: boolean };

  /** What the update changes, hence what gets committed. Default: nothing. */
  updates?: { consumer?: boolean; dnf?: boolean };
  hostsJson?: unknown;
  networkJson?: unknown;

  /** Exit code of `just send-msg`: `10` not configured here, `11` refused. */
  sendMsgExit?: number;
  evalWarnings?: string[];

  /** `nix-eval-jobs` fails as a whole: this error, no line, exit `1`. */
  evalFailure?: string;
}

const WORKSPACE = "/ws";

/** NAR size every path of the simulated store reports: 1 MiB. */
export const SIM_PATH_SIZE = 1_048_576;

const PUBLIC_CACHE = "https://cache.nixos.org";

type Repo = "consumer" | "dnf";

const ok = (durationMs = 0): CommandResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs,
});

const exit = (exitCode: number): CommandResult => ({ ...ok(), exitCode });

const RESULT_NAME = /fleet-update-[a-zA-Z0-9_-]+-(test|switch|rollback)\.rc/;
const ACTIVATED_PHASE = /switch-to-configuration'? (test|switch)/;
const ON_ACTIVE = /--on-active=(\d+)/;

export class SimFleet implements CommandRunner {
  readonly commands: SimCommand[] = [];
  readonly hosts = new Map<string, HostSide>();
  readonly commits: { repo: Repo; message: string }[] = [];

  /** What `just send-msg` received: room and body (`--send-report`). */
  readonly messages: { room: string; body: string }[] = [];
  private readonly pending = { consumer: false, dnf: false };
  private readonly used = new Set<SimHook>();
  private readonly collected = new Set<string>();

  constructor(
    private readonly clock: FakeClock,
    private readonly options: SimOptions = {},
  ) {
    if (options.local !== undefined) this.holding.add(options.local);
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

  /** The garbage collector took this path: `nix path-info` fails on it (`--resume`). */
  collect(path: string): void {
    this.collected.add(path);
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

  /** Hosts holding the toplevel; the deployment machine built it. */
  private readonly holding = new Set<string>();

  private behaviour(name: string): HostBehaviour {
    return this.options.behaviours?.[name] ?? {};
  }

  /**
   * Zone cache of a host, excluding the host itself: what it could pull from
   * once that cache holds the path. `undefined`: the zone has none.
   */
  private zoneCache(name: string): { host: string; url: string } | undefined {
    const fleet = parseFleet(
      this.options.hostsJson ?? HOSTS_JSON,
      this.options.networkJson ?? NETWORK_JSON,
    );
    if (!fleet.ok) return undefined;
    const zone = fleet.value.hosts.find((host) => host.name === name)?.zone;
    const server = fleet.value.services.find(
      (service) => service.name === "harmonia" && service.zone === zone,
    )?.host;
    const ip = fleet.value.hosts.find((host) => host.name === server)?.ip;
    if (server === undefined || server === name || ip === undefined) return undefined;
    return { host: server, url: `http://${ip}:5000` };
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
    if (program === "just" && argv[1] === "generate") return { kind: "generate", at };
    if (program === "just" && argv[1] === "send-msg") {
      return { kind: "send-msg", detail: argv[2], at };
    }
    if (program === "nix" && argv[1] === "path-info") {
      if (argv[2] === "--size") return { kind: "path-size", at };
      return { kind: "path-info", detail: argv[2], at };
    }
    if (program === "nix-instantiate") return { kind: "generated", detail: argv.at(-1), at };
    if (program === "nix-eval-jobs") return { kind: "eval", at };
    if (program === "nix" && argv[1] === "build") {
      const host = /-nixos-system-([a-zA-Z0-9_-]+)\.drv\^\*$/.exec(argv[2] ?? "")?.[1];
      return { kind: "build", host, at };
    }
    if (program === "ping") return { kind: "ping", host: argv.at(-1), at };

    // Both carry `--to`; a push may also carry `--from`, the builder it pulls from.
    const copyTarget = /--to ssh-ng:\/\/nix@([a-zA-Z0-9_-]+)/.exec(joined)?.[1];
    if (copyTarget !== undefined) {
      const kind = joined.includes("nix copy --derivation") ? "derivation" : "copy";
      return { kind, host: copyTarget, at };
    }

    // Host-side command: through ssh, or on the deployment host itself.
    const sshTarget = argv.find((arg) => arg.startsWith("nix@"));
    const host = sshTarget?.slice(4) ?? this.options.local;
    const inner = sshTarget === undefined ? joined : (argv.at(-1) ?? "");
    if (host === undefined) throw new Error(`unsimulated command: ${joined}`);

    // `--resume`: the path asked of the store that holds it, the builder.
    if (inner.includes("nix path-info")) {
      return { kind: "path-info", host, detail: /\/nix\/store\/\S+/.exec(inner)?.[0], at };
    }

    // Delegated build: named by the host built, run by the builder.
    if (inner.includes(".drv^*")) {
      const built = /-nixos-system-([a-zA-Z0-9_-]+)\.drv\^\*/.exec(inner)?.[1];
      return { kind: "build", host: built, detail: host, at };
    }
    if (inner.includes("rm -f")) return { kind: "drop-links", host, at };
    if (inner.includes("dnf-maintenance")) {
      return {
        kind: "maintenance",
        host,
        detail: inner.includes("dnf-maintenance on") ? "on" : "off",
        at,
      };
    }
    if (inner.includes("--max-jobs 0")) return { kind: "pull", host, at };
    if (inner.includes("readlink")) return { kind: "origin", host, at };
    if (inner.includes("systemctl status")) return { kind: "system-status", host, at };
    if (inner.includes("list-units")) return { kind: "failed-units", host, at };
    if (inner.includes("journalctl")) {
      return { kind: "journal", host, detail: /-u (\S+)/.exec(inner)?.[1], at };
    }
    const result = RESULT_NAME.exec(inner)?.[1];
    if (inner.includes("[ -f")) {
      const armed = inner.includes("systemctl stop") ? "armed" : "";
      const phase = result === "test" || result === "switch" ? result : undefined;
      return { kind: "settle", host, phase, detail: `${result} ${armed}`.trim(), at };
    }
    if (inner.includes("rc=$?")) {
      const phase = ACTIVATED_PHASE.exec(inner)?.[1] as Phase | undefined;
      if (result === "rollback") return { kind: "rollback", host, phase, at };
      return { kind: "activate", host, phase, detail: ON_ACTIVE.exec(inner)?.[1], at };
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
      case "generate":
        return ok();

      // `--resume`: a path the fleet built is in the store unless collected.
      // Asked of a builder: unreachable is no answer, hence no reuse.
      case "path-info":
        if (command.host !== undefined && !this.reachable(command.host)) {
          err(`ssh: connect to host ${command.host} port 22: No route to host`);
          return exit(255);
        }
        return exit(this.collected.has(command.detail ?? "") ? 1 : 0);

      // Volume of the copy counters: every synthetic path weighs the same.
      case "path-size":
        for (const path of spec.argv.slice(3)) out(`${path}\t${SIM_PATH_SIZE}`);
        return ok();
      case "generated": {
        const file = command.detail ?? "";
        if (file.endsWith("/hosts.nix")) out(JSON.stringify(this.options.hostsJson ?? HOSTS_JSON));
        else if (file.endsWith("/network.nix")) {
          out(JSON.stringify(this.options.networkJson ?? NETWORK_JSON));
        } else return exit(1);
        return ok();
      }

      // `--send-report`: the framework recipe, body on stdin.
      case "send-msg": {
        this.messages.push({ room: command.detail ?? "", body: spec.stdin ?? "" });
        const code = this.options.sendMsgExit ?? 0;
        if (code !== 0) err(`send-msg: exit ${code}`);
        return exit(code);
      }
      case "eval":
        return this.evaluate(spec, out, err);
      case "build":
        return this.build(command, out, err);
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
    if (this.options.evalFailure !== undefined) {
      err(`error: ${this.options.evalFailure}`);
      return exit(1);
    }
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

  private build(command: SimCommand, out: (line: string) => void, err: (line: string) => void) {
    const name = command.host ?? "";
    const builder = command.detail;

    // Delegated: the ssh to the builder fails like any other.
    if (builder !== undefined && !this.reachable(builder)) {
      err(`ssh: connect to host ${builder} port 22: No route to host`);
      return exit(255);
    }
    const error = this.behaviour(name).buildError;
    if (error !== undefined) {
      err(`@nix ${JSON.stringify({ action: "msg", level: 0, msg: `error: ${error}` })}`);
      return exit(1);
    }

    // The result stays in the builder's store: what its zone then pulls from.
    if (builder !== undefined) this.holding.add(builder);
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
      case "copy": {
        // Counters of the report: the toplevel pushed, one path the host
        // substitutes itself from the public cache (`--substitute-on-destination`).
        err(`copying path '${storePath(name)}' to 'ssh-ng://nix@${name}'...`);
        err(`copying path '${storePath(`${name}-dep`)}' from '${PUBLIC_CACHE}'...`);
        const code = behaviour.copyExit ?? 0;
        if (code !== 0) err(`error: cannot copy to '${name}'`);
        else this.holding.add(name);
        return exit(code);
      }

      // A host substitutes only what its zone cache already holds: the
      // publication seeds that cache first, the rest of the zone pulls from it.
      case "pull": {
        if (this.holding.has(name)) return ok();
        const cache = this.zoneCache(name);
        if (cache === undefined || !this.holding.has(cache.host)) {
          err(`error: path '${storePath(name)}' is not available and --max-jobs 0`);
          return exit(1);
        }
        for (const path of [storePath(name), storePath(`${name}-dep`)]) {
          err(`copying path '${path}' from '${cache.url}'...`);
        }
        this.holding.add(name);
        return ok();
      }
      case "derivation":
      case "drop-links":
      case "maintenance":
        return ok();

      // Collection of a failed host: `systemctl status` exits non-zero on a
      // degraded system, and the collection reads its output, not its code.
      case "system-status": {
        const units = behaviour.failedUnits ?? [];
        out(`State: ${units.length > 0 ? "degraded" : "running"}`);
        out(`Failed: ${units.length} units`);
        return exit(units.length > 0 ? 1 : 0);
      }
      case "failed-units":
        for (const unit of behaviour.failedUnits ?? []) {
          out(`${unit} loaded failed failed ${unit}`);
        }
        return ok();
      case "journal":
        out(`-- journal of ${command.detail ?? "?"} on ${name} --`);
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
        const [result = "", armed] = (command.detail ?? "").split(" ");
        const code = side.results.get(result);
        if (code === undefined) return exit(3);
        out(String(code));
        if (armed === "armed" && side.timers.delete(result as Phase)) {
          side.history.push(`timer cancelled ${result}`);
        }
        return ok();
      }
      case "rollback": {
        const phase = command.phase;
        if (phase === undefined) throw new Error(`rollback without phase on ${name}`);
        const code = behaviour.rollbackExit ?? 0;
        if (code === 0) this.revert(name, phase);
        side.history.push(`rollback ${phase} ${code}`);
        side.results.set("rollback", code);
        return exit(behaviour.rollbackDrops ? 255 : code);
      }
      default:
        throw new Error(`unsimulated host command: ${command.kind}`);
    }
  }
}
