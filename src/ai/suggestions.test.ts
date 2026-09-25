// Suggestion files: the header a human edits, and the two lines a run moves.

import { describe, expect, test } from "bun:test";
import { AiSuggestions, markSeen, parseSuggestion, renderSuggestion, SLUG } from "./suggestions.ts";

const RUN = "20260925T020000Z-full";

describe("SLUG", () => {
  test("kebab-case, 3 to 60 characters", () => {
    expect(SLUG.test("gdm-greeter-uid-shift")).toBe(true);
    expect(SLUG.test("ab")).toBe(false);
    expect(SLUG.test("a".repeat(61))).toBe(false);
    expect(SLUG.test("Nextcloud-legacy")).toBe(false);
    expect(SLUG.test("../escape")).toBe(false);
    expect(SLUG.test("double--dash")).toBe(false);
  });
});

describe("renderSuggestion and parseSuggestion", () => {
  test("a new file reads back as filed", () => {
    const text = renderSuggestion("Pin the gdm greeter UIDs", "  UIDs shift on gfx.\n", RUN);

    expect(text).toBe(
      [
        "# Pin the gdm greeter UIDs",
        "",
        "- Status: open",
        `- First seen: ${RUN}`,
        `- Last seen: ${RUN}`,
        "- Runs: 1",
        "",
        "UIDs shift on gfx.",
        "",
      ].join("\n"),
    );
    expect(parseSuggestion("gdm-uid", text)).toEqual({
      slug: "gdm-uid",
      title: "Pin the gdm greeter UIDs",
      status: "open",
      firstSeen: RUN,
      lastSeen: RUN,
      runs: 1,
    });
  });

  test("the operator's `ignored` is read whatever its case; a reshaped file still reads", () => {
    expect(parseSuggestion("x", "# T\n- status: Ignored\n").status).toBe("ignored");
    expect(parseSuggestion("x", "# T\n- Status: wontfix\n").status).toBe("open");
    expect(parseSuggestion("bare-note", "just a note")).toEqual({
      slug: "bare-note",
      title: "bare-note",
      status: "open",
      runs: 1,
    });
  });
});

describe("markSeen", () => {
  test("Last seen and Runs move, every other byte stays", () => {
    const text = [
      "# Pin the gdm greeter UIDs",
      "",
      "- Status: ignored",
      "- First seen: 20260924T234430Z-full",
      "- Last seen: 20260924T234430Z-full",
      "- Runs: 4",
      "",
      "Operator: expected, the greeters are dynamic.",
      "",
    ].join("\n");

    expect(markSeen(text, RUN)).toBe(
      text
        .replace("- Last seen: 20260924T234430Z-full", `- Last seen: ${RUN}`)
        .replace("- Runs: 4", "- Runs: 5"),
    );
  });
});

describe("AiSuggestions", () => {
  test("what the run filed, closed to the tools until the review opens it", () => {
    const suggestions = new AiSuggestions();
    expect(suggestions.reviewing).toBe(false);

    suggestions.add({ slug: "a-b-c", title: "T", status: "open", runs: 1, fresh: true });
    expect(suggestions.has("a-b-c")).toBe(true);
    expect(suggestions.has("d-e-f")).toBe(false);
    expect(suggestions.all()).toHaveLength(1);
  });
});
