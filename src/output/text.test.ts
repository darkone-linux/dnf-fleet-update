import { expect, test } from "bun:test";
import type { Event } from "../model/events.ts";
import { loadScenario } from "../testing/replay.ts";
import { textLines } from "./text.ts";

const print = (events: readonly Event[]) => events.flatMap(textLines);

test("feed lines with the elapsed time, step titles and the report", () => {
  const events: Event[] = [
    { t: 0, kind: "step.start", step: "build", total: 2 },
    { t: 31_000, kind: "log", level: "ok", host: "gw-ag", message: "build ok 2.6s" },
    { t: 40_000, kind: "wave.start", index: 1, total: 3, hosts: ["hcs"] },
    { t: 3_725_000, kind: "log", level: "error", message: "run stopped" },
    { t: 3_726_000, kind: "run.end", status: "failed", exitCode: 1, report: ["1 failed (hcs)"] },
  ];

  expect(print(events)).toEqual([
    "Build",
    "00:00:31  gw-ag · build ok 2.6s",
    "00:00:40  wave 1/3: hcs",
    "01:02:05  run stopped",
    "1 failed (hcs)",
  ]);
});

test("AI answers indented under their title, streamed or one-shot", () => {
  const events: Event[] = [
    { t: 1000, kind: "ai", id: "a", message: "analysing nlt" },
    { t: 1100, kind: "ai.line", id: "a", line: "nginx.service failed" },
    { t: 1200, kind: "ai.end", id: "a" },
    { t: 2000, kind: "ai", message: "done", detail: ["one", "two"] },
  ];

  expect(print(events)).toEqual([
    "00:00:01  AI analysing nlt",
    "  nginx.service failed",
    "00:00:02  AI done",
    "  one",
    "  two",
  ]);
});

test("no raw command output, no question, no structured event", () => {
  const silent = new Set([
    "host.output",
    "host.state",
    "host.presence",
    "ask",
    "ask.close",
    "plan",
    "commit",
  ]);
  const events = loadScenario("nominal").filter((event) => silent.has(event.kind));

  expect(events.some((event) => event.kind === "host.output")).toBe(true);
  expect(print(events)).toEqual([]);
});
