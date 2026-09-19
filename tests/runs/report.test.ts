// `--send-report`: what the alert rooms receive, and the exit code when a
// message does not reach them.

import { expect, test } from "bun:test";
import { ExitCode } from "../../src/model/exit-codes.ts";
import { NETWORK_JSON } from "../../src/testing/fleet.ts";
import { simulateRun } from "../../src/testing/runs.ts";

const SENDING = ["--no-ui", "--send-report"];

test("run done: the summary reaches the warnings room, exit 0", async () => {
  const run = await simulateRun({ argv: SENDING });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.sim.messages.map((message) => message.room)).toEqual(["warnings"]);
  expect(run.sim.messages[0]?.body).toStartWith("**Fleet Update Report** (0)");
  expect(run.sim.messages[0]?.body).toContain(
    "- Hosts: 6 deployed (hcs, gw-ag, srv-ag, pc-ag, gw-cp, lt-cp)",
  );
  expect(run.feed).toContain("ok report sent to Matrix");
});

test("critical host left out: a second message in the incidents room", async () => {
  const run = await simulateRun({
    argv: SENDING,
    behaviours: { "srv-ag": { reachable: false } },
  });

  expect(run.sim.messages.map((message) => message.room)).toEqual(["warnings", "incidents"]);
  expect(run.sim.messages[1]?.body).toContain("## Critical hosts not deployed");
  expect(run.sim.messages[1]?.body).toContain("- srv-ag (server):");
});

test("the recipe refuses the message: run done, report not sent, exit 3", async () => {
  const run = await simulateRun({ argv: SENDING, sendMsgExit: 11 });

  expect(run.exitCode).toBe(ExitCode.ReportNotSent);
  expect(run.statuses.hcs).toBe("deployed");
  expect(run.feed.at(-1)).toStartWith("error report not sent: warnings: exit 11");
});

test("alert rooms not configured here: exit 3, the run itself is untouched", async () => {
  const run = await simulateRun({ argv: SENDING, sendMsgExit: 10 });

  expect(run.exitCode).toBe(ExitCode.ReportNotSent);
  expect(run.recorded?.report).toContain("- Status: done (exit 0)");
  expect(run.sim.messages).toHaveLength(1);
});

test("a zone without a harmonia: named in the report, its hosts served one by one", async () => {
  const networkJson = {
    ...NETWORK_JSON,
    services: NETWORK_JSON.services.filter((service) => service.zone !== "ag"),
  };
  const run = await simulateRun({ argv: ["--no-ui"], networkJson });

  expect(run.exitCode).toBe(ExitCode.Ok);
  expect(run.recorded?.report).toContain(
    "## Zones without a cache\n\n- ag: no harmonia, everything the fleet builds for it",
  );

  // Built by the global harmonia, but nothing caches zone `ag`: each host of
  // the zone is pushed to, one by one.
  for (const name of ["gw-ag", "srv-ag", "pc-ag"]) expect(run.sim.count("copy", name)).toBe(1);
});
