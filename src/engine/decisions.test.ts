// Decisions taken by the signature table instead of a question.

import { describe, expect, test } from "bun:test";
import { fakeRunContext, feed } from "../testing/fakes.ts";
import { fleetSelection } from "../testing/fleet.ts";
import { decideFailure } from "./decisions.ts";
import { HostTable } from "./hosts.ts";
import type { Fix } from "./known-errors.ts";

/** A host that failed, with the trap its output carried. */
function failed(fix: Fix, activated = false) {
  const context = fakeRunContext({ params: { interactive: true } });
  const hosts = new HostTable(context, fleetSelection());
  hosts.set("hcs", "building");
  const entry = hosts.get("hcs");
  if (activated) entry.activated = "test";
  entry.knownError = { message: "the deploy user is not trusted on that host", fix };
  hosts.set("hcs", "failed", { note: "copy failed" });
  return { context, hosts };
}

describe("decideFailure", () => {
  test("a stop from the table stops the run without asking, interactive included", async () => {
    const { context, hosts } = failed({ kind: "stop" });

    expect(await decideFailure(context, hosts, ["hcs"])).toBe("stop");

    expect(context.flow.ending).toBe("stop");
    expect(context.events.events.some((event) => event.kind === "ask")).toBe(false);
    expect(feed(context.events.events)).toContain("warn known error decides: stop");
  });

  // Leaving an activated host on the new generation is not "going on without it".
  test("an exclusion from the table reverts a host that was already activated", async () => {
    const { context, hosts } = failed({ kind: "exclude" }, true);

    expect(await decideFailure(context, hosts, ["hcs"])).toBe("revert");
    expect(hosts.get("hcs").state).toBe("failed");
  });

  test("an exclusion before any activation excludes the host and goes on", async () => {
    const { context, hosts } = failed({ kind: "exclude" });

    expect(await decideFailure(context, hosts, ["hcs"])).toBe("exclude");
    expect(hosts.get("hcs").state).toBe("excluded");
    expect(context.flow.ending).toBeUndefined();
  });

  // The retries are already spent, and the AI has not run yet: ask.
  test("retry and ai leave the question alone", async () => {
    for (const fix of [{ kind: "retry" } as const, { kind: "ai" } as const]) {
      const context = fakeRunContext({
        params: { interactive: true },
        answers: { "failed-hcs": "exclude" },
      });
      const hosts = new HostTable(context, fleetSelection());
      hosts.set("hcs", "building");
      hosts.get("hcs").knownError = { message: "flaky", fix };
      hosts.set("hcs", "failed", { note: "copy failed" });

      expect(await decideFailure(context, hosts, ["hcs"])).toBe("exclude");
      expect(context.events.events.some((event) => event.kind === "ask")).toBe(true);
    }
  });
});
