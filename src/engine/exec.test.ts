// Commands of the steps: the bounded retry a known trap asks for.

import { describe, expect, test } from "bun:test";
import { fakeRunContext, feed } from "../testing/fakes.ts";
import { execute } from "./exec.ts";
import type { Signature } from "./known-errors.ts";

const FLAKY: Signature[] = [
  {
    match: /connection reset/,
    message: "the link dropped mid-transfer",
    fix: { kind: "retry", max: 3 },
  },
];

const SPEC = { argv: ["nix", "copy"] as const, timeoutMs: 1000, killGraceMs: 10 };

const RESET = [{ stream: "stderr" as const, line: "error: connection reset by peer" }];

/** Fails with the trap `times` times, then succeeds. */
function flaky(times: number) {
  const failing = Array.from({ length: times }, () => ({
    match: ["nix"],
    exitCode: 1,
    output: RESET,
    once: true,
  }));
  return fakeRunContext({ signatures: FLAKY, commands: [...failing, { match: ["nix"] }] });
}

describe("execute", () => {
  test("a retryable trap is replayed up to its own bound, then gives up", async () => {
    const context = flaky(10);

    const execution = await execute(context, SPEC, { retryable: true });

    expect(context.commands.calls).toHaveLength(3);
    expect(execution.known?.fix).toEqual({ kind: "retry", max: 3 });
    expect(feed(context.events.events)).toEqual([
      "warn hint: the link dropped mid-transfer",
      "warn the link dropped mid-transfer, retrying",
      "warn the link dropped mid-transfer, retrying",
    ]);
  });

  test("a retry that works stops there", async () => {
    const context = flaky(1);

    const execution = await execute(context, SPEC, { retryable: true });

    expect(context.commands.calls).toHaveLength(2);
    expect(execution.result.exitCode).toBe(0);
    expect(execution.known).toBeUndefined();
  });

  // Activation, profile, commit: replaying them is not the same as retrying.
  test("a command that is not replayable runs once, trap or not", async () => {
    const context = flaky(10);

    const execution = await execute(context, SPEC);

    expect(context.commands.calls).toHaveLength(1);
    expect(execution.known?.message).toBe("the link dropped mid-transfer");
  });
});
