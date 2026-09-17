// Waves against the spec example (§ Vagues), profile lists, current zone.

import { describe, expect, test } from "bun:test";
import type { FleetHost, FleetZone } from "./fleet.ts";
import { currentZone, OTHERS, parseProfileList, planWaves } from "./waves.ts";

const host = (name: string, profile: string, zone: string): FleetHost => ({
  name,
  profile,
  zone,
  tags: [],
});

// The spec example fleet, in `hosts.nix` order.
const FLEET: FleetHost[] = [
  host("hcs", "hcs", "www"),
  host("gw-ag", "gateway", "ag"),
  host("nlt", "lan", "ag"),
  host("gfx", "admin-desktop", "ag"),
  host("alt", "laptop", "ag"),
  host("vbox-umi", "umi", "ag"),
  host("vbox-test", "vbox", "ag"),
  host("gw-cp", "gateway", "cp"),
  host("ms-a2", "server", "cp"),
  host("lenovo", "laptop", "cp"),
  host("gw-lg", "gateway", "lg"),
  host("fd-01", "desktop", "ag"),
  host("fd-02", "desktop", "ag"),
  host("fl-01", "laptop", "ag"),
];

const DEFAULT_ORDER = ["hcs", "gateway", "server", OTHERS, "laptop"];

const ANYWHERE_OTHERS = ["nlt", "gfx", "vbox-umi", "vbox-test", "fd-01", "fd-02"];

describe("spec example, arthur-network in zone ag", () => {
  test("current zone first", () => {
    expect(planWaves({ hosts: FLEET, order: DEFAULT_ORDER, currentZone: "ag" })).toEqual([
      ["hcs"],
      ["gw-ag"],
      ANYWHERE_OTHERS,
      ["alt", "fl-01"],
      ["gw-cp", "gw-lg"],
      ["ms-a2"],
      ["lenovo"],
    ]);
  });

  test("--no-current-zone-before: by profile, all zones together", () => {
    expect(planWaves({ hosts: FLEET, order: DEFAULT_ORDER })).toEqual([
      ["hcs"],
      ["gw-ag", "gw-cp", "gw-lg"],
      ["ms-a2"],
      ANYWHERE_OTHERS,
      ["alt", "lenovo", "fl-01"],
    ]);
  });
});

test("the head wave spans every zone, even the current one", () => {
  const order = ["gateway", "hcs", OTHERS];
  expect(planWaves({ hosts: FLEET, order, currentZone: "ag" })[0]).toEqual([
    "gw-ag",
    "gw-cp",
    "gw-lg",
  ]);
});

test("a selection keeps only its hosts and drops empty waves", () => {
  const selected = FLEET.filter((candidate) => ["gfx", "ms-a2"].includes(candidate.name));
  expect(planWaves({ hosts: selected, order: DEFAULT_ORDER, currentZone: "ag" })).toEqual([
    ["gfx"],
    ["ms-a2"],
  ]);
});

test("profiles left out of an order without [others] come last", () => {
  expect(planWaves({ hosts: FLEET.slice(0, 4), order: ["hcs", "gateway"] })).toEqual([
    ["hcs"],
    ["gw-ag"],
    ["nlt", "gfx"],
  ]);
});

describe("profile lists", () => {
  test("accepts the generator syntax", () => {
    expect(parseProfileList("hcs:gateway:server:[others]:laptop", true)).toEqual({
      ok: true,
      value: DEFAULT_ORDER,
    });
    expect(parseProfileList("hcs:gateway:server", false).ok).toBe(true);
  });

  test("rejects what the generator rejects", () => {
    for (const [value, allowOthers] of [
      ["hcs:[others]", false],
      ["hcs::gateway", true],
      ["hcs:gateway:hcs", true],
      ["hcs:[others]:[others]", true],
      ["1server", true],
      ["", true],
    ] as const) {
      const result = parseProfileList(value, allowOthers);
      expect({ value, ok: result.ok }).toEqual({ value, ok: false });
    }
  });
});

describe("current zone", () => {
  const zones: FleetZone[] = [
    { name: "www", gateway: "hcs" },
    { name: "ag", ipPrefix: "10.1" },
    { name: "ag-lab", ipPrefix: "10.1.9" },
    { name: "cp", ipPrefix: "10.2" },
  ];

  test("matches on whole address components, longest prefix first", () => {
    expect(currentZone(zones, ["127.0.0.1", "10.1.2.1"])).toBe("ag");
    expect(currentZone(zones, ["10.1.9.4"])).toBe("ag-lab");
    expect(currentZone(zones, ["10.10.0.1"])).toBeUndefined();
  });

  test("unknown without a matching address or prefix", () => {
    expect(currentZone(zones, [])).toBeUndefined();
    expect(currentZone([{ name: "www" }], ["203.0.113.10"])).toBeUndefined();
  });
});
