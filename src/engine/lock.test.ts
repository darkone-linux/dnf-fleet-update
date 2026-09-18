// Taking a busy lock: what is refused, what is asked, what is signalled.

import { describe, expect, test } from "bun:test";
import type { Event } from "../model/events.ts";
import { DEFAULT_TIMEOUTS } from "../model/params.ts";
import { drive, FakeClock, FakeLock, feed, RecordingChannel } from "../testing/fakes.ts";
import { type LockTakeover, takeLock } from "./lock.ts";
import type { EventChannel, LockHolder } from "./ports.ts";

const HOLDER: LockHolder = {
  raw: '{"pid":42}',
  pid: 42,
  startedAt: "2026-09-18T10:00:00.000Z",
  command: "bun src/main.tsx --no-ui",
};

/** Keeps every question open: the abort is what ends it. */
class PendingChannel implements EventChannel {
  readonly events: Event[] = [];
  readonly asked: string[] = [];

  emit(event: Event): void {
    this.events.push(event);
  }

  answer(id: string, signal?: AbortSignal): Promise<string> {
    this.asked.push(id);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

interface Options {
  holder?: LockHolder;
  diesOn?: readonly ("SIGTERM" | "SIGKILL")[];
  interactive?: boolean;
  answers?: Record<string, string>;
  canResume?: boolean;
  events?: EventChannel & { events: Event[] };
}

function harness(options: Options = {}) {
  const clock = new FakeClock();
  const lock = new FakeLock(options.holder, options.diesOn);
  const events = options.events ?? new RecordingChannel(options.answers);
  const controller = new AbortController();
  const env: LockTakeover = {
    lock,
    events,
    clock,
    startedAt: 0,
    interactive: options.interactive ?? false,
    signal: controller.signal,
    canResume: () => options.canResume ?? false,
  };

  // A poll round per step: the grace of a signal passes in fifty of them.
  const take = () => drive(clock, takeLock(env), 200);
  return { clock, lock, events, controller, take };
}

const kinds = (events: readonly Event[]) => events.map((event) => event.kind);

describe("takeLock", () => {
  test("free: taken straight away, nothing said", async () => {
    const { take, events } = harness();

    expect(await take()).toEqual({ kind: "taken", resume: false });
    expect(events.events).toEqual([]);
  });

  test("busy unattended: refused, the holder described, no signal sent", async () => {
    const { take, lock, events } = harness({ holder: HOLDER });

    expect(await take()).toEqual({ kind: "busy" });
    expect(feed(events.events)).toEqual([
      "error another fleet-update run holds the lock: pid 42, " +
        "started 2026-09-18T10:00:00.000Z, bun src/main.tsx --no-ui",
    ]);
    expect(lock.signals).toEqual([]);
  });

  test("busy, no pid confirmed: the raw line is shown, nothing is offered", async () => {
    const { take, events } = harness({ holder: { raw: "garbage" }, interactive: true });

    expect(await take()).toEqual({ kind: "busy" });
    expect(feed(events.events)).toEqual(["error another fleet-update run holds the lock: garbage"]);
    expect(kinds(events.events)).toEqual(["log"]);
  });

  test("interactive, holder left alone: refused without a signal", async () => {
    const { take, lock, events } = harness({
      holder: HOLDER,
      interactive: true,
      answers: { lock: "no" },
    });

    expect(await take()).toEqual({ kind: "busy" });
    expect(kinds(events.events)).toEqual(["log", "ask", "ask.close"]);
    expect(lock.signals).toEqual([]);
  });

  test("interactive: stopped by SIGTERM, then the resume accepted", async () => {
    const { take, lock, events } = harness({
      holder: HOLDER,
      diesOn: ["SIGTERM"],
      interactive: true,
      canResume: true,
      answers: { lock: "yes", resume: "yes" },
    });

    expect(await take()).toEqual({ kind: "taken", resume: true });
    expect(lock.signals).toEqual(["SIGTERM 42"]);
    expect(events.events.filter((event) => event.kind === "ask").map((event) => event.id)).toEqual([
      "lock",
      "resume",
    ]);
    expect(feed(events.events)).toContain("ok lock taken from pid 42");
  });

  test("nothing to resume: the lock is taken without a second question", async () => {
    const { take, events } = harness({
      holder: HOLDER,
      diesOn: ["SIGTERM"],
      interactive: true,
      answers: { lock: "yes" },
    });

    expect(await take()).toEqual({ kind: "taken", resume: false });
    expect(kinds(events.events)).toEqual(["log", "ask", "ask.close", "log", "log"]);
  });

  test("SIGTERM ignored: SIGKILL after the grace, lock taken", async () => {
    const { take, lock, clock, events } = harness({
      holder: HOLDER,
      diesOn: ["SIGKILL"],
      interactive: true,
      answers: { lock: "yes" },
    });

    expect(await take()).toEqual({ kind: "taken", resume: false });
    expect(lock.signals).toEqual(["SIGTERM 42", "SIGKILL 42"]);
    expect(clock.now()).toBeGreaterThanOrEqual(DEFAULT_TIMEOUTS.killGrace * 1000);
    expect(feed(events.events)).toContain("warn pid 42 still holding after 10s (SIGKILL)");
  });

  test("holder survives both signals: refused, lock never taken", async () => {
    const { take, lock, events } = harness({
      holder: HOLDER,
      interactive: true,
      answers: { lock: "yes" },
    });

    expect(await take()).toEqual({ kind: "busy" });
    expect(lock.signals).toEqual(["SIGTERM 42", "SIGKILL 42"]);
    expect(lock.held).toBe(false);
    expect(feed(events.events)).toContain("error pid 42 still holds the lock");
  });

  test("aborted while the question waits: aborted, not a rejection", async () => {
    const events = new PendingChannel();
    const { take, controller } = harness({ holder: HOLDER, interactive: true, events });
    const outcome = take();
    await Promise.resolve();
    controller.abort(new Error("run aborted"));

    expect(await outcome).toEqual({ kind: "aborted" });
    expect(events.asked).toEqual(["lock"]);
  });

  test("an answer outside the options is a bug, not an outcome", async () => {
    const { take } = harness({
      holder: HOLDER,
      interactive: true,
      answers: { lock: "maybe" },
    });

    await expect(take()).rejects.toThrow('answer "maybe" is not an option of lock');
  });
});
