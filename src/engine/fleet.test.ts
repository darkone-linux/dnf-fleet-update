// Fleet data schemas: shape of the generator output, cross-checks, rejections.

import { describe, expect, test } from "bun:test";
import { parseFleet, parseHosts } from "./fleet.ts";

// Synthetic, modelled on the generator output: unused keys are ignored.
const HOSTS = [
  {
    hostname: "hcs",
    profile: "hcs",
    zone: "www",
    ip: "203.0.113.10",
    vpnIp: "100.64.0.2",
    fqdn: "hcs.example.org",
    colmena: { deployment: { tags: ["online", "zone-www"] } },
  },
  {
    hostname: "gw-ag",
    profile: "gateway",
    zone: "ag",
    ip: "10.1.1.1",
    colmena: { deployment: { tags: ["zone-ag"] } },
  },
  {
    hostname: "gfx",
    profile: "admin-desktop",
    zone: "ag",
    ip: null,
    features: { "auto-build": "ag", "build-farm": "ag" },
  },
];

const NETWORK = {
  domain: "example.org",
  services: [],
  zones: {
    ag: { ipPrefix: "10.1", gateway: { hostname: "gw-ag" } },
    www: { ipPrefix: null, gateway: { hostname: "hcs" } },
  },
};

describe("hosts", () => {
  test("keeps order, tags and optional fields", () => {
    const result = parseHosts(HOSTS);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          name: "hcs",
          profile: "hcs",
          zone: "www",
          ip: "203.0.113.10",
          vpnIp: "100.64.0.2",
          arch: undefined,
          tags: ["online", "zone-www"],
          features: [],
        },
        {
          name: "gw-ag",
          profile: "gateway",
          zone: "ag",
          ip: "10.1.1.1",
          vpnIp: undefined,
          arch: undefined,
          tags: ["zone-ag"],
          features: [],
        },
        {
          name: "gfx",
          profile: "admin-desktop",
          zone: "ag",
          ip: undefined,
          vpnIp: undefined,
          arch: undefined,
          tags: [],
          features: ["auto-build", "build-farm"],
        },
      ],
    });
  });

  test("rejects a host name that could reach a shell or a Nix string", () => {
    // `$` + `{`: a Nix antiquotation, spelled apart to stay a plain string.
    for (const hostname of ["a;rm -rf /", `$${"{"}builtins.x}`, "-oProxyCommand", "x"]) {
      const result = parseHosts([{ hostname, profile: "p", zone: "z" }]);
      expect({ hostname, ok: result.ok }).toEqual({ hostname, ok: false });
    }
  });

  test("rejects duplicates and non-lists", () => {
    expect(parseHosts([HOSTS[2], HOSTS[2]])).toEqual({
      ok: false,
      error: "hosts.nix: duplicate host gfx",
    });
    expect(parseHosts({ hosts: HOSTS }).ok).toBe(false);
  });
});

describe("fleet", () => {
  test("zones carry their prefix and gateway, defaults stay empty when undeclared", () => {
    const result = parseFleet(HOSTS, NETWORK);
    if (!result.ok) throw new Error(result.error);

    expect(result.value.zones).toEqual([
      { name: "ag", ipPrefix: "10.1", gateway: "gw-ag" },
      { name: "www", ipPrefix: undefined, gateway: "hcs" },
    ]);
    expect(result.value.domain).toBe("example.org");
    expect(result.value.defaults).toEqual({
      deploymentOrder: undefined,
      criticalProfiles: undefined,
      timeouts: {},
      pingInterval: undefined,
    });
  });

  test("declared fleet defaults are read", () => {
    const network = {
      ...NETWORK,
      fleetUpdate: {
        deploymentOrder: "hcs:gateway:[others]",
        criticalProfiles: "hcs:gateway",
        timeouts: { build: 7200, killGrace: 20 },
        pingInterval: 30,
      },
    };
    const result = parseFleet(HOSTS, network);
    expect(result.ok && result.value.defaults).toEqual({
      deploymentOrder: "hcs:gateway:[others]",
      criticalProfiles: "hcs:gateway",
      timeouts: { build: 7200, killGrace: 20 },
      pingInterval: 30,
    });
  });

  test("a mistyped timeout key or a zero delay is rejected", () => {
    const typo = { ...NETWORK, fleetUpdate: { timeouts: { biuld: 7200 } } };
    expect(parseFleet(HOSTS, typo).ok).toBe(false);

    const zero = { ...NETWORK, fleetUpdate: { timeouts: { ping: 0 } } };
    expect(parseFleet(HOSTS, zero).ok).toBe(false);
  });

  test("a host in an undeclared zone is rejected", () => {
    const stray = [...HOSTS, { hostname: "ms-a2", profile: "server", zone: "cp" }];
    expect(parseFleet(stray, NETWORK)).toEqual({
      ok: false,
      error: "hosts.nix: host ms-a2 in unknown zone cp",
    });
  });
});
