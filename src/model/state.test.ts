// Folds every recorded scenario and checks the outcome the interface shows.
//
// Guards the engine -> interface contract: a scenario that no longer folds to
// its expected end state means the contract moved.

import { expect, test } from "bun:test";
import { listScenarios, loadScenario } from "../testing/replay.ts";
import { type Event, type HostState, STEPS } from "./events.ts";
import {
  excludedCount,
  initialState,
  type RunState,
  reduce,
  type ShownState,
  shownState,
  visibleHosts,
} from "./state.ts";

function fold(name: string): RunState {
  return loadScenario(name).reduce(reduce, initialState());
}

function countState(state: RunState, wanted: ShownState): number {
  return state.hosts.filter((host) => shownState(host) === wanted).length;
}

/** One host, then the given events: the table row the interface would draw. */
function hostAfter(events: Event[]) {
  const start: Event[] = [{ t: 0, kind: "host.add", host: "h", profile: "p", zone: "z" }];
  const state = [...start, ...events].reduce(reduce, initialState());
  return { state, host: state.hosts[0]! };
}

const hostState = (state: HostState, extra: Partial<Event> = {}): Event =>
  ({ t: 1, kind: "host.state", host: "h", state, ...extra }) as Event;

const presence = (online: boolean): Event => ({ t: 1, kind: "host.presence", host: "h", online });

test("every scenario is discoverable", () => {
  expect(listScenarios().sort()).toEqual([
    "abort",
    "ai-repair",
    "build-failure",
    "nominal",
    "offline",
  ]);
});

test("nominal deploys every reachable host", () => {
  const state = fold("nominal");
  expect(state.hosts).toHaveLength(14);
  expect(countState(state, "deployed")).toBe(12);
  expect(countState(state, "offline")).toBe(2);
  expect(state.end?.exitCode).toBe(0);

  // Report is the last step: nothing may stay unfinished behind it.
  for (const step of STEPS) {
    expect(state.steps[step].status).toBe("done");
  }
});

test("offline hides excluded hosts and keeps them counted", () => {
  const state = fold("offline");
  expect(countState(state, "deployed")).toBe(3);
  expect(countState(state, "offline")).toBe(3);
  expect(excludedCount(state)).toBe(1);
  expect(visibleHosts(state)).toHaveLength(state.hosts.length - 1);
});

test("build failure excludes the host during the run, still shown, and finishes", () => {
  const state = fold("build-failure");
  expect(countState(state, "deployed")).toBe(4);
  expect(countState(state, "excluded")).toBe(1);
  expect(excludedCount(state)).toBe(0);
  expect(visibleHosts(state)).toHaveLength(state.hosts.length);
  expect(state.steps.build.status).toBe("error");
  expect(state.feed.some((item) => item.kind === "ai")).toBe(true);
});

test("ai repair recovers the failed host", () => {
  const state = fold("ai-repair");
  expect(countState(state, "deployed")).toBe(3);
  expect(countState(state, "failed")).toBe(0);

  // The failure must survive in the feed even once the host recovered.
  expect(state.feed.some((item) => item.level === "error")).toBe(true);
});

test("abort stops mid-build with nothing deployed", () => {
  const state = fold("abort");
  expect(state.steps.build.status).toBe("running");
  expect(countState(state, "deployed")).toBe(0);
  expect(state.end).toBeUndefined();
});

test("settled hosts drop their live output line", () => {
  const state = fold("nominal");
  for (const host of state.hosts) {
    if (host.state === "deployed") expect(host.lastLine).toBeUndefined();
  }
});

test("each started step opens a heading in the feed", () => {
  const state = fold("nominal");
  const headings = state.feed.filter((item) => item.kind === "step").map((item) => item.message);
  expect(headings).toEqual(["Update", "Select", "Build", "Test", "Switch", "Report"]);
});

test("a streamed AI answer accumulates and closes", () => {
  const state = fold("ai-repair");
  const blocks = state.feed.filter((item) => item.kind === "ai");
  expect(blocks).toHaveLength(1);

  const block = blocks[0]!;
  // Longer than the 8-row streaming window of panels.tsx, so the scenario
  // exercises the rolling view and the collapse that follows it.
  expect(block.detail?.length).toBeGreaterThan(8);
  expect(block.streaming).toBe(false);
});

test("a skipped step still counts as settled", () => {
  const state = fold("offline");
  expect(state.steps.update.status).toBe("skipped");
});

test("every host starts unreachable until a ping answers", () => {
  expect(shownState(hostAfter([]).host)).toBe("offline");
  expect(shownState(hostAfter([presence(true)]).host)).toBe("pending");
});

test("an unreachable host keeps the offline glyph while it builds", () => {
  const { host } = hostAfter([hostState("building")]);
  expect(host.state).toBe("building");
  expect(shownState(host)).toBe("offline");
});

test("failures and exclusions win over presence, failed over error", () => {
  expect(shownState(hostAfter([hostState("error")]).host)).toBe("error");
  expect(shownState(hostAfter([hostState("failed")]).host)).toBe("failed");
  expect(shownState(hostAfter([presence(true), hostState("reverted")]).host)).toBe("reverted");
  expect(shownState(hostAfter([hostState("excluded")]).host)).toBe("excluded");
});

test("only exclusions known before the run are hidden", () => {
  const decided = hostAfter([hostState("excluded")]).state;
  expect(visibleHosts(decided)).toHaveLength(1);
  expect(excludedCount(decided)).toBe(0);

  const known = hostAfter([hostState("excluded", { known: true })]).state;
  expect(visibleHosts(known)).toHaveLength(0);
  expect(excludedCount(known)).toBe(1);
});

test("the built path and the origin survive later states", () => {
  const origin = { system: "/nix/store/a-system", profile: "/nix/store/a-system" };
  const { host } = hostAfter([
    hostState("built", { path: "/nix/store/b-system" }),
    hostState("testing", { origin }),
    hostState("tested"),
  ]);
  expect(host.path).toBe("/nix/store/b-system");
  expect(host.origin).toEqual(origin);
});

test("nominal records its plan and commits without touching the feed", () => {
  const events = loadScenario("nominal");
  expect(events.some((event) => event.kind === "plan")).toBe(true);
  expect(events.filter((event) => event.kind === "commit")).toHaveLength(2);

  const withoutStructured = events.filter((e) => e.kind !== "plan" && e.kind !== "commit");
  const feed = (list: Event[]) =>
    list.reduce(reduce, initialState()).feed.map((item) => item.message);
  expect(feed(events)).toEqual(feed(withoutStructured));
});
