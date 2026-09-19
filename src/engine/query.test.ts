// `--on` parsing and selection.

import { expect, test } from "bun:test";
import type { FleetHost } from "./fleet.ts";
import { parseQuery, type QueryTerm, selectHosts } from "./query.ts";

const FLEET: FleetHost[] = [
  { name: "hcs", profile: "hcs", zone: "www", tags: ["zone-www"], features: [] },
  { name: "gw-ag", profile: "gateway", zone: "ag", tags: ["zone-ag"], features: [] },
  { name: "gfx", profile: "admin-desktop", zone: "ag", tags: ["zone-ag", "admin"], features: [] },
  { name: "gw-cp", profile: "gateway", zone: "cp", tags: ["zone-cp"], features: [] },
  { name: "fd-01", profile: "desktop", zone: "ag", tags: ["zone-ag"], features: [] },
  { name: "fd-02", profile: "desktop", zone: "ag", tags: ["zone-ag"], features: [] },
];

function select(query: string): { names: string[]; unmatched: string[] } {
  const terms = parseQuery(query);
  if (!terms.ok) throw new Error(terms.error);
  const selection = selectHosts(FLEET, terms.value);
  return { names: selection.hosts.map((host) => host.name), unmatched: selection.unmatched };
}

test("spec examples", () => {
  expect(select("gfx,hcs,gw-*,fd-*").names).toEqual([
    "hcs",
    "gw-ag",
    "gfx",
    "gw-cp",
    "fd-01",
    "fd-02",
  ]);
  expect(select("@zone-ag,+gateway").names).toEqual(["gw-ag", "gfx", "gw-cp", "fd-01", "fd-02"]);
});

test("terms unite, keep fleet order and never duplicate", () => {
  expect(select("fd-02,gw-ag,+gateway,gw-*").names).toEqual(["gw-ag", "gw-cp", "fd-02"]);
});

test("globs apply to tags and profiles too, `?` is one character", () => {
  expect(select("@zone-c?").names).toEqual(["gw-cp"]);
  expect(select("+*desktop").names).toEqual(["gfx", "fd-01", "fd-02"]);
  expect(select("fd-0?").names).toEqual(["fd-01", "fd-02"]);
});

test("a dot is literal, not a wildcard", () => {
  expect(select("gfx.lan").names).toEqual([]);
});

test("terms matching nothing are reported as written", () => {
  expect(select("gfx,nlt,@zone-lg,+server")).toEqual({
    names: ["gfx"],
    unmatched: ["nlt", "@zone-lg", "+server"],
  });
});

test("parsing: kinds, spaces around commas", () => {
  expect(parseQuery(" gfx , @admin,+gateway")).toEqual({
    ok: true,
    value: [
      { kind: "name", pattern: "gfx" },
      { kind: "tag", pattern: "admin" },
      { kind: "profile", pattern: "gateway" },
    ] satisfies QueryTerm[],
  });
});

test("parsing rejects empty terms and shell or regex characters", () => {
  for (const query of ["", "gfx,", ",gfx", "@", "+", "gfx;reboot", "gw-[a-z]", "a b", "@zone ag"]) {
    const result = parseQuery(query);
    expect({ query, ok: result.ok }).toEqual({ query, ok: false });
  }
});
