// Folds every recorded scenario and checks the outcome the interface shows.
//
// Guards the engine -> interface contract: a scenario that no longer folds to
// its expected end state means the contract moved.

import { expect, test } from "bun:test";
import { listScenarios, loadScenario } from "../engine/replay.ts";
import { STEPS } from "./events.ts";
import { excludedCount, initialState, reduce, visibleHosts, type RunState } from "./state.ts";

function fold(name: string): RunState {
  return loadScenario(name).reduce(reduce, initialState());
}

function countState(state: RunState, wanted: string): number {
  return state.hosts.filter((host) => host.state === wanted).length;
}

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

test("build failure excludes the host and still finishes", () => {
  const state = fold("build-failure");
  expect(countState(state, "deployed")).toBe(4);
  expect(excludedCount(state)).toBe(1);
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
  expect(headings).toEqual(["Update", "Select", "Probe", "Build", "Test", "Switch", "Report"]);
});

test("a streamed AI answer accumulates and closes", () => {
  const state = fold("ai-repair");
  const blocks = state.feed.filter((item) => item.kind === "ai");
  expect(blocks).toHaveLength(1);

  const block = blocks[0]!;
  expect(block.detail?.length).toBeGreaterThan(AI_STREAM_ROWS);
  expect(block.streaming).toBe(false);
});

/** Above this many lines the block scrolls instead of growing (see panels.tsx). */
const AI_STREAM_ROWS = 8;

test("a skipped step still counts as settled", () => {
  const state = fold("offline");
  expect(state.steps.update.status).toBe("skipped");
});
