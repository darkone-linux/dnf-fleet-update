// Active region: the columns must hold whatever the output line measures.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { destroyTreeSitterClient, getTreeSitterClient, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { Event } from "../model/events.ts";
import { ExitCode } from "../model/exit-codes.ts";
import { testParams } from "../testing/fakes.ts";
import { App } from "./App.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;

/** Left rule of the accent block, drawn on every one of its rows. */
const RULE = "\u{1FB75}";

let current: Setup | undefined;
const forward = console.error;

// Frozen spinners: a ticking frame never reaches visual idle.
beforeAll(() => {
  process.env.FLEET_CAPTURE = "1";

  // Preloaded state, no update from act(): only the warning would be left.
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("was not wrapped in act")) return;
    forward(...args);
  };
});

afterAll(() => {
  delete process.env.FLEET_CAPTURE;
  console.error = forward;
});

afterEach(() => {
  current?.renderer.destroy();
  current = undefined;
});

const LONG_LINE =
  "copying path '/nix/store/zlk9jw06si1j35fhcp0imfll1c8cqqyi-fontconfig-2.18.3-bin' from 'http://10.1.2.1:5000'...";

const add = (host: string): Event[] => [
  { t: 0, kind: "host.add", host, profile: "desktop", zone: "ag" },
  { t: 0, kind: "host.state", host, state: "building" },
  { t: 0, kind: "host.state", host, state: "built" },
  { t: 0, kind: "host.state", host, state: "copying" },
];

const PRELOAD: Event[] = [
  ...add("vbox-umi"),
  ...add("vbox-test"),
  { t: 0, kind: "host.output", host: "vbox-test", phase: "copy", line: LONG_LINE },
];

async function render(width: number): Promise<Setup> {
  const setup = await testRender(<App preload={PRELOAD} />, { width, height: 30 });
  current = setup;
  await setup.waitForVisualIdle();
  return setup;
}

/** Foreground of the first span starting with `text`, as `rrggbb`. */
function fgHex(setup: Setup, text: string): string | undefined {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.startsWith(text))
    ?.fg?.toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

test("host names aligned on the longest of the fleet, whatever the output line", async () => {
  const setup = await render(110);

  // The rule glyph of the block: the host table names the same hosts.
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.includes(RULE));

  // `vbox-test` is the longest name: 9 columns, plus the 2 of the gap.
  expect(rows.find((row) => row.includes("vbox-umi"))).toContain("vbox-umi   ");
  expect(rows.find((row) => row.includes("vbox-test"))).toContain("vbox-test  copy");
});

test("the phase of an active host is white, the output line dim", async () => {
  const setup = await render(110);

  expect(fgHex(setup, "copy ")).toBe("ffffff");
  expect(fgHex(setup, "copying path")).toBe("7a7a7a");
});

/** Attributes of the first span starting with `text`. */
function attributesOf(setup: Setup, text: string): number | undefined {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.startsWith(text))?.attributes;
}

const REPAIRS: Event[] = [
  ...add("vbox-umi"),
  { t: 0, kind: "host.presence", host: "vbox-umi", online: true },
  { t: 0, kind: "host.state", host: "vbox-umi", state: "testing" },
  { t: 0, kind: "host.state", host: "vbox-umi", state: "error", note: "nginx.service failed" },
  { t: 0, kind: "host.state", host: "vbox-umi", state: "repairing" },
  ...add("vbox-test"),
  { t: 0, kind: "host.presence", host: "vbox-test", online: true },
  { t: 0, kind: "host.state", host: "vbox-test", state: "testing" },
  { t: 0, kind: "host.state", host: "vbox-test", state: "failed", note: "boom" },
  { t: 0, kind: "host.state", host: "vbox-test", state: "ai-repairing" },
];

// Someone is working on the host: yellow for the tool, magenta for the AI.
test("a host under repair: label blinking at the right of its row, with its spinner", async () => {
  const setup = await testRender(<App preload={REPAIRS} />, { width: 110, height: 30 });
  current = setup;
  await setup.waitForVisualIdle();

  const rows = setup.captureCharFrame().split("\n");
  expect(rows.find((row) => row.includes("vbox-umi"))).toContain("under repair");
  expect(rows.find((row) => row.includes("vbox-test"))).toContain("AI repair");
  expect(fgHex(setup, "under repair")).toBe("e0b341");
  expect(fgHex(setup, "AI repair")).toBe("d75fd7");
  expect(attributesOf(setup, "under repair")).toBe(TextAttributes.BLINK);
  expect(attributesOf(setup, "AI repair")).toBe(TextAttributes.BLINK);

  // Active state: the weather glyph gives way to the host spinner.
  expect(rows.find((row) => row.includes("vbox-umi"))).not.toContain("\u{1F326}");
});

// Over an hour of run: the chronometer has to carry its hours column.
const LONG_RUN: Event[] = [{ t: 3_725_000, kind: "step.start", step: "update" }];

test("the chronometer rides the Update row, magenta, on the engine clock", async () => {
  const setup = await testRender(<App preload={LONG_RUN} />, { width: 110, height: 30 });
  current = setup;
  await setup.waitForVisualIdle();

  const row = setup
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("Update"));

  expect(row).toContain("01:02:05");
  expect(fgHex(setup, "01:02:05")).toBe("d75fd7");

  // The running step names the current action: yellow, not the plain white.
  // The feed heading before it spells the same word in step purple: take the
  // one on the sidebar row, right of the chronometer.
  const label = setup
    .captureSpans()
    .lines.find((line) => line.spans.some((span) => span.text.startsWith("01:02:05")));
  const update = [...(label?.spans ?? [])].reverse().find((span) => span.text.startsWith("Update"));
  expect(
    update?.fg
      ?.toInts()
      .slice(0, 3)
      .map((p) => p.toString(16).padStart(2, "0"))
      .join(""),
  ).toBe("e0b341");
});

// A wide run summary: the narrow footer has to give segments up.
const SUMMARY: Event[] = [
  {
    t: 0,
    kind: "run.start",
    run: {
      version: "0.3.0",
      selection: "fl-*,fd-*",
      mode: "resume",
      codev: true,
      aiModel: "claude:opus@high",
      maxParallel: 10,
    },
  },
  ...add("vbox-umi"),
  { t: 0, kind: "run.end", status: "aborted", exitCode: ExitCode.Aborted },
];

/** Footer row of a frame: the only one carrying the key hint. */
async function footer(width: number, preload: Event[] = SUMMARY): Promise<string> {
  const setup = await testRender(<App preload={preload} />, { width, height: 30 });
  current = setup;
  await setup.waitForVisualIdle();
  const row = setup
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("? help"));
  return row ?? "";
}

test("the run summary keeps what fits, by falling priority", async () => {
  expect(await footer(160)).toContain(
    "resume · codev · claude:opus@high · 1 hosts · x10 · fl-*,fd-*",
  );

  // Parallelism goes first, then the selection.
  expect(await footer(122)).toContain("resume · codev · claude:opus@high · 1 hosts · fl-*,fd-*");
  expect(await footer(110)).toContain("resume · codev · claude:opus@high · 1 hosts ");
  expect(await footer(100)).toContain("resume · codev · 1 hosts ");
});

/** The same run, with the parameters a real run carries. */
function withAi(aiAnalysis: "none" | "passive", aiErrorAction: "none" | "analysis"): Event[] {
  const [start, ...rest] = SUMMARY as [Extract<Event, { kind: "run.start" }>, ...Event[]];
  const params = { ...testParams({ aiAnalysis, aiErrorAction }) };
  return [{ ...start, run: { ...start.run, params } }, ...rest];
}

test("the AI model shows only when something may ask it", async () => {
  expect(await footer(160, withAi("none", "none"))).toContain("resume · codev · 1 hosts");
  expect(await footer(160, withAi("none", "none"))).not.toContain("opus");

  expect(await footer(160, withAi("passive", "none"))).toContain("claude:opus@high");
  expect(await footer(160, withAi("none", "analysis"))).toContain("claude:opus@high");
});

test("AI answers render Markdown", async () => {
  const treeSitterClient = getTreeSitterClient();
  await treeSitterClient.initialize();
  await treeSitterClient.highlightOnce("**Likely cause**\n\n- Check nginx.service", "markdown");
  const setup = await testRender(
    <App
      preload={[
        { t: 0, kind: "ai", message: "analysis", id: "a" },
        { t: 1, kind: "ai.line", id: "a", line: "**Likely cause**" },
        { t: 2, kind: "ai.line", id: "a", line: "- Check nginx.service" },
        { t: 3, kind: "ai.end", id: "a" },
      ]}
    />,
    { width: 110, height: 30 },
  );
  current = setup;
  await setup.waitForVisualIdle();

  try {
    expect(setup.captureCharFrame()).toContain("Likely cause");
    expect(setup.captureCharFrame()).toContain("Check nginx.service");
    expect(attributesOf(setup, "Likely cause")).toBe(TextAttributes.BOLD);
  } finally {
    setup.renderer.destroy();
    current = undefined;
    await destroyTreeSitterClient();
  }
});

test("AI and YOU mentions are magenta in logs, including error text", async () => {
  const setup = await testRender(
    <App
      preload={[
        { t: 0, kind: "log", level: "error", message: "AI claude: refused" },
        { t: 1, kind: "log", level: "info", message: "YOU: why did it fail?" },
      ]}
    />,
    { width: 110, height: 30 },
  );
  current = setup;
  await setup.waitForVisualIdle();

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  expect(fgHex(setup, "AI")).toBe("d75fd7");
  expect(fgHex(setup, "YOU")).toBe("d75fd7");
  expect(
    spans
      .find((span) => span.text.includes("claude: refused"))
      ?.fg?.toInts()
      .slice(0, 3),
  ).toEqual([249, 112, 102]);
});

test("closed AI answers show in full, an older one too, under a pending question", async () => {
  const older = ["first", "second", "third", "fourth", "fifth", "sixth"].map((l) => `old ${l}`);
  const treeSitterClient = getTreeSitterClient();
  await treeSitterClient.initialize();
  await treeSitterClient.highlightOnce(older.join("\n"), "markdown");
  const setup = await testRender(
    <App
      preload={[
        { t: 0, kind: "ai", message: "older answer", detail: older },
        { t: 1, kind: "ai", message: "newer answer", detail: ["short"] },
        {
          t: 2,
          kind: "ask",
          id: "build",
          question: "Start publish?",
          options: [{ value: "yes", label: "yes" }],
        },
      ]}
    />,
    { width: 110, height: 40 },
  );
  current = setup;
  await setup.waitForVisualIdle();

  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("old sixth");
    expect(frame).toContain("Start publish?");
    expect(frame).not.toContain("more lines");
  } finally {
    setup.renderer.destroy();
    current = undefined;
    await destroyTreeSitterClient();
  }
});
