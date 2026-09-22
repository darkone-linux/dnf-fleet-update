// One AI question: what the feed gets, and what closes the gate for the run.

import { describe, expect, test } from "bun:test";
import { fakeRunContext, feed } from "../testing/fakes.ts";
import { askAi } from "./session.ts";

const QUESTION = { id: "a1", summary: "why nginx failed on nlt", prompt: "why?" };

const answered = (...lines: string[]) => ({
  match: ["claude"],
  output: lines.map((line) => ({ stream: "stdout" as const, line })),
});

/** `ai` / `ai.line` / `ai.end` in order, as the fold and the interface read them. */
const block = (context: ReturnType<typeof fakeRunContext>) =>
  context.events.events.flatMap((event) =>
    event.kind === "ai"
      ? [`open ${event.id}: ${event.message}`]
      : event.kind === "ai.line"
        ? [`line ${event.id}: ${event.line}`]
        : event.kind === "ai.end"
          ? [`end ${event.id}`]
          : [],
  );

describe("askAi", () => {
  test("streams the answer, one event per line, and returns it", async () => {
    const context = fakeRunContext({ commands: [answered("Nginx could not", "read its cert.")] });

    expect(await askAi(context, QUESTION)).toEqual(["Nginx could not", "read its cert."]);
    expect(block(context)).toEqual([
      "open a1: why nginx failed on nlt",
      "line a1: Nginx could not",
      "line a1: read its cert.",
      "end a1",
    ]);
    expect(context.ai.open).toBe(true);
  });

  test("the prompt goes on stdin of the tool, bounded like any command", async () => {
    const context = fakeRunContext({ commands: [answered("ok")] });
    await askAi(context, QUESTION);

    const spec = context.commands.calls[0];
    expect(spec?.stdin).toBe("why?");
    expect(spec?.timeoutMs).toBe(context.params.ai.timeoutSeconds * 1000);
  });

  test("a tool that cannot start closes the gate, and the block still ends", async () => {
    const context = fakeRunContext({
      commands: [
        {
          match: ["claude"],
          onRun: () => {
            throw new Error("spawn claude ENOENT");
          },
        },
      ],
    });

    expect(await askAi(context, QUESTION)).toEqual([]);
    expect(context.ai.open).toBe(false);
    expect(feed(context.events.events)).toEqual([
      "warn AI unavailable: claude could not be started",
    ]);
    expect(block(context)).toEqual(["open a1: why nginx failed on nlt", "end a1"]);
  });

  test("a closed gate launches nothing at all", async () => {
    const context = fakeRunContext();
    context.ai.close("claude could not be started");

    expect(await askAi(context, QUESTION)).toEqual([]);
    expect(context.commands.calls).toEqual([]);
    expect(block(context)).toEqual([]);
  });

  test("a failed answer is said at the feed, the gate stays open", async () => {
    const context = fakeRunContext({
      commands: [
        {
          match: ["claude"],
          exitCode: 1,
          output: [{ stream: "stderr", line: "Invalid model name: opus9" }],
        },
      ],
    });

    expect(await askAi(context, QUESTION)).toEqual([]);
    expect(context.ai.open).toBe(true);
    expect(feed(context.events.events)).toEqual(["error AI claude: Invalid model name: opus9"]);
  });

  test("an unparsable --ai-model closes the gate before any tool runs", async () => {
    const context = fakeRunContext({ params: { aiModel: "gemini:pro" } });

    expect(await askAi(context, QUESTION)).toEqual([]);
    expect(context.commands.calls).toEqual([]);
    expect(context.ai.open).toBe(false);
    expect(feed(context.events.events)[0]).toContain("<tool>[:<model>][@<effort>]");
  });
});
