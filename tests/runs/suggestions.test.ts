// Improvement suggestions on a whole run: a warning in the logs, the review
// at the end, a file that outlives the run, a line in the report.

import { expect, test } from "bun:test";
import { simulateRun } from "../../src/testing/runs.ts";

const ACTIVE = ["--no-ui", "--ai-analysis", "active"];

const FILE = {
  call: "suggest",
  args: {
    slug: "nextcloud-legacy-install",
    title: "Confirm the Nextcloud install is not legacy",
    body: "`evaluation warning: A legacy Nextcloud install` on every evaluation.",
  },
};

test("the review files a suggestion from a warning, and the report lists it", async () => {
  const run = await simulateRun({
    argv: ACTIVE,
    evalWarnings: ["A legacy Nextcloud install (from before NixOS 26.11) may be installed."],
    ai: [
      { call: "known_suggestions", args: {} },
      { call: "run_warnings", args: {} },
      FILE,
      "Filed one.",
    ],
  });

  expect(run.exitCode).toBe(0);
  const text = run.suggestions.files.get("nextcloud-legacy-install") ?? "";
  expect(text).toStartWith("# Confirm the Nextcloud install is not legacy\n\n- Status: open\n");
  expect(run.recorded?.report).toContain(
    "## Suggestions\n\n- **Confirm the Nextcloud install is not legacy** — new — `var/deployments/suggestions/nextcloud-legacy-install.md`",
  );

  // The summary session replays the same script first: refused there, filed once.
  expect(run.feed.filter((line) => line.includes("AI files the suggestion"))).toHaveLength(2);
  expect(text.match(/- Runs: 1/g)).toHaveLength(1);
});

test("a finding the operator ignores is marked seen, and stays out of the report", async () => {
  const ignored = "# Nextcloud\n\n- Status: ignored\n- Last seen: old\n- Runs: 1\n\nKnown.\n";
  const run = await simulateRun({
    argv: ACTIVE,
    evalWarnings: ["A legacy Nextcloud install (from before NixOS 26.11) may be installed."],
    suggestions: { "nextcloud-legacy-install": ignored },
    ai: [FILE, "Nothing new."],
  });

  expect(run.suggestions.files.get("nextcloud-legacy-install")).toContain("- Runs: 2");
  expect(run.recorded?.report).not.toContain("## Suggestions");
});

test("no warning, no review: nothing is asked beyond the summary", async () => {
  const run = await simulateRun({ argv: ACTIVE, ai: ["Everything switched."] });

  const sessions = run.events.filter((event) => event.kind === "ai");
  expect(sessions.map((event) => (event.kind === "ai" ? event.message : ""))).toEqual([
    "summarising the run",
  ]);
  expect(run.suggestions.files.size).toBe(0);
});
