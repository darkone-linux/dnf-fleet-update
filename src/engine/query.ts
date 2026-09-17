// `--on` host query (spec § Options): names, globs, `@tag`, `+profile`.
//
// Terms are comma-separated and united; `*` and `?` glob in every kind, as
// colmena does for names and tags.

import { fail, ok, type Result } from "../model/result.ts";
import type { FleetHost } from "./fleet.ts";

export type QueryTerm =
  | { kind: "name"; pattern: string }
  | { kind: "tag"; pattern: string }
  | { kind: "profile"; pattern: string };

/** Host, tag and profile characters of the generator, plus the two glob wildcards. */
const TERM = /^[a-zA-Z0-9_.*?-]+$/;

export function parseQuery(query: string): Result<QueryTerm[]> {
  const terms: QueryTerm[] = [];
  for (const raw of query.split(",")) {
    const term = raw.trim();
    const kind = term.startsWith("@") ? "tag" : term.startsWith("+") ? "profile" : "name";
    const pattern = kind === "name" ? term : term.slice(1);
    if (!TERM.test(pattern)) return fail(`--on: invalid term "${term}"`);
    terms.push({ kind, pattern });
  }
  return ok(terms);
}

function glob(pattern: string): RegExp {
  const source = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

function matches(host: FleetHost, term: QueryTerm, re: RegExp): boolean {
  switch (term.kind) {
    case "name":
      return re.test(host.name);
    case "tag":
      return host.tags.some((tag) => re.test(tag));
    case "profile":
      return re.test(host.profile);
  }
}

export interface Selection {
  /** In fleet order. */
  hosts: FleetHost[];

  /** Terms that matched no host, as written: the caller decides to warn or stop. */
  unmatched: string[];
}

export function selectHosts(fleet: readonly FleetHost[], terms: readonly QueryTerm[]): Selection {
  const compiled = terms.map((term) => ({ term, re: glob(term.pattern) }));
  const hosts = fleet.filter((host) => compiled.some(({ term, re }) => matches(host, term, re)));
  const unmatched = compiled
    .filter(({ term, re }) => !fleet.some((host) => matches(host, term, re)))
    .map(
      ({ term }) => (term.kind === "tag" ? "@" : term.kind === "profile" ? "+" : "") + term.pattern,
    );
  return { hosts, unmatched };
}
