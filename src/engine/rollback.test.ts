// Forced rollback on fakes: reverse wave order, phase undone, lost hosts left alone.

import { describe, expect, test } from "bun:test";
import { fakeRunContext, feed } from "../testing/fakes.ts";
import { fleetSelection, storePath } from "../testing/fleet.ts";
import { HostTable } from "./hosts.ts";
import { rollbackFleet } from "./rollback.ts";

const ORIGIN = { system: storePath("origin"), profile: storePath("origin") };

describe("rollbackFleet", () => {
  test("activated hosts in reverse wave order, the phase they reached undone", async () => {
    const context = fakeRunContext({ commands: [{ match: ["sudo"] }] });
    const selection = fleetSelection();
    const hosts = new HostTable(context, selection);
    const drive = (name: string, states: Parameters<HostTable["set"]>[1][]) => {
      for (const state of states) {
        hosts.set(
          name,
          state,
          state === "built"
            ? { path: storePath(name) }
            : state === "testing"
              ? { origin: ORIGIN }
              : {},
        );
      }
    };
    const toTested = ["building", "built", "copying", "testing", "tested"] as const;
    drive("hcs", [...toTested, "switching", "deployed"]);
    hosts.get("hcs").activated = "switch";
    drive("gw-ag", [...toTested]);
    hosts.get("gw-ag").activated = "test";
    drive("srv-ag", [...toTested, "switching", "failed"]);
    hosts.get("srv-ag").activated = "switch";
    hosts.get("srv-ag").lost = true;
    drive("pc-ag", ["building", "built"]);
    context.events.events.length = 0;

    await rollbackFleet(context, hosts, selection);

    const order = context.commands.calls.map((call) =>
      call.argv.find((arg) => arg.startsWith("nix@")),
    );
    expect(order).toEqual(["nix@gw-ag", "nix@hcs"]);
    const hcs = context.commands.calls[1]?.argv.at(-1) ?? "";
    expect(hcs).toContain("nix-env");
    expect(context.commands.calls[0]?.argv.at(-1)).not.toContain("nix-env");
    expect(hosts.get("hcs").state).toBe("reverted");
    expect(hosts.get("srv-ag").state).toBe("failed");
    expect(hosts.get("pc-ag").state).toBe("built");
    expect(feed(context.events.events)).toEqual([
      "warn rolling back 2 hosts",
      "ok gw-ag: rolled back to its origin",
      "ok hcs: rolled back to its origin",
    ]);
  });

  test("a failed rollback leaves the host failed, with the reason", async () => {
    const context = fakeRunContext({ commands: [{ match: ["sudo"], exitCode: 255 }] });
    const selection = fleetSelection();
    const hosts = new HostTable(context, selection);
    for (const state of ["building", "built", "copying", "testing", "tested"] as const) {
      hosts.set(
        "lt-cp",
        state,
        state === "built"
          ? { path: storePath("lt-cp") }
          : state === "testing"
            ? { origin: ORIGIN }
            : {},
      );
    }
    hosts.get("lt-cp").activated = "test";

    await rollbackFleet(context, hosts, selection);

    expect(hosts.get("lt-cp")).toMatchObject({
      state: "failed",
      note: "rollback failed: exit 255",
    });
  });

  test("nothing activated: nothing to roll back", async () => {
    const context = fakeRunContext();
    const selection = fleetSelection();

    await rollbackFleet(context, new HostTable(context, selection), selection);

    expect(feed(context.events.events)).toEqual(["info nothing to roll back"]);
  });
});
