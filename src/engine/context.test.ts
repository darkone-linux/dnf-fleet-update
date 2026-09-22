// Run context helpers: `t` stamping, one question at a time, answers checked.

import { describe, expect, test } from "bun:test";
import { fakeRunContext, feed } from "../testing/fakes.ts";
import { ask, disableAi, emit, log, YES_NO } from "./context.ts";
import { describeFailure } from "./exec.ts";

describe("context", () => {
  test("t counts from the run start, rounded", () => {
    const context = { ...fakeRunContext(), startedAt: 1000 };
    context.clock.advance(2500.4);

    emit(context, { kind: "plan", waves: [] });
    log(context, "warn", "slow", "gw-ag");

    expect(context.events.events).toEqual([
      { t: 1500, kind: "plan", waves: [] },
      { t: 1500, kind: "log", level: "warn", host: "gw-ag", message: "slow" },
    ]);
  });

  test("questions are asked one at a time, closed with their answer", async () => {
    const context = fakeRunContext({ answers: { a: "yes", b: "no" } });

    const answers = await Promise.all([
      ask(context, "a", "First?", YES_NO),
      ask(context, "b", "Second?", YES_NO),
    ]);

    expect(answers).toEqual(["yes", "no"]);
    expect(
      context.events.events.map((event) => `${event.kind} ${"id" in event ? event.id : ""}`),
    ).toEqual(["ask a", "ask.close a", "ask b", "ask.close b"]);
  });

  test("an answer outside the options is a bug", async () => {
    const context = fakeRunContext({ answers: { a: "maybe" } });

    await expect(ask(context, "a", "First?", YES_NO)).rejects.toThrow('answer "maybe"');
    expect(feed(context.events.events)).toEqual([]);
  });
});

describe("describeFailure", () => {
  const result = { exitCode: 1, signal: null, timedOut: false, durationMs: 0 };

  test("cause, then the last non-empty stderr line, shortened", () => {
    expect(describeFailure({ result, stdout: [], stderr: ["error: x", "  "] })).toBe(
      "exit 1: error: x",
    );
    expect(describeFailure({ result: { ...result, timedOut: true }, stdout: [], stderr: [] })).toBe(
      "timed out",
    );
    const long = describeFailure({ result, stdout: [], stderr: ["e".repeat(300)] });
    expect(long).toHaveLength("exit 1: ".length + 161);
  });

  test("a signal without exit code", () => {
    const killed = { ...result, exitCode: null, signal: "SIGTERM" };
    expect(describeFailure({ result: killed, stdout: [], stderr: [] })).toBe("killed by SIGTERM");
  });
});

describe("AI gate", () => {
  test("closing says it once, at the feed and at the report", () => {
    const context = fakeRunContext();
    expect(context.ai.open).toBe(true);

    disableAi(context, "claude not found");
    disableAi(context, "claude not found");
    disableAi(context, "another reason entirely");

    expect(context.ai.open).toBe(false);
    expect(feed(context.events.events)).toEqual(["warn AI unavailable: claude not found"]);
    expect(context.events.events.filter((event) => event.kind === "note")).toEqual([
      { t: 0, kind: "note", message: "AI unavailable: claude not found" },
    ]);
  });
});
