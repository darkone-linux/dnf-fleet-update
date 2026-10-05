// Presence on fakes: per-host periods, spaced starts, searches, `p`, tracked hosts only.

import { describe, expect, test } from "bun:test";
import { DEFAULT_PRESENCE, DEFAULT_TIMEOUTS, DEFAULTS } from "../model/params.ts";
import { type CommandScript, drive, fakeRunContext, flush } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { ping } from "./commands/host.ts";
import { HostTable } from "./hosts.ts";
import { Presence } from "./presence.ts";

const ROUND = DEFAULTS.pingInterval * 1000;

const answers = (host: string, ...codes: number[]): CommandScript[] =>
  codes.map((exitCode, index) => ({
    match: [...ping(host, DEFAULT_TIMEOUTS).argv],
    exitCode,
    once: index < codes.length - 1,
  }));

/** Host a probe went to: its `nix@` target. */
const pinged = (argv: readonly string[]) => argv.find((arg) => arg.startsWith("nix@"))?.slice(4);

function setup(commands: CommandScript[], spacingMs = 0) {
  const context = fakeRunContext({
    commands,
    hostname: "pc-ag",
    params: { presence: { ...DEFAULT_PRESENCE, spacingMs } },
  });
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
    const { context, presence, changes, probes } = setup([
      ...answers("gw-ag", 0),
      ...answers("srv-ag", 1),
    ]);
    presence.track(["gw-ag", "srv-ag", "pc-ag"]);

    presence.start();
    await flush();

    // srv-ag searched: its two retries, a round apart.
    for (let round = 0; round < 2; round += 1) {
      context.clock.advance(ROUND);
      await flush();
    }

    expect(changes().sort()).toEqual(["gw-ag up", "pc-ag up", "srv-ag down"]);
    expect(probes().slice(0, 2)).toEqual(["gw-ag", "srv-ag"]);
    await presence.stop();
  });

  test("a failed probe searches, `pingInterval` apart; offline once every attempt failed", async () => {
    const { context, presence, trail, probes } = setup([...answers("srv-ag", 1)]);

    await drive(context.clock, presence.check(["srv-ag"]), 1000);

    expect(DEFAULT_PRESENCE.attempts).toBe(3);
    expect(trail()).toEqual(["srv-ag searching 1", "srv-ag searching 2", "srv-ag down"]);
    expect(probes()).toHaveLength(3);
    expect(context.clock.now()).toBe(2 * ROUND);
  });

  test("why each attempt failed: on the searching event and in the host presence log", async () => {
    const probe = [...ping("srv-ag", DEFAULT_TIMEOUTS).argv];
    const { context, presence } = setup([
      {
        match: probe,
        exitCode: 255,
        output: [{ stream: "stderr", line: "Connection timed out during banner exchange" }],
      },
    ]);

    await drive(context.clock, presence.check(["srv-ag"]), ROUND);

    const searching = context.events.events.find((event) => event.kind === "host.searching");
    expect(searching).toMatchObject({
      reason: "exit 255: Connection timed out during banner exchange",
    });
    const log = context.run.logs.get("srv-ag.presence") ?? [];
    expect(log[0]).toBe("attempt 1/3: exit 255: Connection timed out during banner exchange");
    expect(log.filter((line) => line.startsWith("attempt"))).toHaveLength(3);
  });

  test("one answer ends the search, its verdict said again", async () => {
    const { context, presence, hosts, trail } = setup([...answers("gw-ag", 0, 1, 1, 0)]);

    await presence.check(["gw-ag"]);
    await drive(context.clock, presence.check(["gw-ag"]), ROUND);

    expect(trail()).toEqual(["gw-ag up", "gw-ag searching 1", "gw-ag searching 2", "gw-ag up"]);
    expect(hosts.get("gw-ag").online).toBe(true);
  });

  test("a timed out probe searches; the engine keeps the last verdict meanwhile", async () => {
    let table: HostTable | undefined;
    const seen: (boolean | undefined)[] = [];
    const probe = [...ping("gw-ag", DEFAULT_TIMEOUTS).argv];
    const { context, presence, hosts, trail } = setup([
      { match: probe, once: true },
      { match: probe, timedOut: true, once: true },
      { match: probe, onRun: () => seen.push(table?.get("gw-ag").online) },
    ]);
    table = hosts;

    await presence.check(["gw-ag"]);
    await drive(context.clock, presence.check(["gw-ag"]), ROUND);

    expect(seen).toEqual([true]);
    expect(trail()).toEqual(["gw-ag up", "gw-ag searching 1", "gw-ag up"]);
  });

  test("offline already: one probe watches for its return, no search", async () => {
    const { context, presence, trail, probes } = setup([...answers("srv-ag", 1, 1, 1, 1, 0)]);

    await drive(context.clock, presence.check(["srv-ag"]), ROUND);
    await presence.check(["srv-ag"]);
    expect(probes()).toHaveLength(4);
    expect(trail()).toEqual(["srv-ag searching 1", "srv-ag searching 2", "srv-ag down"]);

    await presence.check(["srv-ag"]);
    expect(trail().at(-1)).toBe("srv-ag up");
  });

  test("probe starts `spacingMs` apart, whatever their host", async () => {
    const starts: number[] = [];
    const { context, presence } = setup(
      [
        {
          match: (argv) => pinged(argv) !== undefined,
          onRun: () => starts.push(context.clock.now()),
        },
      ],
      500,
    );

    await drive(context.clock, presence.check(["gw-ag", "srv-ag", "gw-cp", "lt-cp"]), 100);

    expect(starts).toEqual([0, 500, 1000, 1500]);
  });

  test("a host that answered is pinged `onlineFactor` times less often than one unseen", async () => {
    const { context, presence, probes } = setup([...answers("gw-ag", 0), ...answers("srv-ag", 1)]);
    presence.track(["gw-ag", "srv-ag"]);
    presence.start();

    // Through srv-ag's first search, then a full online period of gw-ag.
    for (let elapsed = 0; elapsed < DEFAULT_PRESENCE.onlineFactor * ROUND; elapsed += ROUND) {
      await flush();
      context.clock.advance(ROUND);
    }
    await flush();
    await presence.stop();

    const count = (host: string) => probes().filter((name) => name === host).length;
    expect(count("gw-ag")).toBe(2);

    // Its search (0, 15, 30 s), then one watch probe a round (45, 60 s).
    expect(count("srv-ag")).toBe(5);
  });

  test("p: every tracked host at once, whatever its period", async () => {
    const { context, presence, probes } = setup([...answers("gw-ag", 0), ...answers("gw-cp", 0)]);
    presence.track(["gw-ag", "gw-cp"]);
    presence.start();
    await flush();
    expect(probes()).toHaveLength(2);

    context.flow.requestPing();
    await flush();

    expect(probes()).toHaveLength(4);
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
    for (let round = 0; round < DEFAULT_PRESENCE.onlineFactor; round += 1) {
      context.clock.advance(ROUND);
      await flush();
    }
    expect(probes()).toEqual(["gw-ag", "gw-cp", "gw-cp"]);

    context.flow.stop("stop");
    await presence.stop();
    context.clock.advance(DEFAULT_PRESENCE.onlineFactor * ROUND);
    await flush();
    expect(context.commands.calls).toHaveLength(3);
  });

  test("check: pings the given hosts now, tracked or not", async () => {
    const { presence, changes } = setup([...answers("lt-cp", 0)]);

    await presence.check(["lt-cp"]);

    expect(changes()).toEqual(["lt-cp up"]);
  });
});
