// Entry point run as a process: exit codes are a contract with the systemd
// module, so they are asserted from outside.

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import { FlockLock } from "../src/adapters/lock.ts";
import { ExitCode } from "../src/model/exit-codes.ts";
import { NETWORK_JSON } from "../src/testing/fleet.ts";

const MAIN = new URL("../src/main.tsx", import.meta.url).pathname;

let workspace: string | undefined;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

/** Empty consumer root: nothing the run could deploy. */
function emptyWorkspace(): string {
  workspace = mkdtempSync(join(tmpdir(), "fleet-update-cli-"));
  return workspace;
}

function run(args: readonly string[], cwd?: string, env?: Record<string, string>) {
  const proc = Bun.spawnSync([process.execPath, "run", MAIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

test("--help prints the options, exit 0", () => {
  const result = run(["--help"]);

  expect(result.code).toBe(ExitCode.Ok);
  expect(result.stdout).toStartWith("Usage: fleet-update [options]");
});

// Packaged as `bun run <store>/src/main.tsx` from the caller's directory: JSX
// config and `package.json` must resolve from the file, never from the cwd.
test("--version prints the package version from outside the repository", () => {
  const result = run(["--version"], tmpdir());

  expect(result.code).toBe(ExitCode.Ok);
  expect(result.stdout).toBe(`${packageJson.version}\n`);
});

test("an invalid option exits 2 on stderr, nothing run", () => {
  const result = run(["--max-parallel", "0"]);

  expect(result.code).toBe(ExitCode.InvalidOptions);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--max-parallel: expected an integer >= 1");
});

test("--send-report is refused until implemented", () => {
  const result = run(["--no-ui", "--send-report"], emptyWorkspace());

  expect(result.code).toBe(ExitCode.InvalidOptions);
  expect(result.stderr).toContain("--send-report: not implemented yet");
});

// Refused by the run itself, once the lock is held: the message goes through
// the stream, like any other refusal.
test("--resume with no deployment to resume: exit 2", () => {
  const result = run(["--no-ui", "--resume"], emptyWorkspace());

  expect(result.code).toBe(ExitCode.InvalidOptions);
  expect(result.stdout).toContain("no deployment to resume");
});

test("--no-ui with the lock held elsewhere: text output, exit 4", () => {
  const root = emptyWorkspace();
  const lock = new FlockLock(join(root, "var", "deployments", "current.lock"));
  expect(lock.acquire().kind).toBe("acquired");
  try {
    const result = run(["--no-ui"], root);

    expect(result.code).toBe(ExitCode.Locked);
    expect(result.stdout).toStartWith(
      `00:00:00  another fleet-update run holds the lock: pid ${process.pid}, started `,
    );
  } finally {
    lock.release();
  }
});

// Only `network.nix` is needed to open the run directory; `git status` then
// fails on a directory that is no repository, and the run stops there.
test("--no-ui: the run directory is printed last, exit 1 on a dirty prerequisite", () => {
  const root = emptyWorkspace();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = join(bin, "nix-instantiate");
  writeFileSync(script, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(NETWORK_JSON)}\nJSON\n`);
  chmodSync(script, 0o755);

  const result = run(["--no-ui"], root, { PATH: `${bin}:${process.env.PATH}` });

  expect(result.code).toBe(ExitCode.Failed);
  expect(result.stdout.trimEnd().split("\n").at(-1)).toMatch(
    new RegExp(`^report and logs: ${join(root, "var", "deployments")}/\\d{8}T\\d{6}Z-full$`),
  );
});

// The fake `nix-instantiate` stops its caller, as systemd would, mid-command.
test("--no-ui and SIGTERM: the command is killed, exit 5, lock released", () => {
  const root = emptyWorkspace();
  const bin = join(root, "bin");
  const script = join(bin, "nix-instantiate");
  mkdirSync(bin);
  writeFileSync(script, '#!/bin/sh\nkill -TERM "$PPID"\nexec sleep 60\n');
  chmodSync(script, 0o755);

  const started = performance.now();
  const result = run(["--no-ui"], root, { PATH: `${bin}:${process.env.PATH}` });

  expect(result.code).toBe(ExitCode.Aborted);
  expect(performance.now() - started).toBeLessThan(10_000);
  const lock = new FlockLock(join(root, "var", "deployments", "current.lock"));
  expect(lock.acquire().kind).toBe("acquired");
  lock.release();
});
