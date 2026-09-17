// Run directories on a temp dir.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvent } from "../model/events.ts";
import { initialPersisted } from "../model/persist.ts";
import { DirectoryStore, runDate } from "./store.ts";

const temp = mkdtempSync(join(tmpdir(), "fleet-update-store-"));
const DATE = new Date("2026-09-17T02:00:00.123Z");
let count = 0;

/** A fresh `var/deployments` per test. */
const store = () => new DirectoryStore(join(temp, `deployments-${++count}`), () => DATE);

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("DirectoryStore", () => {
  test("ISO 8601 basic UTC date, then the mode", () => {
    expect(runDate(DATE)).toBe("20260917T020000Z");
    expect(store().create("partial").id).toBe("20260917T020000Z-partial");
  });

  test("a run directory is never reused", () => {
    const deployments = store();
    deployments.create("full");

    expect(() => deployments.create("full")).toThrow();
  });

  test("events appended one per line, readable back", () => {
    const deployments = store();
    const run = deployments.create("full");
    const events = [
      { t: 0, kind: "log", level: "info", message: "start" },
      { t: 12, kind: "host.presence", host: "gw-ag", online: true },
    ] as const;

    for (const event of events) run.appendEvent(event);

    const path = join(temp, `deployments-${count}`, run.id, "events.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines.map(parseEvent)).toEqual([...events]);
  });

  test("state replaced whole, no temporary file left", () => {
    const run = store().create("full");
    const dir = join(temp, `deployments-${count}`, run.id);
    const state = initialPersisted();

    run.writeState(state);
    run.writeState({ ...state, plan: [["hcs"], ["gw-ag"]], lastEventAt: 42 });

    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).toMatchObject({
      schema: 1,
      plan: [["hcs"], ["gw-ag"]],
      lastEventAt: 42,
    });
    expect(readdirSync(dir).sort()).toEqual(["gcroots", "logs", "state.json"]);
  });

  test("logs by host and phase, run logs, report, out-links inside the run", () => {
    const run = store().create("full");
    const dir = join(temp, `deployments-${count}`, run.id);

    run.appendLog({ host: "gw-ag", phase: "copy" }, "copying 12 paths");
    run.appendLog({ host: "gw-ag", phase: "copy" }, "done");
    run.appendLog({ phase: "clean" }, "formatted");
    run.writeReport("# Report\n");

    expect(readFileSync(join(dir, "logs", "gw-ag.copy.log"), "utf8")).toBe(
      "copying 12 paths\ndone\n",
    );
    expect(existsSync(join(dir, "logs", "clean.log"))).toBe(true);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("# Report\n");
    expect(run.outLink("gw-ag")).toBe(join(dir, "gcroots", "gw-ag"));
  });

  test("names that could leave the run directory throw", () => {
    const run = store().create("full");

    expect(() => run.appendLog({ host: "..", phase: "copy" }, "")).toThrow("unsafe log name");
    expect(() => run.appendLog({ phase: "a/b" }, "")).toThrow("unsafe log name");
    expect(() => run.outLink("../gw-ag")).toThrow("unsafe host");
  });
});
