// Argv builders: the commands are the contract (spec § Exécution), asserted
// verbatim; quoting checked by a real POSIX shell, never by eye.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUTS as T } from "../../model/params.ts";
import {
  activate,
  asNix,
  copyClosure,
  maintenance,
  onHost,
  parseOrigin,
  ping,
  readOrigin,
  rollbackNow,
  rollbackScript,
  rollbackUnit,
  SETTLE_PENDING,
  setProfile,
  settleResult,
} from "./host.ts";
import { buildHost, evalHosts, selectExpression } from "./nix.ts";
import { shellJoin, shellQuote } from "./shell.ts";
import { flakeUpdate, justClean, readGenerated, realignDnfLock, sendMessage } from "./workspace.ts";

const NEW = "/nix/store/jq1s2fmaq2pnv5f233sfkhmjm0lzqgcm-nixos-system-gw-ag-26.11";
const OLD = "/nix/store/0h15zmc3vn75j3w5b2yc4m0j2rxwdzlg-nixos-system-gw-ag-26.05";
const DRV = "/nix/store/mfm2y1k08lnq8cfqdjiz92bjzkzfn575-nixos-system-gw-ag-26.11.drv";
const ORIGIN = { system: OLD, profile: OLD };

/** Deploy identity, login shell included: the prefix of every command as `nix`. */
const AS_NIX = ["sudo", "-n", "-u", "nix", "-H", "--", "/bin/sh", "-lc", 'exec "$0" "$@"'] as const;

/** Words as `/bin/sh` splits the command line. */
function shellWords(line: string): string[] {
  const out = Bun.spawnSync(["sh", "-c", `printf '%s\\0' ${line}`], { stdout: "pipe" });
  return out.stdout.toString().split("\0").slice(0, -1);
}

describe("shell quoting", () => {
  const tricky = [
    "plain",
    "",
    "a b",
    "it's",
    "$(reboot)",
    "`id`",
    "a\nb",
    "semi;colon",
    "*",
    '"q"',
  ];

  test("every word survives the shell unchanged", () => {
    expect(shellWords(shellJoin(tricky))).toEqual(tricky);
  });

  test("inert words stay bare", () => {
    expect(shellQuote("nix@gw-ag")).toBe("nix@gw-ag");
    expect(shellQuote("--kill-after=10")).toBe("--kill-after=10");
    expect(shellQuote("a b")).toBe("'a b'");
  });
});

describe("deploy identity", () => {
  test("sudo as nix, bounded on the nix side, the runner acting only past it", () => {
    expect(asNix(["nix", "copy"], 60, T)).toEqual({
      argv: [...AS_NIX, "timeout", "--kill-after=10", "60", "nix", "copy"],
      timeoutMs: 80_000,
      killGraceMs: 20_000,
    });
  });

  test("nix copy of the built path", () => {
    expect(copyClosure("gw-ag", NEW, T).argv).toEqual([
      ...AS_NIX,
      "timeout",
      "--kill-after=10",
      "3600",
      "env",
      "NIX_SSHOPTS=-o BatchMode=yes -o ConnectTimeout=30",
      "nix",
      "copy",
      "--substitute-on-destination",
      "--no-check-sigs",
      "--to",
      "ssh-ng://nix@gw-ag",
      NEW,
    ]);
  });
});

describe("placement", () => {
  const remote = { host: "gw-ag", local: false };
  const local = { host: "gfx", local: true };

  test("remote: ssh as nix, the host-side command bounded and quoted", () => {
    const spec = onHost(remote, setProfile(NEW, T), T);
    const words = AS_NIX.length;
    expect(spec.argv.slice(0, words + 8)).toEqual([
      ...AS_NIX,
      "timeout",
      "--kill-after=10",
      "60",
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=30",
    ]);
    expect(spec.argv[words + 8]).toBe("nix@gw-ag");
    expect(shellWords(spec.argv[words + 9]!)).toEqual([
      "sudo",
      "-n",
      "timeout",
      "--kill-after=10",
      "30",
      "nix-env",
      "-p",
      "/nix/var/nix/profiles/system",
      "--set",
      NEW,
    ]);
    expect(spec.argv).toHaveLength(words + 10);
  });

  test("local: same command, no ssh, sudo only when root", () => {
    expect(onHost(local, setProfile(NEW, T), T).argv).toEqual([
      "sudo",
      "-n",
      "timeout",
      "--kill-after=10",
      "30",
      "nix-env",
      "-p",
      "/nix/var/nix/profiles/system",
      "--set",
      NEW,
    ]);
    expect(onHost(local, setProfile(NEW, T), T)).toMatchObject({
      timeoutMs: 50_000,
      killGraceMs: 20_000,
    });
    expect(onHost(local, readOrigin(T), T).argv).toEqual([
      "timeout",
      "--kill-after=10",
      "30",
      "readlink",
      "-f",
      "/run/current-system",
      "/nix/var/nix/profiles/system",
    ]);
  });

  test("ping waits for one answer", () => {
    expect(ping("fd-01", T)).toEqual({
      argv: ["ping", "-c", "2", "-W", String(T.ping), "fd-01"],
      timeoutMs: (T.ping + T.killGrace) * 1000,
      killGraceMs: T.killGrace * 1000,
    });
  });

  test("no argv carries a locale-dependent decimal", () => {
    // iputils parses numbers with the locale: `fr_FR` refuses `-i 0.3`.
    expect(ping("fd-01", T).argv.filter((arg) => /^\d+[.,]\d+$/.test(arg))).toEqual([]);
  });

  test("unvalidated host names or paths are programmer errors", () => {
    expect(() => onHost({ host: "a;reboot", local: false }, readOrigin(T), T)).toThrow();
    expect(() => copyClosure("gw-ag", `${NEW} ${OLD}`, T)).toThrow();
    expect(() => setProfile("/tmp/system", T)).toThrow();
    expect(() => rollbackUnit("run 1", "test")).toThrow();
  });
});

describe("activation", () => {
  const RUN = "20260917T020000Z-full";

  /** Script of `systemd-run … /bin/sh -c <script>`, one line per item. */
  const scriptLines = (argv: readonly string[]) => {
    expect(argv.slice(0, 6)).toEqual([
      "systemd-run",
      "--wait",
      "--pipe",
      "--collect",
      "/bin/sh",
      "-c",
    ]);
    // Syntax only: `-n` reads the script without running it.
    expect(Bun.spawnSync(["sh", "-n", "-c", argv[6]!]).exitCode).toBe(0);
    return argv[6]!.split("\n");
  };

  test("with rollback: activation, timer armed whatever the result, then the result file", () => {
    const command = activate(NEW, "test", { runId: RUN, origin: ORIGIN, rollbackAfter: 600 }, T);
    expect(command).toMatchObject({ root: true, seconds: 300 });

    const lines = scriptLines(command.argv);
    expect(lines).toHaveLength(5);
    expect(shellWords(lines[0]!)).toEqual([`${NEW}/bin/switch-to-configuration`, "test"]);
    expect(lines[1]).toBe("rc=$?");
    expect(shellWords(lines[2]!)).toEqual([
      `${NEW}/sw/bin/systemd-run`,
      "--on-active=600",
      `--unit=fleet-update-rollback-${RUN}-test`,
      "/bin/sh",
      "-c",
      `${OLD}/bin/switch-to-configuration test`,
    ]);
    expect(lines[3]).toBe(`echo "$rc" > /run/fleet-update-${RUN}-test.rc`);
    expect(lines[4]).toBe('exit "$rc"');
  });

  test("rollback disabled or deployment host: no timer, the result file all the same", () => {
    const lines = scriptLines(
      activate(NEW, "switch", { runId: RUN, origin: ORIGIN, rollbackAfter: 0 }, T).argv,
    );
    expect(lines).toEqual([
      `${NEW}/bin/switch-to-configuration switch`,
      "rc=$?",
      `echo "$rc" > /run/fleet-update-${RUN}-switch.rc`,
      'exit "$rc"',
    ]);
  });

  test("rolling back a switch restores the profile before switching", () => {
    const origin = { system: OLD, profile: NEW.replace("gw-ag-26.11", "gw-ag-26.05-boot") };
    const script = rollbackScript(origin, "switch");
    const [profile, activation] = script.split(" && ");
    expect(shellWords(profile!)).toEqual([
      `${OLD}/sw/bin/nix-env`,
      "-p",
      "/nix/var/nix/profiles/system",
      "--set",
      origin.profile,
    ]);
    expect(shellWords(activation!)).toEqual([
      `${origin.profile}/bin/switch-to-configuration`,
      "switch",
    ]);
  });

  test("forced rollback: the same reactivation under systemd-run, at once, its result kept", () => {
    const lines = scriptLines(rollbackNow(RUN, ORIGIN, "test", T).argv);
    expect(lines).toEqual([
      `${OLD}/bin/switch-to-configuration test`,
      "rc=$?",
      `echo "$rc" > /run/fleet-update-${RUN}-rollback.rc`,
      'exit "$rc"',
    ]);
  });

  test("settle: result printed, timer of the same run and phase stopped", () => {
    const armed = settleResult(RUN, "switch", true, T);
    expect(armed).toMatchObject({ root: true, seconds: 30 });
    expect(armed.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(armed.argv[2]!.split(" && ")).toEqual([
      `[ -f /run/fleet-update-${RUN}-switch.rc ] || exit ${SETTLE_PENDING}`,
      `cat /run/fleet-update-${RUN}-switch.rc`,
      `systemctl stop fleet-update-rollback-${RUN}-switch.timer`,
    ]);
    expect(settleResult(RUN, "test", false, T).argv[2]!.split(" && ")).toHaveLength(2);
    expect(settleResult(RUN, "rollback", false, T).argv[2]).toBe(
      `[ -f /run/fleet-update-${RUN}-rollback.rc ] || exit ${SETTLE_PENDING} && cat /run/fleet-update-${RUN}-rollback.rc`,
    );
    expect(() => settleResult(RUN, "rollback", true, T)).toThrow("arms no timer");
  });

  test("settle on a real shell: pending without the file, the code once written", () => {
    const script = settleResult(RUN, "test", false, T).argv[2]!;
    const dir = mkdtempSync(join(tmpdir(), "fleet-update-settle-"));
    const local = script.replaceAll("/run/", `${dir}/`);
    try {
      expect(Bun.spawnSync(["sh", "-c", local]).exitCode).toBe(SETTLE_PENDING);
      Bun.spawnSync(["sh", "-c", `echo 4 > ${dir}/fleet-update-${RUN}-test.rc`]);
      const done = Bun.spawnSync(["sh", "-c", local]);
      expect([done.exitCode, done.stdout.toString()]).toEqual([0, "4\n"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maintenance flag needs root", () => {
    expect(maintenance(true, T)).toEqual({
      argv: ["dnf-maintenance", "on"],
      root: true,
      seconds: 30,
    });
  });
});

describe("origin", () => {
  test("two store paths", () => {
    expect(parseOrigin(`${OLD}\n${NEW}\n`)).toEqual({
      ok: true,
      value: { system: OLD, profile: NEW },
    });
  });

  test("anything else is refused", () => {
    for (const stdout of ["", OLD, `${OLD}\n/etc/nixos\n`, `${OLD}\n${NEW}\n${NEW}`]) {
      expect({ stdout, ok: parseOrigin(stdout).ok }).toEqual({ stdout, ok: false });
    }
  });
});

describe("build", () => {
  test("one evaluation of the selected toplevels", () => {
    const spec = evalHosts("/etc/nixos", ["hcs", "gw-ag"], T);
    expect(spec.argv).toEqual([
      "nix-eval-jobs",
      "--flake",
      "/etc/nixos#nixosConfigurations",
      "--select",
      `cfgs: builtins.listToAttrs (map (name: { inherit name; value = cfgs.$${"{"}name}.config.system.build.toplevel; }) [ "hcs" "gw-ag" ])`,
      "--workers",
      "4",
      "--max-memory-size",
      "4096",
    ]);
    expect(spec.timeoutMs).toBe(1_200_000);
    expect(() => selectExpression(['x" ]; builtins.abort "'])).toThrow();
  });

  test("the derivation of the evaluation, logs as internal-json, GC root kept", () => {
    expect(buildHost(DRV, "/etc/nixos/var/deployments/r/result-gw-ag", T).argv).toEqual([
      "nix",
      "build",
      `${DRV}^*`,
      "--log-format",
      "internal-json",
      "--out-link",
      "/etc/nixos/var/deployments/r/result-gw-ag",
      "--print-out-paths",
    ]);
  });
});

describe("workspace", () => {
  test("just runs quiet in the workspace", () => {
    expect(justClean("/etc/nixos", T)).toEqual({
      argv: ["just", "clean"],
      cwd: "/etc/nixos",
      env: { QUIET: "1" },
      timeoutMs: 60_000,
      killGraceMs: 10_000,
    });
  });

  // `--refresh`: without it the fetch cache of nix kept an input eight days old.
  test("flake update refreshes every input of the repository", () => {
    expect(flakeUpdate("/etc/nixos/dnf", T)).toEqual({
      argv: ["nix", "flake", "update", "--refresh"],
      cwd: "/etc/nixos/dnf",
      timeoutMs: 120_000,
      killGraceMs: 10_000,
    });
  });

  // Rooms and token stay in the framework recipe; the text never hits argv.
  test("an alert message goes to the framework recipe, body on stdin", () => {
    expect(sendMessage("/etc/nixos", "incidents", "**fleet-update**", T)).toEqual({
      argv: ["just", "send-msg", "incidents"],
      cwd: "/etc/nixos",
      stdin: "**fleet-update**",
      timeoutMs: 30_000,
      killGraceMs: 10_000,
    });
  });

  test("codev lock realignment and generated data", () => {
    expect(realignDnfLock("/etc/nixos", T).argv).toEqual(["nix", "flake", "update", "dnf"]);
    expect(readGenerated("/etc/nixos", "hosts.nix", T).argv).toEqual([
      "nix-instantiate",
      "--eval",
      "--strict",
      "--json",
      "/etc/nixos/var/generated/hosts.nix",
    ]);
  });
});
