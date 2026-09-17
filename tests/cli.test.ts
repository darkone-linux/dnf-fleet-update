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

// Packaged as `bun run <store>/src/main.tsx` from the caller's directory: JSX
// config and scenarios must resolve from the file, never from the cwd.
test("runs from outside the repository, as packaged", () => {
  const result = run(["--list"], tmpdir());

  expect(result.code).toBe(ExitCode.Ok);
  expect(result.stdout.split("\n")).toContain("nominal");
});
