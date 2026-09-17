// Argv builders: the commands are the contract (spec § Exécution), asserted
// verbatim; quoting checked by a real POSIX shell, never by eye.

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUTS as T } from "../../cli/options.ts";
import {
  activate,
  asNix,
  cancelRollback,
  copyClosure,
  maintenance,
  onHost,
  parseOrigin,
  ping,
  readOrigin,
  rollbackScript,
  rollbackUnit,
  setProfile,
} from "./host.ts";
import { buildHost, evalHosts, selectExpression } from "./nix.ts";
import { shellJoin, shellQuote } from "./shell.ts";
import { justClean, readGenerated, realignDnfLock } from "./workspace.ts";

const NEW = "/nix/store/jq1s2fmaq2pnv5f233sfkhmjm0lzqgcm-nixos-system-gw-ag-26.11";
const OLD = "/nix/store/0h15zmc3vn75j3w5b2yc4m0j2rxwdzlg-nixos-system-gw-ag-26.05";
const DRV = "/nix/store/mfm2y1k08lnq8cfqdjiz92bjzkzfn575-nixos-system-gw-ag-26.11.drv";
const ORIGIN = { system: OLD, profile: OLD };

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
      argv: ["sudo", "-n", "-u", "nix", "-H", "timeout", "--kill-after=10", "60", "nix", "copy"],
      timeoutMs: 80_000,
      killGraceMs: 20_000,
    });
  });

  test("nix copy of the built path", () => {
    expect(copyClosure("gw-ag", NEW, T).argv).toEqual([
      "sudo",
      "-n",
      "-u",
      "nix",
      "-H",
      "timeout",
      "--kill-after=10",
      "3600",
      "env",
      "NIX_SSHOPTS=-o BatchMode=yes -o ConnectTimeout=30",
      "nix",
      "copy",
      "--substitute-on-destination",
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
    expect(spec.argv.slice(0, 13)).toEqual([
      "sudo",
      "-n",
      "-u",
      "nix",
      "-H",
      "timeout",
      "--kill-after=10",
      "60",
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=30",
    ]);
    expect(spec.argv[13]).toBe("nix@gw-ag");
    expect(shellWords(spec.argv[14]!)).toEqual([
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
    expect(spec.argv).toHaveLength(15);
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
      argv: ["ping", "-c", "1", "-W", "5", "fd-01"],
      timeoutMs: 15_000,
      killGraceMs: 10_000,
    });
  });

  test("unvalidated host names or paths are programmer errors", () => {
    expect(() => onHost({ host: "a;reboot", local: false }, readOrigin(T), T)).toThrow();
    expect(() => copyClosure("gw-ag", `${NEW} ${OLD}`, T)).toThrow();
    expect(() => setProfile("/tmp/system", T)).toThrow();
    expect(() => rollbackUnit("run 1", "test")).toThrow();
  });
});

describe("activation", () => {
  test("without rollback: the spec command, verbatim", () => {
    expect(activate(NEW, "switch", undefined, T)).toEqual({
      argv: [
        "systemd-run",
        "--wait",
        "--pipe",
        "--collect",
        `${NEW}/bin/switch-to-configuration`,
        "switch",
      ],
      root: true,
      seconds: 300,
    });
    const disabled = activate(NEW, "test", { runId: "r", origin: ORIGIN, after: 0 }, T);
    expect(disabled.argv.at(-1)).toBe("test");
  });

  test("with rollback: activation, then the timer armed whatever the result", () => {
    const command = activate(
      NEW,
      "test",
      { runId: "20260917-040000-full", origin: ORIGIN, after: 600 },
      T,
    );
    expect(command.argv.slice(0, 6)).toEqual([
      "systemd-run",
      "--wait",
      "--pipe",
      "--collect",
      "/bin/sh",
      "-c",
    ]);

    const lines = command.argv[6]!.split("\n");
    expect(lines).toHaveLength(4);
    expect(shellWords(lines[0]!)).toEqual([`${NEW}/bin/switch-to-configuration`, "test"]);
    expect(lines[1]).toBe("rc=$?");
    expect(shellWords(lines[2]!)).toEqual([
      `${NEW}/sw/bin/systemd-run`,
      "--on-active=600",
      "--unit=fleet-update-rollback-20260917-040000-full-test",
      "/bin/sh",
      "-c",
      `${OLD}/bin/switch-to-configuration test`,
    ]);
    expect(lines[3]).toBe('exit "$rc"');

    // Syntax only: `-n` reads the script without running it.
    expect(Bun.spawnSync(["sh", "-n", "-c", command.argv[6]!]).exitCode).toBe(0);
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

  test("cancel stops the timer of the same run and phase", () => {
    expect(cancelRollback("20260917-040000-full", "switch", T).argv).toEqual([
      "systemctl",
      "stop",
      "fleet-update-rollback-20260917-040000-full-switch.timer",
    ]);
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
