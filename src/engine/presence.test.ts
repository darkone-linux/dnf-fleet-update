// Presence on fakes: rounds at start, every `pingInterval`, on `p`, tracked hosts only.

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUTS, DEFAULTS } from "../model/params.ts";
import { type CommandScript, fakeRunContext, flush } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { ping } from "./commands/host.ts";
import { HostTable } from "./hosts.ts";
import { Presence } from "./presence.ts";

const answers = (host: string, ...codes: number[]): CommandScript[] =>
  codes.map((exitCode, index) => ({
    match: [...ping(host, DEFAULT_TIMEOUTS).argv],
    exitCode,
    once: index < codes.length - 1,
  }));

function setup(commands: CommandScript[]) {
  const context = fakeRunContext({ commands, hostname: "pc-ag" });
  const hosts = new HostTable(context, fleetSelection("pc-ag"));
  const presence = new Presence(context, hosts);
  const changes = () =>
    context.events.events.flatMap((event) =>
      event.kind === "host.presence" ? [`${event.host} ${event.online ? "up" : "down"}`] : [],
    );
  return { context, hosts, presence, changes };
}

describe("Presence", () => {
  test("first round at once, the deployment host without a ping, every first answer", async () => {
    const { context, presence, changes } = setup([...answers("gw-ag", 0), ...answers("srv-ag", 1)]);
    presence.track(["gw-ag", "srv-ag", "pc-ag"]);

    presence.start();
    await flush();

    expect(changes().sort()).toEqual(["gw-ag up", "pc-ag up", "srv-ag down"]);
    expect(context.commands.calls.map((call) => call.argv.at(-1))).toEqual(["gw-ag", "srv-ag"]);
    await presence.stop();
  });

  test("every pingInterval, and at once on p", async () => {
    const { context, presence, changes } = setup([...answers("srv-ag", 1, 0, 1)]);
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
    expect(context.commands.calls).toHaveLength(3);
    await presence.stop();
  });

  test("an untracked host is no longer pinged; a halt ends the loop", async () => {
    const { context, presence } = setup([...answers("gw-ag", 0), ...answers("gw-cp", 0)]);
    presence.track(["gw-ag", "gw-cp"]);
    presence.start();
    await flush();

    presence.untrack(["gw-ag"]);
    context.clock.advance(DEFAULTS.pingInterval * 1000);
    await flush();
    expect(context.commands.calls.map((call) => call.argv.at(-1))).toEqual([
      "gw-ag",
      "gw-cp",
      "gw-cp",
    ]);

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
