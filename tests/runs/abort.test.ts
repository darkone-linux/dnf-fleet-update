// Early ends of a whole run (spec § Raccourcis, abandon; § Mode interactif):
// after wave, now, `no` answers, and which exit code wins.

import { expect, test } from "bun:test";
import { simulateRun } from "../../src/testing/runs.ts";

test("after wave during the build: the build ends, nothing asked, nothing deployed, exit 5", async () => {
  const run = await simulateRun({
    argv: [],
    hooks: (flow) => [{ kind: "build", host: "hcs", run: () => flow.abort("after-wave") }],
  });

  expect(run.exitCode).toBe(5);
  expect(run.events.filter((event) => event.kind === "ask")).toEqual([]);
  expect(run.recorded?.state?.steps.build.status).toBe("done");
  expect(run.sim.count("copy")).toBe(0);
  expect(run.feed).toContain("warn aborting after the current step or wave");
});
