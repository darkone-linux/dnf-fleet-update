// Publication on fakes: zone order, what each host is served with, and the
// hosts the step leaves to their wave.

import { describe, expect, test } from "bun:test";
import type { HostState } from "../../model/events.ts";
import { type CommandScript, fakeRunContext } from "../../testing/fakes.ts";
import {
  anywhere,
  fleetSelection,
  HAPPY_HOSTS as HAPPY,
  pingOf,
  remote,
  storePath,
} from "../../testing/fleet.ts";
import { HostTable } from "../hosts.ts";
import { Presence } from "../presence.ts";
import { publish } from "./publish.ts";

function setup(commands: CommandScript[] = [], local?: string) {
  const context = fakeRunContext({ commands: [...commands, ...HAPPY] });
  const hosts = new HostTable(context, fleetSelection(local));
  for (const host of hosts.all()) {
    hosts.set(host.name, "building");
    hosts.set(host.name, "built", { path: storePath(host.name) });
  }
  context.events.events.length = 0;
  const states = () =>
    Object.fromEntries(hosts.all().map((host) => [host.name, host.state])) as Record<
      string,
      HostState
    >;

  // Hosts in the order the step served them: the zone cache must come first.
  const servedOrder = () =>
    context.commands.calls.flatMap(({ argv }) => {
      const pulled = argv.find((arg) => arg.startsWith("nix@"));
      return pulled !== undefined && (argv.at(-1) ?? "").includes("--max-jobs 0")
        ? [pulled.slice(4)]
        : [];
    });
  return { context, hosts, presence: new Presence(context, hosts), states, servedOrder };
}

describe("publish", () => {
  test("every reachable host ends ready, out of any wave", async () => {
    const { context, hosts, presence, states } = setup();

    await publish(context, hosts, presence);

    expect(Object.values(states())).toEqual(Array(6).fill("ready"));
    expect(context.events.events.filter((event) => event.kind === "wave.start")).toEqual([]);
    expect(context.events.events).toContainEqual({
      t: 0,
      kind: "step.start",
      step: "publish",
      total: 6,
    });
  });

  test("the zone cache is served before the rest of its zone", async () => {
    const { context, hosts, presence, servedOrder } = setup();

    await publish(context, hosts, presence);

    // `srv-ag` caches zone `ag`, `gw-cp` caches zone `cp` (synthetic fleet).
    const order = servedOrder();
    expect(order.indexOf("srv-ag")).toBeLessThan(order.indexOf("gw-ag"));
    expect(order.indexOf("srv-ag")).toBeLessThan(order.indexOf("pc-ag"));
    expect(order.indexOf("gw-cp")).toBeLessThan(order.indexOf("lt-cp"));
  });

  test("a pull that succeeds costs no push", async () => {
    const { context, hosts, presence } = setup([{ match: remote("gw-ag", "--max-jobs 0") }]);

    await publish(context, hosts, presence);

    expect(hosts.get("gw-ag").state).toBe("ready");
    expect(context.commands.calls.some(({ argv }) => argv.includes("ssh-ng://nix@gw-ag"))).toBe(
      false,
    );
  });

  test("the deployment host built it: nothing travels", async () => {
    const { context, hosts, presence } = setup([], "pc-ag");

    await publish(context, hosts, presence);

    expect(hosts.get("pc-ag").state).toBe("ready");
    expect(context.commands.calls.some(({ argv }) => argv.includes("nix@pc-ag"))).toBe(false);
  });

  test("an offline host stays built, named, and its zone cache warned about", async () => {
    const { context, hosts, presence, states } = setup([pingOf("srv-ag", 1)]);

    await publish(context, hosts, presence);

    expect(states()["srv-ag"]).toBe("built");
    expect(states()["gw-ag"]).toBe("ready");
    expect(feedOf(context)).toContain("warn offline, served before their wave: srv-ag");
    expect(feedOf(context)).toContain("warn zone ag: cache offline, its hosts pay one by one");
  });

  test("a zone cache that fails: its zone is still served, with a warning", async () => {
    const { context, hosts, presence, states } = setup([
      { match: anywhere("ssh-ng://nix@srv-ag"), exitCode: 1 },
    ]);

    await publish(context, hosts, presence);

    // Failed, then excluded by the unattended decision.
    expect(states()["srv-ag"]).toBe("excluded");
    expect(states()["gw-ag"]).toBe("ready");
    expect(feedOf(context)).toContain("warn zone ag: cache not seeded, its hosts pay one by one");
  });
});

const feedOf = (context: ReturnType<typeof fakeRunContext>) =>
  context.events.events.flatMap((event) =>
    event.kind === "log" ? [`${event.level} ${event.message}`] : [],
  );
