// Fakes behave like the ports they stand for: engine tests rely on it.

import { describe, expect, test } from "bun:test";
import type { OutputLine } from "../engine/ports.ts";
import { FakeLock, fakeContext, MemoryDeploymentStore } from "./fakes.ts";

const BOUNDS = { timeoutMs: 1000, killGraceMs: 100 };

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
      { argv: ["nix", "build", "/nix/store/x.drv^*"], ...BOUNDS },
      { onLine: (line) => lines.push(line) },
    );

    expect(result.exitCode).toBe(1);
    expect(lines).toEqual([{ stream: "stderr", line: "building" }]);
    expect(context.commands.calls.map((call) => call.argv[1])).toEqual(["build"]);
  });

  test("a timeout reads as killed, not as an exit code", async () => {
    const context = fakeContext({ commands: [{ match: ["ssh"], timedOut: true }] });

    const result = await context.commands.run({ argv: ["ssh", "nix@hcs"], ...BOUNDS });

    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true });
  });

  test("an unscripted command fails the test", async () => {
    const context = fakeContext();

    await expect(context.commands.run({ argv: ["git", "status"], ...BOUNDS })).rejects.toThrow(
      "unscripted command: git status",
    );
  });
});

describe("FakeCommands scripts", () => {
  test("once: consumed, the next matching script answers later calls", async () => {
    const context = fakeContext({
      commands: [
        { match: ["ping"], exitCode: 1, once: true },
        { match: ["ping"], exitCode: 0 },
      ],
    });
    const ping = () => context.commands.run({ argv: ["ping", "gw-ag"], ...BOUNDS });

    expect((await ping()).exitCode).toBe(1);
    expect((await ping()).exitCode).toBe(0);
    expect((await ping()).exitCode).toBe(0);
  });

  test("gate holds the command; an abort ends it by SIGTERM; already aborted rejects", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = fakeContext({ commands: [{ match: ["nix", "copy"], gate }] });

    const held = context.commands.run({ argv: ["nix", "copy"], ...BOUNDS });
    const aborted = context.commands.run(
      { argv: ["nix", "copy"], ...BOUNDS },
      { signal: context.signal },
    );
    context.abort.abort(new Error("now"));

    expect(await aborted).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    release();
    expect(await held).toMatchObject({ exitCode: 0 });
    await expect(
      context.commands.run({ argv: ["nix", "copy"], ...BOUNDS }, { signal: context.signal }),
    ).rejects.toThrow("now");
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

describe("MemoryDeploymentStore", () => {
  test("one run per mode and date, logs named like their files", () => {
    const store = new MemoryDeploymentStore();
    const run = store.create("full");

    run.appendLog({ host: "gw-ag", phase: "copy" }, "copying path");
    run.appendLog({ phase: "clean" }, "formatting");

    expect(run.id).toBe("20260917T020000Z-full");
    expect([...run.logs.keys()]).toEqual(["gw-ag.copy", "clean"]);
    expect(() => run.appendLog({ host: "../x", phase: "copy" }, "")).toThrow("unsafe log name");
    expect(() => store.create("full")).toThrow("run exists");
  });
});

describe("FakeLock", () => {
  const holder = { raw: '{"pid":42}', pid: 42 };

  test("free, then held; busy with a holder", () => {
    const lock = new FakeLock();

    expect(lock.acquire()).toEqual({ kind: "acquired" });
    expect(() => lock.acquire()).toThrow("already held");
    lock.release();
    expect(lock.acquire()).toEqual({ kind: "acquired" });
    expect(new FakeLock(holder).acquire()).toEqual({ kind: "busy", holder });
  });

  test("the holder dies on the signals it answers to, and frees the lock", () => {
    const lock = new FakeLock(holder, ["SIGKILL"]);

    expect(lock.stopHolder(42, "SIGTERM")).toBe(true);
    expect(lock.acquire()).toEqual({ kind: "busy", holder });
    expect(lock.stopHolder(42, "SIGKILL")).toBe(true);
    expect(lock.acquire()).toEqual({ kind: "acquired" });
    expect(lock.stopHolder(42, "SIGTERM")).toBe(false);
    expect(lock.signals).toEqual(["SIGTERM 42", "SIGKILL 42", "SIGTERM 42"]);
  });
});
