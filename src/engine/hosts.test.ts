// Host table: the transition guard and the events it emits.

import { describe, expect, test } from "bun:test";
import { fakeRunContext } from "../testing/fakes.ts";
import { fleetSelection, storePath } from "../testing/fleet.ts";
import { HostTable } from "./hosts.ts";

describe("HostTable", () => {
  test("flags gateways and the deployment host; every host starts pending, unreachable", () => {
    const hosts = new HostTable(fakeRunContext(), fleetSelection("pc-ag"));

    expect(hosts.get("gw-cp")).toMatchObject({ state: "pending", online: false, gateway: true });
    expect(hosts.get("pc-ag")).toMatchObject({ local: true, gateway: false });
    expect(() => hosts.get("nope")).toThrow("unknown host");
  });

  test("legal transitions become events, details included; illegal ones throw", () => {
    const context = fakeRunContext();
    const hosts = new HostTable(context, fleetSelection());

    hosts.set("hcs", "building");
    hosts.set("hcs", "built", { path: storePath("hcs") });

    expect(context.events.events).toEqual([
      { t: 0, kind: "host.state", host: "hcs", state: "building" },
      { t: 0, kind: "host.state", host: "hcs", state: "built", path: storePath("hcs") },
    ]);
    expect(hosts.get("hcs").path).toBe(storePath("hcs"));
    expect(() => hosts.set("hcs", "deployed")).toThrow(
      "illegal transition of hcs: built -> deployed",
    );
  });

  test("presence emitted on change only", () => {
    const context = fakeRunContext();
    const hosts = new HostTable(context, fleetSelection());

    hosts.presence("hcs", false);
    hosts.presence("hcs", true);
    hosts.presence("hcs", true);

    expect(context.events.events).toEqual([
      { t: 0, kind: "host.presence", host: "hcs", online: true },
    ]);
  });
});
