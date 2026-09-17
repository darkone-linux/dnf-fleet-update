// Replay entry point run as a process: `just mock` and `just scenarios`.

import { expect, test } from "bun:test";
import { ExitCode } from "../src/model/exit-codes.ts";

const MOCK = new URL("../src/testing/mock.tsx", import.meta.url).pathname;

function run(args: readonly string[]) {
  const proc = Bun.spawnSync([process.execPath, "run", MOCK, ...args], {
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
