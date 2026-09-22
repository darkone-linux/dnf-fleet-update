// Text each alert room receives.

import { describe, expect, test } from "bun:test";
import { summaryMessage, trimSummary } from "./matrix.ts";

describe("summaryMessage", () => {
  const base = {
    exitCode: 0 as const,
    facts: [
      "Started at 2026-09-17 02:00:00 UTC, duration: 12m03s",
      "Options: full run, selection all, 10 in parallel",
      "Hosts: 6 deployed",
    ],
    knownErrors: [],
  };

  test("exit code in the title, then the facts of the report", () => {
    expect(summaryMessage(base)).toBe(
      [
        "**Fleet Update Report** (0)",
        "",
        "- Started at 2026-09-17 02:00:00 UTC, duration: 12m03s",
        "- Options: full run, selection all, 10 in parallel",
        "- Hosts: 6 deployed",
      ].join("\n"),
    );
  });

  test("error title and known errors, for the incidents room", () => {
    const message = summaryMessage({
      ...base,
      exitCode: 1,
      error: "srv-ag: build failed: disk full",
      knownErrors: ["nix-eval-jobs is not linked against the same Nix as the system"],
    });

    expect(message.split("\n")).toEqual([
      "**Fleet Update Report** (1)",
      "",
      "Error: srv-ag: build failed: disk full",
      "",
      "- Started at 2026-09-17 02:00:00 UTC, duration: 12m03s",
      "- Options: full run, selection all, 10 in parallel",
      "- Hosts: 6 deployed",
      "",
      "Known errors:",
      "- nix-eval-jobs is not linked against the same Nix as the system",
    ]);
  });

  test("the AI synthesis closes the message, trimmed", () => {
    const message = summaryMessage({ ...base, summary: ["Everything switched.", "", "No risk."] });

    expect(message.endsWith("\n\n**AI summary**\n\nEverything switched.\nNo risk.")).toBe(true);
    expect(summaryMessage({ ...base, summary: [] })).toBe(summaryMessage(base));
  });
});

describe("trimSummary", () => {
  test("blank lines dropped, whole synthesis kept when it fits", () => {
    expect(trimSummary(["a", "", " ", "b"])).toEqual(["a", "b"]);
    expect(trimSummary([])).toEqual([]);
  });

  test("too many lines: head, then a pointer to the report", () => {
    const lines = ["1", "2", "3", "4", "5", "6", "7"];

    expect(trimSummary(lines)).toEqual([
      ...lines.slice(0, 6),
      "(cut, full analysis in `report.md`)",
    ]);
  });

  test("too many characters: the line that would overflow is left out", () => {
    const long = "x".repeat(400);

    expect(trimSummary([long, long, "tail"])).toEqual([
      long,
      "(cut, full analysis in `report.md`)",
    ]);
  });

  test("one overlong paragraph is cut, never dropped", () => {
    const [head, more] = trimSummary(["y".repeat(900)]);

    expect(head).toBe(`${"y".repeat(500)}…`);
    expect(more).toBe("(cut, full analysis in `report.md`)");
  });
});
