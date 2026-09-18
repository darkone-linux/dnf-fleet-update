// `--send-report`: what the alert rooms receive, and the exit code when a
// message does not reach them.

import { expect, test } from "bun:test";
import { ExitCode } from "../../src/model/exit-codes.ts";
import { simulateRun } from "../../src/testing/runs.ts";

const SENDING = ["--no-ui", "--send-report"];

test("run done: the summary reaches the warnings room, exit 0", async () => {
  const run = await simulateRun({ argv: SENDING });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.matrix.messages.map((message) => message.room)).toEqual(["!warnings:example.org"]);
  const [summary] = run.matrix.messages;
  expect(summary?.homeserver).toBe("https://matrix.example.org");
  expect(summary?.text).toContain("- 6 deployed");
  expect(run.feed).toContain("ok report sent (1 to Matrix)");
});

test("critical host left out: a second message in the incidents room", async () => {
  const run = await simulateRun({
    argv: SENDING,
    behaviours: { "srv-ag": { reachable: false } },
  });

  expect(run.matrix.messages.map((message) => message.room)).toEqual([
    "!warnings:example.org",
    "!incidents:example.org",
  ]);
  expect(run.matrix.messages[1]?.text).toContain("## Critical hosts not deployed");
  expect(run.matrix.messages[1]?.text).toContain("- srv-ag (server):");
});

test("rooms refuse the messages: run done, report not sent, exit 3", async () => {
  const run = await simulateRun({ argv: SENDING, matrixRefusal: "429 Too Many Requests" });

  expect(run.exitCode).toBe(ExitCode.ReportNotSent);
  expect(run.statuses.hcs).toBe("deployed");
  expect(run.feed).toContain("error report not sent: !warnings:example.org: 429 Too Many Requests");
});

test("no matrix.nix in the workspace: exit 3, the run itself is untouched", async () => {
  const run = await simulateRun({ argv: SENDING, matrixJson: null });

  expect(run.exitCode).toBe(ExitCode.ReportNotSent);
  expect(run.recorded?.report).toContain("- Status: done (exit 0)");
  expect(run.feed.at(-1)).toStartWith("error report not sent: matrix.nix:");
  expect(run.matrix.messages).toEqual([]);
});
