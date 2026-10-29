// `state.json` fold: recorded scenarios and the status of each host.

import { expect, test } from "bun:test";
import { loadScenario } from "../testing/replay.ts";
import { type Event, type HostState, STEPS } from "./events.ts";
import {
  editSeriesOpen,
  type HostStatus,
  hostStatus,
  initialPersisted,
  PERSIST_SCHEMA,
  type PersistedState,
  persist,
  spentAttempts,
  validatedSinceEdit,
} from "./persist.ts";

function fold(events: Event[]): PersistedState {
  return events.reduce(persist, initialPersisted());
}

function statuses(state: PersistedState): Record<string, string> {
  return Object.fromEntries(state.hosts.map((host) => [host.name, host.status]));
}

test("nominal keeps plan, commits, waves and a finished run", () => {
  const state = fold(loadScenario("nominal"));

  expect(state.schema).toBe(PERSIST_SCHEMA);
  expect(state.plan).toHaveLength(5);
  expect(state.commits.map((commit) => commit.repo)).toEqual(["dnf", "consumer"]);

  // What a later `--resume` compares its own trees against.
  expect(state.revisions).toEqual({ dnf: "4f1c2a9", consumer: "b83e07d" });
  expect(state.end).toEqual({ status: "done", exitCode: 0 });
  for (const step of STEPS) expect(state.steps[step].status).toBe("done");

  // Offline hosts were built, never reachable: the report lists them as such.
  const byStatus = Object.values(statuses(state));
  expect(byStatus.filter((status) => status === "deployed")).toHaveLength(12);
  expect(statuses(state).alt).toBe("offline");
  expect(statuses(state)["vbox-umi"]).toBe("offline");
});

test("waves are attributed to the step that started them", () => {
  const state = fold(loadScenario("nominal"));
  expect(state.waves.map((wave) => wave.step)).toEqual(["test", "test", "test", "test", "test"]);
  expect(state.waves[0]).toMatchObject({ index: 1, total: 5, hosts: ["hcs"] });
});

test("step durations are recoverable from start and end", () => {
  const { steps } = fold(loadScenario("nominal"));
  const build = steps.build;
  expect(build.startedAt).toBeDefined();
  expect(build.endedAt! - build.startedAt!).toBeGreaterThan(0);
});

test("an aborted run stays unfinished, resumable from its current step", () => {
  const state = fold(loadScenario("abort"));
  expect(state.end).toBeUndefined();
  expect(state.currentStep).toBe("build");
  expect(Object.values(statuses(state)).every((status) => status === "remaining")).toBe(true);
});

test("a step cut by an abort now: aborted, still the step to resume, hosts not done", () => {
  const state = fold([
    ...loadScenario("abort"),
    { t: 28000, kind: "step.end", step: "build", status: "aborted" },
  ]);
  expect(state.steps.build).toMatchObject({ status: "aborted", endedAt: 28000 });
  expect(state.currentStep).toBe("build");
  expect(Object.values(statuses(state)).every((status) => status === "remaining")).toBe(true);
});

test("a known exclusion and a skipped update are kept", () => {
  const state = fold(loadScenario("offline"));
  expect(state.steps.update.status).toBe("skipped");
  expect(state.hosts.find((host) => host.name === "nlt")).toMatchObject({
    status: "excluded",
    known: true,
  });
});

test("the collection of a failed host is kept: units, then the error excerpt", () => {
  const state = fold(loadScenario("ai-repair"));
  expect(state.hosts.find((host) => host.name === "nlt")?.diagnosis).toEqual({
    units: ["nginx.service"],
    excerpt: ["nginx.service: Failed with result 'exit-code'."],
  });

  // Nothing activated: the build failure keeps an excerpt and no unit.
  const build = fold(loadScenario("build-failure"));
  expect(build.hosts.find((host) => host.name === "ms-a2")?.diagnosis).toMatchObject({ units: [] });
});

test("a repaired host ends deployed, its note kept for the report", () => {
  const state = fold(loadScenario("ai-repair"));
  expect(statuses(state).nlt).toBe("deployed");
  expect(state.notes).toEqual([
    { host: "nlt", message: "recovered by an AI repair: restart nginx.service" },
  ]);
});

test("a refused action is kept, and costs no attempt", () => {
  const state = fold([
    { t: 1, kind: "host.add", host: "nlt", profile: "lan", zone: "ag" },
    {
      t: 2,
      kind: "ai.action",
      host: "nlt",
      action: "restart sshd.service",
      outcome: "refused",
      detail: "not a failed unit",
    },
    { t: 3, kind: "ai.action", host: "nlt", action: "restart nginx.service", outcome: "failed" },
  ]);

  expect(state.actions).toHaveLength(2);
  expect(spentAttempts(state, "nlt")).toBe(1);
  expect(spentAttempts(state, "gfx")).toBe(0);
});

// Recorded streams stop at `ask`: the replayer closes it once answered.
test("an amended commit replaces its line, and counts", () => {
  const commit = (rev: string, amends?: string): Event => ({
    kind: "commit",
    repo: "consumer",
    rev,
    message: `fix(outline): try ${rev}`,
    subject: "gw-cp",
    ...(amends === undefined ? {} : { amends }),
    t: 0,
  });
  const state = fold([commit("c0"), commit("c1"), commit("c2", "c1"), commit("c3", "c2")]);

  const subject = "gw-cp";
  expect(state.commits).toEqual([
    { repo: "consumer", rev: "c0", message: "fix(outline): try c0", subject },
    { repo: "consumer", rev: "c3", message: "fix(outline): try c3", subject, amended: 2 },
  ]);
});

test("a commit waits for a validation of the last edit", () => {
  const action = (host: string, label: string, outcome: "done" | "failed" = "done"): Event => ({
    kind: "ai.action",
    host,
    action: label,
    outcome,
    t: 0,
  });
  const after = (...events: Event[]) => validatedSinceEdit(fold(events), "gfx");

  expect(after()).toBe(true);
  expect(after(action("gfx", "edit a.nix"))).toBe(false);
  expect(after(action("gfx", "edit a.nix"), action("gfx", "validate gfx"))).toBe(true);
  expect(
    after(
      action("gfx", "validate gfx"),
      action("gfx", "edit a.nix"),
      action("nlt", "validate nlt"),
    ),
  ).toBe(false);
  expect(after(action("gfx", "edit a.nix"), action("gfx", "validate gfx", "failed"))).toBe(false);
});

test("edits up to the next validate make one series, closed by any other action", () => {
  const action = (
    label: string,
    outcome: "done" | "failed" | "refused" = "done",
    host = "gfx",
  ): Event => ({ kind: "ai.action", host, action: label, outcome, t: 0 });
  const open = (...events: Event[]) => editSeriesOpen(fold(events), "gfx");

  expect(open()).toBe(false);
  expect(open(action("edit a.nix"))).toBe(true);
  expect(open(action("edit a.nix"), action("edit b.nix", "refused"))).toBe(true);
  expect(open(action("edit a.nix"), action("validate gfx", "failed"))).toBe(false);
  expect(open(action("edit a.nix"), action("restart nginx.service"))).toBe(false);
  expect(open(action("edit a.nix"), action("validate nlt", "done", "nlt"))).toBe(true);
});

test("closed questions are kept as decisions", () => {
  const state = fold([
    { t: 5, kind: "ask", id: "lost", question: "gfx lost", options: [] },
    { t: 9, kind: "ask.close", id: "lost", value: "exclude" },
  ]);
  expect(state.answers).toEqual([{ id: "lost", value: "exclude", t: 9 }]);
});

test("status of each progress state, reachable or not", () => {
  const cases: [HostState, boolean, HostStatus][] = [
    ["pending", false, "remaining"],
    ["building", true, "remaining"],
    ["built", true, "remaining"],
    ["built", false, "offline"],
    ["tested", false, "tested"],
    ["error", true, "error"],
    ["reverted", true, "reverted"],
    ["excluded", false, "excluded"],
  ];
  for (const [state, online, status] of cases) {
    expect({ state, online, status: hostStatus({ state, online }) }).toEqual({
      state,
      online,
      status,
    });
  }
});

test("path and origin survive later states and a JSON round trip", () => {
  const origin = { system: "/nix/store/a-nixos-system", profile: "/nix/store/a-nixos-system" };
  const state = fold([
    { t: 0, kind: "host.add", host: "h", profile: "p", zone: "z" },
    { t: 1, kind: "host.presence", host: "h", online: true },
    { t: 2, kind: "host.state", host: "h", state: "building" },
    { t: 3, kind: "host.state", host: "h", state: "built", path: "/nix/store/b-nixos-system" },
    { t: 4, kind: "host.state", host: "h", state: "copying" },
    { t: 5, kind: "host.state", host: "h", state: "testing", origin },
    { t: 6, kind: "host.state", host: "h", state: "tested" },
  ]);

  expect(state.hosts[0]).toMatchObject({
    path: "/nix/store/b-nixos-system",
    origin,
    status: "tested",
  });
  expect(state.lastEventAt).toBe(6);
  expect(JSON.parse(JSON.stringify(state))).toEqual(state);
});

test("unknown event kinds leave the state untouched", () => {
  const state = fold(loadScenario("nominal"));
  const unknown = { t: 999_999, kind: "from.the.future" } as unknown as Event;
  expect(persist(state, unknown)).toBe(state);
});
