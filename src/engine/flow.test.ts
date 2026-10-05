// Early ends: which signals fire, which ending wins.

import { describe, expect, test } from "bun:test";
import { type AbortCause, abortedBy, RunFlow } from "./flow.ts";

describe("RunFlow", () => {
  test("after wave: an ending, nothing killed", () => {
    const flow = new RunFlow();
    flow.abort("after-wave", "operator");

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
    flow.abort("now", "operator");

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

  test("free AI questions reach subscribers until they leave", () => {
    const flow = new RunFlow();
    const asked: string[] = [];
    const leave = flow.onAi((question) => asked.push(question));

    flow.requestAi("why is gfx slow?");
    leave();
    flow.requestAi("and now?");

    expect(asked).toEqual(["why is gfx slow?"]);
  });

  test("abort requests reach subscribers before any signal fires", () => {
    const flow = new RunFlow();
    const heard: string[] = [];
    flow.onAbort((mode) => heard.push(`${mode} ${flow.now.aborted}`));

    flow.abort("after-wave", "operator");
    flow.abort("now", "operator");

    expect(heard).toEqual(["after-wave false", "now false"]);
  });

  test("the first abort names its cause: a later one does not take it over", () => {
    const flow = new RunFlow();
    expect(flow.abortCause).toBeUndefined();

    flow.abort("after-wave", "answer");
    flow.abort("now", "SIGTERM");

    expect(flow.abortCause).toBe("answer");
    const causes: AbortCause[] = ["operator", "answer", "SIGTERM"];
    expect(causes.map(abortedBy)).toEqual(["by the operator", "on a no answer", "by SIGTERM"]);
  });
});
