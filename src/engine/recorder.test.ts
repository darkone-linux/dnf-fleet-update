// Recorder on the recorded scenarios: what lands in the run directory.

import { describe, expect, test } from "bun:test";
import type { Event } from "../model/events.ts";
import { initialPersisted, persist } from "../model/persist.ts";
import { MemoryRunStore, RecordingChannel } from "../testing/fakes.ts";
import { Recorder, recordedChannel } from "./recorder.ts";
import { listScenarios, loadScenario } from "./replay.ts";

describe("Recorder", () => {
  for (const scenario of listScenarios()) {
    test(`${scenario}: every event, the final fold, fewer state writes than events`, () => {
      const events = loadScenario(scenario);
      const run = new MemoryRunStore("20260917T020000Z-full");
      const recorder = new Recorder(run);

      for (const event of events) recorder.record(event);

      expect(run.events).toEqual(events);
      const folded = events.reduce(persist, initialPersisted());
      expect(recorder.state).toEqual(folded);

      // The last write may predate trailing narration: only `lastEventAt` differs.
      expect({ ...run.state, lastEventAt: 0 }).toEqual({ ...folded, lastEventAt: 0 });
      expect(run.stateWrites).toBeLessThan(events.length);
    });
  }

  test("host output goes to the log of its host and phase, narration to no state write", () => {
    const run = new MemoryRunStore("20260917T020000Z-full");
    const recorder = new Recorder(run);
    const events: Event[] = [
      { t: 0, kind: "host.add", host: "gw-ag", profile: "gateway", zone: "ag" },
      { t: 1, kind: "host.output", host: "gw-ag", phase: "copy", line: "copying 3 paths" },
      { t: 2, kind: "log", level: "info", message: "waiting" },
      { t: 3, kind: "host.output", host: "gw-ag", phase: "test", line: "starting units" },
    ];

    for (const event of events) recorder.record(event);

    expect(Object.fromEntries(run.logs)).toEqual({
      "gw-ag.copy": ["copying 3 paths"],
      "gw-ag.test": ["starting units"],
    });
    expect(run.stateWrites).toBe(1);
  });
});

describe("recordedChannel", () => {
  test("records before forwarding, answers pass through", async () => {
    const run = new MemoryRunStore("20260917T020000Z-full");
    const consumer = new RecordingChannel({ switch: "yes" });
    const seen: number[] = [];
    const channel = recordedChannel(
      {
        emit: (event) => {
          seen.push(run.events.length);
          consumer.emit(event);
        },
        answer: (id) => consumer.answer(id),
      },
      new Recorder(run),
    );

    channel.emit({ t: 0, kind: "log", level: "info", message: "hello" });

    expect(seen).toEqual([1]);
    expect(await channel.answer("switch")).toBe("yes");
  });
});
