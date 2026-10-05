// Derivations failed by themselves: which hosts inherit one, and when.

import { describe, expect, test } from "bun:test";
import { type CommandScript, fakeRunContext } from "../testing/fakes.ts";
import { storePath } from "../testing/fleet.ts";
import { BuildFailures, type FailedBuild } from "./build-failures.ts";

const ANYIO = "/nix/store/h595cdhgvy8s9ajn3b4xrpxrwy8isylm-python3.12-anyio-4.14.2.drv";

const FAILURE: FailedBuild = {
  drv: ANYIO,
  host: "pc-ag",
  note: `Cannot build '${ANYIO}'.`,
  excerpt: [`error: Cannot build '${ANYIO}'.`],
};

/** Closure of each host's derivation: `ANYIO` in those of `holding`. */
function setup(holding: readonly string[]) {
  const scripts: CommandScript[] = ["gw-ag", "srv-ag", "lt-cp"].map((host) => ({
    match: ["nix-store", "--query", "--requisites", storePath(host, ".drv")],
    output: holding.includes(host) ? [{ stream: "stdout", line: ANYIO }] : [],
  }));
  const context = fakeRunContext({ commands: scripts });
  const queries = () => context.commands.calls.filter((call) => call.argv[0] === "nix-store");
  return { context, failures: new BuildFailures(context), queries };
}

describe("build failures", () => {
  test("no failure yet: nothing read, nothing cut", async () => {
    const { failures, queries } = setup(["gw-ag"]);

    const watch = await failures.watch("gw-ag", storePath("gw-ag", ".drv"));

    expect(watch.signal.aborted).toBe(false);
    expect(watch.failure).toBeUndefined();
    expect(queries()).toEqual([]);
  });

  test("a build in flight whose closure holds it: cut, with the failure to inherit", async () => {
    const { failures } = setup(["gw-ag"]);
    const holding = await failures.watch("gw-ag", storePath("gw-ag", ".drv"));
    const free = await failures.watch("lt-cp", storePath("lt-cp", ".drv"));

    failures.record(FAILURE);
    await failures.settled();

    expect(holding.signal.aborted).toBe(true);
    expect(holding.failure).toEqual(FAILURE);
    expect(free.signal.aborted).toBe(false);
  });

  test("a host watched after the failure: known before its build starts", async () => {
    const { failures } = setup(["srv-ag"]);
    failures.record(FAILURE);

    const watch = await failures.watch("srv-ag", storePath("srv-ag", ".drv"));

    expect(watch.failure).toEqual(FAILURE);
  });

  test("its own failure, a closed watch, a derivation seen twice: none cuts", async () => {
    const { failures, queries } = setup(["gw-ag", "srv-ag"]);
    const own = await failures.watch("pc-ag", storePath("pc-ag", ".drv"));
    const closed = await failures.watch("gw-ag", storePath("gw-ag", ".drv"));
    closed.close();

    failures.record(FAILURE);
    failures.record({ ...FAILURE, host: "srv-ag" });
    await failures.settled();

    expect(own.signal.aborted).toBe(false);
    expect(closed.signal.aborted).toBe(false);
    expect(queries()).toEqual([]);
  });

  test("each closure read once, however many failures", async () => {
    const { failures, queries } = setup([]);
    const watch = await failures.watch("lt-cp", storePath("lt-cp", ".drv"));

    failures.record(FAILURE);
    failures.record({ ...FAILURE, drv: storePath("other", ".drv") });
    await failures.settled();

    expect(watch.signal.aborted).toBe(false);
    expect(queries()).toHaveLength(1);
  });
});
