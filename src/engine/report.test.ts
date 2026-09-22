// Report rendering from a folded stream.

import { describe, expect, test } from "bun:test";
import type { Event } from "../model/events.ts";
import { initialPersisted, persist } from "../model/persist.ts";
import { testParams } from "../testing/fakes.ts";
import { formatBytes, formatDuration, renderReport } from "./report.ts";

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

const RUN_ID = "20260917T020000Z-full";

const COPIES: Event[] = [
  {
    t: 45,
    kind: "host.copy",
    host: "hcs",
    builder: "gfx",
    pulled: [
      { source: "harmonia ag", paths: 30 },
      { source: "cache.nixos.org", paths: 7 },
    ],
    pushed: 67,
    pushedBytes: 679_477_248,
  },
  {
    t: 46,
    kind: "host.copy",
    host: "gw-ag",
    builder: "gfx",
    pulled: [{ source: "harmonia ag", paths: 142 }],
    pushed: 3,
    pushedBytes: 1258,
  },
];

const EVENTS_WITH_COPIES = [...EVENTS, ...COPIES];

describe("renderReport", () => {
  const state = EVENTS.reduce(persist, initialPersisted());
  const BASE = {
    runId: RUN_ID,
    status: "done" as const,
    exitCode: 0 as const,
    durationMs: 65_040,
    warnings: [],
    knownErrors: [],
    analyses: [],
  };

  test("short lines for the end of the run", () => {
    const report = renderReport({
      runId: RUN_ID,
      state,
      status: "aborted",
      exitCode: 5,
      durationMs: 65_040,
      warnings: [],
      knownErrors: [],
      analyses: [],
    });

    expect(report.facts).toEqual([
      "Started at 2026-09-17 02:00:00 UTC, duration: 1m05s",
      "Options: full run, selection all, 10 in parallel",
      "Hosts: 1 left in test (hcs), 1 with failed units (gw-ag), 1 failed (nlt)",
      "Run aborted",
    ]);
    expect(report.lines).toEqual([
      "1 left in test (hcs), 1 with failed units (gw-ag), 1 failed (nlt)",
      "duration 1m05s",
      "run aborted",
    ]);
  });

  test("markdown: header, steps, waves, hosts not deployed, hosts left in test, warnings", () => {
    const { markdown } = renderReport({
      runId: RUN_ID,
      state,
      status: "done",
      exitCode: 0,
      durationMs: 65_040,
      warnings: ["evaluation warning: x renamed"],
      knownErrors: ["nix-eval-jobs is not linked against the same Nix as the system"],
      analyses: [],
    });

    expect(markdown).toStartWith("# Fleet Update Report\n\n- Status: done (exit 0)\n");
    expect(markdown).toContain("- Started at 2026-09-17 02:00:00 UTC, duration: 1m05s");
    expect(markdown).toContain("- Options: full run, selection all, 10 in parallel");
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
      runId: RUN_ID,
      state: running,
      status: "done",
      exitCode: 0,
      durationMs: 65_100,
      warnings: [],
      knownErrors: [],
      analyses: [],
    });

    expect(markdown).toContain("| switch | todo |  |");
    expect(markdown).not.toContain("| report |");
  });

  test("incidents: critical hosts left out, in test only after a stop", () => {
    const done = renderReport({
      runId: RUN_ID,
      state,
      status: "done",
      exitCode: 0,
      durationMs: 65_040,
      warnings: [],
      knownErrors: [],
      analyses: [],
    });
    const stopped = renderReport({
      runId: RUN_ID,
      state,
      status: "failed",
      exitCode: 1,
      durationMs: 65_040,
      warnings: [],
      knownErrors: [],
      analyses: [],
    });

    // `nlt` failed too, but `laptop` is not one of the critical profiles.
    expect(done.incident).toBe(
      "## Critical hosts not deployed\n\n- gw-ag (gateway): error, some units failed\n",
    );
    expect(stopped.incident?.endsWith("## Hosts left in test\n\n- hcs\n- gw-ag\n")).toBe(true);
  });

  test("incidents: declared critical profiles, and nothing to raise", () => {
    const laptops = persist(
      { ...state, hosts: state.hosts.filter((host) => host.name === "nlt") },
      {
        t: 0,
        kind: "run.start",
        run: {
          version: "0.3.0",
          selection: "all",
          mode: "full",
          codev: false,
          aiModel: "claude:opus@high",
          maxParallel: 10,
          params: testParams({ criticalProfiles: "laptop" }),
        },
      },
    );
    const input = {
      runId: RUN_ID,
      status: "done" as const,
      exitCode: 0 as const,
      durationMs: 1000,
      warnings: [],
      knownErrors: [],
      analyses: [],
    };

    expect(renderReport({ ...input, state: laptops }).incident).toBe(
      "## Critical hosts not deployed\n\n- nlt (laptop): failed, build failed: x | y\n",
    );
    const deployed = persist(laptops, {
      t: 100,
      kind: "host.state",
      host: "nlt",
      state: "deployed",
    });
    expect(renderReport({ ...input, state: deployed }).incident).toBeUndefined();
  });

  test("diagnostics: failed units per host, then the error that got it there", () => {
    const collected = [
      ...EVENTS,
      {
        t: 61_060,
        kind: "host.diagnosis" as const,
        host: "gw-ag",
        units: ["outline.service"],
        excerpt: ["error: unit failed", "see journalctl"],
      },
      { t: 62_010, kind: "host.diagnosis" as const, host: "nlt", units: [], excerpt: ["error: x"] },
    ].reduce(persist, initialPersisted());
    const { markdown, incident } = renderReport({ ...BASE, state: collected });

    expect(markdown).toContain(
      "## Diagnostics\n\n### gw-ag\n\nFailed units: outline.service\n\n```\nerror: unit failed\nsee journalctl\n```",
    );

    // Nothing was activated on `nlt`: an excerpt, no unit line.
    expect(markdown).toContain("### nlt\n\n```\nerror: x\n```");

    // Critical host: the incidents room says what it could not start.
    expect(incident).toBe(
      "## Critical hosts not deployed\n\n- gw-ag (gateway): error, some units failed, units failed: outline.service\n",
    );
  });

  test("AI analysis: one block per host analysed, then the run summary", () => {
    const { markdown, summary } = renderReport({
      ...BASE,
      state,
      analyses: [
        { host: "gw-ag", lines: ["outline.service cannot bind :3000.", "Another holds it."] },
        { lines: ["Two hosts short of the fleet.", "Both on port conflicts."] },
      ],
    });

    // After the raw evidence: the analysis adds to it, never replaces it.
    expect(markdown.indexOf("## AI analysis")).toBeGreaterThan(markdown.indexOf("## Steps"));
    expect(markdown).toContain(
      "## AI analysis\n\n### gw-ag\n\noutline.service cannot bind :3000.\nAnother holds it.",
    );
    expect(markdown).toContain("### Run summary\n\nTwo hosts short of the fleet.");

    // Only the hostless entry travels to a room.
    expect(summary).toEqual(["Two hosts short of the fleet.", "Both on port conflicts."]);
  });

  test("no AI analysis: no section, no room summary", () => {
    const { markdown, summary } = renderReport({ ...BASE, state });

    expect(markdown).not.toContain("## AI analysis");
    expect(summary).toEqual([]);
  });

  test("copy counters, one line per host copied to", () => {
    const counted = EVENTS_WITH_COPIES.reduce(persist, initialPersisted());
    const { markdown } = renderReport({ ...BASE, state: counted });

    // `nlt` never got a closure: no line of its own.
    expect(markdown.split("## ").find((part) => part.startsWith("Copies"))).toBe(
      [
        "Copies",
        "",
        "| Host | Builder | Pulled | Pushed | Pushed volume |",
        "| --- | --- | --- | --- | --- |",
        "| hcs | gfx | 37 (harmonia ag 30, cache.nixos.org 7) | 67 | 648 MiB |",
        "| gw-ag | gfx | 142 (harmonia ag) | 3 | 1.2 KiB |",
        "",
        "",
      ].join("\n"),
    );
  });

  test("builders and zones without a cache: who built what, and what to declare", () => {
    const planned: Event[] = [
      ...EVENTS,
      {
        t: 25,
        kind: "plan",
        waves: [["hcs"], ["gw-ag"]],
        builders: { hcs: "gw-cp", "gw-ag": "gfx", nlt: "gfx" },
      },
    ];
    const state = planned.reduce(persist, initialPersisted());

    const { markdown } = renderReport({ ...BASE, state, zonesWithoutCache: ["lg"] });

    expect(markdown.split("## ").find((part) => part.startsWith("Builders"))).toBe(
      [
        "Builders",
        "",
        "| Builder | Hosts built |",
        "| --- | --- |",
        "| gw-cp | hcs |",
        "| gfx | gw-ag, nlt |",
        "",
        "",
      ].join("\n"),
    );
    expect(markdown).toContain("## Zones without a cache\n\n- lg: no harmonia, everything");
  });

  test("no builder elected, no zone left out: neither section", () => {
    const { markdown } = renderReport({ ...BASE, state });

    expect(markdown).not.toContain("## Builders");
    expect(markdown).not.toContain("## Zones without a cache");
  });

  test("no host copied to: no section", () => {
    expect(renderReport({ ...BASE, state }).markdown).not.toContain("## Copies");
  });

  test("volumes", () => {
    expect([formatBytes(0), formatBytes(1258), formatBytes(679_477_248)]).toEqual([
      "0 B",
      "1.2 KiB",
      "648 MiB",
    ]);
  });

  test("durations", () => {
    expect([formatDuration(400), formatDuration(185_000), formatDuration(3_725_000)]).toEqual([
      "0s",
      "3m05s",
      "1h02m",
    ]);
  });
});
