// AI repair on a whole run: the deterministic restart fails, the AI's targeted
// one works, and the host rejoins the deployment.

import { expect, test } from "bun:test";
import { storePath } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";
import { fixedPath } from "../../src/testing/sim.ts";

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
  // the analysis session is not even shown the tool — not a prompt, its path.
  expect(run.recorded?.state?.actions).toEqual([
    { host: "gw-cp", action: "restart outline.service", outcome: "done" },
  ]);
  const lines = run.events.flatMap((event) => (event.kind === "ai.line" ? [event.line] : []));
  expect(lines).toContain("service_action refused: no tool named service_action in this session");
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

test("a fix that changes other hosts: the fleet is realigned on it, served ones again", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    behaviours: {
      ...NEEDS_CODE,
      hcs: { changedByFix: true },
      "lt-cp": { changedByFix: true },
    },
    ai: ["outline starts before its database; ordering belongs in the module.", ...FIX],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ hcs: "deployed", "lt-cp": "deployed", "gw-cp": "deployed" });

  // Rebuilt at HEAD: hcs, served before the fix, tested again in a final pass;
  // lt-cp, in a later wave, tested once with its new path.
  expect(run.feed).toContain("ok aligned: 2 changed, 4 unchanged");
  expect(run.feed).toContain("info aligned, serving again: hcs");
  const tests = (host: string) =>
    run.sim.host(host).history.filter((line) => line.startsWith("test "));
  expect(tests("hcs")).toEqual(["test 0", "test 0"]);
  expect(tests("lt-cp")).toEqual(["test 0"]);
  const paths = Object.fromEntries(
    (run.recorded?.state?.hosts ?? []).map((host) => [host.name, host.path]),
  );
  expect(paths).toMatchObject({ hcs: fixedPath("hcs"), "lt-cp": fixedPath("lt-cp") });

  // One revision for the whole fleet: the one the fix committed.
  const state = run.recorded?.state;
  expect(state?.commits.at(-1)?.message).toBe("fix(outline): start outline after postgresql");
  expect(state?.revisions.consumer).toBe(state?.commits.at(-1)?.rev);
});

test("a host the final pass cannot reach: the fleet is on two revisions, the alert names it", async () => {
  // hcs drops off the network once the fix is committed: tested on the old path only.
  let up = true;
  const run = await simulateRun({
    argv: [...REPAIR, "--send-report"],
    behaviours: { ...NEEDS_CODE, hcs: { changedByFix: true, reachable: () => up } },
    hooks: () => [{ kind: "commit", run: () => (up = false) }],
    ai: ["outline starts before its database; ordering belongs in the module.", ...FIX],
  });

  expect(run.feed).toContain("warn offline, not aligned: hcs");

  // Back to what it runs: tested on its old path, left in test by the switch.
  expect(run.statuses).toMatchObject({ "gw-cp": "deployed", hcs: "tested" });
  expect(run.recorded?.state?.hosts.find((host) => host.name === "hcs")?.path).toBe(
    storePath("hcs"),
  );
  expect(run.feed).toContain("warn offline, left in test: hcs");

  const reason = "not aligned: hcs (offline at the final pass)";
  expect(run.recorded?.report).toContain(
    `- Repaired by commit: gw-cp, fleet on two revisions — ${reason}`,
  );
  const incident = run.sim.messages.find((message) => message.room === "incidents");
  expect(incident?.body).toContain(`## Fleet on two revisions\n\n- ${reason}`);
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

  // One fix, one commit: each new round amends it (spec § Règle de commit).
  expect(run.sim.commits.filter((commit) => commit.message.startsWith("fix("))).toEqual([
    { repo: "consumer", message: "fix(outline): start outline after postgresql", amended: 2 },
  ]);
  expect(run.recorded?.report).toContain(
    "fix(outline): start outline after postgresql (amended 2×)",
  );
});

/** One derivation of `dnf/` fails its own tests: every host holding it fails to build. */
const POSTHOG = `/nix/store/${"p".repeat(32)}-python3.14-posthog-7.71.0.drv`;
const BROKEN = {
  buildError: `Cannot build '${POSTHOG}'.\nReason: builder failed with exit code 1.`,
  buildFixedByEdit: true,
};
const BUILD_FIX = (host: string) => [
  {
    call: "edit_code",
    args: {
      host,
      path: "dnf/lib/overlays/posthog.nix",
      content: '{ disabledTests = [ "test_user_defined_flush_at" ]; }\n',
    },
  },
  { call: "validate", args: { host } },
  {
    call: "commit",
    args: { host, scope: "posthog", subject: "skip the tests that race the clock" },
  },
];

const aiMarks = (run: Awaited<ReturnType<typeof simulateRun>>, host: string) =>
  run.events.flatMap((event) =>
    event.kind === "host.state" && event.host === host && event.state.startsWith("ai")
      ? [event.state]
      : [],
  );

test("a failed build: repaired once for its group, the fleet aligned on the fix, all deployed", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    codev: true,
    behaviours: {
      "srv-ag": BROKEN,
      "pc-ag": BROKEN,
      "lt-cp": BROKEN,
      hcs: { changedByFix: true },
    },
    ai: [
      "posthog's own tests race the clock; disable them in the overlay.",
      ...BUILD_FIX("srv-ag"),
    ],
  });

  expect(run.exitCode).toBe(0);
  expect(Object.values(run.statuses).every((status) => status === "deployed")).toBe(true);

  // One analysis, one repair for the three: through srv-ag, first to build it.
  for (const host of ["srv-ag", "pc-ag", "lt-cp"]) {
    expect(aiMarks(run, host)).toEqual(["ai-analysing", "ai-repairing"]);
  }
  expect(run.feed).toContain("ok srv-ag: build fixed and committed by an AI repair");

  // The pair of co-development, one subject: dnf/ then the consumer lock.
  expect(run.sim.commits).toEqual([
    { repo: "dnf", message: "fix(posthog): skip the tests that race the clock" },
    { repo: "consumer", message: "fix(posthog): skip the tests that race the clock" },
  ]);

  // Aligned at HEAD: the group and hcs, whose path the fix changed too.
  expect(run.feed).toContain("ok aligned: 4 changed, 2 unchanged");
  const paths = Object.fromEntries(
    (run.recorded?.state?.hosts ?? []).map((host) => [host.name, host.path]),
  );
  expect(paths).toMatchObject({
    hcs: fixedPath("hcs"),
    "srv-ag": fixedPath("srv-ag"),
    "lt-cp": fixedPath("lt-cp"),
  });
  const tests = (host: string) =>
    run.sim.host(host).history.filter((line) => line.startsWith("test "));
  expect(tests("hcs")).toEqual(["test 0"]);

  // No decision left to take: nothing failed once aligned.
  expect(run.feed.join("\n")).not.toContain("excluded");
  const state = run.recorded?.state;
  expect(state?.revisions.consumer).toBe(state?.commits.at(-1)?.rev);
  expect(state?.revisions.dnf).toBe(state?.commits.findLast((c) => c.repo === "dnf")?.rev);
  expect(run.recorded?.report).toContain("- Repaired by commit: srv-ag, fleet aligned on it");
});

test("every host broken: the repair comes before « no host built »", async () => {
  const names = ["hcs", "gw-ag", "srv-ag", "pc-ag", "gw-cp", "lt-cp"];
  const run = await simulateRun({
    argv: REPAIR,
    codev: true,
    behaviours: Object.fromEntries(names.map((name) => [name, BROKEN])),
    ai: [...BUILD_FIX("hcs")],
  });

  expect(run.exitCode).toBe(0);
  expect(run.feed).not.toContain("error no host built");
  expect(run.feed).toContain("ok aligned: 6 changed, 0 unchanged");
  expect(Object.values(run.statuses).every((status) => status === "deployed")).toBe(true);
});

test("a build fix that does not validate: nothing committed, the group decided as before", async () => {
  const run = await simulateRun({
    argv: REPAIR,
    codev: true,
    behaviours: {
      "pc-ag": { buildError: BROKEN.buildError },
      "lt-cp": { buildError: BROKEN.buildError },
    },
    ai: [...BUILD_FIX("pc-ag")],
  });

  expect(run.exitCode).toBe(0);
  expect(run.statuses).toMatchObject({ "pc-ag": "excluded", "lt-cp": "excluded", hcs: "deployed" });
  expect(run.sim.commits).toEqual([]);

  // Uncommitted: the tree back to HEAD, its patch kept, nothing aligned, no repair to report.
  const discarded = "warn pc-ag: dnf/: uncommitted repair edits discarded, kept in ";
  expect(
    run.feed.some((line) => line.startsWith(discarded) && line.endsWith("/logs/pc-ag.dnf.patch")),
  ).toBe(true);
  expect(run.feed.some((line) => line.includes("aligning"))).toBe(false);
  expect(run.recorded?.report).not.toContain("Repaired by commit");
  const commit = run.recorded?.state?.actions.find((entry) => entry.action.startsWith("commit"));
  expect(commit?.outcome).toBe("refused");
});
