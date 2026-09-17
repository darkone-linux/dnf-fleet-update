// Keys that act on the run: they must reach `RunControl`, never fake the stream.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AbortMode, Event, RunControl, RunSource } from "../model/events.ts";
import { App } from "./App.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;

interface Harness {
  setup: Setup;
  calls: string[];
  quits: number[];
  emit: (event: Event) => void;
  frame: () => Promise<string>;
}

let current: Setup | undefined;

// Frozen spinners: a ticking frame would update state outside `act`.
beforeAll(() => {
  process.env.FLEET_CAPTURE = "1";
});

afterAll(() => {
  delete process.env.FLEET_CAPTURE;
});

afterEach(() => {
  act(() => current?.renderer.destroy());
  current = undefined;
});

async function start(): Promise<Harness> {
  const calls: string[] = [];
  const quits: number[] = [];
  let deliver: ((event: Event) => void) | undefined;
  const control: RunControl = {
    respond: (value) => calls.push(`respond ${value}`),
    abort: (mode: AbortMode) => calls.push(`abort ${mode}`),
    ping: () => calls.push("ping"),
  };
  const source: RunSource = (emit) => {
    deliver = emit;
    return control;
  };

  const setup = await testRender(
    <App source={source} onQuit={(code) => quits.push(code)} />,
    // As `main.tsx`: `^C` is the abort dialog, not a renderer exit.
    { width: 120, height: 30, exitOnCtrlC: false },
  );
  current = setup;
  await setup.renderOnce();
  return {
    setup,
    calls,
    quits,
    emit: (event) => act(() => deliver?.(event)),
    frame: async () => {
      await setup.renderOnce();
      return setup.captureCharFrame();
    },
  };
}

/** Lets the input parser deliver a lone escape. */
async function settle(setup: Setup): Promise<void> {
  await act(() => Bun.sleep(30));
  await setup.renderOnce();
}

const ask: Event = {
  t: 1,
  kind: "ask",
  id: "build",
  question: "Build done. Start the test?",
  options: [
    { value: "yes", label: "yes" },
    { value: "no", label: "no" },
  ],
};

test("^C opens the abort dialog, a second ^C aborts now", async () => {
  const { setup, calls, frame } = await start();

  act(() => setup.mockInput.pressCtrlC());
  expect(await frame()).toContain("Abort the deployment?");

  act(() => setup.mockInput.pressCtrlC());
  expect(calls).toEqual(["abort now"]);
  const shown = await frame();
  expect(shown).toContain("? help");
  expect(shown).not.toContain("Abort the deployment?");
});

test("after wave is chosen with the arrows", async () => {
  const { setup, calls } = await start();

  act(() => setup.mockInput.pressCtrlC());
  await setup.renderOnce();
  act(() => setup.mockInput.pressEnter());
  expect(calls).toEqual(["abort after-wave"]);
});

test("q aborts while running, quits with the exit code once ended", async () => {
  const { setup, calls, quits, emit, frame } = await start();

  act(() => setup.mockInput.pressKey("q"));
  expect(await frame()).toContain("Abort the deployment?");
  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(await frame()).not.toContain("Abort the deployment?");
  expect(quits).toEqual([]);

  emit({ t: 2, kind: "run.end", status: "failed", exitCode: 1, report: ["1 failed (h)"] });
  act(() => setup.mockInput.pressKey("q"));
  expect(quits).toEqual([1]);
  expect(calls).toEqual([]);
});

test("an engine question takes only its options; ^C raises the abort dialog over it", async () => {
  const { setup, calls, emit, frame } = await start();
  emit(ask);
  expect(await frame()).toContain("Build done. Start the test?");

  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(calls).toEqual([]);

  act(() => setup.mockInput.pressCtrlC());
  expect(await frame()).toContain("Abort the deployment?");
  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(await frame()).toContain("Build done. Start the test?");

  act(() => setup.mockInput.pressArrow("right"));
  await setup.renderOnce();
  act(() => setup.mockInput.pressEnter());
  expect(calls).toEqual(["respond no"]);
});

test("p pings the tracked hosts until the run ends", async () => {
  const { setup, calls, emit } = await start();

  act(() => setup.mockInput.pressKey("p"));
  emit({ t: 2, kind: "run.end", status: "done", exitCode: 0 });
  act(() => setup.mockInput.pressKey("p"));
  expect(calls).toEqual(["ping"]);
});
