// Selection step on the synthetic fleet: `--on`, current zone, plan, gateways.

import { describe, expect, test } from "bun:test";
import { type FakeRunOptions, fakeRunContext, feed } from "../../testing/fakes.ts";
import { generatedScripts, HOSTS_JSON } from "../../testing/fleet.ts";
import { select } from "./select.ts";

const context = (options: FakeRunOptions = {}) =>
  fakeRunContext({ commands: generatedScripts(), addresses: ["10.1.0.50"], ...options });

describe("select", () => {
  test("whole fleet from zone ag: hosts added, plan, gateways, deployment host", async () => {
    const run = context({ hostname: "gw-ag" });

    const selection = await select(run);

    expect(selection?.waves).toEqual([
      ["hcs"],
      ["gw-ag"],
      ["srv-ag"],
      ["pc-ag"],
      ["gw-cp"],
      ["lt-cp"],
    ]);
    expect([...(selection?.gateways ?? [])]).toEqual(["hcs", "gw-ag", "gw-cp"]);
    expect(selection?.local).toBe("gw-ag");
    const kinds = run.events.events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "host.add")).toHaveLength(6);
    expect(run.events.events).toContainEqual({ t: 0, kind: "plan", waves: selection?.waves ?? [] });
    expect(feed(run.events.events)).toEqual([
      "info current zone: ag",
      "ok 6 hosts selected, 6 waves",
    ]);
    expect(kinds.at(-1)).toBe("step.end");
  });

  test("--on narrows the fleet, unmatched terms are warnings", async () => {
    const run = context({ params: { on: "gw-*,@nope" } });

    const selection = await select(run);

    expect(selection?.hosts.map((host) => host.name)).toEqual(["gw-ag", "gw-cp"]);
    expect(selection?.local).toBeUndefined();
    expect(feed(run.events.events)[0]).toBe("warn --on: no host matches @nope");
  });

  test("no current zone, non-interactive: waves by profile, all zones together", async () => {
    const run = context({ addresses: ["192.168.9.9"] });

    const selection = await select(run);

    expect(selection?.waves).toEqual([
      ["hcs"],
      ["gw-ag", "gw-cp"],
      ["srv-ag"],
      ["pc-ag"],
      ["lt-cp"],
    ]);
    expect(run.flow.ending).toBeUndefined();
  });

  test("no current zone, interactive, answered no: the run ends aborted after the step", async () => {
    const run = context({ addresses: [], params: { interactive: true }, answers: { zone: "no" } });

    expect(await select(run)).toBeDefined();

    expect(run.events.events.map((event) => event.kind)).toContain("ask.close");
    expect(run.flow.ending).toBe("aborted");
  });

  test("current zone detection skipped under --no-current-zone-before", async () => {
    const run = context({ params: { currentZoneBefore: false } });

    await select(run);

    expect(feed(run.events.events)).toEqual(["ok 6 hosts selected, 5 waves"]);
  });

  test("invalid fleet data or an empty selection fail the step", async () => {
    const duplicate = context({ commands: generatedScripts([...HOSTS_JSON, HOSTS_JSON[0]]) });
    expect(await select(duplicate)).toBeUndefined();
    expect(feed(duplicate.events.events)).toEqual(["error hosts.nix: duplicate host hcs"]);
    expect(duplicate.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });

    const empty = context({ params: { on: "nothing-*" } });
    expect(await select(empty)).toBeUndefined();
    expect(feed(empty.events.events).at(-1)).toBe("error no host selected");
  });
});
