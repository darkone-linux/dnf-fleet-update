// Reading `state.json` of a previous run: what is refused, what is taken back.

import { describe, expect, test } from "bun:test";
import { initialPersisted, type PersistedState, persist } from "../model/persist.ts";
import { testParams } from "../testing/fakes.ts";
import { storePath } from "../testing/fleet.ts";
import { parseSavedState, restore, sameRevisions } from "./resume.ts";

const ORIGIN = { system: storePath("old"), profile: storePath("old") };

/** `state.json` as the fold writes it, with the hosts a test needs. */
function saved(hosts: PersistedState["hosts"], patch: Partial<PersistedState> = {}): string {
  const state = persist(initialPersisted(), {
    t: 0,
    kind: "run.start",
    run: {
      version: "0.0.0-test",
      selection: "all",
      mode: "full",
      codev: false,
      aiModel: "claude:opus@high",
      maxParallel: 10,
      params: testParams(),
    },
  });
  return JSON.stringify({ ...state, hosts, ...patch });
}

const host = (
  name: string,
  status: PersistedState["hosts"][number]["status"],
  patch: Partial<PersistedState["hosts"][number]> = {},
): PersistedState["hosts"][number] => ({
  name,
  profile: "server",
  zone: "ag",
  state: "built",
  status,
  ...patch,
});

describe("parseSavedState", () => {
  test("keeps the work left, drops what was decided or done", () => {
    const text = saved([
      host("hcs", "deployed"),
      host("gw-ag", "tested"),
      host("srv-ag", "offline"),
      host("pc-ag", "failed"),
      host("gw-cp", "remaining"),
      host("lt-cp", "excluded"),
      host("fd-01", "reverted"),
      host("fd-02", "error"),
    ]);

    const state = parseSavedState("20260917T020000Z-full", text);

    expect(state.ok && state.value.hosts.map((entry) => entry.name)).toEqual([
      "gw-ag",
      "srv-ag",
      "pc-ag",
      "gw-cp",
    ]);
    expect(state.ok && state.value.id).toBe("20260917T020000Z-full");
    expect(state.ok && state.value.params.maxParallel).toBe(10);
  });

  test("malformed, foreign or parameterless state is refused with its reason", () => {
    expect(parseSavedState("x", "{")).toMatchObject({ ok: false, error: "state.json: not JSON" });

    const future = JSON.parse(saved([])) as { schema: number };
    future.schema = 99;
    const refused = parseSavedState("x", JSON.stringify(future));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toStartWith("state.json:");

    const noParams = JSON.parse(saved([])) as { run: { params?: unknown } };
    noParams.run.params = undefined;
    expect(parseSavedState("x", JSON.stringify(noParams))).toMatchObject({
      ok: false,
      error: "state.json: no run parameters to resume from",
    });
  });

  test("a store path outside the store is refused: it is fed back to nix", () => {
    const text = saved([host("gw-ag", "tested", { path: "/etc/passwd" })]);

    expect(parseSavedState("x", text).ok).toBe(false);
  });
});

describe("sameRevisions", () => {
  const consumer = "c".repeat(40);
  const dnf = "d".repeat(40);

  test("consumer alone outside co-development, both under it", () => {
    expect(sameRevisions({ consumer }, { consumer }, false)).toBe(true);
    expect(sameRevisions({ consumer }, { consumer: "other" }, false)).toBe(false);
    expect(sameRevisions({ consumer, dnf }, { consumer, dnf }, true)).toBe(true);
    expect(sameRevisions({ consumer, dnf }, { consumer, dnf: "other" }, true)).toBe(false);
  });

  test("an unknown revision never counts as unchanged", () => {
    expect(sameRevisions({}, {}, false)).toBe(false);
    expect(sameRevisions({ consumer }, {}, false)).toBe(false);
    expect(sameRevisions({ consumer }, { consumer }, true)).toBe(false);
  });
});

describe("restore", () => {
  const path = storePath("gw-ag");

  test("a reusable path keeps the progress; a tested host keeps its origin", () => {
    expect(restore(host("gw-ag", "tested", { path, origin: ORIGIN }), true)).toEqual({
      state: "tested",
      path,
      origin: ORIGIN,
    });
    expect(restore(host("gw-ag", "offline", { path }), true)).toEqual({ state: "built", path });
  });

  test("no reusable path: the host starts over, whatever it reached", () => {
    expect(restore(host("gw-ag", "tested", { path, origin: ORIGIN }), false)).toBeUndefined();
    expect(restore(host("gw-ag", "tested", {}), true)).toBeUndefined();
  });
});
