// Deterministic repair: the restart, what it concludes, and when it stands back.

import { describe, expect, test } from "bun:test";
import { type CommandScript, drive, fakeRunContext, feed } from "../testing/fakes.ts";
import { anywhere, fleetSelection } from "../testing/fleet.ts";
import { HostTable } from "./hosts.ts";
import { repairUnits } from "./repair.ts";

const UNITS = ["outline.service", "nginx.service"];

/** A host the activation left in `error`, its failed units already collected. */
function inError(commands: CommandScript[]) {
  const context = fakeRunContext({ commands });
  const hosts = new HostTable(context, fleetSelection());
  hosts.set("hcs", "building");
  hosts.set("hcs", "built");
  hosts.set("hcs", "copying");
  hosts.set("hcs", "ready");
  hosts.set("hcs", "testing");
  hosts.set("hcs", "error", { note: "some units failed" });
  context.events.events.length = 0;
  return { context, hosts };
}

const states = (context: ReturnType<typeof inError>["context"]) =>
  context.events.events.flatMap((event) =>
    event.kind === "host.state"
      ? [`${event.state}${event.note === undefined ? "" : `: ${event.note}`}`]
      : [],
  );

describe("repairUnits", () => {
  test("units back up: the host takes the state its activation aimed at, with a note", async () => {
    const { context, hosts } = inError([
      { match: anywhere("systemctl restart") },
      { match: anywhere("list-units") },
    ]);

    await drive(context.clock, repairUnits(context, hosts, "hcs", UNITS, "test"), 1000);

    expect(states(context)).toEqual([
      "repairing: restarting outline.service, nginx.service",
      "tested",
    ]);
    expect(context.events.events.at(-1)).toEqual({
      t: 10_000,
      kind: "note",
      host: "hcs",
      message: "units recovered after a restart: probable activation ordering issue",
    });

    // One command per unit would make the order ours, when order is the suspect.
    const restart = context.commands.calls
      .map((call) => call.argv.join(" "))
      .find((argv) => argv.includes("systemctl restart"));
    expect(restart).toContain("systemctl restart outline.service nginx.service");
  });

  test("a switch repaired the same way ends deployed", async () => {
    const { context, hosts } = inError([
      { match: anywhere("systemctl restart") },
      { match: anywhere("list-units") },
    ]);

    await drive(context.clock, repairUnits(context, hosts, "hcs", UNITS, "switch"), 1000);

    expect(hosts.get("hcs").state).toBe("deployed");
  });

  // Read back: a unit that starts then dies exits `0` all the same.
  test("a unit still failed: back to error, its name kept, no note", async () => {
    const { context, hosts } = inError([
      { match: anywhere("systemctl restart") },
      {
        match: anywhere("list-units"),
        output: [{ stream: "stdout", line: "nginx.service loaded failed failed Nginx" }],
      },
    ]);

    await drive(context.clock, repairUnits(context, hosts, "hcs", UNITS, "test"), 1000);

    expect(states(context).at(-1)).toBe("error: units still failed after a restart: nginx.service");
    expect(feed(context.events.events)).toContain(
      "warn hcs: units still failed after a restart: nginx.service",
    );
    expect(context.events.events.some((event) => event.kind === "note")).toBe(false);
  });

  test("a halted run repairs nothing: a restart is a new operation", async () => {
    const { context, hosts } = inError([]);
    context.flow.stop("stop");

    await repairUnits(context, hosts, "hcs", UNITS, "test");

    expect(context.commands.calls).toEqual([]);
    expect(hosts.get("hcs").state).toBe("error");
  });

  test("no failed unit collected: nothing to restart", async () => {
    const { context, hosts } = inError([]);

    await repairUnits(context, hosts, "hcs", [], "test");

    expect(context.events.events).toEqual([]);
  });
});
