// Entry point run as a process: exit codes are a contract with the systemd
// module, so they are asserted from outside.

import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ExitCode } from "../src/model/exit-codes.ts";

const MAIN = new URL("../src/main.tsx", import.meta.url).pathname;

function run(args: readonly string[], cwd?: string) {
  const proc = Bun.spawnSync([process.execPath, "run", MAIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

test("--list prints the scenarios and exits cleanly", () => {
  const result = run(["--list"]);

  expect(result.code).toBe(ExitCode.Ok);
  expect(result.stdout.split("\n")).toContain("nominal");
});

test("an unknown scenario is an invalid option", () => {
  const result = run(["no-such-scenario"]);

  expect(result.code).toBe(ExitCode.InvalidOptions);
  expect(result.stderr).toContain("unknown scenario: no-such-scenario");
});

// Packaged as `bun run <store>/src/main.tsx` from the caller's directory: JSX
// config and scenarios must resolve from the file, never from the cwd.
test("runs from outside the repository, as packaged", () => {
  const result = run(["--list"], tmpdir());

  expect(result.code).toBe(ExitCode.Ok);
  expect(result.stdout.split("\n")).toContain("nominal");
});
