// Early ends: which signals fire, which ending wins.

import { describe, expect, test } from "bun:test";
import { RunFlow } from "./flow.ts";

describe("RunFlow", () => {
  test("after wave: an ending, nothing killed", () => {
    const flow = new RunFlow();
    flow.abort("after-wave");

    expect(flow.ending).toBe("aborted");
    expect([flow.halt.aborted, flow.now.aborted]).toEqual([false, false]);
  });

  test("stop halts new operations, commands keep running", () => {
    const flow = new RunFlow();
    flow.stop("stop");

    expect([flow.halt.aborted, flow.now.aborted]).toEqual([true, false]);
  });

  test("now kills everything; a stop decided earlier keeps its exit code", () => {
    const flow = new RunFlow();
    flow.stop("stop");
    flow.abort("now");

    expect(flow.ending).toBe("stop");
    expect([flow.halt.aborted, flow.now.aborted]).toEqual([true, true]);

    flow.stop("rollback");
    expect(flow.ending).toBe("rollback");
  });

  test("ping requests reach subscribers until they leave", () => {
    const flow = new RunFlow();
    let pings = 0;
    const leave = flow.onPing(() => {
      pings += 1;
    });

    flow.requestPing();
    leave();
    flow.requestPing();

    expect(pings).toBe(1);
  });
});
