// Text each alert room receives.

import { describe, expect, test } from "bun:test";
import { summaryMessage } from "./matrix.ts";

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
});
