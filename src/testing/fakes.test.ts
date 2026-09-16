// Fakes behave like the ports they stand for: engine tests rely on it.

import { describe, expect, test } from "bun:test";
import type { OutputLine } from "../engine/ports.ts";
import { fakeContext } from "./fakes.ts";

describe("FakeCommands", () => {
  test("replies with the first script matching the argv prefix", async () => {
    const context = fakeContext({
      commands: [
        { match: ["nix", "build"], output: [{ stream: "stderr", line: "building" }], exitCode: 1 },
        { match: ["nix"], exitCode: 0 },
      ],
    });
    const lines: OutputLine[] = [];

    const result = await context.commands.run(
      { argv: ["nix", "build", "/nix/store/x.drv^*"] },
      { onLine: (line) => lines.push(line) },
    );

    expect(result.exitCode).toBe(1);
    expect(lines).toEqual([{ stream: "stderr", line: "building" }]);
    expect(context.commands.calls.map((call) => call.argv[1])).toEqual(["build"]);
  });

  test("a timeout reads as killed, not as an exit code", async () => {
    const context = fakeContext({ commands: [{ match: ["ssh"], timedOut: true }] });

    const result = await context.commands.run({ argv: ["ssh", "nix@hcs"] });

    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true });
  });

  test("an unscripted command fails the test", async () => {
    const context = fakeContext();

    await expect(context.commands.run({ argv: ["git", "status"] })).rejects.toThrow(
      "unscripted command: git status",
    );
  });
});

describe("FakeClock", () => {
  test("releases sleepers only once time reaches them", async () => {
    const { clock } = fakeContext();
    const woken: number[] = [];
    const first = clock.sleep(600_000).then(() => woken.push(1));
    const second = clock.sleep(10_000).then(() => woken.push(2));

    clock.advance(10_000);
    await second;
    expect(woken).toEqual([2]);

    clock.advance(590_000);
    await first;
    expect(woken).toEqual([2, 1]);
    expect(clock.now()).toBe(600_000);
  });

  test("an abort interrupts a pending sleep", async () => {
    const context = fakeContext();
    const sleeping = context.clock.sleep(600_000, context.signal);

    context.abort.abort(new Error("aborted now"));

    await expect(sleeping).rejects.toThrow("aborted now");
  });
});

describe("RecordingChannel", () => {
  test("records events and answers scripted questions only", async () => {
    const { events } = fakeContext({ answers: { switch: "yes" } });

    events.emit({ t: 0, kind: "log", level: "info", message: "hello" });

    expect(events.events).toHaveLength(1);
    expect(await events.answer("switch")).toBe("yes");
    await expect(events.answer("repair")).rejects.toThrow("unanswered question: repair");
  });
});
