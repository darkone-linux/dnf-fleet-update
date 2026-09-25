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

/** The restart cannot help: the fix is in the code, and only a rebuild carries it. */
const NEEDS_CODE = {
  "gw-cp": {
    activation: { test: 4 as const },
    failedUnits: ["outline.service"],
    repaired: { test: 0 as const },
  },
};

const FIX = [
  {
    call: "edit_code",
    args: {
      host: "gw-cp",
      path: "usr/modules/outline.nix",
      content: '{ after = [ "postgresql.service" ]; }\n',
    },
  },
  { call: "validate", args: { host: "gw-cp" } },
  {
    call: "commit",
    args: { host: "gw-cp", scope: "outline", subject: "start outline after postgresql" },
  },
];

test("a fix in the code: the host is rebuilt, redeployed, and ends deployed", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    behaviours: NEEDS_CODE,
    ai: ["outline starts before its database; ordering belongs in the module.", ...FIX],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses["gw-cp"]).toBe("deployed");

  // Rebuilt, then served a second time by its own wave: not a recursion.
  expect(run.feed).toContain("info gw-cp: rebuilt by an AI repair, deploying it again");
  expect(run.feed).toContain("info repaired, deploying again: gw-cp");
  expect(run.sim.host("gw-cp").history.filter((line) => line.startsWith("test "))).toEqual([
    "test 4",
    "test 0",
  ]);

  // One commit, scoped by what it touches; no lock to realign outside codev.
  expect(run.sim.commits.map((commit) => commit.message)).toContain(
    "fix(outline): start outline after postgresql",
  );

  // A check and a commit cost nothing: the edit alone spent an attempt.
  const actions = run.recorded?.state?.actions ?? [];
  expect(
    actions.filter((action) => action.spends !== false && action.outcome === "done"),
  ).toHaveLength(1);
  expect(run.recorded?.report).toContain("| gw-cp | edit usr/modules/outline.nix | done |");
});

test("a fix that does not fix: attempts run out, the host lands back in error", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    behaviours: { "gw-cp": { ...NEEDS_CODE["gw-cp"], repaired: { test: 4 } } },
    ai: [...FIX],
  });

  expect(run.statuses["gw-cp"]).toBe("error");

  // Three changes, then the tool refuses: the loop cannot run for ever.
  const actions = run.recorded?.state?.actions ?? [];
  expect(
    actions.filter((entry) => entry.spends !== false && entry.outcome === "done"),
  ).toHaveLength(3);
  expect(actions.map((entry) => entry.detail)).toContain(
    "3 repair attempts already spent on gw-cp",
  );
  expect(run.exitCode).toBe(0);
});
