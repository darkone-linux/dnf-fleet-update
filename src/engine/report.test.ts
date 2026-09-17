// Report rendering from a folded stream.

import { describe, expect, test } from "bun:test";
import type { Event } from "../model/events.ts";
import { initialPersisted, persist } from "../model/persist.ts";
import { formatDuration, renderReport } from "./report.ts";

const EVENTS: Event[] = [
  {
    t: 0,
    kind: "run.start",
    run: {
      version: "0.2.0",
      selection: "all",
      mode: "full",
      codev: true,
      aiModel: "claude:opus@high",
      maxParallel: 10,
    },
  },
  {
    t: 10,
    kind: "commit",
    repo: "consumer",
    rev: "0a1b2c3d4e5f",
    message: "chore(update): full fleet",
  },
  { t: 20, kind: "host.add", host: "hcs", profile: "hcs", zone: "www" },
  { t: 20, kind: "host.add", host: "gw-ag", profile: "gateway", zone: "ag" },
  { t: 20, kind: "host.add", host: "nlt", profile: "laptop", zone: "ag" },
  { t: 30, kind: "step.start", step: "test" },
  { t: 40, kind: "wave.start", index: 1, total: 2, hosts: ["hcs"] },
  { t: 50, kind: "host.state", host: "hcs", state: "tested" },
  { t: 61_040, kind: "wave.start", index: 2, total: 2, hosts: ["gw-ag"] },
  { t: 61_050, kind: "host.state", host: "gw-ag", state: "error", note: "some units failed" },
  { t: 62_000, kind: "host.state", host: "nlt", state: "failed", note: "build failed: x | y" },
  { t: 65_040, kind: "step.end", step: "test", status: "ok" },
];

describe("renderReport", () => {
  const state = EVENTS.reduce(persist, initialPersisted());

  test("short lines for the end of the run", () => {
    const report = renderReport({
      state,
      status: "aborted",
      exitCode: 5,
      durationMs: 65_040,
      warnings: [],
      knownErrors: [],
    });

    expect(report.lines).toEqual([
      "1 left in test (hcs), 1 with failed units (gw-ag), 1 failed (nlt)",
      "duration 1m05s",
      "run aborted",
    ]);
  });

  test("markdown: header, steps, waves, hosts not deployed, hosts left in test, warnings", () => {
    const { markdown } = renderReport({
      state,
      status: "done",
      exitCode: 0,
      durationMs: 65_040,
      warnings: ["evaluation warning: x renamed"],
      knownErrors: ["nix-eval-jobs is not linked against the same Nix as the system"],
    });

    expect(markdown).toContain("- Commits: consumer 0a1b2c3 chore(update): full fleet");
    expect(markdown).toContain("| test | done | 1m05s |");
    expect(markdown).toContain("| test | 1/2 | hcs | 1m01s |");
    expect(markdown).toContain("| test | 2/2 | gw-ag | 4s |");
    expect(markdown).toContain("| nlt | failed | build failed: x \\| y |");
    expect(markdown).toContain("## Hosts left in test\n\n- hcs\n- gw-ag");
    expect(markdown).toContain(
      "## Known errors\n\n- nix-eval-jobs is not linked against the same Nix as the system",
    );
    expect(markdown.endsWith("- evaluation warning: x renamed\n")).toBe(true);
  });

  test("no row for the report step: it is written while that step runs", () => {
    const running = persist(state, { t: 65_100, kind: "step.start", step: "report" });

    const { markdown } = renderReport({
      state: running,
      status: "done",
      exitCode: 0,
      durationMs: 65_100,
      warnings: [],
      knownErrors: [],
    });

    expect(markdown).toContain("| switch | todo |  |");
    expect(markdown).not.toContain("| report |");
  });

  test("durations", () => {
    expect([formatDuration(400), formatDuration(185_000), formatDuration(3_725_000)]).toEqual([
      "0s",
      "3m05s",
      "1h02m",
    ]);
  });
});
