// AI repair on a whole run: the deterministic restart fails, the AI's targeted
// one works, and the host rejoins the deployment.

import { expect, test } from "bun:test";
import { simulateRun } from "../../src/testing/runs.ts";

/** `gw-cp` activates with a failed unit; only the second restart brings it back. */
const RESISTS = {
  "gw-cp": {
    activation: { test: 4 as const },
    failedUnits: ["outline.service"],
    unitsRecoverFrom: 2,
  },
};

const REPAIR = ["--no-ui", "--ai-error-action", "repair"];

const action = {
  call: "service_action",
  args: { host: "gw-cp", units: ["outline.service"], action: "restart" },
};

test("the AI restarts what the group restart could not, and the host is deployed", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    behaviours: RESISTS,
    ai: ["outline lost its database socket; restarting it alone.", action, "It holds now."],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["gw-cp"]).toBe("deployed");

  // Two sessions, two states: the analysis explains, the repair acts.
  expect(run.states["gw-cp"]).toBe("deployed");
  const marks = run.events.flatMap((event) =>
    event.kind === "host.state" && event.host === "gw-cp" && event.state.startsWith("ai")
      ? [event.state]
      : [],
  );
  expect(marks).toEqual(["ai-analysing", "ai-repairing"]);

  // The script is replayed by both sessions; only the repair one may act, and
  // the state guard — not the prompt — is what says so.
  expect(run.recorded?.state?.actions).toEqual([
    {
      host: "gw-cp",
      action: "restart outline.service",
      outcome: "refused",
      detail: "gw-cp is not under repair right now (state ai-analysing)",
    },
    { host: "gw-cp", action: "restart outline.service", outcome: "done" },
  ]);
  expect(run.feed).toContain("ok gw-cp: AI repair recovered the host");
  expect(run.recorded?.report).toContain(
    "## Notes\n\n- gw-cp: recovered by an AI repair: restart outline.service",
  );
  expect(run.recorded?.report).toContain("| gw-cp | restart outline.service | done |  |");
});

test("a unit the run never saw fail is refused, and the host stays in error", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    behaviours: RESISTS,
    ai: [
      { call: "service_action", args: { host: "gw-cp", units: ["sshd.service"], action: "stop" } },
    ],
  });

  expect(run.statuses["gw-cp"]).toBe("error");
  expect(run.recorded?.state?.actions.at(-1)).toEqual({
    host: "gw-cp",
    action: "stop sshd.service",
    outcome: "refused",
    detail: "not failed on gw-cp: sshd.service (failed units: outline.service)",
  });

  // Refused costs no attempt, and `sshd` was never touched on the host.
  expect(run.sim.host("gw-cp").history.filter((line) => line === "units restarted")).toHaveLength(
    1,
  );
});

test("--ai-error-action analysis never publishes the action tool", async () => {
  const run = await simulateRun({
    argv: ["--no-ui", "--ai-error-action", "analysis"],
    behaviours: RESISTS,
    ai: [action],
  });

  expect(run.statuses["gw-cp"]).toBe("error");
  expect(run.recorded?.state?.actions).toEqual([]);
  expect(run.feed.join("\n")).not.toContain("ai-repairing");
});
