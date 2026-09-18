// Report step on fakes: `report.md` always written, Matrix only on demand.

import { describe, expect, test } from "bun:test";
import type { Event } from "../../model/events.ts";
import { initialPersisted, persist } from "../../model/persist.ts";
import { type CommandScript, fakeRunContext, feed } from "../../testing/fakes.ts";
import type { ReportInput } from "../report.ts";
import { report } from "./report.ts";

const EVENTS: Event[] = [
  { t: 0, kind: "host.add", host: "hcs", profile: "hcs", zone: "www" },
  { t: 0, kind: "host.add", host: "lt-cp", profile: "laptop", zone: "cp" },
  { t: 10, kind: "host.state", host: "hcs", state: "deployed" },
  { t: 20, kind: "host.state", host: "lt-cp", state: "deployed" },
];

const STATE = EVENTS.reduce(persist, initialPersisted());

/** `hcs` is a critical profile: its failure is worth its own message. */
const FAILED_HCS = persist(STATE, {
  t: 30,
  kind: "host.state",
  host: "hcs",
  state: "failed",
  note: "build failed: disk full",
});

/** The framework recipe: rooms and token are none of the tool's business. */
const SENDING: CommandScript[] = [{ match: ["just", "send-msg"] }];

const sent = (context: { commands: { calls: { argv: readonly string[]; stdin?: string }[] } }) =>
  context.commands.calls
    .filter((call) => call.argv[1] === "send-msg")
    .map((call) => ({ room: call.argv[2], text: call.stdin ?? "" }));

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    runId: "20260917T020000Z-full",
    state: STATE,
    status: "done",
    exitCode: 0,
    durationMs: 65_040,
    warnings: [],
    knownErrors: [],
    ...overrides,
  };
}

describe("report", () => {
  test("no --send-report: report written, nothing sent", async () => {
    const context = fakeRunContext();

    const outcome = await report(context, input());

    expect(outcome.sent).toBe(true);
    expect(context.run.report).toContain("- Status: done (exit 0)");
    expect(sent(context)).toEqual([]);
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "ok" });
  });

  test("run done: summary to the warnings room, critical hosts to the incidents room", async () => {
    const context = fakeRunContext({ params: { sendReport: true }, commands: SENDING });

    const outcome = await report(context, input({ state: FAILED_HCS }));

    expect(outcome.sent).toBe(true);
    const [summary, incident] = sent(context);
    expect([summary?.room, incident?.room]).toEqual(["warnings", "incidents"]);
    expect(summary?.text).toStartWith("**Fleet Update Report** (0)");
    expect(incident?.text).toContain("- hcs (hcs): failed, build failed: disk full");
    expect(feed(context.events.events)).toContain("ok report sent to Matrix");
  });

  test("stop: one message to the incidents room, titled by the error that ended the run", async () => {
    const context = fakeRunContext({ params: { sendReport: true }, commands: SENDING });

    await report(
      context,
      input({ state: FAILED_HCS, status: "failed", exitCode: 1 }),
      "hcs: build failed: disk full",
    );

    expect(sent(context).map((message) => message.room)).toEqual(["incidents"]);
    expect(sent(context)[0]?.text).toContain("Error: hcs: build failed: disk full");
  });

  // Exit `10`: nothing is configured here, so the incidents room is not tried.
  test("alert rooms not configured: report written, one refusal, nothing else tried", async () => {
    const context = fakeRunContext({
      params: { sendReport: true },
      commands: [
        {
          match: ["just", "send-msg"],
          exitCode: 10,
          output: [{ stream: "stderr", line: "no warnings room in matrix.nix" }],
        },
      ],
    });

    const outcome = await report(context, input({ state: FAILED_HCS }));

    expect(outcome.sent).toBe(false);
    expect(context.run.report).toContain("- Status: done (exit 0)");
    expect(sent(context)).toHaveLength(1);
    expect(feed(context.events.events).at(-1)).toBe(
      "error report not sent: warnings: exit 10: no warnings room in matrix.nix",
    );
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });
  });

  // Exit `11`: that room refused, the other one is still worth a try.
  test("room refuses the message: the next room is still tried", async () => {
    const context = fakeRunContext({
      params: { sendReport: true },
      commands: [
        {
          match: ["just", "send-msg"],
          exitCode: 11,
          output: [{ stream: "stderr", line: "homeserver refused the message (HTTP 403)" }],
        },
      ],
    });

    const outcome = await report(context, input({ state: FAILED_HCS }));

    expect(outcome.sent).toBe(false);
    expect(sent(context).map((message) => message.room)).toEqual(["warnings", "incidents"]);
    expect(feed(context.events.events)).toContain(
      "error report not sent: warnings: exit 11: homeserver refused the message (HTTP 403)",
    );
  });
});
