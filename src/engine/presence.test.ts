// Presence on fakes: rounds at start, every `pingInterval`, on `p`, tracked hosts only.

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUTS, DEFAULTS } from "../model/params.ts";
import { type CommandScript, fakeRunContext, flush } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { ping } from "./commands/host.ts";
import { HostTable } from "./hosts.ts";
import { PROBE_ATTEMPTS, Presence } from "./presence.ts";

const answers = (host: string, ...codes: number[]): CommandScript[] =>
  codes.map((exitCode, index) => ({
    match: [...ping(host, DEFAULT_TIMEOUTS).argv],
    exitCode,
    once: index < codes.length - 1,
  }));

/** Host a probe went to: its `nix@` target. */
const pinged = (argv: readonly string[]) => argv.find((arg) => arg.startsWith("nix@"))?.slice(4);

function setup(commands: CommandScript[]) {
  const context = fakeRunContext({ commands, hostname: "pc-ag" });
  const hosts = new HostTable(context, fleetSelection("pc-ag"));
  const presence = new Presence(context, hosts);
  const changes = () =>
    context.events.events.flatMap((event) =>
      event.kind === "host.presence" ? [`${event.host} ${event.online ? "up" : "down"}`] : [],
    );

  // Verdicts and searches, in stream order.
  const trail = () =>
    context.events.events.flatMap((event) => {
      if (event.kind === "host.searching") return [`${event.host} searching ${event.attempt}`];
      if (event.kind === "host.presence") return [`${event.host} ${event.online ? "up" : "down"}`];
      return [];
    });
  const probes = () => context.commands.calls.map((call) => pinged(call.argv));
  return { context, hosts, presence, changes, trail, probes };
}

describe("Presence", () => {
  test("first round at once, the deployment host without a ping, every first verdict", async () => {
    const { presence, changes, probes } = setup([...answers("gw-ag", 0), ...answers("srv-ag", 1)]);
    presence.track(["gw-ag", "srv-ag", "pc-ag"]);

    presence.start();
    await flush();

    expect(changes().sort()).toEqual(["gw-ag up", "pc-ag up", "srv-ag down"]);
    expect(probes()).toEqual(["gw-ag", "srv-ag", "srv-ag", "srv-ag"]);
    await presence.stop();
  });

  test("a failed probe searches; offline after every attempt failed", async () => {
    const { presence, trail, probes } = setup([...answers("srv-ag", 1)]);

    await presence.check(["srv-ag"]);

    expect(PROBE_ATTEMPTS).toBe(3);
    expect(trail()).toEqual(["srv-ag searching 1", "srv-ag searching 2", "srv-ag down"]);
    expect(probes()).toHaveLength(PROBE_ATTEMPTS);
  });

  test("one answer ends the search, its verdict said again", async () => {
    const { presence, hosts, trail } = setup([...answers("gw-ag", 0, 1, 1, 0)]);

    await presence.check(["gw-ag"]);
    await presence.check(["gw-ag"]);

    expect(trail()).toEqual(["gw-ag up", "gw-ag searching 1", "gw-ag searching 2", "gw-ag up"]);
    expect(hosts.get("gw-ag").online).toBe(true);
  });

  test("a timed out probe searches; the engine keeps the last verdict meanwhile", async () => {
    let table: HostTable | undefined;
    const seen: (boolean | undefined)[] = [];
    const probe = [...ping("gw-ag", DEFAULT_TIMEOUTS).argv];
    const { presence, hosts, trail } = setup([
      { match: probe, once: true },
      { match: probe, timedOut: true, once: true },
      { match: probe, onRun: () => seen.push(table?.get("gw-ag").online) },
    ]);
    table = hosts;

    await presence.check(["gw-ag"]);
    await presence.check(["gw-ag"]);

    expect(seen).toEqual([true]);
    expect(trail()).toEqual(["gw-ag up", "gw-ag searching 1", "gw-ag up"]);
  });

  test("offline already: one probe watches for its return, no search", async () => {
    const { presence, trail, probes } = setup([...answers("srv-ag", 1, 1, 1, 1, 0)]);

    await presence.check(["srv-ag"]);
    await presence.check(["srv-ag"]);
    expect(probes()).toHaveLength(PROBE_ATTEMPTS + 1);
    expect(trail()).toEqual(["srv-ag searching 1", "srv-ag searching 2", "srv-ag down"]);

    await presence.check(["srv-ag"]);
    expect(trail().at(-1)).toBe("srv-ag up");
  });

  test("every pingInterval, and at once on p", async () => {
    const { context, presence, changes } = setup([...answers("srv-ag", 1, 1, 1, 0, 1)]);
    presence.track(["srv-ag"]);
    presence.start();
    await flush();
    expect(changes()).toEqual(["srv-ag down"]);

    context.clock.advance(DEFAULTS.pingInterval * 1000);
    await flush();
    expect(changes()).toEqual(["srv-ag down", "srv-ag up"]);

    context.flow.requestPing();
    await flush();
    expect(changes()).toEqual(["srv-ag down", "srv-ag up", "srv-ag down"]);
    expect(context.commands.calls).toHaveLength(2 * PROBE_ATTEMPTS + 1);
    await presence.stop();
  });

  test("a second check joins the probe under way", async () => {
    const { presence, probes, changes } = setup([...answers("lt-cp", 0)]);

    await Promise.all([presence.check(["lt-cp"]), presence.check(["lt-cp"])]);

    expect(probes()).toEqual(["lt-cp"]);
    expect(changes()).toEqual(["lt-cp up"]);
  });

  test("an untracked host is no longer pinged; a halt ends the loop", async () => {
    const { context, presence, probes } = setup([...answers("gw-ag", 0), ...answers("gw-cp", 0)]);
    presence.track(["gw-ag", "gw-cp"]);
    presence.start();
    await flush();

    presence.untrack(["gw-ag"]);
    context.clock.advance(DEFAULTS.pingInterval * 1000);
    await flush();
    expect(probes()).toEqual(["gw-ag", "gw-cp", "gw-cp"]);

    context.flow.stop("stop");
    await presence.stop();
    context.clock.advance(DEFAULTS.pingInterval * 1000);
    await flush();
    expect(context.commands.calls).toHaveLength(3);
  });

  test("check: pings the given hosts now, tracked or not", async () => {
    const { presence, changes } = setup([...answers("lt-cp", 0)]);

    await presence.check(["lt-cp"]);

    expect(changes()).toEqual(["lt-cp up"]);
  });
});
