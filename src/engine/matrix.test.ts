// Text each alert room receives.

import { describe, expect, test } from "bun:test";
import { summaryMessage } from "./matrix.ts";

describe("summaryMessage", () => {
  const base = {
    runId: "20260917T020000Z-full",
    exitCode: 0 as const,
    lines: ["6 deployed", "duration 12m03s"],
    knownErrors: [],
  };

  test("run, exit code and the short lines of the report", () => {
    expect(summaryMessage(base)).toBe(
      "**fleet-update 20260917T020000Z-full** — exit 0\n\n- 6 deployed\n- duration 12m03s",
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
      "**fleet-update 20260917T020000Z-full** — exit 1",
      "",
      "error: srv-ag: build failed: disk full",
      "",
      "- 6 deployed",
      "- duration 12m03s",
      "",
      "Known errors:",
      "- nix-eval-jobs is not linked against the same Nix as the system",
    ]);
  });
});
