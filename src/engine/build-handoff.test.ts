// Which failed builds go to the AI, grouped how, read through which host.

import { describe, expect, test } from "bun:test";
import type { HostState } from "../model/events.ts";
import { buildGroups } from "./build-handoff.ts";
import type { BuildCause, HostEntry } from "./hosts.ts";
import type { KnownError } from "./known-errors.ts";

const ANYIO = "/nix/store/h595cdhgvy8s9ajn3b4xrpxrwy8isylm-python3.12-anyio-4.14.2.drv";

function host(
  name: string,
  note: string,
  cause?: BuildCause,
  extra: { state?: HostState; knownError?: KnownError } = {},
): HostEntry {
  return {
    name,
    profile: "desktop",
    zone: "ag",
    state: extra.state ?? "failed",
    gateway: false,
    local: false,
    builder: "srv-ag",
    lost: false,
    note,
    ...(cause === undefined ? {} : { buildCause: cause }),
    ...(extra.knownError === undefined ? {} : { knownError: extra.knownError }),
  };
}

const own = { kind: "derivation", drv: ANYIO, own: true } as const;
const inherited = { kind: "derivation", drv: ANYIO, own: false } as const;
const CANNOT = `Cannot build '${ANYIO}'.`;

describe("buildGroups", () => {
  test("one group per reason, read through the host that built the failure itself", () => {
    const groups = buildGroups([
      host("gw-ag", CANNOT, inherited),
      host("pc-ag", CANNOT, own),
      host("lt-cp", CANNOT, inherited),
      host("srv-ag", "error: Go 1.25 is end-of-life", { kind: "evaluation" }),
    ]);

    expect(groups).toEqual([
      { hosts: ["gw-ag", "pc-ag", "lt-cp"], representative: "pc-ag" },
      { hosts: ["srv-ag"], representative: "srv-ag" },
    ]);
  });

  test("nothing the code holds: builder, evaluation as a whole, known stop or exclude", () => {
    const stop: KnownError = { message: "nix-eval-jobs mismatch", fix: { kind: "stop" } };
    const exclude: KnownError = { message: "excluded", fix: { kind: "exclude" } };
    const retried: KnownError = { message: "transient", fix: { kind: "retry" } };

    expect(
      buildGroups([
        host("hcs", "builder gw-cp: killed by signal 9"),
        host("gw-ag", "not evaluated"),
        host("pc-ag", CANNOT, own, { knownError: stop }),
        host("lt-cp", CANNOT, own, { knownError: exclude }),
        host("gw-cp", CANNOT, own, { state: "excluded" }),
      ]),
    ).toEqual([]);

    // A retry already ran and the build still failed: the code may hold the cause.
    expect(buildGroups([host("pc-ag", CANNOT, own, { knownError: retried })])).toHaveLength(1);
  });
});
