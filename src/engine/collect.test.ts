// Deterministic collection: what it asks a host, and what it keeps.

import { describe, expect, test } from "bun:test";
import { type CommandScript, fakeRunContext, feed } from "../testing/fakes.ts";
import { anywhere, fleetSelection } from "../testing/fleet.ts";
import { collect } from "./collect.ts";
import { HostTable } from "./hosts.ts";

const UNITS: CommandScript[] = [
  { match: anywhere("systemctl status"), output: [{ stream: "stdout", line: "State: degraded" }] },
  {
    match: anywhere("list-units"),
    output: [
      { stream: "stdout", line: "outline.service loaded failed failed Outline" },
      { stream: "stdout", line: "nginx.service   loaded failed failed Nginx" },
    ],
  },
  { match: anywhere("journalctl") },
];

/** A host that failed after its activation: reachable, with a wave behind it. */
function activated(commands: CommandScript[] = UNITS) {
  const context = fakeRunContext({ commands });
  const hosts = new HostTable(context, fleetSelection());
  const host = hosts.get("hcs");
  host.activated = "test";
  host.online = true;
  host.waveStartedAt = 0;
  context.clock.advance(45_000);
  return { context, hosts };
}

describe("collect", () => {
  test("an activated host: units named, journals read since its wave started", async () => {
    const { context, hosts } = activated();

    expect(await collect(context, hosts, "hcs")).toEqual(["outline.service", "nginx.service"]);

    const journals = context.commands.calls
      .map((call) => call.argv.join(" "))
      .filter((argv) => argv.includes("journalctl"));
    expect(journals).toHaveLength(2);
    expect(journals[0]).toContain("journalctl -u outline.service --no-pager -n 200 --since=-45s");
    expect(feed(context.events.events)).toContain(
      "warn hcs: units failed: outline.service, nginx.service",
    );
    expect(context.events.events.at(-1)).toMatchObject({
      kind: "host.diagnosis",
      host: "hcs",
      units: ["outline.service", "nginx.service"],
    });
  });

  test("everything collected lands in the log of the host", async () => {
    const { context, hosts } = activated();

    await collect(context, hosts, "hcs");

    const log = context.run.logs.get("hcs.diag") ?? [];
    expect(log.filter((line) => line.startsWith("$ "))).toHaveLength(4);
    expect(log).toContain("State: degraded");
  });

  test("a host that was never activated: excerpt only, no command run", async () => {
    const context = fakeRunContext();
    const hosts = new HostTable(context, fleetSelection());

    const units = await collect(context, hosts, "hcs", ["error: build failed", "  at line 2"]);

    expect(units).toEqual([]);
    expect(context.commands.calls).toEqual([]);
    expect(context.events.events).toEqual([
      {
        t: 0,
        kind: "host.diagnosis",
        host: "hcs",
        units: [],
        excerpt: ["error: build failed", "  at line 2"],
      },
    ]);
  });

  test("the excerpt keeps its last lines, as many as the parameters allow", async () => {
    const context = fakeRunContext({
      params: { diagnostics: { journalLines: 5, excerptLines: 2 } },
    });
    const hosts = new HostTable(context, fleetSelection());

    await collect(context, hosts, "hcs", ["one", "two", "three"]);

    expect(context.events.events[0]).toMatchObject({ excerpt: ["two", "three"] });
  });

  test("nothing to say: no event, so the report keeps no empty diagnosis", async () => {
    const { context, hosts } = activated([
      { match: anywhere("systemctl status") },
      { match: anywhere("list-units") },
    ]);

    expect(await collect(context, hosts, "hcs")).toEqual([]);
    expect(context.events.events).toEqual([]);
  });

  test("an unreachable host is not asked anything", async () => {
    const { context, hosts } = activated();
    hosts.get("hcs").online = false;

    expect(await collect(context, hosts, "hcs", ["boom"])).toEqual([]);
    expect(context.commands.calls).toEqual([]);
    expect(context.events.events).toHaveLength(1);
  });
});
