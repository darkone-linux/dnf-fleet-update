// Warnings of a run, grouped: what the suggestions session starts from.

import { describe, expect, test } from "bun:test";
import type { LogName } from "../engine/ports.ts";
import { groupWarnings, renderWarnings, runWarnings, warningShape } from "./warnings.ts";

describe("warningShape", () => {
  test("journal dates, store hashes and numbers are masked", () => {
    expect(
      warningShape(
        "sept. 24 22:07:19 gfx systemd[4915]: warning: /nix/store/80wk0xfrn1ydgla6k304knb2dq0ynyxx-x (60580 -> 60579)",
      ),
    ).toBe("systemd[#]: warning: /nix/store/…-x (# -> #)");
    expect(warningShape("2026-09-24T22:07:19-02:00 gfx hm[1]: renamed")).toBe("hm[#]: renamed");
  });
});

describe("groupWarnings", () => {
  test("one group per shape, hosts and phases gathered, most frequent first", () => {
    const groups = groupWarnings([
      {
        name: { host: "gfx", phase: "test" },
        lines: [
          "warning: not applying UID change of user 'gdm-greeter-2' (60580 -> 60579)",
          "starting the following units: polkit.service",
          "warning: not applying UID change of user 'gdm-greeter-3' (60581 -> 60580)",
        ],
      },
      {
        name: { host: "alt", phase: "switch" },
        lines: ["warning: not applying UID change of user 'gdm-greeter-2' (60580 -> 60579)"],
      },
      {
        name: { phase: "build" },
        lines: ["evaluation warning: the option `foo' has been Renamed to `bar'."],
      },
    ]);

    expect(groups).toEqual([
      {
        example: "warning: not applying UID change of user 'gdm-greeter-2' (60580 -> 60579)",
        count: 3,
        hosts: ["gfx", "alt"],
        phases: ["test", "switch"],
      },
      {
        example: "evaluation warning: the option `foo' has been Renamed to `bar'.",
        count: 1,
        hosts: [],
        phases: ["build"],
      },
    ]);
  });

  test("the AI's own logs are left out: its answers quote warnings", () => {
    expect(
      groupWarnings([
        { name: { phase: "ai" }, lines: ["warning: quoted"] },
        { name: { host: "gfx", phase: "ai" }, lines: ["warning: quoted"] },
      ]),
    ).toEqual([]);
  });

  test("a word merely holding one of the markers is not a warning", () => {
    expect(groupWarnings([{ name: { phase: "build" }, lines: ["forewarnings"] }])).toEqual([]);
  });
});

describe("renderWarnings", () => {
  test("one line per group, run-wide logs said so, the rest counted past 80", () => {
    const groups = Array.from({ length: 82 }, (_, index) => ({
      example: `warning: ${"x".repeat(index)}`,
      count: 1,
      hosts: index === 0 ? [] : ["gfx", "nlt"],
      phases: ["build"],
    }));
    const rendered = renderWarnings(groups);

    expect(rendered.lines).toHaveLength(80);
    expect(rendered.dropped).toBe(2);
    expect(rendered.lines[0]).toBe("1× run (build): warning: ");
    expect(rendered.lines[1]).toBe("1× gfx, nlt (build): warning: x");
  });
});

describe("runWarnings", () => {
  test("reads every log but the AI's, from its end", async () => {
    const reads: string[] = [];
    const names: LogName[] = [{ phase: "ai" }, { host: "gfx", phase: "test" }];
    const groups = await runWarnings(names, (name, lines) => {
      reads.push(`${name.host ?? "run"}.${name.phase} ${lines}`);
      return Promise.resolve({ lines: ["warning: x"], dropped: 0 });
    });

    expect(reads).toEqual(["gfx.test 5000"]);
    expect(groups).toHaveLength(1);
  });
});
