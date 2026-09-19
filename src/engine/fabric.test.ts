// Naming of the stores a run talks to, from the generated fleet data.

import { describe, expect, test } from "bun:test";
import { HOSTS_JSON, NETWORK_JSON } from "../testing/fleet.ts";
import { Fabric } from "./fabric.ts";
import { type Fleet, parseFleet } from "./fleet.ts";

function fleet(): Fleet {
  const parsed = parseFleet(HOSTS_JSON, NETWORK_JSON);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
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

  test("anything outside the fleet keeps its address", () => {
    const fabric = new Fabric(fleet());

    expect(fabric.substituter("https://cache.nixos.org")).toBe("cache.nixos.org");
    expect(fabric.substituter("not a url")).toBe("not a url");
  });
});
