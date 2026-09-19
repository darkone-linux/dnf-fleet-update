// Naming of the stores a run talks to, and the builder each host gets.

import { describe, expect, test } from "bun:test";
import { HOSTS_JSON, NETWORK_JSON } from "../testing/fleet.ts";
import { Fabric } from "./fabric.ts";
import { type Fleet, type FleetHost, parseFleet } from "./fleet.ts";

function fleet(hosts: unknown = HOSTS_JSON, network: unknown = NETWORK_JSON): Fleet {
  const parsed = parseFleet(hosts, network);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Builder of every host of a fleet, deployment machine `deployer`. */
function builders(value: Fleet): Record<string, string> {
  const fabric = new Fabric(value);
  const named = (host: FleetHost) => [host.name, fabric.builder(host, "deployer")];
  return Object.fromEntries(value.hosts.map(named));
}

describe("Fabric", () => {
  test("the harmonia host of a zone, when it has one", () => {
    const fabric = new Fabric(fleet());

    expect(fabric.harmonia("ag")).toBe("srv-ag");
    expect(fabric.harmonia("cp")).toBe("gw-cp");
    expect(fabric.harmonia("www")).toBeUndefined();
  });

  test("a substituter on a host running one cache service: that service and its zone", () => {
    const fabric = new Fabric(fleet());

    // `srv-ag` by address, `gw-ag` by name and by fqdn: all three forms occur.
    expect(fabric.substituter("http://10.1.0.2:5000")).toBe("harmonia ag");
    expect(fabric.substituter("http://gw-ag:8502")).toBe("nix-cache ag");
    expect(fabric.substituter("http://gw-ag.ag.example.org:8502")).toBe("nix-cache ag");
  });

  test("a host running both caches is named, the port alone cannot tell them apart", () => {
    expect(new Fabric(fleet()).substituter("http://10.2.0.1:5000")).toBe("gw-cp");
  });

  test("builder: the harmonia of the zone, the global harmonia for a zone without one", () => {
    // `www` has no harmonia: `hcs` falls on the global one, two zones away.
    expect(builders(fleet())).toEqual({
      hcs: "gw-cp",
      "gw-ag": "srv-ag",
      "srv-ag": "srv-ag",
      "pc-ag": "srv-ag",
      "gw-cp": "gw-cp",
      "lt-cp": "gw-cp",
    });
  });

  test("builder: auto-build wins over the zone, nothing will travel", () => {
    const hosts = HOSTS_JSON.map((host) =>
      host.hostname === "pc-ag" ? { ...host, features: { "auto-build": "ag" } } : host,
    );

    expect(builders(fleet(hosts))["pc-ag"]).toBe("pc-ag");
  });

  test("builder: an architecture the elected builder does not share stays central", () => {
    const hosts = HOSTS_JSON.map((host) =>
      host.hostname === "pc-ag" ? { ...host, arch: "aarch64-linux" } : host,
    );

    expect(builders(fleet(hosts))["pc-ag"]).toBe("deployer");
  });

  test("builder: no harmonia anywhere, everything is built centrally", () => {
    const network = { ...NETWORK_JSON, services: [] };

    expect(Object.values(builders(fleet(HOSTS_JSON, network)))).toEqual(Array(6).fill("deployer"));
  });

  test("anything outside the fleet keeps its address", () => {
    const fabric = new Fabric(fleet());

    expect(fabric.substituter("https://cache.nixos.org")).toBe("cache.nixos.org");
    expect(fabric.substituter("not a url")).toBe("not a url");
  });
});
