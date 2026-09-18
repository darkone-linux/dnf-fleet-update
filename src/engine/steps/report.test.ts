// Report step on fakes: `report.md` always written, Matrix only on demand.

import { describe, expect, test } from "bun:test";
import type { Event } from "../../model/events.ts";
import { initialPersisted, persist } from "../../model/persist.ts";
import { type CommandScript, fakeRunContext, feed } from "../../testing/fakes.ts";
import { MATRIX_JSON, NETWORK_JSON } from "../../testing/fleet.ts";
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

const generated = (file: string, value: unknown): CommandScript => ({
  match: (argv) => argv[0] === "nix-instantiate" && argv.at(-1)?.endsWith(file) === true,
  output: [{ stream: "stdout", line: JSON.stringify(value) }],
});

const SOPS: CommandScript = {
  match: ["sops"],
  output: [{ stream: "stdout", line: "syt_fake_token" }],
};

const SENDING: CommandScript[] = [
  generated("matrix.nix", MATRIX_JSON),
  generated("network.nix", NETWORK_JSON),
  SOPS,
];

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
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
    expect(context.matrix.messages).toEqual([]);
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "ok" });
  });

  test("run done: summary to the warnings room, critical hosts to the incidents room", async () => {
    const context = fakeRunContext({ params: { sendReport: true }, commands: SENDING });

    const outcome = await report(context, input({ state: FAILED_HCS }));

    expect(outcome.sent).toBe(true);
    expect(context.matrix.messages.map((message) => message.room)).toEqual([
      "!warnings:example.org",
      "!incidents:example.org",
    ]);
    const [summary, incident] = context.matrix.messages;
    expect(summary?.homeserver).toBe("https://matrix.example.org");
    expect(summary?.token).toBe("syt_fake_token");
    expect(summary?.timeoutMs).toBe(30_000);
    expect(summary?.text).toStartWith("**fleet-update 20260917T020000Z-full** — exit 0");
    expect(incident?.text).toContain("- hcs (hcs): failed — build failed: disk full");
    expect(feed(context.events.events)).toContain("ok report sent (2 to Matrix)");
  });

  test("stop: one message to the incidents room, titled by the error that ended the run", async () => {
    const context = fakeRunContext({ params: { sendReport: true }, commands: SENDING });

    await report(
      context,
      input({ state: FAILED_HCS, status: "failed", exitCode: 1 }),
      "hcs: build failed: disk full",
    );

    expect(context.matrix.messages.map((message) => message.room)).toEqual([
      "!incidents:example.org",
    ]);
    expect(context.matrix.messages[0]?.text).toContain("error: hcs: build failed: disk full");
  });

  test("no matrix.nix: report written, run reported as not sent", async () => {
    const context = fakeRunContext({
      params: { sendReport: true },
      commands: [{ match: ["nix-instantiate"], exitCode: 1 }],
    });

    const outcome = await report(context, input());

    expect(outcome.sent).toBe(false);
    expect(context.run.report).toContain("- Status: done (exit 0)");
    expect(feed(context.events.events).at(-1)).toStartWith("error report not sent: matrix.nix:");
    expect(context.events.events.at(-1)).toMatchObject({ kind: "step.end", status: "error" });
  });

  test("room refuses the message: not sent", async () => {
    const context = fakeRunContext({ params: { sendReport: true }, commands: SENDING });
    context.matrix.refusal = "403 Forbidden";

    const outcome = await report(context, input());

    expect(outcome.sent).toBe(false);
    expect(feed(context.events.events)).toContain(
      "error report not sent: !warnings:example.org: 403 Forbidden",
    );
  });
});
