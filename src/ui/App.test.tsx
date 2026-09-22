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
    askAi: (question) => calls.push(`askAi ${question}`),
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
  question: "Build done. Start publish and test?",
  options: [
    { value: "yes", label: "yes" },
    { value: "no", label: "no" },
  ],
};

const aborted: Event = { t: 2, kind: "run.end", status: "aborted", exitCode: 5 };

test("^C opens the abort dialog, a second ^C aborts now and quits once ended", async () => {
  const { setup, calls, quits, emit, frame } = await start();

  act(() => setup.mockInput.pressCtrlC());
  expect(await frame()).toContain("Abort the deployment?");

  act(() => setup.mockInput.pressCtrlC());
  expect(calls).toEqual(["abort now"]);
  const shown = await frame();
  expect(shown).toContain("? help");
  expect(shown).not.toContain("Abort the deployment?");
  expect(quits).toEqual([]);

  emit(aborted);
  await setup.renderOnce();
  expect(quits).toEqual([5]);
});

test("now chosen in the abort dialog: quits once the run ended", async () => {
  const { setup, calls, quits, emit } = await start();

  act(() => setup.mockInput.pressKey("q"));
  await setup.renderOnce();
  act(() => setup.mockInput.pressArrow("right"));
  await setup.renderOnce();
  act(() => setup.mockInput.pressEnter());
  expect(calls).toEqual(["abort now"]);
  expect(quits).toEqual([]);

  emit(aborted);
  await setup.renderOnce();
  expect(quits).toEqual([5]);
});

test("s asks first; yes stops now and stays open until q", async () => {
  const { setup, calls, quits, emit, frame } = await start();

  act(() => setup.mockInput.pressKey("s"));
  expect(await frame()).toContain("Stop the deployment now?");
  act(() => setup.mockInput.pressArrow("right"));
  await setup.renderOnce();
  act(() => setup.mockInput.pressEnter());
  expect(calls).toEqual([]);

  act(() => setup.mockInput.pressKey("s"));
  await setup.renderOnce();
  act(() => setup.mockInput.pressEnter());
  expect(calls).toEqual(["abort now"]);

  emit({ ...aborted, report: ["1 not done (h)"] });
  const ended = await frame();
  expect(ended).toContain("1 not done (h)");
  expect(quits).toEqual([]);

  act(() => setup.mockInput.pressKey("s"));
  expect(await frame()).not.toContain("Stop the deployment now?");
  act(() => setup.mockInput.pressKey("q"));
  expect(quits).toEqual([5]);
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

test("an engine question takes only its options; ^C and s raise their dialog over it", async () => {
  const { setup, calls, emit, frame } = await start();
  emit(ask);
  expect(await frame()).toContain("Build done. Start publish and test?");

  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(calls).toEqual([]);

  act(() => setup.mockInput.pressCtrlC());
  expect(await frame()).toContain("Abort the deployment?");
  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(await frame()).toContain("Build done. Start publish and test?");

  act(() => setup.mockInput.pressKey("s"));
  expect(await frame()).toContain("Stop the deployment now?");
  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(await frame()).toContain("Build done. Start publish and test?");

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

test("a pending question: host logs opened from the table, then back to answer", async () => {
  const { setup, calls, emit, frame } = await start();
  emit({ t: 1, kind: "host.add", host: "hcs", profile: "hcs", zone: "www" });
  emit({
    t: 1,
    kind: "host.output",
    host: "hcs",
    phase: "build",
    line: "error: Go 1.25 is end-of-life",
  });
  emit({
    ...ask,
    question: "hcs failed: Go 1.25 is end-of-life",
    options: [
      { value: "exclude", label: "exclude" },
      { value: "stop", label: "stop" },
    ],
  });

  act(() => setup.mockInput.pressTab());
  expect(await frame()).toContain("↵ host logs");
  act(() => setup.mockInput.pressEnter());
  const logs = await frame();
  expect(logs).toContain("hcs — logs");
  expect(logs).toContain("error: Go 1.25 is end-of-life");
  expect(logs).not.toContain("exclude");
  expect(calls).toEqual([]);

  act(() => setup.mockInput.pressEscape());
  await settle(setup);
  expect(await frame()).toContain("hcs failed: Go 1.25 is end-of-life");
  act(() => setup.mockInput.pressTab());
  await setup.renderOnce();
  act(() => setup.mockInput.pressEnter());
  expect(calls).toEqual(["respond exclude"]);
});

test("`a` sends the typed question to the engine, esc closes the input", async () => {
  const { setup, calls, frame } = await start();

  act(() => setup.mockInput.pressKey("a"));
  expect(await frame()).toContain("ask the AI");

  await act(() => setup.mockInput.typeText("why is gfx slow?"));
  act(() => setup.mockInput.pressEnter());
  await settle(setup);

  expect(calls).toEqual(["askAi why is gfx slow?"]);
  expect(await frame()).not.toContain("ask the AI");
});
