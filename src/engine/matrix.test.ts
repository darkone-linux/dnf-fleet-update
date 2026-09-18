// Rooms read from `matrix.nix` and the text each room receives.

import { describe, expect, test } from "bun:test";
import { MATRIX_JSON } from "../testing/fleet.ts";
import { homeserver, parseRooms, summaryMessage } from "./matrix.ts";

describe("parseRooms", () => {
  test("both rooms of the alert bot", () => {
    expect(parseRooms(MATRIX_JSON)).toEqual({
      ok: true,
      value: { warnings: "!warnings:example.org", incidents: "!incidents:example.org" },
    });
  });

  test("a room missing is refused, never sent to the other", () => {
    const parsed = parseRooms({ matrix: { warningsRoom: "!warnings:example.org" } });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toStartWith("matrix.nix:");
  });
});

test("client API of the public vhost", () => {
  expect(homeserver("example.org")).toBe("https://matrix.example.org");
});

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
