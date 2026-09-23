// The free question of `a`: from the key to the tool, and back to the feed.

import { describe, expect, test } from "bun:test";
import { simulateRun } from "../../src/testing/runs.ts";

/** `ai` / `ai.line` / `ai.end`, in the order the fold reads them. */
const block = (events: Awaited<ReturnType<typeof simulateRun>>["events"]) =>
  events.flatMap((event) =>
    event.kind === "ai"
      ? [`open: ${event.message}`]
      : event.kind === "ai.line"
        ? [`line: ${event.line}`]
        : event.kind === "ai.end"
          ? ["end"]
          : [],
  );

describe("free AI question", () => {
  test("asked during the build, answered in the feed, run unaffected", async () => {
    const run = await simulateRun({
      ai: ["Nothing is wrong:", "gfx is fetching gnome-shell."],
      hooks: (flow) => [
        { kind: "build", once: true, run: () => flow.requestAi("why is gfx slow?") },
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(block(run.events)).toEqual([
      "open: why is gfx slow?",
      "line: Nothing is wrong:",
      "line: gfx is fetching gnome-shell.",
      "end",
    ]);
    expect(run.feed).toContain("info YOU: why is gfx slow?");
  });

  test("--ai-analysis: the end-of-run summary reaches report.md", async () => {
    const run = await simulateRun({
      argv: ["--no-ui", "--ai-analysis", "passive"],
      ai: ["Everything switched.", "Nothing needs a look."],
    });

    expect(run.exitCode).toBe(0);
    expect(run.recorded?.report).toContain(
      "## AI analysis\n\n### Run summary\n\nEverything switched.\nNothing needs a look.",
    );
  });

  test("the answer never lands after the end of the run", async () => {
    const run = await simulateRun({
      hooks: (flow) => [
        { kind: "build", once: true, run: () => flow.requestAi("why is gfx slow?") },
      ],
    });

    const end = run.events.findIndex((event) => event.kind === "run.end");
    expect(end).toBeGreaterThan(-1);
    expect(run.events.slice(end).some((event) => event.kind.startsWith("ai"))).toBe(false);
  });
});
